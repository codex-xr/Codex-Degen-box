import { ChainKey, CHAINS } from "../chains/registry.js";
import { IAdminDb, IUserVault, IVaultManager, OrderRow, PositionRow } from "../db/types.js";
import { formatExactUnits, formatUsd } from "../utils/amounts.js";
import { MarketDataService, TokenSnapshot } from "./marketData.js";
import { SecurityService } from "./security.js";
import { ExecutionResult, TradingEngine } from "./tradingEngine.js";

export type OrderNotifyHandler = (telegramId: string, text: string, result?: ExecutionResult) => Promise<void>;

export class OrderMonitorService {
  private readonly adminDb: IAdminDb;
  private readonly vaultManager: IVaultManager;
  private readonly market: MarketDataService;
  private readonly security: SecurityService;
  private readonly trading: TradingEngine;
  private readonly onNotify: OrderNotifyHandler;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(params: {
    adminDb: IAdminDb;
    vaultManager: IVaultManager;
    market: MarketDataService;
    security: SecurityService;
    trading: TradingEngine;
    onNotify: OrderNotifyHandler;
  }) {
    this.adminDb = params.adminDb;
    this.vaultManager = params.vaultManager;
    this.market = params.market;
    this.security = params.security;
    this.trading = params.trading;
    this.onNotify = params.onNotify;
  }

