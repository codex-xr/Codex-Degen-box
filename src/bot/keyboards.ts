import { InlineKeyboard } from "grammy";
import { CHAIN_LIST, ChainKey, CHAINS, EVM_CHAIN_KEYS, shortAddress } from "../chains/registry.js";
import { PnlTheme, PositionRow, UserSettings, WatchedWalletRow } from "../db/userVault.js";
import { formatShortTokenLabel, shortChainCode } from "./formatters.js";

function packCallback(stateless: string, legacyFallback: string): string {
  return Buffer.byteLength(stateless, "utf8") <= 64 ? stateless : legacyFallback;
}

export type TokenRefResolver = (chain: ChainKey, address: string) => string;

export function buildHomeKeyboard(isAdmin: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("💰 Funds & Balance", "nav:funds")
    .text("⚡ Buy / Scan Token", "nav:scan")
    .row()
    .text("📈 Positions & Orders", "nav:positions")
    .text("📜 History & PnL Cards", "nav:history")
    .row()
    .text("👁️ Watch Wallets (Copy)", "nav:watchers")
    .text("📊 Weekly Alpha Report", "nav:report")
    .row()
    .text("🕵️ Investigate Any Wallet", "det:ask")
    .text("⚙️ Settings", "nav:settings")
    .row()
    .text("❓ How It Works", "nav:help");

  if (isAdmin) {
    kb.text("🔑 Admin Panel (Invite Codes)", "nav:admin");
  }
  return kb;
}

export function buildFundsKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const c of CHAIN_LIST) {
    kb.text(`${c.emoji} Add / Edit ${c.name}`, `funds:pick:${c.key}`).row();
  }
  kb.text("🏠 Main Menu", "nav:home");
  return kb;
}

export function buildEditChainFundsKeyboard(chain: ChainKey, nativePriceUsd = 0): InlineKeyboard {
  const spec = CHAINS[chain];
  const presets = chain === "solana" ? ["1", "5", "10", "50"] : ["0.1", "0.5", "1", "5"];
  const kb = new InlineKeyboard();
  for (const amt of presets) {
    const num = Number(amt);
    const usdHint =
      nativePriceUsd > 0 ? ` (~$${Math.round(num * nativePriceUsd).toLocaleString("en-US")})` : "";
    kb.text(`+${amt} ${spec.nativeSymbol}${usdHint}`, `funds:add:${chain}:${amt}`);
  }
  kb.row()
    .text("💵 Add by USDT Value", `funds:addusd:${chain}`)
    .text(`➕ Add Exact ${spec.nativeSymbol}`, `funds:addnative:${chain}`)
    .row()
    .text(`✏️ Set Exact Total`, `funds:custom:${chain}`)
    .text("🗑️ Reset to 0", `funds:set:${chain}:0`)
    .row()
    .text("⬅️ Back", "nav:funds");
  return kb;
}

export function buildTokenTradeKeyboard(
  chain: ChainKey,
  tokenAddress: string,
  refId: string
): InlineKeyboard {
  const spec = CHAINS[chain];
  const sc = shortChainCode(chain);
  const kb = new InlineKeyboard();
  for (const amt of spec.defaultBuyPresets) {
    kb.text(`Buy ${amt} ${spec.nativeSymbol}`, packCallback(`b:${sc}:${tokenAddress}:${amt}`, `buy:${refId}:${amt}`));
  }
  kb.row()
    .text("💵 Buy by USDT Value", packCallback(`bu:${sc}:${tokenAddress}`, `buyusd:${refId}`))
    .text(`✏️ Buy Custom ${spec.nativeSymbol}`, packCallback(`bc:${sc}:${tokenAddress}`, `buycustom:${refId}`))
    .row()
    .text("🎯 Limit Buy", packCallback(`lb:${sc}:${tokenAddress}`, `limitbuy:${refId}`))
    .text("🔁 DCA Buy", packCallback(`db:${sc}:${tokenAddress}`, `dcabuy:${refId}`))
    .row()
    .text("🔄 Refresh", packCallback(`rf:${sc}:${tokenAddress}`, `refreshscan:${refId}`))
    .text("📈 Positions", "nav:positions")
    .row()
    .text("🏠 Home", "nav:home");

  return kb;
}

