import { escapeMd } from "../bot/formatters.js";
import { ChainKey, CHAINS, shortAddress } from "../chains/registry.js";
import { IUserVault, IVaultManager, WatchedWalletRow } from "../db/types.js";
import { formatExactUnits, formatUsd } from "../utils/amounts.js";
import { MarketDataService } from "./marketData.js";
import { SecurityService } from "./security.js";
import { ExecutionResult, TradingEngine } from "./tradingEngine.js";

export interface DetectedWalletSwap {
  chain: ChainKey;
  walletAddress: string;
  txHash: string;
  side: "buy" | "sell";
  tokenAddress: string;
  tokenSymbolHint?: string;
  walletNativeAmountAtomic: bigint | null;
  walletTokenAmount?: number;
  dex?: string;
  detectedAt: number;
}

export type CopyNotifyCallback = (
  telegramId: string,
  message: string,
  result?: ExecutionResult
) => Promise<void>;

export class CopyEngine {
  private readonly vaultManager: IVaultManager;
  private readonly market: MarketDataService;
  private readonly security: SecurityService;
  private readonly trading: TradingEngine;
  private readonly onNotify: CopyNotifyCallback;
  private readonly snapshotRetryDelaysMs: number[];

  constructor(params: {
    vaultManager: IVaultManager;
    market: MarketDataService;
    security: SecurityService;
    trading: TradingEngine;
    onNotify: CopyNotifyCallback;
    snapshotRetryDelaysMs?: number[];
  }) {
    this.vaultManager = params.vaultManager;
    this.market = params.market;
    this.security = params.security;
    this.trading = params.trading;
    this.onNotify = params.onNotify;
    this.snapshotRetryDelaysMs = params.snapshotRetryDelaysMs ?? [2500, 4000];
  }

  async processSwapForUser(
    telegramId: string,
    wallet: WatchedWalletRow,
    swap: DetectedWalletSwap
  ): Promise<void> {
    const vault = await this.vaultManager.getVault(telegramId);
    const settings = await vault.getSettings();
    const spec = CHAINS[swap.chain];

    if (!wallet.enabled) {
      await vault.recordObservedSwap({
        watchedWalletId: wallet.id,
        chain: swap.chain,
        txHash: swap.txHash,
        side: swap.side,
        tokenAddress: swap.tokenAddress,
        tokenSymbol: swap.tokenSymbolHint ?? null,
        walletNativeAmountAtomic: swap.walletNativeAmountAtomic,
        priceUsdAtEvent: null,
        mcUsdAtEvent: null,
        liqUsdAtEvent: null,
        vol5mUsdAtEvent: null,
        tokenAgeSec: null,
        dex: swap.dex ?? null,
        actionTaken: "paused",
        skipReason: "Watcher paused",
        observedAt: swap.detectedAt
      });
      return;
    }

    // Realistic mode waits configured block/execution delay before checking live fill price
    let simDelayMs = 0;
    if (wallet.simMode === "realistic" && settings.simDelayMs > 0) {
      simDelayMs = Math.min(3500, settings.simDelayMs);
      await new Promise((r) => setTimeout(r, simDelayMs));
    }

    let snap = await this.market.getTokenSnapshot(swap.chain, swap.tokenAddress, 1500);
    if (!snap && swap.side === "buy") {
      for (const waitMs of this.snapshotRetryDelaysMs) {
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
        snap = await this.market.getTokenSnapshot(swap.chain, swap.tokenAddress, 1500);
        if (snap) break;
      }
      if (!snap && swap.chain === "solana") {
        snap = await this.market.buildOnChainSolanaSnapshot({
          tokenAddress: swap.tokenAddress,
          walletNativeAmountAtomic: swap.walletNativeAmountAtomic,
          walletTokenAmount: swap.walletTokenAmount,
          dex: swap.dex,
          hasExplicitMinLiq: wallet.minLiqUsd !== null
        });
      }
    } else if (!snap && swap.side === "sell" && wallet.mirrorSells) {
      const openPos = await vault.getOpenPosition(swap.chain, swap.tokenAddress, wallet.id);
      if (openPos) {
        if ((this.snapshotRetryDelaysMs[0] ?? 0) > 0) {
          await new Promise((r) => setTimeout(r, this.snapshotRetryDelaysMs[0]));
        }
        snap = await this.market.getTokenSnapshot(swap.chain, swap.tokenAddress, 1500);
        if (!snap && swap.chain === "solana") {
          snap = await this.market.buildOnChainSolanaSnapshot({
            tokenAddress: swap.tokenAddress,
            walletNativeAmountAtomic: swap.walletNativeAmountAtomic,
            walletTokenAmount: swap.walletTokenAmount,
            dex: swap.dex,
            hasExplicitMinLiq: false
          });
        }
      }
    }

    const sec = await this.security.checkToken(swap.chain, swap.tokenAddress);
    const symbol = snap?.symbol ?? swap.tokenSymbolHint ?? shortAddress(swap.tokenAddress);

    if (swap.side === "buy") {
      await this.handleWatchedBuy({
        telegramId,
        vault,
        wallet,
        swap,
        snap,
        secRisk: sec.riskLevel,
        isRug: sec.isHoneypot || sec.cannotBuy || sec.riskLevel === "danger",
        symbol,
        simDelayMs,
        notifyEnabled: settings.copyNotify,
        specNativeDecimals: spec.nativeDecimals,
        specNativeSymbol: spec.nativeSymbol,
        specBadge: spec.shortBadge,
        sec
      });
    } else {
      await this.handleWatchedSell({
        telegramId,
        vault,
        wallet,
        swap,
        snap,
        sec,
        symbol,
        simDelayMs,
        notifyEnabled: settings.copyNotify,
        specNativeDecimals: spec.nativeDecimals,
        specNativeSymbol: spec.nativeSymbol,
        specBadge: spec.shortBadge
      });
    }
  }