  start(intervalMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const userIds = await this.adminDb.listActiveUserIds();
      for (const userId of userIds) {
        if (!(await this.vaultManager.hasVault(userId))) continue;
        const vault = await this.vaultManager.getVault(userId);
        await this.processUserVault(userId, vault);
      }
    } catch {
      // Prevent loop crash on transient failure
    } finally {
      this.running = false;
    }
  }

  async processUserVault(userId: string, vault: IUserVault): Promise<void> {
    const positions = await vault.listOpenPositions();
    const orders = await vault.listActiveOrders();
    if (positions.length === 0 && orders.length === 0) return;

    // Group tokens by chain for fast batched market fetches
    const tokensByChain = new Map<ChainKey, Set<string>>();
    const addToken = (chain: ChainKey, addr: string) => {
      let set = tokensByChain.get(chain);
      if (!set) {
        set = new Set();
        tokensByChain.set(chain, set);
      }
      set.add(addr);
    };

    for (const p of positions) addToken(p.chain, p.tokenAddress);
    for (const o of orders) addToken(o.chain, o.tokenAddress);

    const snapshots = new Map<string, TokenSnapshot>();
    for (const [chain, addrs] of tokensByChain.entries()) {
      const batch = await this.market.getBatchTokenSnapshots(chain, [...addrs]);
      for (const [addr, snap] of batch.entries()) {
        snapshots.set(`${chain}:${addr}`, snap);
      }
    }

    // 1. Update open position marks & detect sudden LP pulls / rugs
    const posMap = new Map<number, PositionRow>();
    for (const pos of positions) {
      posMap.set(pos.id, pos);
      const snap = snapshots.get(`${pos.chain}:${pos.tokenAddress}`);
      if (!snap) continue;

      await vault.updatePositionMark(pos.id, snap.priceUsd, snap.mcUsd);

      if (snap.liquidityUsd < 50 && pos.entryLiqUsd >= 500) {
        try {
          const res = await this.trading.executeSell(vault, {
            positionId: pos.id,
            sellPct: 100,
            sourceType: "rug",
            snapshotOverride: snap
          });
          await this.onNotify(
            userId,
            `🚨 *Liquidity Pulled (Simulated Rug)* on *${pos.tokenSymbol}* (${CHAINS[pos.chain].shortBadge})\n` +
              `Position written off at \$0.00 (Loss: ${formatUsd(res.realizedPnlUsd)})`,
            res
          );
          posMap.delete(pos.id);
        } catch {
          // ignore
        }
      }
    }

    // 2. Evaluate active orders
    const now = Date.now();
    for (const order of orders) {
      const snap = snapshots.get(`${order.chain}:${order.tokenAddress}`);
      await this.evaluateOrder(userId, vault, order, snap ?? null, posMap, now);
    }
  }

  private async evaluateOrder(
    userId: string,
    vault: IUserVault,
    order: OrderRow,
    snap: TokenSnapshot | null,
    posMap: Map<number, PositionRow>,
    now: number
  ): Promise<void> {
    if (order.orderType === "limit_buy") {
      if (!snap || !order.amountNativeAtomic) return;
      const mcHit = order.triggerMcUsd !== null && snap.mcUsd > 0 && snap.mcUsd <= order.triggerMcUsd;
      const priceHit = order.triggerPriceUsd !== null && snap.priceUsd <= order.triggerPriceUsd;
      if (!mcHit && !priceHit) return;

      try {
        const res = await this.trading.executeBuy(vault, {
          chain: order.chain,
          tokenAddress: order.tokenAddress,
          spendNativeAtomic: order.amountNativeAtomic,
          sourceType: "limit",
          snapshotOverride: snap
        });
        await vault.setOrderStatus(order.id, "filled");
        const spec = CHAINS[order.chain];
        await this.onNotify(
          userId,
          `🎯 *Limit Buy Filled!* (${spec.shortBadge})\n` +
            `Bought *${res.tokenSymbol}* for ${formatExactUnits(res.nativeAmountAtomic, spec.nativeDecimals)} ${spec.nativeSymbol} @ ${formatUsd(res.mcUsd)} MC`,
          res
        );
      } catch (err) {
        await vault.setOrderStatus(order.id, "cancelled");
        await this.onNotify(
          userId,
          `⚠️ *Limit Buy Cancelled* for *${order.tokenSymbol}*: ${(err as Error).message}`
        );
      }
      return;
    }

    if (order.orderType === "dca") {
      if (!snap || !order.amountNativeAtomic || !order.nextRunAt || now < order.nextRunAt) return;
      try {
        const res = await this.trading.executeBuy(vault, {
          chain: order.chain,
          tokenAddress: order.tokenAddress,
          spendNativeAtomic: order.amountNativeAtomic,
          sourceType: "dca",
          snapshotOverride: snap
        });
        const remaining = Math.max(0, (order.dcaRemaining ?? 1) - 1);
        const nextRunAt =
          remaining > 0 && order.dcaIntervalSec ? now + order.dcaIntervalSec * 1000 : null;
        await vault.advanceDcaOrder(order.id, remaining, nextRunAt);
        const spec = CHAINS[order.chain];
        await this.onNotify(
          userId,
          `🔁 *DCA Buy Executed* (${spec.shortBadge})\n` +
            `Bought *${res.tokenSymbol}* for ${formatExactUnits(res.nativeAmountAtomic, spec.nativeDecimals)} ${spec.nativeSymbol}. Remaining runs: ${remaining}`,
          res
        );
      } catch (err) {
        await vault.setOrderStatus(order.id, "cancelled");
        await this.onNotify(
          userId,
          `⚠️ *DCA Order Stopped* for *${order.tokenSymbol}*: ${(err as Error).message}`
        );
      }
      return;
    }

    // Position-bound TP / SL / Trailing Stop
    if (!order.positionId || !snap) return;
    const pos = posMap.get(order.positionId);
    if (!pos || pos.status !== "open" || pos.entryPriceUsd <= 0) {
      await vault.setOrderStatus(order.id, "cancelled");
      return;
    }

    const pnlPct = ((snap.priceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;

    if (order.orderType === "tp" && order.triggerPnlPct !== null && pnlPct >= order.triggerPnlPct) {
      await this.triggerPositionSell(userId, vault, order, pos, snap, "tp", `Take Profit (+${pnlPct.toFixed(1)}%)`);
      return;
    }

    if (order.orderType === "sl" && order.triggerPnlPct !== null && pnlPct <= order.triggerPnlPct) {
      await this.triggerPositionSell(userId, vault, order, pos, snap, "sl", `Stop Loss (${pnlPct.toFixed(1)}%)`);
      return;
    }

    if (order.orderType === "trailing_stop" && order.trailingDropPct !== null) {
      const prevHigh = order.highestPriceUsd ?? pos.entryPriceUsd;
      const newHigh = Math.max(prevHigh, snap.priceUsd);
      if (newHigh > prevHigh) {
        await vault.updateOrderHighestPrice(order.id, newHigh);
      }
      const dropFromHighPct = ((newHigh - snap.priceUsd) / newHigh) * 100;
      if (dropFromHighPct >= order.trailingDropPct) {
        await this.triggerPositionSell(
          userId,
          vault,
          order,
          pos,
          snap,
          "trailing_stop",
          `Trailing Stop (-${dropFromHighPct.toFixed(1)}% from peak)`
        );
      }
    }
  }

  private async triggerPositionSell(
    userId: string,
    vault: IUserVault,
    order: OrderRow,
    pos: PositionRow,
    snap: TokenSnapshot,
    sourceType: "tp" | "sl" | "trailing_stop",
    label: string
  ): Promise<void> {
    try {
      const res = await this.trading.executeSell(vault, {
        positionId: pos.id,
        sellPct: order.sellPct ?? 100,
        sourceType,
        snapshotOverride: snap
      });
      await vault.setOrderStatus(order.id, "filled");
      const spec = CHAINS[pos.chain];
      await this.onNotify(
        userId,
        `⚡ *${label} Triggered!* (${spec.shortBadge})\n` +
          `Sold ${order.sellPct ?? 100}% of *${pos.tokenSymbol}* → ${formatExactUnits(res.nativeAmountAtomic, spec.nativeDecimals)} ${spec.nativeSymbol} (PnL: ${formatUsd(res.realizedPnlUsd)})`,
        res
      );
    } catch (err) {
      await this.onNotify(
        userId,
        `⚠️ Failed ${label} for *${pos.tokenSymbol}*: ${(err as Error).message}`
      );
    }
  }
}