export function buildDisambiguateChainKeyboard(
  chains: ChainKey[],
  refByChain: Map<ChainKey, string>,
  address?: string
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const c of chains) {
    const spec = CHAINS[c];
    const refId = refByChain.get(c);
    const stateless = address ? `rf:${shortChainCode(c)}:${address}` : "";
    const cb = stateless && Buffer.byteLength(stateless, "utf8") <= 64 ? stateless : refId ? `refreshscan:${refId}` : "";
    if (cb) {
      kb.text(`${spec.emoji} ${spec.name}`, cb);
    }
  }
  kb.row().text("🏠 Main Menu", "nav:home");
  return kb;
}

export function buildPositionsKeyboard(positions: PositionRow[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of positions.slice(0, 10)) {
    kb.text(formatShortTokenLabel(p.chain, p.tokenSymbol, p.tokenAddress), `pos:view:${p.id}`).row();
  }
  kb.text("🎯 Active Auto-Orders", "nav:orders")
    .text("🔄 Refresh", "nav:positions")
    .row()
    .text("🏠 Main Menu", "nav:home");
  return kb;
}

export function buildPositionDetailKeyboard(positionId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Sell 25%", `sell:${positionId}:25`)
    .text("Sell 50%", `sell:${positionId}:50`)
    .text("Sell 100%", `sell:${positionId}:100`)
    .row()
    .text("✏️ Sell Exact Amount", `sellcustom:${positionId}`)
    .text("🖼️ PnL Image Card", `pnlcard:${positionId}`)
    .row()
    .text("🎯 Take Profit", `posorder:${positionId}:tp`)
    .text("🛑 Stop Loss", `posorder:${positionId}:sl`)
    .text("📉 Trailing Stop", `posorder:${positionId}:trailing_stop`)
    .row()
    .text("🔄 Refresh", `pos:view:${positionId}`)
    .text("⬅️ Positions", "nav:positions");
}

export function buildHistoryKeyboard(closed: PositionRow[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of closed.slice(0, 8)) {
    const tag = p.status === "rugged" ? "💀" : p.realizedUsd >= p.initialCostUsd ? "🟢" : "🔴";
    kb.text(`${tag} PnL Card: $${p.tokenSymbol} (${CHAINS[p.chain].shortBadge})`, `pnlcard:${p.id}`).row();
  }
  kb.text("🏠 Main Menu", "nav:home");
  return kb;
}

export function buildWatchersKeyboard(watchers: WatchedWalletRow[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const w of watchers.slice(0, 12)) {
    const icon = w.enabled ? "🟢" : "⏸️";
    kb.text(`${icon} ${w.alias} (${CHAINS[w.chain].shortBadge})`, `watch:view:${w.id}`).row();
  }
  kb.text("➕ Watch New Wallet", "watch:add:start")
    .text("🏆 Leaderboard", "watch:board")
    .row()
    .text("🏠 Main Menu", "nav:home");
  return kb;
}

export function buildWatchChainPickKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const c of CHAIN_LIST) {
    kb.text(`${c.emoji} ${c.name}`, `watch:add:chain:${c.key}`).row();
  }
  kb.text("⬅️ Back", "nav:watchers");
  return kb;
}

export function buildWatcherDetailKeyboard(w: WatchedWalletRow): InlineKeyboard {
  return new InlineKeyboard()
    .text(w.enabled ? "⏸️ Pause Watching" : "▶️ Resume Watching", `watch:toggle:${w.id}:enabled`)
    .text("✏️ Rename Wallet", `watch:rename:${w.id}`)
    .row()
    .text("💵 Copy Amount", `watch:editamt:${w.id}`)
    .text("🔍 Weekly Report", `report:wallet:${w.id}:7`)
    .row()
    .text(`🚨 Funding Alerts: ${w.transferAlerts ? "ON" : "OFF"}`, `watch:toggle:${w.id}:transferAlerts`)
    .text(`🔁 Mirror Sells: ${w.mirrorSells ? "ON" : "OFF"}`, `watch:toggle:${w.id}:mirrorSells`)
    .row()
    .text(`📉 Sell Match: ${w.sellMode === "proportional" ? "Proportional" : "Full 100%"}`, `watch:toggle:${w.id}:sellMode`)
    .text(`🚀 Dev Snipe: ${w.snipeDevLaunches ? "ON" : "OFF"}`, `watch:toggle:${w.id}:snipeDevLaunches`)
    .row()
    .text(`🛡️ Block Risky: ${w.blockRisky ? "ON" : "OFF"}`, `watch:toggle:${w.id}:blockRisky`)
    .text(`⚡ Skip Held: ${w.skipIfHeld ? "ON" : "OFF"}`, `watch:toggle:${w.id}:skipIfHeld`)
    .row()
    .text(
      `⏱️ Sim: ${w.simMode === "realistic" ? "Realistic" : "Ideal"}`,
      `watch:toggle:${w.id}:simMode`
    )
    .text("🎯 Set Auto TP/SL", `watch:filter:${w.id}:tp_sl`)
    .row()
    .text(
      `📈 Trail Stop: ${w.autoTrailingPct ? `${w.autoTrailingPct}%` : "Off"}`,
      `watch:filter:${w.id}:trail`
    )
    .text("📏 Min MC", `watch:filter:${w.id}:min_mc`)
    .row()
    .text("📏 Max MC", `watch:filter:${w.id}:max_mc`)
    .text("💧 Min Liq", `watch:filter:${w.id}:min_liq`)
    .row()
    .text("🗑️ Delete Watcher", `watch:del:${w.id}`)
    .text("⬅️ All Watched", "nav:watchers");
}

