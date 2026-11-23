import { ChainKey, CHAINS, explorerAddressUrl, shortAddress } from "../chains/registry.js";
import { AppConfig } from "../config.js";
import {
  IAdminDb,
  IUserVault,
  IVaultManager,
  ObservedSwapRow,
  PositionRow,
  WatchedWalletRow
} from "../db/types.js";
import { formatDuration, formatUsd } from "../utils/amounts.js";
import { MarketDataService } from "./marketData.js";
import { WalletDetectiveService, WalletInvestigationReport } from "./walletDetective.js";

export interface WalletAttributionStats {
  walletId: number;
  alias: string;
  chain: ChainKey;
  address: string;
  positionsCount: number;
  wins: number;
  losses: number;
  rugs: number;
  winRatePct: number;
  netPnlUsd: number;
  roiPct: number;
  profitFactor: number;
  avgHoldMs: number;
  avgEntryMcUsd: number;
  avgEntryLiqUsd: number;
  observedSwapsCount: number;
  copiedCount: number;
  skippedCount: number;
  copyabilityScore: number;
  patternNotes: string[];
}

export interface ChainAttributionStats {
  chain: ChainKey;
  tradesCount: number;
  positionsCount: number;
  wins: number;
  winRatePct: number;
  netPnlUsd: number;
}

export interface BucketStat {
  label: string;
  count: number;
  wins: number;
  winRatePct: number;
  avgRoiPct: number;
  netPnlUsd: number;
}

export interface WeeklySummaryData {
  periodStart: number;
  periodEnd: number;
  totalTrades: number;
  totalPositions: number;
  closedPositions: number;
  openPositions: number;
  wins: number;
  losses: number;
  rugs: number;
  winRatePct: number;
  totalNetPnlUsd: number;
  profitFactor: number;
  bestTrade: { symbol: string; chain: ChainKey; pnlUsd: number; roiPct: number } | null;
  worstTrade: { symbol: string; chain: ChainKey; pnlUsd: number; roiPct: number } | null;
  walletLeaderboard: WalletAttributionStats[];
  chainBreakdown: ChainAttributionStats[];
  mcBuckets: BucketStat[];
  ageBuckets: BucketStat[];
  avgWinnerHoldMs: number;
  avgLoserHoldMs: number;
  recommendations: string[];
}

export class WeeklyReportService {
  private readonly config: AppConfig;
  private readonly adminDb: IAdminDb;
  private readonly vaultManager: IVaultManager;
  private readonly market: MarketDataService;
  private readonly detective?: WalletDetectiveService;
  private timer: NodeJS.Timeout | null = null;
  private schedulerBusy = false;
  private readonly scheduledAttempted = new Set<string>();
  private onAutoReport?: (telegramId: string, reportText: string) => Promise<void>;

  constructor(params: {
    config: AppConfig;
    adminDb: IAdminDb;
    vaultManager: IVaultManager;
    market: MarketDataService;
    detective?: WalletDetectiveService;
  }) {
    this.config = params.config;
    this.adminDb = params.adminDb;
    this.vaultManager = params.vaultManager;
    this.market = params.market;
    this.detective = params.detective;
  }

