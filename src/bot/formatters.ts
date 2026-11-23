import {
  CHAIN_LIST,
  ChainKey,
  CHAINS,
  explorerTokenUrl,
  shortAddress
} from "../chains/registry.js";
import { IUserVault, OrderRow, PositionRow, WatchedWalletRow } from "../db/types.js";
import { TokenSnapshot } from "../services/marketData.js";
import { TokenSecurityReport } from "../services/security.js";
import { TradingEngine } from "../services/tradingEngine.js";
import {
  formatCompactPrice,
  formatDuration,
  formatExactUnits,
  formatUsd
} from "../utils/amounts.js";

export function escapeMd(text: string): string {
  return text.replace(/([_*`\[])/g, "\\$1");
}

export function stripMdForFallback(text: string): string {
  return text.replace(/\\([_*`\[\\])|[*_`]/g, (_match, escaped?: string) => escaped ?? "");
}

const SHORT_TO_CHAIN: Record<string, ChainKey> = {
  s: "solana",
  e: "ethereum",
  b: "base",
  r: "robinhood"
};

export function shortChainCode(chain: ChainKey): string {
  if (chain === "solana") return "s";
  if (chain === "ethereum") return "e";
  if (chain === "base") return "b";
  return "r";
}

export function chainFromShortCode(code: string | undefined): ChainKey | null {
  return code ? (SHORT_TO_CHAIN[code] ?? null) : null;
}

export async function formatHomeMessage(vault: IUserVault, isAdmin: boolean): Promise<string> {
  const [balances, settings, openPositions, activeOrders, watchers] = await Promise.all([
    vault.getBalances(),
    vault.getSettings(),
    vault.listOpenPositions(),
    vault.listActiveOrders(),
    vault.listWatchedWallets(false)
  ]);
  const enabledWatchers = watchers.filter((w) => w.enabled).length;

  const lines: string[] = [
    `🏴‍☠️ *EVIL.FUN* ${isAdmin ? "• 👑 Admin" : ""}`,
    `_Private Trading & Copy-Alpha Terminal_`,
    "",
    "💰 *Your Wallet Funds:*"
  ];

  for (const spec of CHAIN_LIST) {
    const row = balances.find((b) => b.chain === spec.key);
    const balStr = formatExactUnits(row?.balanceAtomic ?? 0n, spec.nativeDecimals);
    lines.push(`${spec.emoji} *${spec.name}:* \`${balStr} ${spec.nativeSymbol}\``);
  }

  lines.push("");
  lines.push(
    `📈 Open Trades: *${openPositions.length}*  |  🎯 Orders: *${activeOrders.length}*  |  👁️ Watching: *${enabledWatchers}/${watchers.length}*`
  );
  lines.push(
    `⚙️ Slippage: *${(settings.slippageBps / 100).toFixed(1)}%*  |  Mode: *${
      settings.simMode === "realistic" ? "Realistic Delay" : "Instant Ideal"
    }*`
  );
  lines.push("");
  lines.push("💡 _Tip: Paste any token OR wallet address right here in chat to trade or investigate it!_");

  return lines.join("\n");
}

export function formatTokenScanMessage(
  snap: TokenSnapshot,
  sec: TokenSecurityReport,
  balanceAtomic: bigint
): string {
  const spec = CHAINS[snap.chain];
  const balStr = formatExactUnits(balanceAtomic, spec.nativeDecimals);
  const ageStr = snap.tokenAgeSec !== null ? formatDuration(snap.tokenAgeSec * 1000) : "Unknown";

  const riskBadge =
    sec.riskLevel === "safe"
      ? "✅ Looks Clean"
      : sec.riskLevel === "warning"
        ? "⚠️ Caution"
        : sec.riskLevel === "danger"
          ? "🚨 High Risk / Honeypot"
          : "❔ Unverified";

  const lines: string[] = [
    `${spec.emoji} *${escapeMd(snap.name)} ($${escapeMd(snap.symbol)})* • *${spec.name}*`,
    `\`${snap.address}\``,
    "",
    `💵 Price: *${formatCompactPrice(snap.priceUsd)}*  |  MC: *${formatUsd(snap.mcUsd)}*`,
    `💧 Liquidity: *${formatUsd(snap.liquidityUsd)}*  |  5m Vol: *${formatUsd(snap.volume5mUsd)}*`,
    `📊 5m: ${signedPct(snap.priceChange5m)} | 1h: ${signedPct(snap.priceChange1h)} | 24h: ${signedPct(snap.priceChange24h)}`,
    `🔄 5m Trades: *${snap.txns5mBuys}* Buys / *${snap.txns5mSells}* Sells | Age: *${ageStr}*`,
    "",
    `🛡️ *Safety Check:* ${riskBadge}`
  ];

  if (sec.buyTaxBps > 0 || sec.sellTaxBps > 0) {
    lines.push(
      `💸 Tax: Buy ${(sec.buyTaxBps / 100).toFixed(1)}% / Sell ${(sec.sellTaxBps / 100).toFixed(1)}%`
    );
  }
  if (sec.warnings.length > 0) {
    lines.push(`⚠️ ${sec.warnings.slice(0, 3).map(escapeMd).join(" • ")}`);
  }

  lines.push("");
  lines.push(`💰 Your ${spec.shortBadge} Balance: \`${balStr} ${spec.nativeSymbol}\``);
  lines.push(
    `[Explorer](${explorerTokenUrl(snap.chain, snap.address)})${
      snap.dexUrl ? ` • [DexScreener](${snap.dexUrl})` : ""
    }`
  );

  return lines.join("\n");
}

export function formatPositionMessage(
  pos: PositionRow,
  snap: TokenSnapshot | null,
  trading: TradingEngine,
  orders: OrderRow[],
  watchedWalletAlias?: string
): string {
  const spec = CHAINS[pos.chain];
  const currentPrice = snap?.priceUsd ?? pos.lastPriceUsd;
  const nativePrice = snap?.nativePriceUsd ?? 0;
  const currentMc = snap?.mcUsd ?? pos.entryMcUsd;

  let pnlUsd = 0;
  let pnlPct = 0;
  let currentValNative = "—";
  if (nativePrice > 0) {
    const stats = trading.computeUnrealizedStats(pos, currentPrice, nativePrice);
    pnlUsd = stats.pnlUsd;
    pnlPct = stats.pnlPct;
    currentValNative = `${formatExactUnits(stats.currentValueNativeAtomic, spec.nativeDecimals, 6)} ${spec.nativeSymbol}`;
  } else if (pos.entryPriceUsd > 0 && pos.costUsd > 0) {
    const val = pos.costUsd * (currentPrice / pos.entryPriceUsd);
    pnlUsd = val - pos.costUsd;
    pnlPct = (pnlUsd / pos.costUsd) * 100;
  }

  const holdMs = Date.now() - pos.openedAt;
  const sourceText = watchedWalletAlias ? `👁️ Copied from *${escapeMd(watchedWalletAlias)}*` : "👤 Manual Trade";
  const emoji = pnlUsd >= 0 ? "🟢" : "🔴";

  const lines: string[] = [
    `${spec.emoji} *$${escapeMd(pos.tokenSymbol)}* (${spec.name})`,
    `${sourceText} • Held ${formatDuration(holdMs)}`,
    `\`${pos.tokenAddress}\``,
    "",
    `${emoji} *Live PnL:* ${pnlUsd >= 0 ? "+" : ""}${formatUsd(pnlUsd)} (*${signedPct(pnlPct)}*)`,
    `💰 Cost: \`${formatExactUnits(pos.costNativeAtomic, spec.nativeDecimals, 6)} ${spec.nativeSymbol}\` (${formatUsd(pos.costUsd)})`,
    `💎 Value Now: \`${currentValNative}\``,
    `📊 MC: ${formatUsd(pos.entryMcUsd)} → *${formatUsd(currentMc)}*`,
    `🪙 Tokens: \`${formatExactUnits(pos.qtyTokenAtomic, pos.tokenDecimals, 4)}\``
  ];

  const posOrders = orders.filter((o) => o.positionId === pos.id);
  if (posOrders.length > 0) {
    lines.push("");
    lines.push("🎯 *Active Auto-Orders:*");
    for (const o of posOrders) {
      if (o.orderType === "tp") lines.push(`• Take Profit at +${o.triggerPnlPct}% (Sell ${o.sellPct}%)`);
      if (o.orderType === "sl") lines.push(`• Stop Loss at ${o.triggerPnlPct}% (Sell ${o.sellPct}%)`);
      if (o.orderType === "trailing_stop") lines.push(`• Trailing Stop: -${o.trailingDropPct}% from peak`);
    }
  }

  return lines.join("\n");
}

export function formatWatchedWalletMessage(w: WatchedWalletRow): string {
  const spec = CHAINS[w.chain];
  const copyAmtStr =
    w.copyMode === "fixed"
      ? w.copyAmountAtomic <= 0n
        ? "0 (Watch & Alert Only — no auto buys)"
        : `${formatExactUnits(w.copyAmountAtomic, spec.nativeDecimals)} ${spec.nativeSymbol} per trade`
      : `${w.copyPercent}% of balance per trade`;

  const lines: string[] = [
    `${spec.emoji} *${escapeMd(w.alias)}* (${spec.name})`,
    `Status: ${w.enabled ? "🟢 *ACTIVE (Watching Live)*" : "⏸️ *PAUSED*"}`,
    `Address: \`${w.address}\``,
    "",
    `💵 *Copy Size:* \`${copyAmtStr}\``,
    `🚨 Funding / Transfer Alerts: *${w.transferAlerts ? "Yes" : "No"}*`,
    `🔁 Mirror Sells: *${w.mirrorSells ? "Yes" : "No"}* (${
      w.sellMode === "proportional" ? "Match Wallet Sell %" : "Full 100% Exit"
    })`,
    `🚀 Snipe Dev Launches: *${w.snipeDevLaunches ? "ON (Real Opening Pool MC)" : "Off"}*`,
    `🛡️ Block Risky/Honeypots: *${w.blockRisky ? "Yes" : "No"}*`,
    `⚡ Skip If Already Holding: *${w.skipIfHeld ? "Yes" : "No"}*`,
    `⏱️ Sim Mode: *${w.simMode === "realistic" ? "Realistic Delay" : "Instant Ideal"}*`,
    "",
    `📏 *Filters:*`,
    `• Min MC: ${w.minMcUsd !== null ? formatUsd(w.minMcUsd) : "Any"}  |  Max MC: ${
      w.maxMcUsd !== null ? formatUsd(w.maxMcUsd) : "Any"
    }`,
    `• Min Liquidity: ${w.minLiqUsd !== null ? formatUsd(w.minLiqUsd) : "Any"}`,
    `• Auto TP / SL: ${w.autoTpPct !== null ? `+${w.autoTpPct}%` : "Off"} / ${
      w.autoSlPct !== null ? `${w.autoSlPct}%` : "Off"
    }  |  Trailing: ${w.autoTrailingPct !== null ? `${w.autoTrailingPct}%` : "Off"}`
  ];

  return lines.join("\n");
}

export function formatWalletLeaderboardMessage(
  wallets: WatchedWalletRow[],
  openPositions: PositionRow[],
  closedPositions: PositionRow[]
): string {
  if (wallets.length === 0) {
    return "🏆 *Wallet Copy Leaderboard*\n\n_No watched wallets yet — add one under Watch Wallets!_";
  }

  const allCopyPos = [...openPositions, ...closedPositions].filter(
    (p) => p.sourceType === "copy" && p.copiedWalletId !== null
  );

  const stats = wallets.map((w) => {
    const mine = allCopyPos.filter((p) => p.copiedWalletId === w.id);
    let wins = 0;
    let losses = 0;
    let rugs = 0;
    let investedUsd = 0;
    let totalPnlUsd = 0;

    for (const p of mine) {
      const inv = p.initialCostUsd > 0 ? p.initialCostUsd : p.costUsd;
      investedUsd += inv;
      if (p.status === "rugged") {
        rugs++;
        losses++;
        totalPnlUsd += p.realizedUsd - inv;
      } else if (p.status === "closed") {
        const pnl = p.realizedUsd - inv;
        totalPnlUsd += pnl;
        if (pnl >= 0) wins++;
        else losses++;
      } else {
        const markRatio = p.entryPriceUsd > 0 ? p.lastPriceUsd / p.entryPriceUsd : 1;
        const openValUsd = p.costUsd * Math.max(0, markRatio);
        totalPnlUsd += p.realizedUsd + openValUsd - inv;
      }
    }

    const settled = wins + losses;
    const winRate = settled > 0 ? (wins / settled) * 100 : 0;
    const roi = investedUsd > 0 ? (totalPnlUsd / investedUsd) * 100 : 0;
    return { w, trades: mine.length, wins, losses, rugs, investedUsd, totalPnlUsd, winRate, roi };
  });

  stats.sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);

  const lines = [
    "🏆 *Wallet Copy Leaderboard*",
    "_Ranked by real PnL from copied positions (wins, losses & rugs):_",
    ""
  ];
  stats.forEach((s, idx) => {
    const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : "•";
    const sign = s.totalPnlUsd >= 0 ? "+" : "";
    const spec = CHAINS[s.w.chain];
    lines.push(
      `${medal} *${escapeMd(s.w.alias)}* (${spec.shortBadge})` +
        `\n   PnL: *${sign}${formatUsd(s.totalPnlUsd)}* (${signedPct(s.roi)})` +
        ` • Trades: *${s.trades}* (${s.wins}W / ${s.losses}L${s.rugs > 0 ? ` / ${s.rugs}💀` : ""}) • WR: *${s.winRate.toFixed(0)}%*`
    );
  });

  return lines.join("\n");
}

export function signedPct(val: number): string {
  if (!Number.isFinite(val)) return "0.0%";
  return `${val >= 0 ? "+" : ""}${val.toFixed(1)}%`;
}

export function formatShortTokenLabel(chain: ChainKey, symbol: string, address: string): string {
  return `${CHAINS[chain].shortBadge} $${symbol} (${shortAddress(address, 4, 4)})`;
}