  private async handleWatchedBuy(ctx: {
    telegramId: string;
    vault: IUserVault;
    wallet: WatchedWalletRow;
    swap: DetectedWalletSwap;
    snap: Awaited<ReturnType<MarketDataService["getTokenSnapshot"]>>;
    secRisk: string;
    isRug: boolean;
    symbol: string;
    simDelayMs: number;
    notifyEnabled: boolean;
    specNativeDecimals: number;
    specNativeSymbol: string;
    specBadge: string;
    sec: Awaited<ReturnType<SecurityService["checkToken"]>>;
  }): Promise<void> {
    const recordSwap = (actionTaken: string, skipReason: string | null) =>
      ctx.vault.recordObservedSwap({
        watchedWalletId: ctx.wallet.id,
        chain: ctx.swap.chain,
        txHash: ctx.swap.txHash,
        side: "buy",
        tokenAddress: ctx.swap.tokenAddress,
        tokenSymbol: ctx.symbol,
        walletNativeAmountAtomic: ctx.swap.walletNativeAmountAtomic,
        priceUsdAtEvent: ctx.snap?.priceUsd ?? null,
        mcUsdAtEvent: ctx.snap?.mcUsd ?? null,
        liqUsdAtEvent: ctx.snap?.liquidityUsd ?? null,
        vol5mUsdAtEvent: ctx.snap?.volume5mUsd ?? null,
        tokenAgeSec: ctx.snap?.tokenAgeSec ?? null,
        dex: ctx.snap?.dex ?? ctx.swap.dex ?? null,
        actionTaken,
        skipReason,
        observedAt: ctx.swap.detectedAt
      });

    if (!ctx.snap) {
      await recordSwap("skipped_filter", "No live liquidity pool found");
      return;
    }

    if (ctx.wallet.blockRisky && ctx.isRug) {
      if ((await recordSwap("skipped_risk", "Blocked by safety filter")) && ctx.notifyEnabled) {
        await this.onNotify(
          ctx.telegramId,
          `🛡️ *Copy Skipped (Risk)*: *${escapeMd(ctx.wallet.alias)}* bought *${escapeMd(ctx.symbol)}* (${ctx.specBadge}), blocked due to safety warnings.`
        );
      }
      return;
    }

    if (ctx.wallet.minMcUsd !== null && ctx.snap.mcUsd < ctx.wallet.minMcUsd) {
      await recordSwap("skipped_filter", `MC ${formatUsd(ctx.snap.mcUsd)} < min ${formatUsd(ctx.wallet.minMcUsd)}`);
      return;
    }
    if (ctx.wallet.maxMcUsd !== null && ctx.snap.mcUsd > ctx.wallet.maxMcUsd) {
      await recordSwap("skipped_filter", `MC ${formatUsd(ctx.snap.mcUsd)} > max ${formatUsd(ctx.wallet.maxMcUsd)}`);
      return;
    }
    if (ctx.wallet.minLiqUsd !== null && ctx.snap.liquidityUsd < ctx.wallet.minLiqUsd) {
      await recordSwap("skipped_filter", `Liq ${formatUsd(ctx.snap.liquidityUsd)} < min ${formatUsd(ctx.wallet.minLiqUsd)}`);
      return;
    }

    if (ctx.wallet.skipIfHeld && (await ctx.vault.getOpenPosition(ctx.swap.chain, ctx.swap.tokenAddress))) {
      await recordSwap("skipped_duplicate", "Already holding token");
      return;
    }

    const isWatchOnly =
      (ctx.wallet.copyMode === "fixed" && ctx.wallet.copyAmountAtomic <= 0n) ||
      (ctx.wallet.copyMode === "percent_balance" && ctx.wallet.copyPercent <= 0);
    if (isWatchOnly) {
      if ((await recordSwap("alert_only", "Alert & investigate mode ($0 copy)")) && ctx.notifyEnabled) {
        await this.onNotify(
          ctx.telegramId,
          `👀 *Wallet Trade Alert:* *${escapeMd(ctx.wallet.alias)}* bought *$${escapeMd(ctx.symbol)}* (${ctx.specBadge}) at ${formatUsd(ctx.snap.mcUsd)} MC.`
        );
      }
      return;
    }

    const available = (await ctx.vault.getBalance(ctx.swap.chain)).balanceAtomic;
    let spendAtomic = 0n;
    if (ctx.wallet.copyMode === "fixed") {
      spendAtomic = ctx.wallet.copyAmountAtomic;
    } else {
      const bps = BigInt(Math.round(Math.max(0, Math.min(100, ctx.wallet.copyPercent)) * 100));
      spendAtomic = (available * bps) / 10_000n;
      if (ctx.wallet.maxBuyAtomic && spendAtomic > ctx.wallet.maxBuyAtomic) {
        spendAtomic = ctx.wallet.maxBuyAtomic;
      }
    }

    if (spendAtomic <= 0n || available < spendAtomic) {
      if ((await recordSwap("skipped_balance", "Insufficient virtual balance")) && ctx.notifyEnabled) {
        await this.onNotify(
          ctx.telegramId,
          `⚠️ *Copy Skipped (Low Balance)*: *${escapeMd(ctx.wallet.alias)}* bought *${escapeMd(ctx.symbol)}* (${ctx.specBadge}), but you only have ${formatExactUnits(available, ctx.specNativeDecimals)} ${ctx.specNativeSymbol}.`
        );
      }
      return;
    }

    const inserted = await recordSwap("copied", null);
    if (!inserted) return;

    try {
      const res = await this.trading.executeBuy(ctx.vault, {
        chain: ctx.swap.chain,
        tokenAddress: ctx.swap.tokenAddress,
        spendNativeAtomic: spendAtomic,
        sourceType: "copy",
        copiedWalletId: ctx.wallet.id,
        copiedTxHash: ctx.swap.txHash,
        simDelayMs: ctx.simDelayMs,
        ignoreSlippageLimit: true, // Mirror whale even on volatile memecoin spikes
        snapshotOverride: ctx.snap,
        securityOverride: ctx.sec
      });

      // Attach automatic TP/SL orders if configured on this watcher
      if (ctx.wallet.autoTpPct !== null && ctx.wallet.autoTpPct > 0) {
        await ctx.vault.createOrder({
          chain: ctx.swap.chain,
          tokenAddress: ctx.swap.tokenAddress,
          tokenSymbol: res.tokenSymbol,
          positionId: res.positionId,
          orderType: "tp",
          triggerMcUsd: null,
          triggerPriceUsd: null,
          triggerPnlPct: ctx.wallet.autoTpPct,
          trailingDropPct: null,
          highestPriceUsd: res.priceUsd,
          amountNativeAtomic: null,
          sellPct: 100,
          dcaIntervalSec: null,
          dcaRemaining: null,
          nextRunAt: null
        });
      }
      if (ctx.wallet.autoSlPct !== null && ctx.wallet.autoSlPct < 0) {
        await ctx.vault.createOrder({
          chain: ctx.swap.chain,
          tokenAddress: ctx.swap.tokenAddress,
          tokenSymbol: res.tokenSymbol,
          positionId: res.positionId,
          orderType: "sl",
          triggerMcUsd: null,
          triggerPriceUsd: null,
          triggerPnlPct: ctx.wallet.autoSlPct,
          trailingDropPct: null,
          highestPriceUsd: res.priceUsd,
          amountNativeAtomic: null,
          sellPct: 100,
          dcaIntervalSec: null,
          dcaRemaining: null,
          nextRunAt: null
        });
      }

      if (ctx.notifyEnabled) {
        await this.onNotify(
          ctx.telegramId,
          `⚡ *Instant Copy Buy!* (${ctx.specBadge})\n` +
            `👤 Wallet: *${escapeMd(ctx.wallet.alias)}*\n` +
            `🪙 Token: *${escapeMd(res.tokenSymbol)}*\n` +
            `💵 Spent: *${formatExactUnits(res.nativeAmountAtomic, ctx.specNativeDecimals)} ${ctx.specNativeSymbol}*\n` +
            `📊 Entry MC: *${formatUsd(res.mcUsd)}* | Impact: ${(res.slippageImpactBps / 100).toFixed(2)}%`,
          res
        );
      }
    } catch (err) {
      if (ctx.notifyEnabled) {
        await this.onNotify(
          ctx.telegramId,
          `⚠️ *Copy Buy Failed* (*${escapeMd(ctx.wallet.alias)}* → *${escapeMd(ctx.symbol)}*): ${escapeMd((err as Error).message)}`
        );
      }
    }
  }