  startScheduler(onAutoReport: (telegramId: string, reportText: string) => Promise<void>): void {
    this.onAutoReport = onAutoReport;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.checkScheduledReports();
    }, 60_000);
  }

  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async checkScheduledReports(): Promise<void> {
    if (!this.onAutoReport || this.schedulerBusy) return;
    const now = new Date();
    if (
      now.getUTCDay() !== this.config.weeklyReportDayUtc ||
      now.getUTCHours() !== this.config.weeklyReportHourUtc
    ) {
      return;
    }

    this.schedulerBusy = true;
    try {
      const weekAgo = Date.now() - 6 * 24 * 3600_000;
      const runWindowKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`;

      for (const userId of await this.adminDb.listActiveUserIds()) {
        const dedupKey = `${userId}:${runWindowKey}`;
        if (this.scheduledAttempted.has(dedupKey)) continue;
        if (!(await this.vaultManager.hasVault(userId))) continue;
        const vault = await this.vaultManager.getVault(userId);
        if (!(await vault.getSettings()).weeklyReportEnabled) continue;

        const latest = await vault.getLatestWeeklyReport();
        if (latest && latest.createdAt >= weekAgo) continue;

        this.scheduledAttempted.add(dedupKey);
        try {
          const wallets = await vault.listWatchedWallets(true);
          if (wallets.length > 0 && this.detective) {
            let sentCount = 0;
            for (const w of wallets) {
              try {
                const perWallet = await this.generateForWatchedWallet(vault, w.id, 7);
                if (perWallet) {
                  await this.onAutoReport(userId, perWallet.formattedText);
                  sentCount++;
                }
              } catch {
                // Keep sending remaining wallets cleanly
              }
            }
            await vault.saveWeeklyReport({
              periodStart: Date.now() - 7 * 86_400_000,
              periodEnd: Date.now(),
              summaryJson: JSON.stringify({ mode: "wallet_by_wallet", wallets: wallets.length, sent: sentCount }),
              reportText: `Sent ${sentCount}/${wallets.length} wallet-by-wallet reports.`
            });
          } else {
            const { formattedText } = await this.generateForUser(vault, 7);
            await this.onAutoReport(userId, formattedText);
          }
        } catch {
          // Recorded in scheduledAttempted for this UTC hour so transient errors don't spam every 60s
        }
      }
    } finally {
      this.schedulerBusy = false;
    }
  }

  async generateForUser(
    vault: IUserVault,
    days = 7
  ): Promise<{ summary: WeeklySummaryData; formattedText: string }> {
    const periodEnd = Date.now();
    const periodStart = periodEnd - days * 24 * 3600_000;

    // Refresh live marks for open positions so unrealized numbers are up to date
    const openPositions = await vault.listOpenPositions();
    const byChain = new Map<ChainKey, string[]>();
    for (const p of openPositions) {
      const list = byChain.get(p.chain) ?? [];
      list.push(p.tokenAddress);
      byChain.set(p.chain, list);
    }
    for (const [chain, addrs] of byChain.entries()) {
      const snaps = await this.market.getBatchTokenSnapshots(chain, addrs);
      for (const p of openPositions) {
        if (p.chain !== chain) continue;
        const s = snaps.get(p.tokenAddress);
        if (s) await vault.updatePositionMark(p.id, s.priceUsd, s.mcUsd);
      }
    }

    const trades = await vault.listTradesBetween(periodStart, periodEnd);
    const positions = await vault.listPositionsInPeriod(periodStart, periodEnd);
    const wallets = await vault.listWatchedWallets(false);
    const observedSwaps = await vault.listObservedSwapsBetween(periodStart, periodEnd);

    const summary = this.computeSummary({
      periodStart,
      periodEnd,
      tradesCount: trades.length,
      positions,
      wallets,
      observedSwaps
    });

    const aiInsight = await this.tryGenerateAiCommentary(summary);
    const formattedText = this.formatReportMessage(summary, days, aiInsight);

    await vault.saveWeeklyReport({
      periodStart,
      periodEnd,
      summaryJson: JSON.stringify(summary),
      reportText: formattedText
    });

    return { summary, formattedText };
  }

  /**
   * Generates a complete wallet-by-wallet report combining copy-trade attribution
   * + on-chain Detective Investigation (most interacted buddies, balances, coins launched, Twitter).
   */
  async generateForWatchedWallet(
    vault: IUserVault,
    walletId: number,
    days = 7
  ): Promise<{
    wallet: WatchedWalletRow;
    stats: WalletAttributionStats | null;
    investigation: WalletInvestigationReport | null;
    formattedText: string;
  } | null> {
    const wallet = await vault.getWatchedWallet(walletId);
    if (!wallet) return null;

    const periodEnd = Date.now();
    const periodStart = periodEnd - days * 86_400_000;
    const [positions, observedSwaps, investigation] = await Promise.all([
      vault.listPositionsInPeriod(periodStart, periodEnd),
      vault.listObservedSwapsBetween(periodStart, periodEnd),
      this.detective
        ? this.detective.investigateWallet(wallet.chain, wallet.address, days)
        : Promise.resolve(null)
    ]);

    const summary = this.computeSummary({
      periodStart,
      periodEnd,
      tradesCount: 0,
      positions,
      wallets: [wallet],
      observedSwaps
    });
    const stats = summary.walletLeaderboard.find((w) => w.walletId === wallet.id) ?? null;

    const formattedText = formatWalletReportCombined({
      wallet,
      stats,
      investigation,
      days
    });

    return { wallet, stats, investigation, formattedText };
  }

  computeSummary(input: {
    periodStart: number;
    periodEnd: number;
    tradesCount: number;
    positions: PositionRow[];
    wallets: WatchedWalletRow[];
    observedSwaps: ObservedSwapRow[];
  }): WeeklySummaryData {
    const walletMap = new Map(input.wallets.map((w) => [w.id, w]));

    const positionPnl = (p: PositionRow): { pnlUsd: number; roiPct: number; holdMs: number; investedUsd: number } => {
      const openVal =
        p.status === "open" && p.entryPriceUsd > 0 && p.costUsd > 0
          ? p.costUsd * (p.lastPriceUsd / p.entryPriceUsd)
          : 0;
      const investedUsd = p.initialCostUsd > 0 ? p.initialCostUsd : p.costUsd;
      const exactPnl = p.realizedUsd + openVal - investedUsd;
      const roiPct = investedUsd > 0 ? (exactPnl / investedUsd) * 100 : 0;
      const holdMs = (p.closedAt ?? input.periodEnd) - p.openedAt;
      return { pnlUsd: exactPnl, roiPct, holdMs: Math.max(0, holdMs), investedUsd };
    };

    let wins = 0;
    let losses = 0;
    let rugs = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let totalNetPnlUsd = 0;
    let closedCount = 0;
    let openCount = 0;
    let bestTrade: WeeklySummaryData["bestTrade"] = null;
    let worstTrade: WeeklySummaryData["worstTrade"] = null;
    const winnerHolds: number[] = [];
    const loserHolds: number[] = [];

    const byWalletPos = new Map<number, PositionRow[]>();
    const byChainPos = new Map<ChainKey, PositionRow[]>();

    for (const p of input.positions) {
      const m = positionPnl(p);
      totalNetPnlUsd += m.pnlUsd;
      if (p.status === "open") openCount++;
      else closedCount++;
      if (p.status === "rugged") rugs++;

      if (m.pnlUsd >= 0) {
        wins++;
        grossProfit += m.pnlUsd;
        winnerHolds.push(m.holdMs);
      } else {
        losses++;
        grossLoss += Math.abs(m.pnlUsd);
        loserHolds.push(m.holdMs);
      }

      if (!bestTrade || m.pnlUsd > bestTrade.pnlUsd) {
        bestTrade = { symbol: p.tokenSymbol, chain: p.chain, pnlUsd: m.pnlUsd, roiPct: m.roiPct };
      }
      if (!worstTrade || m.pnlUsd < worstTrade.pnlUsd) {
        worstTrade = { symbol: p.tokenSymbol, chain: p.chain, pnlUsd: m.pnlUsd, roiPct: m.roiPct };
      }

      if (p.copiedWalletId !== null) {
        const arr = byWalletPos.get(p.copiedWalletId) ?? [];
        arr.push(p);
        byWalletPos.set(p.copiedWalletId, arr);
      }

      const cArr = byChainPos.get(p.chain) ?? [];
      cArr.push(p);
      byChainPos.set(p.chain, cArr);
    }

    // Wallet Leaderboard & Pattern Recognition per Wallet
    const walletLeaderboard: WalletAttributionStats[] = [];
    for (const w of input.wallets) {
      const wPositions = byWalletPos.get(w.id) ?? [];
      const wObserved = input.observedSwaps.filter((s) => s.watchedWalletId === w.id);
      if (wPositions.length === 0 && wObserved.length === 0) continue;

      let wWins = 0;
      let wLosses = 0;
      let wRugs = 0;
      let wPnl = 0;
      let wInvested = 0;
      let wGrossWin = 0;
      let wGrossLoss = 0;
      let holdSum = 0;
      let mcSum = 0;
      let liqSum = 0;
      let fastFlips = 0;

      for (const p of wPositions) {
        const m = positionPnl(p);
        wPnl += m.pnlUsd;
        wInvested += m.investedUsd;
        holdSum += m.holdMs;
        mcSum += p.entryMcUsd;
        liqSum += p.entryLiqUsd;
        if (m.holdMs < 45_000 && p.status !== "open") fastFlips++;
        if (p.status === "rugged") wRugs++;
        if (m.pnlUsd >= 0) {
          wWins++;
          wGrossWin += m.pnlUsd;
        } else {
          wLosses++;
          wGrossLoss += Math.abs(m.pnlUsd);
        }
      }

      const n = wPositions.length;
      const avgHoldMs = n > 0 ? holdSum / n : 0;
      const avgMc = n > 0 ? mcSum / n : 0;
      const avgLiq = n > 0 ? liqSum / n : 0;
      const winRate = n > 0 ? (wWins / n) * 100 : 0;
      const roiPct = wInvested > 0 ? (wPnl / wInvested) * 100 : 0;
      const pf = wGrossLoss > 0 ? wGrossWin / wGrossLoss : wGrossWin > 0 ? 99 : 0;

      // Copyability Score (0-100): rewards solid hold times, healthy liquidity, low rug rate, positive profit factor
      let copyScore = 50;
      if (avgLiq >= 50_000) copyScore += 15;
      else if (avgLiq > 0 && avgLiq < 10_000) copyScore -= 20;
      if (avgHoldMs >= 120_000) copyScore += 15;
      else if (n > 0 && fastFlips / n > 0.5) copyScore -= 25;
      if (winRate >= 55) copyScore += 10;
      if (pf >= 1.5) copyScore += 15;
      else if (pf < 0.8 && n >= 3) copyScore -= 15;
      if (wRugs > 0 && n > 0) copyScore -= Math.min(30, Math.round((wRugs / n) * 50));
      copyScore = Math.max(0, Math.min(100, copyScore));

      const patternNotes: string[] = [];
      if (n > 0) {
        patternNotes.push(`Avg entry MC: ${formatUsd(avgMc)} | Avg hold: ${formatDuration(avgHoldMs)}`);
        if (fastFlips > 0 && fastFlips / n >= 0.4) {
          patternNotes.push(`Warning: ${fastFlips}/${n} trades were quick sub-45s flips (hard to copy safely)`);
        }
        if (avgLiq > 0 && avgLiq < 12_000) {
          patternNotes.push(`Trades thin pools (avg liq ${formatUsd(avgLiq)}) — watch slippage`);
        }
        const winMc = wPositions
          .filter((p) => positionPnl(p).pnlUsd >= 0)
          .map((p) => p.entryMcUsd)
          .filter((v) => v > 0);
        if (winMc.length >= 2) {
          const avgWinMc = winMc.reduce((a, b) => a + b, 0) / winMc.length;
          patternNotes.push(`Best winners enter around ${formatUsd(avgWinMc)} MC`);
        }
      } else {
        patternNotes.push(`Observed ${wObserved.length} swaps (all filtered/skipped)`);
      }

      walletLeaderboard.push({
        walletId: w.id,
        alias: w.alias,
        chain: w.chain,
        address: w.address,
        positionsCount: n,
        wins: wWins,
        losses: wLosses,
        rugs: wRugs,
        winRatePct: winRate,
        netPnlUsd: wPnl,
        roiPct,
        profitFactor: pf,
        avgHoldMs,
        avgEntryMcUsd: avgMc,
        avgEntryLiqUsd: avgLiq,
        observedSwapsCount: wObserved.length,
        copiedCount: wObserved.filter((s) => s.actionTaken === "copied").length,
        skippedCount: wObserved.filter((s) => s.actionTaken !== "copied").length,
        copyabilityScore: copyScore,
        patternNotes
      });
    }

    walletLeaderboard.sort((a, b) => b.netPnlUsd - a.netPnlUsd);

    // Chain Breakdown
    const chainBreakdown: ChainAttributionStats[] = [];
    for (const [chain, cPositions] of byChainPos.entries()) {
      let cWins = 0;
      let cPnl = 0;
      for (const p of cPositions) {
        const m = positionPnl(p);
        cPnl += m.pnlUsd;
        if (m.pnlUsd >= 0) cWins++;
      }
      chainBreakdown.push({
        chain,
        tradesCount: cPositions.length,
        positionsCount: cPositions.length,
        wins: cWins,
        winRatePct: cPositions.length > 0 ? (cWins / cPositions.length) * 100 : 0,
        netPnlUsd: cPnl
      });
    }
    chainBreakdown.sort((a, b) => b.netPnlUsd - a.netPnlUsd);

    // MC Buckets (Pattern Recognition)
    const mcBucketDefs: Array<{ label: string; min: number; max: number }> = [
      { label: "Micro (<$30K MC)", min: 0, max: 30_000 },
      { label: "Early ($30K–$100K MC)", min: 30_000, max: 100_000 },
      { label: "Mid ($100K–$500K MC)", min: 100_000, max: 500_000 },
      { label: "Large (>$500K MC)", min: 500_000, max: Number.POSITIVE_INFINITY }
    ];
    const mcBuckets = this.buildBuckets(
      input.positions,
      mcBucketDefs,
      (p) => p.entryMcUsd,
      positionPnl
    );

    // Token Age Buckets
    const ageBucketDefs: Array<{ label: string; min: number; max: number }> = [
      { label: "Fresh (<5m old)", min: 0, max: 300 },
      { label: "Early (5m–30m)", min: 300, max: 1800 },
      { label: "Developing (30m–4h)", min: 1800, max: 14_400 },
      { label: "Established (>4h)", min: 14_400, max: Number.POSITIVE_INFINITY }
    ];
    const ageBuckets = this.buildBuckets(
      input.positions.filter((p) => p.entryTokenAgeSec !== null),
      ageBucketDefs,
      (p) => p.entryTokenAgeSec ?? 0,
      positionPnl
    );

    const avgWinnerHoldMs =
      winnerHolds.length > 0 ? winnerHolds.reduce((a, b) => a + b, 0) / winnerHolds.length : 0;
    const avgLoserHoldMs =
      loserHolds.length > 0 ? loserHolds.reduce((a, b) => a + b, 0) / loserHolds.length : 0;

    // Actionable recommendations
    const recommendations: string[] = [];
    if (walletLeaderboard.length > 0) {
      const top = walletLeaderboard[0];
      if (top.netPnlUsd > 0) {
        recommendations.push(
          `Top earner: "${top.alias}" (${CHAINS[top.chain].shortBadge}) made +${formatUsd(
            top.netPnlUsd
          )} with ${top.winRatePct.toFixed(0)}% win rate (Copy Score ${top.copyabilityScore}/100).`
        );
      }
      const worst = walletLeaderboard[walletLeaderboard.length - 1];
      if (worst.netPnlUsd < 0 && worst.positionsCount >= 2) {
        recommendations.push(
          `Consider pausing "${worst.alias}" (${formatUsd(
            worst.netPnlUsd
          )} loss, ${worst.rugs} rugs).`
        );
      }
    }
    const bestMc = [...mcBuckets].filter((b) => b.count >= 2).sort((a, b) => b.netPnlUsd - a.netPnlUsd)[0];
    if (bestMc && bestMc.netPnlUsd > 0) {
      recommendations.push(
        `Sweet spot: ${bestMc.label} delivered ${bestMc.winRatePct.toFixed(0)}% win rate and +${formatUsd(
          bestMc.netPnlUsd
        )}.`
      );
    }
    if (avgLoserHoldMs > avgWinnerHoldMs * 2 && loserHolds.length >= 2 && winnerHolds.length >= 2) {
      recommendations.push(
        `Hold asymmetry: losers are held ${formatDuration(
          avgLoserHoldMs
        )} vs winners ${formatDuration(avgWinnerHoldMs)} — tighten Stop Losses.`
      );
    }

    // Keep unused map suppressed cleanly
    void walletMap;

    return {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      totalTrades: input.tradesCount,
      totalPositions: input.positions.length,
      closedPositions: closedCount,
      openPositions: openCount,
      wins,
      losses,
      rugs,
      winRatePct: input.positions.length > 0 ? (wins / input.positions.length) * 100 : 0,
      totalNetPnlUsd,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0,
      bestTrade,
      worstTrade,
      walletLeaderboard,
      chainBreakdown,
      mcBuckets,
      ageBuckets,
      avgWinnerHoldMs,
      avgLoserHoldMs,
      recommendations
    };
  }

  private buildBuckets(
    positions: PositionRow[],
    defs: Array<{ label: string; min: number; max: number }>,
    getMetric: (p: PositionRow) => number,
    calcPnl: (p: PositionRow) => { pnlUsd: number; roiPct: number }
  ): BucketStat[] {
    return defs.map((def) => {
      const matched = positions.filter((p) => {
        const v = getMetric(p);
        return v >= def.min && v < def.max;
      });
      let wins = 0;
      let netPnl = 0;
      let roiSum = 0;
      for (const p of matched) {
        const m = calcPnl(p);
        netPnl += m.pnlUsd;
        roiSum += m.roiPct;
        if (m.pnlUsd >= 0) wins++;
      }
      return {
        label: def.label,
        count: matched.length,
        wins,
        winRatePct: matched.length > 0 ? (wins / matched.length) * 100 : 0,
        avgRoiPct: matched.length > 0 ? roiSum / matched.length : 0,
        netPnlUsd: netPnl
      };
    });
  }

  formatReportMessage(summary: WeeklySummaryData, days: number, aiInsight: string | null): string {
    const lines: string[] = [];
    const pnlSign = summary.totalNetPnlUsd >= 0 ? "+" : "";
    lines.push(`📊 *WEEKLY TRADING & ALPHA REPORT (${days}d)*`);
    lines.push("");

    if (summary.totalPositions === 0 && summary.walletLeaderboard.length === 0) {
      lines.push("No trades or watched wallet activity recorded in this period yet.");
      lines.push("Paste any token address to buy or add a wallet to watch!");
      return lines.join("\n");
    }

    lines.push(`💰 *Overall Result:* ${pnlSign}${formatUsd(summary.totalNetPnlUsd)}`);
    lines.push(
      `📈 Positions: *${summary.totalPositions}* (${summary.wins}W / ${summary.losses}L${
        summary.rugs > 0 ? ` / ${summary.rugs} Rugged` : ""
      }) | Win Rate: *${summary.winRatePct.toFixed(0)}%*`
    );
    if (summary.bestTrade) {
      lines.push(
        `🏆 Best Trade: *${escMd(summary.bestTrade.symbol)}* (${CHAINS[summary.bestTrade.chain].shortBadge}) ${
          summary.bestTrade.pnlUsd >= 0 ? "+" : ""
        }${formatUsd(summary.bestTrade.pnlUsd)} (${summary.bestTrade.roiPct.toFixed(0)}%)`
      );
    }

    if (summary.chainBreakdown.length > 0) {
      lines.push("");
      lines.push("🌐 *By Chain:*");
      for (const c of summary.chainBreakdown) {
        const spec = CHAINS[c.chain];
        const sign = c.netPnlUsd >= 0 ? "+" : "";
        lines.push(
          `• ${spec.emoji} *${spec.name}*: ${sign}${formatUsd(c.netPnlUsd)} (${c.positionsCount} trades, ${c.winRatePct.toFixed(
            0
          )}% win)`
        );
      }
    }

    if (summary.walletLeaderboard.length > 0) {
      lines.push("");
      lines.push("👁️ *Watched Wallet Leaderboard:*");
      for (const [idx, w] of summary.walletLeaderboard.slice(0, 6).entries()) {
        const sign = w.netPnlUsd >= 0 ? "+" : "";
        const badge = CHAINS[w.chain].shortBadge;
        lines.push(
          `${idx + 1}. *${escMd(w.alias)}* (${badge}) — ${sign}${formatUsd(w.netPnlUsd)} | ${w.winRatePct.toFixed(
            0
          )}% W | Copy Score: *${w.copyabilityScore}/100*`
        );
        for (const note of w.patternNotes.slice(0, 2)) {
          lines.push(`   _${escMd(note)}_`);
        }
      }
    }

    const activeMcBuckets = summary.mcBuckets.filter((b) => b.count > 0);
    if (activeMcBuckets.length > 0) {
      lines.push("");
      lines.push("🧠 *Pattern Recognition (Where Wins Come From):*");
      for (const b of activeMcBuckets) {
        const sign = b.netPnlUsd >= 0 ? "+" : "";
        lines.push(
          `• ${b.label}: ${b.count} trades, ${b.winRatePct.toFixed(0)}% win, ${sign}${formatUsd(b.netPnlUsd)}`
        );
      }
    }

    const activeAgeBuckets = summary.ageBuckets.filter((b) => b.count > 0);
    if (activeAgeBuckets.length > 0) {
      lines.push("⏱️ *By Token Age:*");
      for (const b of activeAgeBuckets) {
        const sign = b.netPnlUsd >= 0 ? "+" : "";
        lines.push(`• ${b.label}: ${b.count} trades, ${b.winRatePct.toFixed(0)}% win, ${sign}${formatUsd(b.netPnlUsd)}`);
      }
    }

    if (summary.recommendations.length > 0) {
      lines.push("");
      lines.push("💡 *Key Takeaways:*");
      for (const rec of summary.recommendations) {
        lines.push(`• ${escMd(rec)}`);
      }
    }

    if (aiInsight) {
      lines.push("");
      lines.push(`🤖 *Coach Summary:*\n${aiInsight.replace(/\*\*([^*]+)\*\*/g, "*$1*")}`);
    }

    return lines.join("\n");
  }

  private async tryGenerateAiCommentary(summary: WeeklySummaryData): Promise<string | null> {
    if (summary.totalPositions === 0) return null;
    const prompt =
      "You are a friendly trading coach explaining weekly trading numbers in plain, simple English (no heavy jargon) in 3 short bullet points based ONLY on this JSON data:\n" +
      JSON.stringify({
        totalNetPnlUsd: summary.totalNetPnlUsd,
        winRatePct: summary.winRatePct,
        chains: summary.chainBreakdown,
        wallets: summary.walletLeaderboard.slice(0, 5),
        mcBuckets: summary.mcBuckets,
        ageBuckets: summary.ageBuckets
      });

    if (this.config.geminiApiKey) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.config.geminiApiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
            signal: AbortSignal.timeout(8000)
          }
        );
        if (res.ok) {
          const data = (await res.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          };
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (text) return text;
        }
      } catch {
        // Fallback silently
      }
    }

    if (this.config.openaiApiKey) {
      try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.openaiApiKey}`
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 220
          }),
          signal: AbortSignal.timeout(8000)
        });
        if (res.ok) {
          const data = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const text = data.choices?.[0]?.message?.content?.trim();
          if (text) return text;
        }
      } catch {
        // Fallback silently
      }
    }

    return null;
  }
}