export function buildReportKeyboard(wallets: WatchedWalletRow[] = []): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const w of wallets.slice(0, 12)) {
    kb.text(`${CHAINS[w.chain].emoji} ${w.alias} (${CHAINS[w.chain].shortBadge})`, `report:wallet:${w.id}:7`).row();
  }
  kb.text("🕵️ Investigate Any Address", "det:ask")
    .row()
    .text("📋 Overall Vault Summary (7d)", "report:run:7")
    .text("📆 30d Overall", "report:run:30")
    .row()
    .text("🏠 Main Menu", "nav:home");
  return kb;
}

export function buildWalletReportKeyboard(params: {
  walletId: number;
  chain?: ChainKey;
  address?: string;
  days: number;
  cardRefId: string;
  buddyRefs: Array<{ address: string; roleBadge: string; refId: string }>;
}): InlineKeyboard {
  const sc = params.chain ? shortChainCode(params.chain) : "";
  const kb = new InlineKeyboard()
    .text(params.days === 1 ? "• 24h •" : "⚡ 24h", `report:wallet:${params.walletId}:1`)
    .text(params.days === 7 ? "• 7d •" : "📅 7d", `report:wallet:${params.walletId}:7`)
    .text(params.days === 30 ? "• 30d •" : "📆 30d", `report:wallet:${params.walletId}:30`)
    .row()
    .text(
      "🖼️ Detective Card (PNG)",
      sc && params.address
        ? packCallback(`dc:${sc}:${params.address}`, `det:card:${params.cardRefId}`)
        : `det:card:${params.cardRefId}`
    )
    .row();

  for (const b of params.buddyRefs.slice(0, 3)) {
    const short = shortAddress(b.address, 4, 4);
    kb.text(
      `🔍 Check ${short}`,
      sc ? packCallback(`dg:${sc}:${b.address}`, `det:go:${b.refId}`) : `det:go:${b.refId}`
    )
      .text(
        `👁️ Watch ${short}`,
        sc ? packCallback(`dw:${sc}:${b.address}`, `det:watch:${b.refId}`) : `det:watch:${b.refId}`
      )
      .row();
  }

  kb.text("⬅️ Pick Another Wallet", "nav:report").text("🏠 Main Menu", "nav:home");
  return kb;
}

export function buildDetectiveKeyboard(params: {
  cardRefId: string;
  watchRefId: string;
  chain: ChainKey;
  address: string;
  days: number;
  buddyRefs: Array<{ address: string; refId: string }>;
}): InlineKeyboard {
  const sc = shortChainCode(params.chain);
  const kb = new InlineKeyboard()
    .text("🖼️ Detective Card (PNG)", packCallback(`dc:${sc}:${params.address}`, `det:card:${params.cardRefId}`))
    .text("👁️ Watch This Wallet", packCallback(`dw:${sc}:${params.address}`, `det:watch:${params.watchRefId}`))
    .row()
    .text(
      params.days === 1 ? "• 24h •" : "⚡ 24h",
      packCallback(`dd:${sc}:${params.address}:1`, `det:days:${params.cardRefId}:1`)
    )
    .text(
      params.days === 7 ? "• 7d •" : "📅 7d",
      packCallback(`dd:${sc}:${params.address}:7`, `det:days:${params.cardRefId}:7`)
    )
    .text(
      params.days === 30 ? "• 30d •" : "📆 30d",
      packCallback(`dd:${sc}:${params.address}:30`, `det:days:${params.cardRefId}:30`)
    )
    .row();

  if (CHAINS[params.chain].vm === "evm") {
    for (const c of EVM_CHAIN_KEYS) {
      const label = c === params.chain ? `• ${CHAINS[c].shortBadge} •` : `${CHAINS[c].emoji} ${CHAINS[c].shortBadge}`;
      kb.text(label, packCallback(`de:${sc}:${params.address}:${shortChainCode(c)}`, `det:evm:${params.cardRefId}:${c}`));
    }
    kb.row();
  }

  for (const b of params.buddyRefs.slice(0, 3)) {
    const short = shortAddress(b.address, 4, 4);
    kb.text(`🔍 ${short}`, packCallback(`dg:${sc}:${b.address}`, `det:go:${b.refId}`))
      .text(`👁️ Watch ${short}`, packCallback(`dw:${sc}:${b.address}`, `det:watch:${b.refId}`))
      .row();
  }

  kb.text("📊 Wallet Reports", "nav:report").text("🏠 Main Menu", "nav:home");
  return kb;
}

