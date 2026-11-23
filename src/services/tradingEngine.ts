import { ChainKey, CHAINS } from "../chains/registry.js";
import { PositionRow, UserVault } from "../db/userVault.js";
import {
  atomicToNumber,
  computeNativeForTokenSell,
  computeTokensForNativeSpend,
  formatExactUnits,
  nativeAtomicToUsd,
  parseExactUnits
} from "../utils/amounts.js";
import { MarketDataService, TokenSnapshot } from "./marketData.js";
import { SecurityService, TokenSecurityReport } from "./security.js";

export interface BuyRequest {
  chain: ChainKey;
  tokenAddress: string;
  spendNativeAtomic: bigint;
  sourceType: "manual" | "copy" | "limit" | "dca";
  copiedWalletId?: number | null;
  copiedTxHash?: string | null;
  slippageBpsOverride?: number;
  simDelayMs?: number;
  ignoreSlippageLimit?: boolean;
  snapshotOverride?: TokenSnapshot;
  securityOverride?: TokenSecurityReport;
}

export interface SellRequest {
  positionId: number;
  sellPct?: number; // 0..100
  sellTokensAtomic?: bigint;
  sourceType: "manual" | "copy" | "tp" | "sl" | "trailing_stop" | "rug";
  copiedTxHash?: string | null;
  slippageBpsOverride?: number;
  simDelayMs?: number;
  snapshotOverride?: TokenSnapshot;
  securityOverride?: TokenSecurityReport;
}

export interface ExecutionResult {
  tradeId: number;
  positionId: number;
  chain: ChainKey;
  tokenSymbol: string;
  tokenAddress: string;
  side: "buy" | "sell" | "rug_writeoff";
  qtyTokenAtomic: bigint;
  tokenDecimals: number;
  nativeAmountAtomic: bigint;
  feeNativeAtomic: bigint;
  slippageImpactBps: number;
  taxBps: number;
  priceUsd: number;
  mcUsd: number;
  realizedPnlNativeAtomic: bigint;
  realizedPnlUsd: number;
  remainingBalanceAtomic: bigint;
  positionClosed: boolean;
  snapshot: TokenSnapshot;
  security: TokenSecurityReport;
}

export class TradingEngine {
  private readonly market: MarketDataService;
  private readonly security: SecurityService;

  constructor(market: MarketDataService, security: SecurityService) {
    this.market = market;
    this.security = security;
  }

  computeLiquidityImpactBps(tradeUsd: number, liquidityUsd: number): number {
    if (tradeUsd <= 0) return 0;
    if (liquidityUsd <= 0) return 2500; // 25% severe penalty if liquidity unindexed
    const ratio = tradeUsd / (2 * liquidityUsd + tradeUsd);
    return Math.min(4500, Math.max(1, Math.round(ratio * 10_000)));
  }

  getSimulatedNetworkFeeAtomic(chain: ChainKey, vault: UserVault, spendNativeAtomic: bigint): bigint {
    const settings = vault.getSettings();
    const spec = CHAINS[chain];
    const configuredFeeStr = chain === "solana" ? settings.priorityFeeSol : settings.evmGasEth;
    let configuredFee = 0n;
    try {
      configuredFee = parseExactUnits(configuredFeeStr, spec.nativeDecimals);
    } catch {
      configuredFee = 0n;
    }
    // Allow micro-decimal trades (e.g., 1 lamport or 1 wei) cleanly without rejecting on flat gas
    if (configuredFee <= 0n || spendNativeAtomic < configuredFee * 4n) {
      return 0n;
    }
    return configuredFee;
  }

