import { InlineKeyboard } from "grammy";
import { CHAIN_LIST, ChainKey, CHAINS } from "../chains/registry.js";
import { PnlTheme, PositionRow, UserSettings, WatchedWalletRow } from "../db/userVault.js";
import { formatShortTokenLabel } from "./formatters.js";

export type TokenRefResolver = (chain: ChainKey, address: string) => string;

export function buildHomeKeyboard(isAdmin: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("💰 Virtual Funds", "nav:funds")
    .text("⚡ Buy / Scan Token", "nav:scan")
    .row()
    .text("📈 Positions & Orders", "nav:positions")
    .text("📜 History & PnL Cards", "nav:history")
    .row()
    .text("👁️ Watch Wallets (Copy)", "nav:watchers")
    .text("📊 Weekly Alpha Report", "nav:report")
    .row()
    .text("⚙️ Settings", "nav:settings")
    .text("❓ How It Works", "nav:help");

  if (isAdmin) {
    kb.row().text("🔑 Admin Panel (Invite Codes)", "nav:admin");
  }
  return kb;
}

export function buildFundsKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const c of CHAIN_LIST) {
    kb.text(`${c.emoji} Edit ${c.name}`, `funds:pick:${c.key}`).row();
  }
  kb.text("🏠 Main Menu", "nav:home");
  return kb;
}

export function buildEditChainFundsKeyboard(chain: ChainKey): InlineKeyboard {
  const spec = CHAINS[chain];
  const presets = chain === "solana" ? ["1", "5", "10", "50"] : ["0.1", "0.5", "1", "5"];
  const kb = new InlineKeyboard();
  for (const amt of presets) {
    kb.text(`${amt} ${spec.nativeSymbol}`, `funds:set:${chain}:${amt}`);
  }
  kb.row()
    .text("✏️ Type Exact Amount (Any Decimal)", `funds:custom:${chain}`)
    .row()
    .text("🗑️ Reset to 0", `funds:set:${chain}:0`)
    .text("⬅️ Back", "nav:funds");
  return kb;
}

export function buildTokenTradeKeyboard(
  chain: ChainKey,
  tokenAddress: string,
  refId: string
): InlineKeyboard {
  const spec = CHAINS[chain];
  const kb = new InlineKeyboard();
  for (const amt of spec.defaultBuyPresets) {
    kb.text(`Buy ${amt} ${spec.nativeSymbol}`, `buy:${refId}:${amt}`);
  }
  kb.row()
    .text(`✏️ Buy Custom ${spec.nativeSymbol}`, `buycustom:${refId}`)
    .text("🎯 Limit Buy", `limitbuy:${refId}`)
    .row()
    .text("🔁 DCA Buy", `dcabuy:${refId}`)
    .text("🔄 Refresh", `refreshscan:${refId}`)
    .row()
    .text("📈 Positions", "nav:positions")
    .text("🏠 Home", "nav:home");

  void tokenAddress;
  return kb;
}

export function buildDisambiguateChainKeyboard(
  chains: ChainKey[],
  refByChain: Map<ChainKey, string>
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const c of chains) {
    const spec = CHAINS[c];
    const refId = refByChain.get(c);
    if (refId) {
      kb.text(`${spec.emoji} ${spec.name}`, `refreshscan:${refId}`);
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
    .text("💵 Change Copy Amount", `watch:editamt:${w.id}`)
    .row()
    .text(`🔁 Mirror Sells: ${w.mirrorSells ? "ON" : "OFF"}`, `watch:toggle:${w.id}:mirrorSells`)
    .text(`🛡️ Block Risky: ${w.blockRisky ? "ON" : "OFF"}`, `watch:toggle:${w.id}:blockRisky`)
    .row()
    .text(`⚡ Skip Held: ${w.skipIfHeld ? "ON" : "OFF"}`, `watch:toggle:${w.id}:skipIfHeld`)
    .text(
      `⏱️ Sim: ${w.simMode === "realistic" ? "Realistic" : "Ideal"}`,
      `watch:toggle:${w.id}:simMode`
    )
    .row()
    .text("📏 Min MC", `watch:filter:${w.id}:min_mc`)
    .text("📏 Max MC", `watch:filter:${w.id}:max_mc`)
    .text("💧 Min Liq", `watch:filter:${w.id}:min_liq`)
    .row()
    .text("🎯 Set Auto TP/SL", `watch:filter:${w.id}:tp_sl`)
    .text("🗑️ Delete Watcher", `watch:del:${w.id}`)
    .row()
    .text("⬅️ All Watched Wallets", "nav:watchers");
}

export function buildReportKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📅 Generate 7-Day Alpha Report", "report:run:7")
    .row()
    .text("⚡ 24-Hour Report", "report:run:1")
    .text("📆 30-Day Report", "report:run:30")
    .row()
    .text("🏠 Main Menu", "nav:home");
}

export function buildSettingsKeyboard(settings: UserSettings): InlineKeyboard {
  const themes: PnlTheme[] = ["cyber", "solana", "robinhood", "gold"];
  const nextTheme = themes[(themes.indexOf(settings.pnlTheme) + 1) % themes.length];
  return new InlineKeyboard()
    .text(`💨 Slippage: ${(settings.slippageBps / 100).toFixed(1)}%`, "set:slippage")
    .text(
      `⏱️ Sim Mode: ${settings.simMode === "realistic" ? "Realistic" : "Ideal"}`,
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
      `📊 Weekly Auto-Report: ${settings.weeklyReportEnabled ? "ON" : "OFF"}`,
      "set:toggle:weeklyReport"
    )
    .row()
    .text(`🎨 Card Theme: ${settings.pnlTheme.toUpperCase()}`, `set:theme:${nextTheme}`)
    .text("🖼️ Preview Sample PnL Card", "set:previewcard")
    .row()
    .text("🏠 Main Menu", "nav:home");
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