export function buildSettingsKeyboard(settings: UserSettings): InlineKeyboard {
  return new InlineKeyboard()
    .text(`💨 Slippage: ${(settings.slippageBps / 100).toFixed(1)}%`, "set:slippage")
    .text(
      `⏱️ Speed: ${settings.simMode === "realistic" ? "Realistic" : "Instant"}`,
      "set:toggle:simMode"
    )
    .row()
    .text(`🟣 Sol Priority Fee: ${settings.priorityFeeSol}`, "set:fee:solana")
    .text(`🔵 EVM Gas Fee: ${settings.evmGasEth}`, "set:fee:base")
    .row()
    .text(
      `🔔 Copy Alerts: ${settings.copyNotify ? "ON" : "OFF"}`,
      "set:toggle:copyNotify"
    )
    .text(
      `⏭️ Skip Alerts: ${settings.notifySkips ? "ON" : "OFF"}`,
      "set:toggle:notifySkips"
    )
    .row()
    .text(
      `📊 Weekly Auto-Report: ${settings.weeklyReportEnabled ? "ON" : "OFF"}`,
      "set:toggle:weeklyReport"
    )
    .row()
    .text("🎨 Customize PnL Card", "nav:pnlstudio")
    .text("🖼️ Preview PnL Card", "set:previewcard")
    .row()
    .text("🏠 Main Menu", "nav:home");
}

export function buildPnlStudioKeyboard(settings: UserSettings): InlineKeyboard {
  const themes: PnlTheme[] = ["cyber", "solana", "robinhood", "gold"];
  const nextTheme = themes[(themes.indexOf(settings.pnlTheme) + 1) % themes.length];
  const kb = new InlineKeyboard()
    .text(`🎨 Theme: ${settings.pnlTheme.toUpperCase()}`, `pnl:theme:${nextTheme}`)
    .text(`🖌️ Accent: ${settings.pnlAccentHex ?? "Auto"}`, "pnl:accent:menu")
    .row()
    .text(
      `🙈 Hide Bag Size: ${settings.pnlHideAmounts ? "ON" : "OFF"}`,
      "set:toggle:pnlHideAmounts"
    )
    .row()
    .text("🖼️ Upload Background Photo", "pnl:bg:ask");
  if (settings.hasPnlBg) {
    kb.text("🗑️ Remove Photo", "pnl:bg:clear");
  }
  return kb
    .row()
    .text("🖼️ Preview Sample PnL Card", "set:previewcard")
    .row()
    .text("⬅️ Back to Settings", "nav:settings")
    .text("🏠 Main Menu", "nav:home");
}

export function buildAccentColorKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔵 Electric Blue", "pnl:accent:set:#38BDF8")
    .text("🟢 Neon Green", "pnl:accent:set:#22C55E")
    .text("💜 Purple", "pnl:accent:set:#A855F7")
    .row()
    .text("🟡 Gold", "pnl:accent:set:#FBBF24")
    .text("🔴 Crimson", "pnl:accent:set:#F43F5E")
    .text("🩷 Hot Pink", "pnl:accent:set:#EC4899")
    .row()
    .text("⚪ White", "pnl:accent:set:#FFFFFF")
    .text("✏️ Custom Color", "pnl:accent:custom")
    .text("🔄 Theme Default", "pnl:accent:clear")
    .row()
    .text("⬅️ Back", "nav:pnlstudio");
}

export function buildAdminKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🎟️ Create 1-Person Invite Pass", "admin:gencode:1")
    .row()
    .text("👥 Create Group Pass (Up to 10)", "admin:gencode:10")
    .row()
    .text("📋 Active Invite Passes", "admin:codes")
    .text("👤 Member List", "admin:members")
    .row()
    .text("🏠 Main Menu", "nav:home");
}
