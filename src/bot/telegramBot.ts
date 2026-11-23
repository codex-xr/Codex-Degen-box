import crypto from "node:crypto";
import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import {
  ChainKey,
  CHAINS,
  detectChainFromAddress,
  isChainKey,
  isValidAddressFormat,
  normalizeAddress,
  shortAddress
} from "../chains/registry.js";
import { AppConfig } from "../config.js";
import { IAdminDb, IUserVault, IVaultManager, PnlTheme } from "../db/types.js";
import { MarketDataService, TokenSnapshot } from "../services/marketData.js";
import { PnlCardRenderer } from "../services/pnlCard.js";
import { SecurityService } from "../services/security.js";
import { ExecutionResult, TradingEngine } from "../services/tradingEngine.js";
import { WalletWatcherService } from "../services/walletWatcher.js";
import { WeeklyReportService } from "../services/weeklyReport.js";
import { formatExactUnits, formatUsd, parseExactUnits } from "../utils/amounts.js";
import {
  escapeMd,
  formatHomeMessage,
  formatPositionMessage,
  formatTokenScanMessage,
  formatWatchedWalletMessage
} from "./formatters.js";
import {
  buildAdminKeyboard,
  buildDisambiguateChainKeyboard,
  buildEditChainFundsKeyboard,
  buildFundsKeyboard,
  buildHistoryKeyboard,
  buildHomeKeyboard,
  buildPositionDetailKeyboard,
  buildPositionsKeyboard,
  buildReportKeyboard,
  buildSettingsKeyboard,
  buildTokenTradeKeyboard,
  buildWatchChainPickKeyboard,
  buildWatcherDetailKeyboard,
  buildWatchersKeyboard
} from "./keyboards.js";
import { SessionStore } from "./sessionState.js";

export interface BotServices {
  config: AppConfig;
  adminDb: IAdminDb;
  vaultManager: IVaultManager;
  market: MarketDataService;
  security: SecurityService;
  trading: TradingEngine;
  pnlCards: PnlCardRenderer;
  weeklyReports: WeeklyReportService;
  walletWatcher: WalletWatcherService;
}