function escMd(text: string): string {
  return text.replace(/([_*`\[])/g, "\\$1");
}

function formatAgo(ms: number | null): string {
  if (!ms) return "Unknown";
  const diff = Math.max(0, Date.now() - ms);
  return `${formatDuration(diff)} ago`;
}

export function formatWalletReportCombined(params: {
  wallet: WatchedWalletRow;
  stats: WalletAttributionStats | null;
  investigation: WalletInvestigationReport | null;
  days: number;
}): string {
  const { wallet, stats, investigation, days } = params;
  const spec = CHAINS[wallet.chain];
  const lines: string[] = [];

  lines.push(`${spec.emoji} *WALLET REPORT: ${escMd(wallet.alias)}* (${spec.shortBadge} • ${days}d)`);
  lines.push(`\`${wallet.address}\``);
  lines.push("");

  // 1. Copy-trading performance for THIS wallet
  lines.push("📈 *Copy-Trading Performance:*");
  if (stats && stats.positionsCount > 0) {
    const sign = stats.netPnlUsd >= 0 ? "+" : "";
    lines.push(
      `• Result: *${sign}${formatUsd(stats.netPnlUsd)}* (${stats.roiPct >= 0 ? "+" : ""}${stats.roiPct.toFixed(1)}%)`
    );
    lines.push(
      `• Trades: *${stats.positionsCount}* (${stats.wins}W / ${stats.losses}L${
        stats.rugs > 0 ? ` / ${stats.rugs} Rugged` : ""
      }) | Copy Score: *${stats.copyabilityScore}/100*`
    );
    for (const note of stats.patternNotes.slice(0, 3)) {
      lines.push(`• _${escMd(note)}_`);
    }
  } else {
    lines.push("• Quiet on copied swaps (0 copied trades in this window — could be a storage vault!).");
  }

  if (investigation) {
    lines.push("");
    lines.push(...buildInvestigationLines(investigation, { includeHeader: false }));
  }

  return lines.join("\n");
}

export function formatDetectiveReportMessage(
  report: WalletInvestigationReport,
  alias?: string
): string {
  return buildInvestigationLines(report, { includeHeader: true, alias }).join("\n");
}

function buildInvestigationLines(
  r: WalletInvestigationReport,
  opts: { includeHeader: boolean; alias?: string }
): string[] {
  const spec = CHAINS[r.chain];
  const lines: string[] = [];

  if (opts.includeHeader) {
    const title = opts.alias ? `${escMd(opts.alias)} (${shortAddress(r.address)})` : shortAddress(r.address, 8, 6);
    lines.push(`🕵️‍♂️ *WALLET DETECTIVE: ${title}* (${spec.name} • ${r.days}d)`);
    lines.push(`\`${r.address}\``);
    lines.push("");
  }

  lines.push(`🏷️ *Wallet Type:* ${r.roleSummary}`);
  lines.push(
    `💰 *Existing Balance:* \`${r.nativeBalanceStr} ${r.nativeSymbol}\` (~*${formatUsd(
      r.nativeUsd
    )}*)${r.totalHoldingsUsd > r.nativeUsd + 1 ? ` | Total w/ Coins: ~*${formatUsd(r.totalHoldingsUsd)}*` : ""}`
  );
  if (r.topHoldings.length > 0) {
    const tops = r.topHoldings
      .slice(0, 4)
      .map((h) => `*$${escMd(h.symbol)}* (${h.amountStr}${h.usdValue > 0.5 ? `, ~${formatUsd(h.usdValue)}` : ""})`)
      .join(" • ");
    lines.push(`🪙 *Coins Held Now:* ${tops}`);
  }

  const lastStr = r.lastActiveAtMs ? formatAgo(r.lastActiveAtMs) : "Quiet";
  lines.push(
    `⚡ *${r.days}d Activity:* *${r.activityCount}* moves (*${r.swapsCount}* swaps, *${r.transfersCount}* transfers) | Last active: *${lastStr}*`
  );
  if (r.tradingStyle || r.peakHoursUtc) {
    lines.push(
      `🧠 *Style:* ${r.tradingStyle ?? "Unknown"}${r.peakHoursUtc ? ` | 🕒 Peak Hours: *${r.peakHoursUtc}*` : ""}`
    );
  }

  // Twitter / Social Identity & Cross-Chain Twin
  lines.push("");
  lines.push("🐦 *Twitter / X & Public Clues:*");
  if (r.identity.twitterHandles.length > 0) {
    lines.push(
      `• *Linked Twitter/X:* ${r.identity.twitterHandles.map((t) => `@${escMd(t)} (https://x.com/${t})`).join(", ")}`
    );
  } else if (r.identity.coinSocialTwitters.length > 0) {
    lines.push(
      `• *Coin Social Twitter:* ${r.identity.coinSocialTwitters.map((t) => `@${escMd(t)}`).join(", ")} _(attached to a coin it launched)_`
    );
  } else {
    lines.push("• *Twitter/X:* No public Twitter linked to this wallet.");
  }

  if (r.identity.domains.length > 0) {
    lines.push(`• *Wallet Names:* ${r.identity.domains.map(escMd).join(", ")}`);
  }
  if (r.identity.pumpUsername) {
    lines.push(
      `• *Pump.fun Profile:* \`${escMd(r.identity.pumpUsername)}\`${
        r.identity.pumpFollowers !== null ? ` (${r.identity.pumpFollowers} followers)` : ""
      }`
    );
  }
  if (r.identity.farcasterHandles.length > 0) {
    lines.push(`• *Farcaster:* ${r.identity.farcasterHandles.map(escMd).join(", ")}`);
  }
  if (r.identity.linkedEvmWallet) {
    lines.push(`• *Cross-Chain Twin EVM Wallet:* \`${r.identity.linkedEvmWallet}\``);
  }
  if (r.identity.linkedSolWallet) {
    lines.push(`• *Cross-Chain Twin Solana Wallet:* \`${r.identity.linkedSolWallet}\``);
  }

  // Launched Coins
  lines.push("");
  lines.push(`🚀 *Launched Coins Before?* ${r.launchedCount > 0 ? `*YES (${r.launchedCount} found!)*` : "*No launches found*"}`);
  for (const c of r.launchedCoins.slice(0, 4)) {
    const grad = c.graduated ? "🎓 Graduated" : "Curved/Early";
    const mc = c.mcUsd > 0 ? ` • MC ${formatUsd(c.mcUsd)}` : "";
    const tw = c.twitter ? ` • X: @${escMd(c.twitter)}` : "";
    lines.push(`• *$${escMd(c.symbol)}* (${escMd(c.name)}) — ${grad}${mc}${tw}`);
  }

  if (r.firstFunder) {
    lines.push("");
    lines.push(
      `🔑 *First Funder Clue:* Started by *${escMd(
        r.firstFunder.label ?? shortAddress(r.firstFunder.address)
      )}* (\`${r.firstFunder.address}\`)${
        r.firstFunder.amountNative > 0 ? ` with ${r.firstFunder.amountNative.toFixed(3)} ${r.nativeSymbol}` : ""
      }`
    );
  }

  // Most Interacted Wallets ("The Circle")
  lines.push("");
  lines.push(`🤝 *Most Connected Wallets (${r.days}d Familiar Circle):*`);
  if (r.connectedWallets.length === 0) {
    lines.push("• No direct wallet-to-wallet transfers spotted inside this window.");
  } else {
    for (const [idx, b] of r.connectedWallets.slice(0, 5).entries()) {
      const tagName = b.label ? `*${escMd(b.label)}* ` : "";
      const movedParts: string[] = [];
      if (b.inflowNative > 0.001) movedParts.push(`+${b.inflowNative.toFixed(2)} ${r.nativeSymbol} IN`);
      if (b.outflowNative > 0.001) movedParts.push(`-${b.outflowNative.toFixed(2)} ${r.nativeSymbol} OUT`);
      const movedStr = movedParts.length > 0 ? ` (${movedParts.join(", ")})` : "";

      lines.push(
        `${idx + 1}. ${b.roleBadge} ${tagName}([${shortAddress(b.address)}](${explorerAddressUrl(
          r.chain,
          b.address
        )}))`
      );
      lines.push(`   \`${b.address}\``);
      lines.push(`   • *${b.interactionsCount}x* together • ${b.directionTag}${movedStr}`);

      if (!b.isExchangeOrApp && b.nativeBalance !== null) {
        const bUsd = b.totalHoldingsUsd ?? b.nativeUsd ?? 0;
        const holdNote = b.topHolding ? ` | Top coin: ${escMd(b.topHolding)}` : "";
        lines.push(
          `   • *Balance:* \`${b.nativeBalance.toFixed(3)} ${r.nativeSymbol}\` (~${formatUsd(bUsd)})${holdNote}`
        );
        lines.push(
          `   • *${r.days}d Activity:* *${b.activityCount ?? 0}* moves (*${
            b.swapsCount ?? 0
          }* swaps) | Last seen: *${formatAgo(b.lastActiveAtMs)}*`
        );
        if (b.launchedCount > 0) {
          const sample = b.launchedCoins[0] ? ` (e.g. $${escMd(b.launchedCoins[0].symbol)})` : "";
          lines.push(`   • *Coins Launched:* *YES (${b.launchedCount})*${sample}`);
        } else {
          lines.push("   • *Coins Launched:* None found");
        }
        if (b.identity.twitterHandles.length > 0) {
          lines.push(
            `   • *Twitter/X:* ${b.identity.twitterHandles.map((t) => `@${escMd(t)}`).join(", ")}`
          );
        } else if (b.identity.domains.length > 0) {
          lines.push(`   • *Name:* ${b.identity.domains.map(escMd).join(", ")}`);
        }
        if (b.identity.linkedEvmWallet) {
          lines.push(`   • *Twin EVM:* \`${b.identity.linkedEvmWallet}\``);
        }
        if (b.hop2Targets.length > 0) {
          const h2 = b.hop2Targets
            .map((h) => `${escMd(h.label ?? shortAddress(h.address))} (${h.count}x ${h.direction})`)
            .join(", ");
          lines.push(`   • *2nd-Step Trail:* Also talks to ${h2}`);
        }
      }
    }
  }

  if (r.crossChainGlances.length > 1) {
    lines.push("");
    lines.push("🌐 *Activity Across EVM Chains:*");
    for (const g of r.crossChainGlances) {
      lines.push(
        `• ${g.emoji} *${g.chainLabel}:* \`${g.balanceNative.toFixed(4)} ${g.nativeSymbol}\` (~${formatUsd(
          g.usdValue
        )}) • ${g.txCount >= 50 ? "50+" : g.txCount} recent moves`
      );
    }
  }

  if (r.notes.length > 0) {
    lines.push("");
    for (const n of r.notes) {
      lines.push(`ℹ️ _${escMd(n)}_`);
    }
  }

  lines.push("");
  lines.push(`[Open on Explorer](${explorerAddressUrl(r.chain, r.address)})`);
  return lines;
}

