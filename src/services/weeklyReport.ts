import { ChainKey, CHAINS } from "../chains/registry.js";
import { AppConfig } from "../config.js";
import { AdminDb } from "../db/adminDb.js";
import { PositionRow, UserVault, UserVaultManager, WatchedWalletRow } from "../db/userVault.js";
import { formatDuration, formatUsd } from "../utils/amounts.js";
import { MarketDataService } from "./marketData.js";

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
  private readonly adminDb: AdminDb;
  private readonly vaultManager: UserVaultManager;
  private readonly market: MarketDataService;
  private timer: NodeJS.Timeout | null = null;
  private onAutoReport?: (telegramId: string, reportText: string) => Promise<void>;

  constructor(params: {
    config: AppConfig;
    adminDb: AdminDb;
    vaultManager: UserVaultManager;
    market: MarketDataService;
  }) {
    this.config = params.config;
    this.adminDb = params.adminDb;
    this.vaultManager = params.vaultManager;
    this.market = params.market;
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
    if (!this.onAutoReport) return;
    const now = new Date();
    if (
      now.getUTCDay() !== this.config.weeklyReportDayUtc ||
      now.getUTCHours() !== this.config.weeklyReportHourUtc
    ) {
      return;
    }

    const weekAgo = Date.now() - 6 * 24 * 3600_000;
    for (const userId of this.adminDb.listActiveUserIds()) {
      if (!this.vaultManager.hasVault(userId)) continue;
      const vault = this.vaultManager.getVault(userId);
      if (!vault.getSettings().weeklyReportEnabled) continue;

      const latest = vault.getLatestWeeklyReport();
      if (latest && latest.createdAt >= weekAgo) continue;

      try {
        const { formattedText } = await this.generateForUser(vault, 7);
        await this.onAutoReport(userId, formattedText);
      } catch {
        // ignore transient errors on scheduled send
      }
    }
  }

  async generateForUser(
    vault: UserVault,
    days = 7
  ): Promise<{ summary: WeeklySummaryData; formattedText: string }> {
    const periodEnd = Date.now();
    const periodStart = periodEnd - days * 24 * 3600_000;

    // Refresh live marks for open positions so unrealized numbers are up to date
    const openPositions = vault.listOpenPositions();
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
        if (s) vault.updatePositionMark(p.id, s.priceUsd, s.mcUsd);
      }
    }

    const trades = vault.listTradesBetween(periodStart, periodEnd);
    const positions = vault.listPositionsInPeriod(periodStart, periodEnd);
    const wallets = vault.listWatchedWallets(false);
    const observedSwaps = vault.listObservedSwapsBetween(periodStart, periodEnd);

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

    vault.saveWeeklyReport({
      periodStart,
      periodEnd,
      summaryJson: JSON.stringify(summary),
      reportText: formattedText
    });

    return { summary, formattedText };
  }

  computeSummary(input: {
    periodStart: number;
    periodEnd: number;
    tradesCount: number;
    positions: PositionRow[];
    wallets: WatchedWalletRow[];
    observedSwaps: ReturnType<UserVault["listObservedSwapsBetween"]>;
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
      lines.push("No simulated trades or watched wallet activity recorded in this period yet.");
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
        `🏆 Best Trade: *${summary.bestTrade.symbol}* (${CHAINS[summary.bestTrade.chain].shortBadge}) ${
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
          `${idx + 1}. *${w.alias}* (${badge}) — ${sign}${formatUsd(w.netPnlUsd)} | ${w.winRatePct.toFixed(
            0
          )}% W | Copy Score: *${w.copyabilityScore}/100*`
        );
        for (const note of w.patternNotes.slice(0, 2)) {
          lines.push(`   _${note}_`);
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
        lines.push(`• ${rec}`);
      }
    }

    if (aiInsight) {
      lines.push("");
      lines.push(`🤖 *Coach Summary:*\n${aiInsight}`);
    }

    return lines.join("\n");
  }

  private async tryGenerateAiCommentary(summary: WeeklySummaryData): Promise<string | null> {
    if (summary.totalPositions === 0) return null;
    const prompt =
      "You are a friendly trading coach explaining weekly demo trading numbers in plain, simple English (no heavy jargon) in 3 short bullet points based ONLY on this JSON data:\n" +
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