export function createTelegramBot(services: BotServices): Bot {
  const bot = new Bot(services.config.botToken);
  const sessions = new SessionStore();
  const tokenRefs = new Map<string, { chain: ChainKey; address: string }>();

  const registerTokenRef = (chain: ChainKey, address: string): string => {
    const norm = normalizeAddress(chain, address);
    const id = crypto.createHash("sha256").update(`${chain}:${norm}`).digest("hex").slice(0, 10);
    tokenRefs.set(id, { chain, address: norm });
    if (tokenRefs.size > 4000) {
      const oldest = tokenRefs.keys().next().value;
      if (oldest) tokenRefs.delete(oldest);
    }
    return id;
  };

  const getUserId = (ctx: Context): string | null =>
    ctx.from?.id !== undefined ? String(ctx.from.id) : null;

  const safeReply = async (ctx: Context, text: string, kb?: InlineKeyboard) => {
    try {
      return await ctx.reply(text, {
        parse_mode: "Markdown",
        reply_markup: kb,
        link_preview_options: { is_disabled: true }
      });
    } catch {
      return await ctx.reply(text.replace(/[*_`]/g, ""), {
        reply_markup: kb,
        link_preview_options: { is_disabled: true }
      });
    }
  };

  const safeEditOrReply = async (ctx: Context, text: string, kb?: InlineKeyboard) => {
    if (ctx.callbackQuery?.message) {
      try {
        return await ctx.editMessageText(text, {
          parse_mode: "Markdown",
          reply_markup: kb,
          link_preview_options: { is_disabled: true }
        });
      } catch {
        // Message unchanged or uneditable -> send fresh message
      }
    }
    return safeReply(ctx, text, kb);
  };

  const showHome = async (ctx: Context, telegramId: string, edit = false) => {
    sessions.clear(telegramId);
    const vault = await services.vaultManager.getVault(telegramId);
    const isAdmin = await services.adminDb.isAdmin(telegramId);
    const msg = await formatHomeMessage(vault, isAdmin);
    const kb = buildHomeKeyboard(isAdmin);
    if (edit) await safeEditOrReply(ctx, msg, kb);
    else await safeReply(ctx, msg, kb);
  };

  const requireAuthorized = async (ctx: Context): Promise<{ telegramId: string; vault: IUserVault } | null> => {
    const telegramId = getUserId(ctx);
    if (!telegramId) return null;
    const auth = await services.adminDb.isAuthorized(telegramId);
    if (!auth.authorized) {
      if (auth.user?.isBanned) {
        await safeReply(ctx, "🚫 Your access to this bot has been paused by the admin.");
      } else {
        sessions.set(telegramId, { kind: "await_access_code" });
        await safeReply(
          ctx,
          "🔒 *Private Access Only*\n\nSend your *invite pass code* (for example: `CABAL-XXXX-XXXX`) to unlock your private trading vault."
        );
      }
      return null;
    }
    return { telegramId, vault: await services.vaultManager.getVault(telegramId) };
  };

  const sendTokenCard = async (
    ctx: Context,
    telegramId: string,
    snap: TokenSnapshot,
    edit = false
  ) => {
    const vault = await services.vaultManager.getVault(telegramId);
    const sec = await services.security.checkToken(snap.chain, snap.address);
    const bal = (await vault.getBalance(snap.chain)).balanceAtomic;
    const refId = registerTokenRef(snap.chain, snap.address);
    const text = formatTokenScanMessage(snap, sec, bal);
    const kb = buildTokenTradeKeyboard(snap.chain, snap.address, refId);
    if (edit) await safeEditOrReply(ctx, text, kb);
    else await safeReply(ctx, text, kb);
  };

  const scanAddressInput = async (
    ctx: Context,
    telegramId: string,
    rawAddress: string,
    preferredChain?: ChainKey
  ) => {
    const trimmed = rawAddress.trim();
    const detected = preferredChain ?? detectChainFromAddress(trimmed);
    const snaps = await services.market.lookupToken(detected, trimmed, 2000);

    if (snaps.length === 0) {
      await safeReply(
        ctx,
        "❌ Couldn't find a live trading pool for that token address on *Solana*, *Base*, or *Robinhood Chain*."
      );
      return;
    }

    if (snaps.length === 1) {
      await sendTokenCard(ctx, telegramId, snaps[0]);
      return;
    }

    // Found on multiple EVM chains (e.g., Base and Robinhood Chain)
    const refMap = new Map<ChainKey, string>();
    for (const s of snaps) {
      refMap.set(s.chain, registerTokenRef(s.chain, s.address));
    }
    await safeReply(
      ctx,
      `🔍 Found this token on multiple chains! Which chain do you want to trade on?`,
      buildDisambiguateChainKeyboard(
        snaps.map((s) => s.chain),
        refMap
      )
    );
  };

  const sendPnlCardForPosition = async (ctx: Context, vault: IUserVault, positionId: number) => {
    const pos = await vault.getPositionById(positionId);
    if (!pos) {
      await safeReply(ctx, "❌ Trade not found in your private vault.");
      return;
    }
    const spec = CHAINS[pos.chain];
    const snap = pos.status === "open" ? await services.market.getTokenSnapshot(pos.chain, pos.tokenAddress) : null;
    const currentPrice = snap?.priceUsd ?? pos.lastPriceUsd;
    const currentMc = snap?.mcUsd ?? pos.exitMcUsd ?? pos.entryMcUsd;
    const nativePrice = snap?.nativePriceUsd ?? (await services.market.getNativePriceUsd(pos.chain));

    let pnlUsd = 0;
    let pnlNativeAtomic = 0n;
    let roiPct = 0;

    if (pos.status === "open" && nativePrice > 0) {
      const stats = services.trading.computeUnrealizedStats(pos, currentPrice, nativePrice);
      const totalValueUsd = stats.currentValueUsd + pos.realizedUsd;
      const investedUsd = pos.initialCostUsd > 0 ? pos.initialCostUsd : pos.costUsd;
      pnlUsd = totalValueUsd - investedUsd;
      roiPct = investedUsd > 0 ? (pnlUsd / investedUsd) * 100 : 0;
      pnlNativeAtomic = stats.currentValueNativeAtomic + pos.realizedNativeAtomic - pos.initialCostNativeAtomic;
    } else {
      const investedUsd = pos.initialCostUsd > 0 ? pos.initialCostUsd : pos.costUsd;
      pnlUsd = pos.realizedUsd - investedUsd;
      roiPct = investedUsd > 0 ? (pnlUsd / investedUsd) * 100 : pos.status === "rugged" ? -100 : 0;
      pnlNativeAtomic = pos.realizedNativeAtomic - pos.initialCostNativeAtomic;
    }

    const watchedWallet = pos.copiedWalletId ? await vault.getWatchedWallet(pos.copiedWalletId) : null;
    const sourceLabel = watchedWallet ? `Copied: ${watchedWallet.alias}` : "Manual Trade";
    const settings = await vault.getSettings();
    const traderHandle = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name ?? undefined;

    const png = await services.pnlCards.renderPng({
      theme: settings.pnlTheme,
      chain: pos.chain,
      tokenSymbol: pos.tokenSymbol,
      sourceLabel,
      roiPct,
      pnlNativeAtomic,
      pnlUsd,
      investedNativeAtomic: pos.initialCostNativeAtomic,
      entryMcUsd: pos.entryMcUsd,
      currentOrExitMcUsd: currentMc,
      holdDurationMs: (pos.closedAt ?? Date.now()) - pos.openedAt,
      statusLabel: pos.status.toUpperCase(),
      traderHandle
    });

    await ctx.replyWithPhoto(new InputFile(png, `pnl-${pos.tokenSymbol}.png`), {
      caption: `🖼️ *${pos.tokenSymbol}* (${spec.name}) • ${roiPct >= 0 ? "+" : ""}${roiPct.toFixed(1)}% (${
        pnlUsd >= 0 ? "+" : ""
      }${formatUsd(pnlUsd)})`,
      parse_mode: "Markdown"
    });
  };

  // === Commands ===

  bot.command("start", async (ctx) => {
    const telegramId = getUserId(ctx);
    if (!telegramId) return;

    const payload = ctx.match?.trim();
    const auth = await services.adminDb.isAuthorized(telegramId);

    if (!auth.authorized) {
      if (auth.user?.isBanned) {
        await safeReply(ctx, "🚫 Your access to this bot has been disabled by the admin.");
        return;
      }
      if (payload) {
        const res = await services.adminDb.redeemCode({
          code: payload,
          telegramId,
          username: ctx.from?.username ?? null,
          firstName: ctx.from?.first_name ?? null
        });
        if (!res.ok) {
          sessions.set(telegramId, { kind: "await_access_code" });
          await safeReply(ctx, `❌ ${res.reason}\n\nPlease send a valid invite pass code:`);
          return;
        }
        sessions.clear(telegramId);
        await services.vaultManager.getVault(telegramId); // Initialize private DB immediately
        await safeReply(
          ctx,
          `🎉 *Welcome! Your private trading vault is now created.*\nOnly you can see your balances, trades, watched wallets, and reports.`
        );
        await showHome(ctx, telegramId);
        return;
      }

      sessions.set(telegramId, { kind: "await_access_code" });
      await safeReply(
        ctx,
        `🔒 *Welcome to Codex Degen Box!*\n\nThis is a private demo trading bot.\nPlease send your *invite pass code* (given to you by the admin) to get started:`
      );
      return;
    }

    await showHome(ctx, telegramId);
  });

  bot.command("menu", async (ctx) => {
    const ok = await requireAuthorized(ctx);
    if (!ok) return;
    await showHome(ctx, ok.telegramId);
  });

  bot.command("funds", async (ctx) => {
    const ok = await requireAuthorized(ctx);
    if (!ok) return;
    await showFundsScreen(ok.vault, ctx, false);
  });

  bot.command("positions", async (ctx) => {
    const ok = await requireAuthorized(ctx);
    if (!ok) return;
    await showPositionsScreen(ok.vault, ctx, false);
  });

  bot.command("watch", async (ctx) => {
    const ok = await requireAuthorized(ctx);
    if (!ok) return;
    await showWatchersScreen(ok.vault, ctx, false);
  });

  bot.command("report", async (ctx) => {
    const ok = await requireAuthorized(ctx);
    if (!ok) return;
    await safeReply(ctx, "📊 *Weekly Alpha & Pattern Report*\nPick a time window:", buildReportKeyboard());
  });

  bot.command("settings", async (ctx) => {
    const ok = await requireAuthorized(ctx);
    if (!ok) return;
    const s = await ok.vault.getSettings();
    await safeReply(ctx, "⚙️ *Your Trading & Simulation Settings*", buildSettingsKeyboard(s));
  });

  bot.command("buy", async (ctx) => {
    const ok = await requireAuthorized(ctx);
    if (!ok) return;
    const parts = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      sessions.set(ok.telegramId, { kind: "await_buy_token_ca" });
      await safeReply(ctx, "⚡ Paste the *token address* you want to scan or buy:");
      return;
    }
    if (parts.length === 1) {
      await scanAddressInput(ctx, ok.telegramId, parts[0]);
      return;
    }
    const [addr, amtStr] = parts;
    const snaps = await services.market.lookupToken(detectChainFromAddress(addr), addr);
    if (snaps.length === 0) {
      await safeReply(ctx, "❌ Token pool not found.");
      return;
    }
    const snap = snaps[0];
    try {
      const spec = CHAINS[snap.chain];
      const atomic = parseExactUnits(amtStr, spec.nativeDecimals);
      const res = await services.trading.executeBuy(ok.vault, {
        chain: snap.chain,
        tokenAddress: snap.address,
        spendNativeAtomic: atomic,
        sourceType: "manual",
        snapshotOverride: snap
      });
      await sendBuySuccess(ctx, res);
    } catch (err) {
      await safeReply(ctx, `❌ ${(err as Error).message}`);
    }
  });

  bot.command("pnl", async (ctx) => {
    const ok = await requireAuthorized(ctx);
    if (!ok) return;
    const open = await ok.vault.listOpenPositions();
    const closed = open.length === 0 ? await ok.vault.listClosedPositions(1) : [];
    const pos = open[0] ?? closed[0];
    if (!pos) {
      await safeReply(ctx, "No trades found yet! Make a paper trade first.");
      return;
    }
    await sendPnlCardForPosition(ctx, ok.vault, pos.id);
  });

  bot.command("admin", async (ctx) => {
    const ok = await requireAuthorized(ctx);
    if (!ok) return;
    if (!(await services.adminDb.isAdmin(ok.telegramId))) {
      await safeReply(ctx, "🔒 Admin access only.");
      return;
    }
    await showAdminScreen(ctx, false);
  });

  bot.command("gencode", async (ctx) => {
    const ok = await requireAuthorized(ctx);
    if (!ok) return;
    if (!(await services.adminDb.isAdmin(ok.telegramId))) {
      await safeReply(ctx, "🔒 Admin access only.");
      return;
    }
    const label = ctx.match?.trim() || undefined;
    const code = await services.adminDb.generateAccessCode({
      createdBy: ok.telegramId,
      label,
      maxUses: 1
    });
    await safeReply(
      ctx,
      `🎟️ *New Single-Use Invite Code Ready!*\n\nCode: \`${code.code}\`${
        label ? `\nFor: *${escapeMd(label)}*` : ""
      }\n\nTell your friend to open the bot, tap Start, and send this code!`
    );
  });

  bot.command("help", async (ctx) => {
    const ok = await requireAuthorized(ctx);
    if (!ok) return;
    await showHelpScreen(ctx, false);
  });

  // === Helper Screens ===

  const showFundsScreen = async (vault: IUserVault, ctx: Context, edit: boolean) => {
    const balances = await vault.getBalances();
    const lines = [
      "💰 *Your Virtual Play Money*",
      "_Pick any chain below to type in your exact starting balance (even tiny decimals!)._",
      ""
    ];
    for (const b of balances) {
      const spec = CHAINS[b.chain];
      lines.push(`${spec.emoji} *${spec.name}:* \`${formatExactUnits(b.balanceAtomic, spec.nativeDecimals)} ${spec.nativeSymbol}\``);
    }
    const kb = buildFundsKeyboard();
    if (edit) await safeEditOrReply(ctx, lines.join("\n"), kb);
    else await safeReply(ctx, lines.join("\n"), kb);
  };

  const showPositionsScreen = async (vault: IUserVault, ctx: Context, edit: boolean) => {
    const open = await vault.listOpenPositions();
    if (open.length === 0) {
      const msg = "📈 *Open Positions*\n\nYou have no open paper trades right now.\nPaste any token address in chat to scan & buy!";
      const kb = new InlineKeyboard()
        .text("🎯 Active Auto-Orders", "nav:orders")
        .text("🏠 Main Menu", "nav:home");
      if (edit) await safeEditOrReply(ctx, msg, kb);
      else await safeReply(ctx, msg, kb);
      return;
    }

    const lines = ["📈 *Your Open Paper Trades*", "_Tap any coin below to sell, set auto take-profit/stop-loss, or get a PnL picture card._", ""];
    for (const p of open.slice(0, 10)) {
      const spec = CHAINS[p.chain];
      const estPnlPct =
        p.entryPriceUsd > 0 ? ((p.lastPriceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100 : 0;
      lines.push(
        `${estPnlPct >= 0 ? "🟢" : "🔴"} *$${escapeMd(p.tokenSymbol)}* (${spec.shortBadge}) • ${
          estPnlPct >= 0 ? "+" : ""
        }${estPnlPct.toFixed(1)}% • Cost ${formatUsd(p.costUsd)}`
      );
    }
    const kb = buildPositionsKeyboard(open);
    if (edit) await safeEditOrReply(ctx, lines.join("\n"), kb);
    else await safeReply(ctx, lines.join("\n"), kb);
  };

  const showWatchersScreen = async (vault: IUserVault, ctx: Context, edit: boolean) => {
    const watchers = await vault.listWatchedWallets(false);
    const lines = [
      "👁️ *Instant Wallet Copy-Trading*",
      "_Watch any wallet on Solana, Base, or Robinhood Chain. The exact second it trades, your virtual vault copies it automatically!_",
      ""
    ];
    if (watchers.length === 0) {
      lines.push("You aren't watching any wallets yet. Tap *Watch New Wallet* below to start!");
    } else {
      for (const w of watchers) {
        const spec = CHAINS[w.chain];
        const amt =
          w.copyMode === "fixed"
            ? `${formatExactUnits(w.copyAmountAtomic, spec.nativeDecimals)} ${spec.nativeSymbol}`
            : `${w.copyPercent}% balance`;
        lines.push(
          `${w.enabled ? "🟢" : "⏸️"} *${escapeMd(w.alias)}* (${spec.shortBadge}) — \`${amt}\` • \`${shortAddress(w.address)}\``
        );
      }
    }
    const kb = buildWatchersKeyboard(watchers);
    if (edit) await safeEditOrReply(ctx, lines.join("\n"), kb);
    else await safeReply(ctx, lines.join("\n"), kb);
  };

  const showAdminScreen = async (ctx: Context, edit: boolean) => {
    const activeCount = await services.adminDb.countActiveUsers();
    const activeCodes = (await services.adminDb.listAccessCodes(false)).length;
    const text =
      `🔑 *Admin Control Panel*\n\n` +
      `👥 Cabal Members: *${activeCount} / ${services.config.maxCabalUsers}*\n` +
      `🎟️ Active Unused Passes: *${activeCodes}*\n\n` +
      `_Note: Every user's trades, funds, and watched wallets stay 100% private in their own separate vault._`;
    const kb = buildAdminKeyboard();
    if (edit) await safeEditOrReply(ctx, text, kb);
    else await safeReply(ctx, text, kb);
  };

  const showHelpScreen = async (ctx: Context, edit: boolean) => {
    const text =
      `❓ *How To Use Codex Degen Box (Simple Guide)*\n\n` +
      `1️⃣ *Add Play Money:* Tap *Virtual Funds*, pick Solana, Base, or Robinhood Chain, and type any starting amount you want.\n` +
      `2️⃣ *Buy Any Coin:* Just paste any coin address right into this chat! You'll get a safety check and quick Buy buttons.\n` +
      `3️⃣ *Copy Any Wallet Live:* Tap *Watch Wallets*, paste a smart trader's wallet, and pick how much play money to spend every time they buy.\n` +
      `4️⃣ *Get Your Weekly Report:* Tap *Weekly Alpha Report* to see which wallet made the most profit, which chain worked best, and the exact pattern behind winning trades!\n` +
      `5️⃣ *Flex PnL Cards:* Tap *PnL Image Card* on any trade to get a shareable picture card.\n\n` +
      `*Quick Commands:* \`/menu\`, \`/funds\`, \`/positions\`, \`/watch\`, \`/report\`, \`/pnl\`, \`/settings\``;
    const kb = new InlineKeyboard().text("🏠 Main Menu", "nav:home");
    if (edit) await safeEditOrReply(ctx, text, kb);
    else await safeReply(ctx, text, kb);
  };

  const sendBuySuccess = async (ctx: Context, res: ExecutionResult) => {
    const spec = CHAINS[res.chain];
    const msg =
      `✅ *Paper Buy Complete!* (${spec.name})\n\n` +
      `🪙 Bought: *${formatExactUnits(res.qtyTokenAtomic, res.tokenDecimals, 4)} $${escapeMd(res.tokenSymbol)}*\n` +
      `💵 Spent: \`${formatExactUnits(res.nativeAmountAtomic, spec.nativeDecimals)} ${spec.nativeSymbol}\`\n` +
      `📊 Entry MC: *${formatUsd(res.mcUsd)}* (Impact: ${(res.slippageImpactBps / 100).toFixed(2)}%)\n` +
      `💰 Remaining ${spec.shortBadge}: \`${formatExactUnits(res.remainingBalanceAtomic, spec.nativeDecimals)} ${spec.nativeSymbol}\``;
    const kb = new InlineKeyboard()
      .text("📈 View Position", `pos:view:${res.positionId}`)
      .text("🖼️ PnL Card", `pnlcard:${res.positionId}`)
      .row()
      .text("🏠 Main Menu", "nav:home");
    await safeReply(ctx, msg, kb);
  };

  const sendSellSuccess = async (ctx: Context, res: ExecutionResult) => {
    const spec = CHAINS[res.chain];
    const sign = res.realizedPnlUsd >= 0 ? "+" : "";
    const msg =
      `${res.side === "rug_writeoff" ? "💀 *Rugged Position Written Off*" : "✅ *Paper Sell Complete!*"} (${spec.name})\n\n` +
      `🪙 Token: *$${escapeMd(res.tokenSymbol)}*\n` +
      `💰 Received: \`${formatExactUnits(res.nativeAmountAtomic, spec.nativeDecimals)} ${spec.nativeSymbol}\`\n` +
      `📈 Realized Profit/Loss: *${sign}${formatUsd(res.realizedPnlUsd)}*\n` +
      `💼 ${spec.shortBadge} Balance Now: \`${formatExactUnits(res.remainingBalanceAtomic, spec.nativeDecimals)} ${spec.nativeSymbol}\``;
    const kb = new InlineKeyboard()
      .text("🖼️ Get PnL Image Card", `pnlcard:${res.positionId}`)
      .row()
      .text("📈 Positions", "nav:positions")
      .text("🏠 Main Menu", "nav:home");
    await safeReply(ctx, msg, kb);
  };

  // === Callback Queries (All Inline Menu Buttons) ===

  bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const ok = await requireAuthorized(ctx);
    if (!ok) return;

    const { telegramId, vault } = ok;
    const data = ctx.callbackQuery.data;
    const parts = data.split(":");

    try {
      // Navigation
      if (data === "nav:home") return await showHome(ctx, telegramId, true);
      if (data === "nav:funds") return await showFundsScreen(vault, ctx, true);
      if (data === "nav:positions") return await showPositionsScreen(vault, ctx, true);
      if (data === "nav:watchers") return await showWatchersScreen(vault, ctx, true);
      if (data === "nav:help") return await showHelpScreen(ctx, true);

      if (data === "nav:scan") {
        sessions.set(telegramId, { kind: "await_buy_token_ca" });
        return await safeReply(
          ctx,
          "⚡ Paste any *token address* from Solana, Base, or Robinhood Chain right now:"
        );
      }

      if (data === "nav:history") {
        const closed = await vault.listClosedPositions(10);
        if (closed.length === 0) {
          return await safeEditOrReply(
            ctx,
            "📜 *Trade History*\n\nNo closed trades yet. Once you sell a coin, it appears here with a 1-tap PnL image card!",
            new InlineKeyboard().text("🏠 Main Menu", "nav:home")
          );
        }
        const lines = ["📜 *Recent Closed Trades*", "_Tap any trade to generate its PNG PnL image card:_", ""];
        for (const p of closed) {
          const invested = p.initialCostUsd > 0 ? p.initialCostUsd : p.costUsd;
          const pnl = p.realizedUsd - invested;
          const sign = pnl >= 0 ? "+" : "";
          lines.push(
            `${p.status === "rugged" ? "💀" : pnl >= 0 ? "🟢" : "🔴"} *$${escapeMd(p.tokenSymbol)}* (${CHAINS[p.chain].shortBadge}) • *${sign}${formatUsd(pnl)}*`
          );
        }
        return await safeEditOrReply(ctx, lines.join("\n"), buildHistoryKeyboard(closed));
      }

      if (data === "nav:orders") {
        const orders = await vault.listActiveOrders();
        if (orders.length === 0) {
          return await safeEditOrReply(
            ctx,
            "🎯 *Active Auto-Orders*\n\nNo active limit buys, take-profits, stop-losses, or DCA orders.",
            new InlineKeyboard().text("⬅️ Positions", "nav:positions").text("🏠 Home", "nav:home")
          );
        }
        const lines = ["🎯 *Active Auto-Orders*", ""];
        const kb = new InlineKeyboard();
        for (const o of orders.slice(0, 10)) {
          lines.push(`• #${o.id} *${o.orderType.toUpperCase()}* on *$${escapeMd(o.tokenSymbol)}* (${CHAINS[o.chain].shortBadge})`);
          kb.text(`❌ Cancel #${o.id} ($${o.tokenSymbol})`, `order:cancel:${o.id}`).row();
        }
        kb.text("⬅️ Positions", "nav:positions").text("🏠 Home", "nav:home");
        return await safeEditOrReply(ctx, lines.join("\n"), kb);
      }

      if (parts[0] === "order" && parts[1] === "cancel") {
        const orderId = Number(parts[2]);
        await vault.setOrderStatus(orderId, "cancelled");
        return await safeReply(ctx, `✅ Cancelled auto-order #${orderId}.`);
      }

      if (data === "nav:report") {
        return await safeEditOrReply(
          ctx,
          "📊 *Weekly Alpha & Pattern Recognition*\n\nPick a time window to generate your private report (top wallets, chains, win patterns & copyability scores):",
          buildReportKeyboard()
        );
      }

      if (data === "nav:settings") {
        return await safeEditOrReply(
          ctx,
          "⚙️ *Trading & Simulation Settings*",
          buildSettingsKeyboard(await vault.getSettings())
        );
      }

      if (data === "nav:admin") {
        if (!(await services.adminDb.isAdmin(telegramId))) return;
        return await showAdminScreen(ctx, true);
      }

      // Funds
      if (parts[0] === "funds" && parts[1] === "pick" && isChainKey(parts[2])) {
        const chain = parts[2];
        const spec = CHAINS[chain];
        const bal = (await vault.getBalance(chain)).balanceAtomic;
        return await safeEditOrReply(
          ctx,
          `${spec.emoji} *${spec.name} Virtual Balance*\nCurrent: \`${formatExactUnits(bal, spec.nativeDecimals)} ${spec.nativeSymbol}\`\n\nPick a quick amount or type your own exact balance (down to ${spec.nativeDecimals} decimals):`,
          buildEditChainFundsKeyboard(chain)
        );
      }

      if (parts[0] === "funds" && parts[1] === "set" && isChainKey(parts[2])) {
        const chain = parts[2];
        const spec = CHAINS[chain];
        const amt = parseExactUnits(parts[3], spec.nativeDecimals);
        await vault.setVirtualFunds(chain, amt, true);
        await safeReply(
          ctx,
          `✅ Set your *${spec.name}* virtual balance to \`${formatExactUnits(amt, spec.nativeDecimals)} ${spec.nativeSymbol}\`!`
        );
        return await showFundsScreen(vault, ctx, false);
      }

      if (parts[0] === "funds" && parts[1] === "custom" && isChainKey(parts[2])) {
        const chain = parts[2];
        const spec = CHAINS[chain];
        sessions.set(telegramId, { kind: "await_set_balance", chain });
        return await safeReply(
          ctx,
          `✏️ Type the exact *${spec.nativeSymbol}* virtual balance you want for *${spec.name}*:\n_(Examples: \`12.5\`, \`0.0025\`, or even \`0.${"0".repeat(spec.nativeDecimals - 1)}1\`)_`
        );
      }

      // Token Trading
      if (parts[0] === "refreshscan") {
        const ref = tokenRefs.get(parts[1]);
        if (!ref) return await safeReply(ctx, "⚠️ Token session expired. Please paste the token address again.");
        const snap = await services.market.getTokenSnapshot(ref.chain, ref.address, 500);
        if (!snap) return await safeReply(ctx, "❌ Could not refresh token data.");
        return await sendTokenCard(ctx, telegramId, snap, true);
      }

      if (parts[0] === "buy") {
        const ref = tokenRefs.get(parts[1]);
        if (!ref) return await safeReply(ctx, "⚠️ Please paste the token address again.");
        const spec = CHAINS[ref.chain];
        const spendAtomic = parseExactUnits(parts[2], spec.nativeDecimals);
        const res = await services.trading.executeBuy(vault, {
          chain: ref.chain,
          tokenAddress: ref.address,
          spendNativeAtomic: spendAtomic,
          sourceType: "manual"
        });
        return await sendBuySuccess(ctx, res);
      }

      if (parts[0] === "buycustom") {
        const ref = tokenRefs.get(parts[1]);
        if (!ref) return await safeReply(ctx, "⚠️ Please paste the token address again.");
        const spec = CHAINS[ref.chain];
        sessions.set(telegramId, {
          kind: "await_custom_buy_amount",
          chain: ref.chain,
          tokenAddress: ref.address
        });
        return await safeReply(
          ctx,
          `✏️ How much virtual *${spec.nativeSymbol}* do you want to spend? (Any decimal allowed)`
        );
      }

      if (parts[0] === "limitbuy") {
        const ref = tokenRefs.get(parts[1]);
        if (!ref) return await safeReply(ctx, "⚠️ Please paste the token address again.");
        const spec = CHAINS[ref.chain];
        sessions.set(telegramId, {
          kind: "await_limit_buy",
          chain: ref.chain,
          tokenAddress: ref.address
        });
        return await safeReply(
          ctx,
          `🎯 *Set Limit Buy*\nSend: \`<target_market_cap_usd> <spend_${spec.nativeSymbol}>\`\nExample: \`50000 0.5\` (buys 0.5 ${spec.nativeSymbol} if Market Cap drops to \$50,000 or below)`
        );
      }

      if (parts[0] === "dcabuy") {
        const ref = tokenRefs.get(parts[1]);
        if (!ref) return await safeReply(ctx, "⚠️ Please paste the token address again.");
        const spec = CHAINS[ref.chain];
        sessions.set(telegramId, {
          kind: "await_dca_buy",
          chain: ref.chain,
          tokenAddress: ref.address
        });
        return await safeReply(
          ctx,
          `🔁 *Set Auto-DCA*\nSend: \`<amount_per_buy> <minutes_between> <number_of_buys>\`\nExample: \`0.2 15 5\` (buys 0.2 ${spec.nativeSymbol} every 15 mins, 5 times)`
        );
      }

      // Position Details & Sells
      if (parts[0] === "pos" && parts[1] === "view") {
        const posId = Number(parts[2]);
        const pos = await vault.getPositionById(posId);
        if (!pos) return await safeReply(ctx, "❌ Position not found.");
        const snap = await services.market.getTokenSnapshot(pos.chain, pos.tokenAddress, 2000);
        if (snap) await vault.updatePositionMark(pos.id, snap.priceUsd, snap.mcUsd);
        const wallet = pos.copiedWalletId ? await vault.getWatchedWallet(pos.copiedWalletId) : null;
        const orders = await vault.listActiveOrders(pos.chain);
        const msg = formatPositionMessage(pos, snap, services.trading, orders, wallet?.alias);
        return await safeEditOrReply(ctx, msg, buildPositionDetailKeyboard(pos.id));
      }

      if (parts[0] === "sell") {
        const posId = Number(parts[1]);
        const pct = Number(parts[2]);
        const res = await services.trading.executeSell(vault, {
          positionId: posId,
          sellPct: pct,
          sourceType: "manual"
        });
        return await sendSellSuccess(ctx, res);
      }

      if (parts[0] === "sellcustom") {
        const posId = Number(parts[1]);
        const pos = await vault.getPositionById(posId);
        if (!pos || pos.status !== "open") return await safeReply(ctx, "❌ Position is no longer open.");
        sessions.set(telegramId, { kind: "await_custom_sell_amount", positionId: posId });
        return await safeReply(
          ctx,
          `✏️ Enter how many *${escapeMd(pos.tokenSymbol)}* tokens to sell, OR enter a percentage like \`33%\`:`
        );
      }

      if (parts[0] === "posorder") {
        const posId = Number(parts[1]);
        const orderType = parts[2] as "tp" | "sl" | "trailing_stop";
        sessions.set(telegramId, { kind: "await_pos_order", positionId: posId, orderType });
        if (orderType === "tp") {
          return await safeReply(ctx, "🎯 Send: `<profit_percent> <sell_percent>`\nExample: `100 50` (when +100% profit, sell 50%!)");
        }
        if (orderType === "sl") {
          return await safeReply(ctx, "🛑 Send: `<loss_percent> <sell_percent>`\nExample: `-40 100` (if down -40%, sell 100%)");
        }
        return await safeReply(ctx, "📉 Send: `<drop_from_peak_percent> <sell_percent>`\nExample: `25 100` (sell 100% if price drops 25% from its highest point)");
      }

      if (parts[0] === "pnlcard") {
        const posId = Number(parts[1]);
        return await sendPnlCardForPosition(ctx, vault, posId);
      }

      // Watched Wallets
      if (data === "watch:add:start") {
        return await safeEditOrReply(
          ctx,
          "👁️ *Watch a New Wallet*\nWhich chain is this wallet trading on?",
          buildWatchChainPickKeyboard()
        );
      }

      if (parts[0] === "watch" && parts[1] === "add" && parts[2] === "chain" && isChainKey(parts[3])) {
        const chain = parts[3];
        sessions.set(telegramId, { kind: "await_watch_address", chain });
        return await safeReply(
          ctx,
          `${CHAINS[chain].emoji} Paste the *${CHAINS[chain].name} wallet address* you want to watch & copy:`
        );
      }

      if (parts[0] === "watch" && parts[1] === "view") {
        const w = await vault.getWatchedWallet(Number(parts[2]));
        if (!w) return await safeReply(ctx, "❌ Watched wallet not found.");
        return await safeEditOrReply(ctx, formatWatchedWalletMessage(w), buildWatcherDetailKeyboard(w));
      }

      if (parts[0] === "watch" && parts[1] === "toggle") {
        const id = Number(parts[2]);
        const field = parts[3];
        const w = await vault.getWatchedWallet(id);
        if (!w) return;
        if (field === "enabled") await vault.updateWatchedWallet(id, { enabled: !w.enabled });
        if (field === "mirrorSells") await vault.updateWatchedWallet(id, { mirrorSells: !w.mirrorSells });
        if (field === "blockRisky") await vault.updateWatchedWallet(id, { blockRisky: !w.blockRisky });
        if (field === "skipIfHeld") await vault.updateWatchedWallet(id, { skipIfHeld: !w.skipIfHeld });
        if (field === "simMode") {
          await vault.updateWatchedWallet(id, {
            simMode: w.simMode === "realistic" ? "ideal" : "realistic"
          });
        }
        await services.walletWatcher.reloadWatchers();
        const updated = (await vault.getWatchedWallet(id))!;
        return await safeEditOrReply(
          ctx,
          formatWatchedWalletMessage(updated),
          buildWatcherDetailKeyboard(updated)
        );
      }

      if (parts[0] === "watch" && parts[1] === "editamt") {
        const walletId = Number(parts[2]);
        const w = await vault.getWatchedWallet(walletId);
        if (!w) return;
        const spec = CHAINS[w.chain];
        sessions.set(telegramId, { kind: "await_edit_watch_amount", walletId });
        return await safeReply(
          ctx,
          `💵 Type the new amount of *${spec.nativeSymbol}* to spend per copied trade (e.g. \`0.25\` or \`0.00005\`), OR a % of your balance like \`10%\`:`
        );
      }

      if (parts[0] === "watch" && parts[1] === "filter") {
        const walletId = Number(parts[2]);
        const field = parts[3] as "min_mc" | "max_mc" | "min_liq" | "tp_sl";
        sessions.set(telegramId, { kind: "await_edit_watch_filter", walletId, field });
        if (field === "tp_sl") {
          return await safeReply(
            ctx,
            "🎯 Send auto Take-Profit % and Stop-Loss % separated by space (e.g., `150 -40`), or `off` to clear:"
          );
        }
        return await safeReply(
          ctx,
          `📏 Send the USD amount (e.g. \`25000\` or \`500000\`), or \`off\` to remove this limit:`
        );
      }

      if (parts[0] === "watch" && parts[1] === "del") {
        const id = Number(parts[2]);
        await vault.deleteWatchedWallet(id);
        await services.walletWatcher.reloadWatchers();
        await safeReply(ctx, "🗑️ Stopped watching that wallet.");
        return await showWatchersScreen(vault, ctx, false);
      }

      // Weekly Report
      if (parts[0] === "report" && parts[1] === "run") {
        const days = Math.max(1, Math.min(90, Number(parts[2] ?? 7)));
        await safeReply(ctx, `⏳ Building your private ${days}-day report...`);
        const { formattedText } = await services.weeklyReports.generateForUser(vault, days);
        return await safeReply(
          ctx,
          formattedText,
          new InlineKeyboard().text("🏠 Main Menu", "nav:home")
        );
      }

      // Settings
      if (parts[0] === "set" && parts[1] === "slippage") {
        sessions.set(telegramId, { kind: "await_slippage" });
        return await safeReply(ctx, "💨 Type your new max slippage % (for example: `15` for 15%):");
      }

      if (parts[0] === "set" && parts[1] === "fee" && isChainKey(parts[2])) {
        const chain = parts[2];
        sessions.set(telegramId, { kind: "await_gas_fee", chain });
        return await safeReply(
          ctx,
          `⛽ Type your simulated network fee in *${CHAINS[chain].nativeSymbol}* (or \`0\` for zero fee):`
        );
      }

      if (parts[0] === "set" && parts[1] === "toggle") {
        const s = await vault.getSettings();
        if (parts[2] === "simMode") {
          await vault.setSetting("sim_mode", s.simMode === "realistic" ? "ideal" : "realistic");
        } else if (parts[2] === "copyNotify") {
          await vault.setSetting("copy_notify", s.copyNotify ? "0" : "1");
        } else if (parts[2] === "weeklyReport") {
          await vault.setSetting("weekly_report_enabled", s.weeklyReportEnabled ? "0" : "1");
        }
        return await safeEditOrReply(
          ctx,
          "⚙️ *Trading & Simulation Settings*",
          buildSettingsKeyboard(await vault.getSettings())
        );
      }

      if (parts[0] === "set" && parts[1] === "theme") {
        await vault.setSetting("pnl_theme", parts[2] as PnlTheme);
        return await safeEditOrReply(
          ctx,
          "⚙️ *Trading & Simulation Settings*",
          buildSettingsKeyboard(await vault.getSettings())
        );
      }

      if (data === "set:previewcard") {
        const s = await vault.getSettings();
        const png = await services.pnlCards.renderPng({
          theme: s.pnlTheme,
          chain: "solana",
          tokenSymbol: "CASHCAT",
          sourceLabel: "Copied: AlphaWhale",
          roiPct: 342.8,
          pnlNativeAtomic: 3_428_000_000n,
          pnlUsd: 617.04,
          investedNativeAtomic: 1_000_000_000n,
          entryMcUsd: 42_500,
          currentOrExitMcUsd: 188_200,
          holdDurationMs: 14 * 60_000 + 22_000,
          statusLabel: "CLOSED",
          traderHandle: ctx.from?.username ? `@${ctx.from.username}` : undefined
        });
        return await ctx.replyWithPhoto(new InputFile(png, "sample-pnl.png"), {
          caption: `🎨 Preview of *${s.pnlTheme.toUpperCase()}* PnL Card Theme`,
          parse_mode: "Markdown"
        });
      }

      // Admin
      if (parts[0] === "admin") {
        if (!(await services.adminDb.isAdmin(telegramId))) return;
        if (parts[1] === "gencode") {
          const maxUses = Number(parts[2] ?? 1);
          sessions.set(telegramId, { kind: "await_admin_code_label", maxUses });
          return await safeReply(
            ctx,
            "🎟️ Type a quick note for who this pass is for (e.g., `Alex`), or send `skip`:"
          );
        }
        if (parts[1] === "codes") {
          const codes = await services.adminDb.listAccessCodes(false);
          if (codes.length === 0) {
            return await safeEditOrReply(
              ctx,
              "📋 No active unused invite passes right now.",
              buildAdminKeyboard()
            );
          }
          const lines = ["📋 *Active Invite Passes:*", ""];
          const kb = new InlineKeyboard();
          for (const c of codes.slice(0, 10)) {
            lines.push(
              `• \`${c.code}\` — Uses: ${c.usesCount}/${c.maxUses}${c.label ? ` (${escapeMd(c.label)})` : ""}`
            );
            kb.text(`🚫 Cancel ${c.code}`, `admin:revoke:${c.code}`).row();
          }
          kb.text("⬅️ Admin Panel", "nav:admin");
          return await safeEditOrReply(ctx, lines.join("\n"), kb);
        }
        if (parts[1] === "revoke") {
          await services.adminDb.revokeAccessCode(parts[2]);
          await safeReply(ctx, `🚫 Cancelled invite pass \`${parts[2]}\`.`);
          return await showAdminScreen(ctx, false);
        }
        if (parts[1] === "members") {
          const users = await services.adminDb.listUsers();
          const lines = [`👤 *Cabal Members (${users.filter((u) => !u.isBanned).length}/${services.config.maxCabalUsers}):*`, ""];
          const kb = new InlineKeyboard();
          for (const u of users) {
            const name = u.username ? `@${u.username}` : u.firstName || u.telegramId;
            lines.push(
              `• ${u.isBanned ? "🚫" : "✅"} *${escapeMd(name)}* (${u.role}) — ID \`${u.telegramId}\``
            );
            if (u.telegramId !== telegramId) {
              kb.text(
                u.isBanned ? `✅ Unban ${name}` : `🚫 Remove ${name}`,
                `admin:${u.isBanned ? "unban" : "ban"}:${u.telegramId}`
              ).row();
            }
          }
          kb.text("⬅️ Admin Panel", "nav:admin");
          return await safeEditOrReply(ctx, lines.join("\n"), kb);
        }
        if (parts[1] === "ban" || parts[1] === "unban") {
          if (parts[1] === "ban") await services.adminDb.banUser(parts[2]);
          else await services.adminDb.unbanUser(parts[2]);
          await services.walletWatcher.reloadWatchers();
          return await showAdminScreen(ctx, false);
        }
      }
    } catch (err) {
      await safeReply(ctx, `❌ ${(err as Error).message}`);
    }
  });

  // === Plain Text Inputs & Auto Token Scanning ===

  bot.on("message:text", async (ctx) => {
    const telegramId = getUserId(ctx);
    if (!telegramId) return;
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;

    const auth = await services.adminDb.isAuthorized(telegramId);
    if (!auth.authorized) {
      if (auth.user?.isBanned) {
        await safeReply(ctx, "🚫 Your access to this bot has been disabled by the admin.");
        return;
      }
      const res = await services.adminDb.redeemCode({
        code: text,
        telegramId,
        username: ctx.from?.username ?? null,
        firstName: ctx.from?.first_name ?? null
      });
      if (!res.ok) {
        await safeReply(ctx, `❌ ${res.reason}\n\nTry entering your invite code again:`);
        return;
      }
      sessions.clear(telegramId);
      await services.vaultManager.getVault(telegramId);
      await safeReply(
        ctx,
        `🎉 *Access Granted!* Your private vault is unlocked.\nSet your virtual play funds first so you can trade or copy wallets!`
      );
      await showHome(ctx, telegramId);
      return;
    }

    const vault = await services.vaultManager.getVault(telegramId);
    const pending = sessions.get(telegramId);

    if (!pending) {
      // Auto-detect pasted token contract address right in chat!
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text) || /^0x[a-fA-F0-9]{40}$/.test(text)) {
        await scanAddressInput(ctx, telegramId, text);
        return;
      }
      await safeReply(
        ctx,
        "💡 Paste any token address to trade it, or tap /menu to open all controls!"
      );
      return;
    }

    try {
      switch (pending.kind) {
        case "await_set_balance": {
          const spec = CHAINS[pending.chain];
          const atomic = parseExactUnits(text, spec.nativeDecimals);
          await vault.setVirtualFunds(pending.chain, atomic, true);
          sessions.clear(telegramId);
          await safeReply(
            ctx,
            `✅ Updated *${spec.name}* balance to \`${formatExactUnits(atomic, spec.nativeDecimals)} ${spec.nativeSymbol}\`!`
          );
          await showFundsScreen(vault, ctx, false);
          return;
        }

        case "await_buy_token_ca": {
          sessions.clear(telegramId);
          await scanAddressInput(ctx, telegramId, text, pending.chain);
          return;
        }

        case "await_custom_buy_amount": {
          const spec = CHAINS[pending.chain];
          const atomic = parseExactUnits(text, spec.nativeDecimals);
          sessions.clear(telegramId);
          const res = await services.trading.executeBuy(vault, {
            chain: pending.chain,
            tokenAddress: pending.tokenAddress,
            spendNativeAtomic: atomic,
            sourceType: "manual"
          });
          await sendBuySuccess(ctx, res);
          return;
        }

        case "await_custom_sell_amount": {
          const pos = await vault.getPositionById(pending.positionId);
          if (!pos || pos.status !== "open") {
            sessions.clear(telegramId);
            return await safeReply(ctx, "❌ Position is no longer open.");
          }
          sessions.clear(telegramId);
          if (text.endsWith("%")) {
            const pct = Number(text.slice(0, -1).trim());
            if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
              throw new Error("Percentage must be between 0.01% and 100%.");
            }
            const res = await services.trading.executeSell(vault, {
              positionId: pos.id,
              sellPct: pct,
              sourceType: "manual"
            });
            return await sendSellSuccess(ctx, res);
          }
          const tokensAtomic = parseExactUnits(text, pos.tokenDecimals);
          const res = await services.trading.executeSell(vault, {
            positionId: pos.id,
            sellTokensAtomic: tokensAtomic,
            sourceType: "manual"
          });
          return await sendSellSuccess(ctx, res);
        }

        case "await_limit_buy": {
          const [mcStr, amtStr] = text.split(/\s+/);
          const targetMc = Number(mcStr);
          if (!Number.isFinite(targetMc) || targetMc <= 0 || !amtStr) {
            throw new Error("Send two numbers: `<target_mc_usd> <amount>`, e.g. `50000 0.5`");
          }
          const spec = CHAINS[pending.chain];
          const amountAtomic = parseExactUnits(amtStr, spec.nativeDecimals);
          const snap = await services.market.getTokenSnapshot(pending.chain, pending.tokenAddress);
          const symbol = snap?.symbol ?? shortAddress(pending.tokenAddress);
          const id = await vault.createOrder({
            chain: pending.chain,
            tokenAddress: pending.tokenAddress,
            tokenSymbol: symbol,
            positionId: null,
            orderType: "limit_buy",
            triggerMcUsd: targetMc,
            triggerPriceUsd: null,
            triggerPnlPct: null,
            trailingDropPct: null,
            highestPriceUsd: null,
            amountNativeAtomic: amountAtomic,
            sellPct: null,
            dcaIntervalSec: null,
            dcaRemaining: null,
            nextRunAt: null
          });
          sessions.clear(telegramId);
          return await safeReply(
            ctx,
            `🎯 *Limit Buy #${id} Active!*\nWill buy *${formatExactUnits(amountAtomic, spec.nativeDecimals)} ${spec.nativeSymbol}* of *$${escapeMd(symbol)}* if Market Cap hits ≤ ${formatUsd(targetMc)}.`
          );
        }

        case "await_dca_buy": {
          const [amtStr, minStr, countStr] = text.split(/\s+/);
          const intervalMin = Number(minStr);
          const count = Math.floor(Number(countStr));
          if (!amtStr || !Number.isFinite(intervalMin) || intervalMin < 1 || !Number.isFinite(count) || count < 1) {
            throw new Error("Send 3 numbers: `<amount> <minutes> <count>`, e.g. `0.2 15 5`");
          }
          const spec = CHAINS[pending.chain];
          const amountAtomic = parseExactUnits(amtStr, spec.nativeDecimals);
          const snap = await services.market.getTokenSnapshot(pending.chain, pending.tokenAddress);
          const symbol = snap?.symbol ?? shortAddress(pending.tokenAddress);
          const id = await vault.createOrder({
            chain: pending.chain,
            tokenAddress: pending.tokenAddress,
            tokenSymbol: symbol,
            positionId: null,
            orderType: "dca",
            triggerMcUsd: null,
            triggerPriceUsd: null,
            triggerPnlPct: null,
            trailingDropPct: null,
            highestPriceUsd: null,
            amountNativeAtomic: amountAtomic,
            sellPct: null,
            dcaIntervalSec: Math.round(intervalMin * 60),
            dcaRemaining: count,
            nextRunAt: Date.now()
          });
          sessions.clear(telegramId);
          return await safeReply(
            ctx,
            `🔁 *DCA Order #${id} Started!*\nWill buy *${formatExactUnits(amountAtomic, spec.nativeDecimals)} ${spec.nativeSymbol}* of *$${escapeMd(symbol)}* every ${intervalMin}m (${count} times).`
          );
        }

        case "await_pos_order": {
          const pos = await vault.getPositionById(pending.positionId);
          if (!pos || pos.status !== "open") {
            sessions.clear(telegramId);
            return await safeReply(ctx, "❌ Position is no longer open.");
          }
          const [pctStr, sellPctStr] = text.split(/\s+/);
          const trigger = Number(pctStr);
          const sellPct = Math.min(100, Math.max(1, Number(sellPctStr ?? 100)));
          if (!Number.isFinite(trigger)) throw new Error("Enter valid numbers.");
          if (pending.orderType === "tp" && trigger <= 0) {
            throw new Error("Take-profit % should be positive (e.g. `100 50`).");
          }
          if (pending.orderType === "sl" && trigger >= 0) {
            throw new Error("Stop-loss % should be negative (e.g. `-40 100`).");
          }
          if (pending.orderType === "trailing_stop" && (trigger <= 0 || trigger >= 100)) {
            throw new Error("Trailing drop % must be between 1 and 99 (e.g. `25 100`).");
          }

          await vault.createOrder({
            chain: pos.chain,
            tokenAddress: pos.tokenAddress,
            tokenSymbol: pos.tokenSymbol,
            positionId: pos.id,
            orderType: pending.orderType,
            triggerMcUsd: null,
            triggerPriceUsd: null,
            triggerPnlPct: pending.orderType === "trailing_stop" ? null : trigger,
            trailingDropPct: pending.orderType === "trailing_stop" ? trigger : null,
            highestPriceUsd: pos.lastPriceUsd,
            amountNativeAtomic: null,
            sellPct,
            dcaIntervalSec: null,
            dcaRemaining: null,
            nextRunAt: null
          });
          sessions.clear(telegramId);
          return await safeReply(ctx, `✅ Auto-order saved for *$${escapeMd(pos.tokenSymbol)}*!`);
        }

        case "await_watch_address": {
          if (!isValidAddressFormat(pending.chain, text)) {
            throw new Error(`That doesn't look like a valid ${CHAINS[pending.chain].name} address. Try again:`);
          }
          sessions.set(telegramId, {
            kind: "await_watch_alias",
            chain: pending.chain,
            address: normalizeAddress(pending.chain, text)
          });
          return await safeReply(
            ctx,
            "🏷️ Give this wallet a nickname so you recognize it in reports (e.g., `AlphaWhale`):"
          );
        }

        case "await_watch_alias": {
          const alias = text.slice(0, 32);
          const spec = CHAINS[pending.chain];
          sessions.set(telegramId, {
            kind: "await_watch_amount",
            chain: pending.chain,
            address: pending.address,
            alias
          });
          return await safeReply(
            ctx,
            `💵 How much virtual *${spec.nativeSymbol}* should be spent each time *${escapeMd(alias)}* buys?\n\n` +
              `• Type any exact amount (e.g. \`0.25\`, \`0.0005\`, \`0.000000001\`)\n` +
              `• OR type a % of your balance (e.g. \`10%\`)`
          );
        }

        case "await_watch_amount": {
          const spec = CHAINS[pending.chain];
          let copyMode: "fixed" | "percent_balance" = "fixed";
          let copyAmountAtomic = 0n;
          let copyPercent = 0;

          if (text.endsWith("%")) {
            copyMode = "percent_balance";
            copyPercent = Number(text.slice(0, -1).trim());
            if (!Number.isFinite(copyPercent) || copyPercent <= 0 || copyPercent > 100) {
              throw new Error("Percentage must be between 0.01% and 100%.");
            }
          } else {
            copyAmountAtomic = parseExactUnits(text, spec.nativeDecimals);
            if (copyAmountAtomic <= 0n) throw new Error("Amount must be greater than 0.");
          }

          const walletId = await vault.addWatchedWallet({
            chain: pending.chain,
            address: pending.address,
            alias: pending.alias,
            copyMode,
            copyAmountAtomic,
            copyPercent
          });
          sessions.clear(telegramId);
          await services.walletWatcher.reloadWatchers();

          const w = (await vault.getWatchedWallet(walletId))!;
          await safeReply(
            ctx,
            `🎉 *Now Watching ${escapeMd(w.alias)} Live!*\nThe very second this wallet trades on *${spec.name}*, your demo vault will copy it automatically.`
          );
          return await safeReply(ctx, formatWatchedWalletMessage(w), buildWatcherDetailKeyboard(w));
        }

        case "await_edit_watch_amount": {
          const w = await vault.getWatchedWallet(pending.walletId);
          if (!w) {
            sessions.clear(telegramId);
            return await safeReply(ctx, "❌ Wallet not found.");
          }
          const spec = CHAINS[w.chain];
          if (text.endsWith("%")) {
            const pct = Number(text.slice(0, -1).trim());
            if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
              throw new Error("Percentage must be between 0.01% and 100%.");
            }
            await vault.updateWatchedWallet(w.id, {
              copyMode: "percent_balance",
              copyPercent: pct,
              copyAmountAtomic: 0n
            });
          } else {
            const amt = parseExactUnits(text, spec.nativeDecimals);
            if (amt <= 0n) throw new Error("Amount must be greater than 0.");
            await vault.updateWatchedWallet(w.id, {
              copyMode: "fixed",
              copyAmountAtomic: amt,
              copyPercent: 0
            });
          }
          sessions.clear(telegramId);
          await services.walletWatcher.reloadWatchers();
          const updated = (await vault.getWatchedWallet(w.id))!;
          return await safeReply(
            ctx,
            formatWatchedWalletMessage(updated),
            buildWatcherDetailKeyboard(updated)
          );
        }

        case "await_edit_watch_filter": {
          const w = await vault.getWatchedWallet(pending.walletId);
          if (!w) {
            sessions.clear(telegramId);
            return await safeReply(ctx, "❌ Wallet not found.");
          }
          const isOff = text.toLowerCase() === "off";
          if (pending.field === "tp_sl") {
            if (isOff) {
              await vault.updateWatchedWallet(w.id, { autoTpPct: null, autoSlPct: null });
            } else {
              const [tpStr, slStr] = text.split(/\s+/);
              const tp = Number(tpStr);
              const sl = Number(slStr);
              if (!Number.isFinite(tp) || tp <= 0 || !Number.isFinite(sl) || sl >= 0) {
                throw new Error("Example format: `150 -40` (positive TP, negative SL) or `off`");
              }
              await vault.updateWatchedWallet(w.id, { autoTpPct: tp, autoSlPct: sl });
            }
          } else {
            const val = isOff ? null : Number(text.replace(/[,$]/g, ""));
            if (!isOff && (!Number.isFinite(val) || (val as number) < 0)) {
              throw new Error("Enter a valid dollar number like `25000` or `off`.");
            }
            if (pending.field === "min_mc") await vault.updateWatchedWallet(w.id, { minMcUsd: val });
            if (pending.field === "max_mc") await vault.updateWatchedWallet(w.id, { maxMcUsd: val });
            if (pending.field === "min_liq") await vault.updateWatchedWallet(w.id, { minLiqUsd: val });
          }
          sessions.clear(telegramId);
          await services.walletWatcher.reloadWatchers();
          const updated = (await vault.getWatchedWallet(w.id))!;
          return await safeReply(
            ctx,
            formatWatchedWalletMessage(updated),
            buildWatcherDetailKeyboard(updated)
          );
        }

        case "await_slippage": {
          const pct = Number(text.replace("%", ""));
          if (!Number.isFinite(pct) || pct < 0.1 || pct > 90) {
            throw new Error("Enter a slippage % between 0.1 and 90.");
          }
          await vault.setSetting("slippage_bps", String(Math.round(pct * 100)));
          sessions.clear(telegramId);
          return await safeReply(
            ctx,
            `✅ Slippage set to *${pct.toFixed(1)}%*.`,
            buildSettingsKeyboard(await vault.getSettings())
          );
        }

        case "await_gas_fee": {
          const spec = CHAINS[pending.chain];
          const parsed = parseExactUnits(text, spec.nativeDecimals);
          const formatted = formatExactUnits(parsed, spec.nativeDecimals);
          if (pending.chain === "solana") await vault.setSetting("priority_fee_sol", formatted);
          else await vault.setSetting("evm_gas_eth", formatted);
          sessions.clear(telegramId);
          return await safeReply(
            ctx,
            `✅ Simulated network fee updated to \`${formatted} ${spec.nativeSymbol}\`.`,
            buildSettingsKeyboard(await vault.getSettings())
          );
        }

        case "await_admin_code_label": {
          const label = text.toLowerCase() === "skip" ? undefined : text.slice(0, 40);
          const code = await services.adminDb.generateAccessCode({
            createdBy: telegramId,
            label,
            maxUses: pending.maxUses
          });
          sessions.clear(telegramId);
          return await safeReply(
            ctx,
            `🎟️ *Invite Code Created!*\n\nCode: \`${code.code}\`\nMax Uses: *${code.maxUses}*${
              label ? `\nLabel: *${escapeMd(label)}*` : ""
            }\n\nShare this code with your member — they enter it after starting the bot!`
          );
        }
      }
    } catch (err) {
      await safeReply(ctx, `❌ ${(err as Error).message}`);
    }
  });

  bot.catch((err) => {
    console.error("Telegram bot error:", err.error);
  });

  return bot;
}