  async executeBuy(vault: UserVault, req: BuyRequest): Promise<ExecutionResult> {
    const spec = CHAINS[req.chain];
    if (req.spendNativeAtomic <= 0n) {
      throw new Error("Buy amount must be greater than 0.");
    }

    const snap =
      req.snapshotOverride ?? (await this.market.getTokenSnapshot(req.chain, req.tokenAddress, 2500));
    if (!snap || snap.priceUsd <= 0 || snap.nativePriceUsd <= 0) {
      throw new Error("Could not find a live trading pool for this token right now.");
    }

    const sec = req.securityOverride ?? (await this.security.checkToken(req.chain, req.tokenAddress));
    if (sec.cannotBuy) {
      throw new Error("Trade blocked: Token contract currently prevents buying.");
    }

    const settings = vault.getSettings();
    const maxSlippageBps = req.slippageBpsOverride ?? settings.slippageBps;
    const spendUsd = nativeAtomicToUsd(req.spendNativeAtomic, spec.nativeDecimals, snap.nativePriceUsd);
    const impactBps = this.computeLiquidityImpactBps(spendUsd, snap.liquidityUsd);
    const totalFrictionBps = impactBps + sec.buyTaxBps;

    if (!req.ignoreSlippageLimit && totalFrictionBps > maxSlippageBps) {
      throw new Error(
        `Slippage too high (${(totalFrictionBps / 100).toFixed(2)}% price impact + tax vs ${(
          maxSlippageBps / 100
        ).toFixed(1)}% limit). Raise slippage in Settings or trade a smaller amount.`
      );
    }

    const effectiveBuyPriceUsd = snap.priceUsd * (1 + impactBps / 10_000);
    const feeAtomic = this.getSimulatedNetworkFeeAtomic(req.chain, vault, req.spendNativeAtomic);
    const balance = vault.getBalance(req.chain).balanceAtomic;

    // Deduct fee cleanly; if user wants to spend 100% of exact balance, deduct fee out of spend if needed
    let netSpendNativeAtomic = req.spendNativeAtomic;
    let totalWalletDebit = req.spendNativeAtomic + feeAtomic;
    if (balance < req.spendNativeAtomic) {
      throw new Error(
        `Not enough virtual ${spec.nativeSymbol}. Available: ${formatExactUnits(
          balance,
          spec.nativeDecimals
        )} ${spec.nativeSymbol}`
      );
    }
    if (balance < totalWalletDebit) {
      totalWalletDebit = req.spendNativeAtomic;
      netSpendNativeAtomic = req.spendNativeAtomic - feeAtomic;
    }

    const grossTokens = computeTokensForNativeSpend(
      netSpendNativeAtomic,
      spec.nativeDecimals,
      snap.decimals,
      snap.nativePriceUsd,
      effectiveBuyPriceUsd
    );
    const taxKeepFactor = BigInt(Math.max(0, 10_000 - sec.buyTaxBps));
    const receivedTokensAtomic = (grossTokens * taxKeepFactor) / 10_000n;
    if (receivedTokensAtomic <= 0n) {
      throw new Error("Trade amount is too tiny to buy at least 1 smallest unit of this token.");
    }

    const netSpendUsd = nativeAtomicToUsd(netSpendNativeAtomic, spec.nativeDecimals, snap.nativePriceUsd);
    const now = Date.now();

    const out = vault.runInTransaction(() => {
      const remainingBalanceAtomic = vault.adjustBalance(req.chain, -totalWalletDebit);

      // Keep copied positions isolated per watched wallet for clean weekly attribution
      const existingPos =
        req.sourceType === "copy" && req.copiedWalletId
          ? vault.getOpenPosition(req.chain, req.tokenAddress, req.copiedWalletId)
          : vault.getOpenPosition(req.chain, req.tokenAddress);

      let positionId: number;
      if (existingPos && (req.sourceType !== "copy" || existingPos.copiedWalletId === req.copiedWalletId)) {
        positionId = existingPos.id;
        vault.addToPosition({
          id: positionId,
          addedTokensAtomic: receivedTokensAtomic,
          addedNativeAtomic: totalWalletDebit,
          addedCostUsd: netSpendUsd,
          newPriceUsd: effectiveBuyPriceUsd,
          newMcUsd: snap.mcUsd
        });
      } else {
        positionId = vault.createPosition({
          chain: req.chain,
          tokenAddress: req.tokenAddress,
          tokenSymbol: snap.symbol,
          tokenName: snap.name,
          tokenDecimals: snap.decimals,
          pairAddress: snap.pairAddress,
          dex: snap.dex,
          sourceType: req.sourceType,
          copiedWalletId: req.copiedWalletId ?? null,
          qtyTokenAtomic: receivedTokensAtomic,
          costNativeAtomic: totalWalletDebit,
          costUsd: netSpendUsd,
          entryPriceUsd: effectiveBuyPriceUsd,
          entryMcUsd: snap.mcUsd,
          entryLiqUsd: snap.liquidityUsd,
          entryVol5mUsd: snap.volume5mUsd,
          entryTokenAgeSec: snap.tokenAgeSec,
          openedAt: now
        });
      }

      const tradeId = vault.recordTrade({
        positionId,
        chain: req.chain,
        side: "buy",
        sourceType: req.sourceType,
        copiedWalletId: req.copiedWalletId ?? null,
        copiedTxHash: req.copiedTxHash ?? null,
        tokenAddress: req.tokenAddress,
        tokenSymbol: snap.symbol,
        qtyTokenAtomic: receivedTokensAtomic,
        nativeAmountAtomic: netSpendNativeAtomic,
        feeNativeAtomic: feeAtomic,
        taxBps: sec.buyTaxBps,
        slippageBps: impactBps,
        priceUsd: effectiveBuyPriceUsd,
        nativePriceUsd: snap.nativePriceUsd,
        mcUsd: snap.mcUsd,
        liqUsd: snap.liquidityUsd,
        vol5mUsd: snap.volume5mUsd,
        tokenAgeSec: snap.tokenAgeSec,
        securityRisk: sec.riskLevel,
        realizedPnlNativeAtomic: 0n,
        realizedPnlUsd: 0,
        simDelayMs: req.simDelayMs ?? 0,
        executedAt: now
      });

      return { positionId, tradeId, remainingBalanceAtomic };
    });

    return {
      tradeId: out.tradeId,
      positionId: out.positionId,
      chain: req.chain,
      tokenSymbol: snap.symbol,
      tokenAddress: req.tokenAddress,
      side: "buy",
      qtyTokenAtomic: receivedTokensAtomic,
      tokenDecimals: snap.decimals,
      nativeAmountAtomic: netSpendNativeAtomic,
      feeNativeAtomic: feeAtomic,
      slippageImpactBps: impactBps,
      taxBps: sec.buyTaxBps,
      priceUsd: effectiveBuyPriceUsd,
      mcUsd: snap.mcUsd,
      realizedPnlNativeAtomic: 0n,
      realizedPnlUsd: 0,
      remainingBalanceAtomic: out.remainingBalanceAtomic,
      positionClosed: false,
      snapshot: snap,
      security: sec
    };
  }