  private async handleWatchedSell(ctx: {
    telegramId: string;
    vault: IUserVault;
    wallet: WatchedWalletRow;
    swap: DetectedWalletSwap;
    snap: Awaited<ReturnType<MarketDataService["getTokenSnapshot"]>>;
    sec: Awaited<ReturnType<SecurityService["checkToken"]>>;
    symbol: string;
    simDelayMs: number;
    notifyEnabled: boolean;
    specNativeDecimals: number;
    specNativeSymbol: string;
    specBadge: string;
  }): Promise<void> {
    const openPos = await ctx.vault.getOpenPosition(ctx.swap.chain, ctx.swap.tokenAddress, ctx.wallet.id);

    if (!ctx.wallet.mirrorSells || !openPos) {
      await ctx.vault.recordObservedSwap({
        watchedWalletId: ctx.wallet.id,
        chain: ctx.swap.chain,
        txHash: ctx.swap.txHash,
        side: "sell",
        tokenAddress: ctx.swap.tokenAddress,
        tokenSymbol: ctx.symbol,
        walletNativeAmountAtomic: ctx.swap.walletNativeAmountAtomic,
        priceUsdAtEvent: ctx.snap?.priceUsd ?? null,
        mcUsdAtEvent: ctx.snap?.mcUsd ?? null,
        liqUsdAtEvent: ctx.snap?.liquidityUsd ?? null,
        vol5mUsdAtEvent: ctx.snap?.volume5mUsd ?? null,
        tokenAgeSec: ctx.snap?.tokenAgeSec ?? null,
        dex: ctx.snap?.dex ?? ctx.swap.dex ?? null,
        actionTaken: openPos ? "skipped_filter" : "skipped_no_position",
        skipReason: openPos ? "Mirror sells disabled" : "No open copied position",
        observedAt: ctx.swap.detectedAt
      });
      return;
    }

    const inserted = await ctx.vault.recordObservedSwap({
      watchedWalletId: ctx.wallet.id,
      chain: ctx.swap.chain,
      txHash: ctx.swap.txHash,
      side: "sell",
      tokenAddress: ctx.swap.tokenAddress,
      tokenSymbol: ctx.symbol,
      walletNativeAmountAtomic: ctx.swap.walletNativeAmountAtomic,
      priceUsdAtEvent: ctx.snap?.priceUsd ?? null,
      mcUsdAtEvent: ctx.snap?.mcUsd ?? null,
      liqUsdAtEvent: ctx.snap?.liquidityUsd ?? null,
      vol5mUsdAtEvent: ctx.snap?.volume5mUsd ?? null,
      tokenAgeSec: ctx.snap?.tokenAgeSec ?? null,
      dex: ctx.snap?.dex ?? ctx.swap.dex ?? null,
      actionTaken: "copied",
      skipReason: null,
      observedAt: ctx.swap.detectedAt
    });
    if (!inserted) return;

    try {
      const res = await this.trading.executeSell(ctx.vault, {
        positionId: openPos.id,
        sellPct: 100,
        sourceType: "copy",
        copiedTxHash: ctx.swap.txHash,
        simDelayMs: ctx.simDelayMs,
        snapshotOverride: ctx.snap ?? undefined,
        securityOverride: ctx.sec
      });

      if (ctx.notifyEnabled) {
        const pnlSign = res.realizedPnlUsd >= 0 ? "+" : "";
        await this.onNotify(
          ctx.telegramId,
          `🏁 *Instant Copy Sell!* (${ctx.specBadge})\n` +
            `👤 Wallet: *${escapeMd(ctx.wallet.alias)}*\n` +
            `🪙 Token: *${escapeMd(res.tokenSymbol)}*\n` +
            `💰 Received: *${formatExactUnits(res.nativeAmountAtomic, ctx.specNativeDecimals)} ${ctx.specNativeSymbol}*\n` +
            `📈 Realized PnL: *${pnlSign}${formatUsd(res.realizedPnlUsd)}*`,
          res
        );
      }
    } catch (err) {
      if (ctx.notifyEnabled) {
        await this.onNotify(
          ctx.telegramId,
          `⚠️ *Copy Sell Failed* (*${escapeMd(ctx.wallet.alias)}* → *${escapeMd(ctx.symbol)}*): ${escapeMd((err as Error).message)}`
        );
      }
    }
  }
}