  async executeSell(vault: UserVault, req: SellRequest): Promise<ExecutionResult> {
    const pos = vault.getPositionById(req.positionId);
    if (!pos || pos.status !== "open") {
      throw new Error("Open position not found.");
    }

    const spec = CHAINS[pos.chain];
    const snap =
      req.snapshotOverride ?? (await this.market.getTokenSnapshot(pos.chain, pos.tokenAddress, 2500));
    const sec = req.securityOverride ?? (await this.security.checkToken(pos.chain, pos.tokenAddress));

    let tokensToSell: bigint;
    if (req.sellTokensAtomic !== undefined) {
      tokensToSell = req.sellTokensAtomic > pos.qtyTokenAtomic ? pos.qtyTokenAtomic : req.sellTokensAtomic;
    } else {
      const pct = Math.min(100, Math.max(0.01, req.sellPct ?? 100));
      if (pct >= 99.999) {
        tokensToSell = pos.qtyTokenAtomic;
      } else {
        const bps = BigInt(Math.round(pct * 100));
        tokensToSell = (pos.qtyTokenAtomic * bps) / 10_000n;
      }
    }
    if (tokensToSell <= 0n) {
      throw new Error("Sell amount is 0.");
    }

    const now = Date.now();
    // Reality check: honeypot or liquidity pulled completely -> mark rugged write-off
    const isRugged =
      req.sourceType === "rug" ||
      sec.isHoneypot ||
      sec.cannotSellAll ||
      sec.sellTaxBps >= 9500 ||
      !snap ||
      snap.liquidityUsd < 50;

    if (isRugged) {
      const out = vault.runInTransaction(() => {
        const reduced = vault.reduceOrClosePosition({
          id: pos.id,
          soldTokensAtomic: pos.qtyTokenAtomic,
          receivedNativeAtomic: 0n,
          receivedUsd: 0,
          priceUsd: 0,
          mcUsd: 0,
          statusIfZero: "rugged",
          closedAt: now
        });

        const pnlNative = -reduced.costBasisSoldNative;
        const pnlUsd = -reduced.costBasisSoldUsd;

        const tradeId = vault.recordTrade({
          positionId: pos.id,
          chain: pos.chain,
          side: "rug_writeoff",
          sourceType: req.sourceType,
          copiedWalletId: pos.copiedWalletId,
          copiedTxHash: req.copiedTxHash ?? null,
          tokenAddress: pos.tokenAddress,
          tokenSymbol: pos.tokenSymbol,
          qtyTokenAtomic: pos.qtyTokenAtomic,
          nativeAmountAtomic: 0n,
          feeNativeAtomic: 0n,
          taxBps: sec.sellTaxBps,
          slippageBps: 10_000,
          priceUsd: 0,
          nativePriceUsd: snap?.nativePriceUsd ?? 0,
          mcUsd: 0,
          liqUsd: snap?.liquidityUsd ?? 0,
          vol5mUsd: snap?.volume5mUsd ?? 0,
          tokenAgeSec: snap?.tokenAgeSec ?? null,
          securityRisk: "danger",
          realizedPnlNativeAtomic: pnlNative,
          realizedPnlUsd: pnlUsd,
          simDelayMs: req.simDelayMs ?? 0,
          executedAt: now
        });

        this.cancelPositionOrders(vault, pos.id);
        return {
          tradeId,
          pnlNative,
          pnlUsd,
          remainingBalanceAtomic: vault.getBalance(pos.chain).balanceAtomic
        };
      });

      return {
        tradeId: out.tradeId,
        positionId: pos.id,
        chain: pos.chain,
        tokenSymbol: pos.tokenSymbol,
        tokenAddress: pos.tokenAddress,
        side: "rug_writeoff",
        qtyTokenAtomic: pos.qtyTokenAtomic,
        tokenDecimals: pos.tokenDecimals,
        nativeAmountAtomic: 0n,
        feeNativeAtomic: 0n,
        slippageImpactBps: 10_000,
        taxBps: sec.sellTaxBps,
        priceUsd: 0,
        mcUsd: 0,
        realizedPnlNativeAtomic: out.pnlNative,
        realizedPnlUsd: out.pnlUsd,
        remainingBalanceAtomic: out.remainingBalanceAtomic,
        positionClosed: true,
        snapshot: snap ?? {
          chain: pos.chain,
          address: pos.tokenAddress,
          symbol: pos.tokenSymbol,
          name: pos.tokenName,
          decimals: pos.tokenDecimals,
          pairAddress: pos.pairAddress ?? "",
          dex: pos.dex ?? "dex",
          dexUrl: "",
          priceUsd: 0,
          priceNative: 0,
          nativePriceUsd: 0,
          mcUsd: 0,
          fdvUsd: 0,
          liquidityUsd: 0,
          volume5mUsd: 0,
          volume1hUsd: 0,
          volume24hUsd: 0,
          txns5mBuys: 0,
          txns5mSells: 0,
          priceChange5m: 0,
          priceChange1h: 0,
          priceChange24h: 0,
          pairCreatedAtMs: null,
          tokenAgeSec: null,
          imageUrl: null,
          fetchedAt: now
        },
        security: sec
      };
    }

    const grossEstimateUsd = atomicToNumber(tokensToSell, pos.tokenDecimals) * snap.priceUsd;
    const impactBps = this.computeLiquidityImpactBps(grossEstimateUsd, snap.liquidityUsd);
    const effectiveSellPriceUsd = snap.priceUsd * Math.max(0.01, 1 - impactBps / 10_000);

    const grossNative = computeNativeForTokenSell(
      tokensToSell,
      pos.tokenDecimals,
      spec.nativeDecimals,
      snap.nativePriceUsd,
      effectiveSellPriceUsd
    );
    const afterTaxNative = (grossNative * BigInt(Math.max(0, 10_000 - sec.sellTaxBps))) / 10_000n;
    const feeAtomic = this.getSimulatedNetworkFeeAtomic(pos.chain, vault, afterTaxNative);
    const netReceivedNative = afterTaxNative > feeAtomic ? afterTaxNative - feeAtomic : afterTaxNative;
    const netReceivedUsd = nativeAtomicToUsd(netReceivedNative, spec.nativeDecimals, snap.nativePriceUsd);

    const out = vault.runInTransaction(() => {
      const reduced = vault.reduceOrClosePosition({
        id: pos.id,
        soldTokensAtomic: tokensToSell,
        receivedNativeAtomic: netReceivedNative,
        receivedUsd: netReceivedUsd,
        priceUsd: effectiveSellPriceUsd,
        mcUsd: snap.mcUsd,
        statusIfZero: "closed",
        closedAt: now
      });

      const pnlNative = netReceivedNative - reduced.costBasisSoldNative;
      const pnlUsd = netReceivedUsd - reduced.costBasisSoldUsd;
      const remainingBalanceAtomic = vault.adjustBalance(pos.chain, netReceivedNative);

      const tradeId = vault.recordTrade({
        positionId: pos.id,
        chain: pos.chain,
        side: "sell",
        sourceType: req.sourceType,
        copiedWalletId: pos.copiedWalletId,
        copiedTxHash: req.copiedTxHash ?? null,
        tokenAddress: pos.tokenAddress,
        tokenSymbol: pos.tokenSymbol,
        qtyTokenAtomic: tokensToSell,
        nativeAmountAtomic: netReceivedNative,
        feeNativeAtomic: feeAtomic,
        taxBps: sec.sellTaxBps,
        slippageBps: impactBps,
        priceUsd: effectiveSellPriceUsd,
        nativePriceUsd: snap.nativePriceUsd,
        mcUsd: snap.mcUsd,
        liqUsd: snap.liquidityUsd,
        vol5mUsd: snap.volume5mUsd,
        tokenAgeSec: snap.tokenAgeSec,
        securityRisk: sec.riskLevel,
        realizedPnlNativeAtomic: pnlNative,
        realizedPnlUsd: pnlUsd,
        simDelayMs: req.simDelayMs ?? 0,
        executedAt: now
      });

      if (reduced.closed) {
        this.cancelPositionOrders(vault, pos.id);
      }
      return {
        tradeId,
        pnlNative,
        pnlUsd,
        remainingBalanceAtomic,
        closed: reduced.closed
      };
    });

    return {
      tradeId: out.tradeId,
      positionId: pos.id,
      chain: pos.chain,
      tokenSymbol: pos.tokenSymbol,
      tokenAddress: pos.tokenAddress,
      side: "sell",
      qtyTokenAtomic: tokensToSell,
      tokenDecimals: pos.tokenDecimals,
      nativeAmountAtomic: netReceivedNative,
      feeNativeAtomic: feeAtomic,
      slippageImpactBps: impactBps,
      taxBps: sec.sellTaxBps,
      priceUsd: effectiveSellPriceUsd,
      mcUsd: snap.mcUsd,
      realizedPnlNativeAtomic: out.pnlNative,
      realizedPnlUsd: out.pnlUsd,
      remainingBalanceAtomic: out.remainingBalanceAtomic,
      positionClosed: out.closed,
      snapshot: snap,
      security: sec
    };
  }

  computeUnrealizedStats(pos: PositionRow, currentPriceUsd: number, currentNativePriceUsd: number): {
    currentValueUsd: number;
    currentValueNativeAtomic: bigint;
    pnlUsd: number;
    pnlPct: number;
  } {
    const spec = CHAINS[pos.chain];
    const currentValueNativeAtomic = computeNativeForTokenSell(
      pos.qtyTokenAtomic,
      pos.tokenDecimals,
      spec.nativeDecimals,
      currentNativePriceUsd,
      currentPriceUsd
    );
    const currentValueUsd = nativeAtomicToUsd(
      currentValueNativeAtomic,
      spec.nativeDecimals,
      currentNativePriceUsd
    );
    const pnlUsd = currentValueUsd - pos.costUsd;
    const pnlPct = pos.costUsd > 0 ? (pnlUsd / pos.costUsd) * 100 : 0;
    return { currentValueUsd, currentValueNativeAtomic, pnlUsd, pnlPct };
  }

  private cancelPositionOrders(vault: UserVault, positionId: number): void {
    const active = vault.listActiveOrders();
    for (const o of active) {
      if (o.positionId === positionId && o.orderType !== "limit_buy" && o.orderType !== "dca") {
        vault.setOrderStatus(o.id, "cancelled");
      }
    }
  }
}
