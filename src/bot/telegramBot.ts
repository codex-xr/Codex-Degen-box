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
import {
  WalletDetectiveService,
  WalletInvestigationReport
} from "../services/walletDetective.js";
import { WalletWatcherService } from "../services/walletWatcher.js";
import {
  formatDetectiveReportMessage,
  WeeklyReportService
} from "../services/weeklyReport.js";
import {
  formatExactUnits,
  formatUsd,
  nativeAtomicToUsd,
  parseExactUnits,
  usdToNativeAtomic
} from "../utils/amounts.js";
import {
  chainFromShortCode,
  escapeMd,
  formatHomeMessage,
  formatPositionMessage,
  formatTokenScanMessage,
  formatWalletLeaderboardMessage,
  formatWatchedWalletMessage,
  shortChainCode,
  stripMdForFallback
} from "./formatters.js";
import {
  buildAccentColorKeyboard,
  buildAdminKeyboard,
  buildDetectiveKeyboard,
  buildDisambiguateChainKeyboard,
  buildEditChainFundsKeyboard,
  buildFundsKeyboard,
  buildHistoryKeyboard,
  buildHomeKeyboard,
  buildPnlStudioKeyboard,
  buildPositionDetailKeyboard,
  buildPositionsKeyboard,
  buildReportKeyboard,
  buildSettingsKeyboard,
  buildTokenTradeKeyboard,
  buildWalletReportKeyboard,
  buildWatchChainPickKeyboard,
  buildWatcherDetailKeyboard,
  buildWatchersKeyboard
} from "./keyboards.js";
import { PendingPrompt, SessionStore } from "./sessionState.js";

export interface BotServices {
  config: AppConfig;
  adminDb: IAdminDb;
  vaultManager: IVaultManager;
  market: MarketDataService;
  security: SecurityService;
  trading: TradingEngine;
  pnlCards: PnlCardRenderer;
  detective: WalletDetectiveService;
  weeklyReports: WeeklyReportService;
  walletWatcher: WalletWatcherService;
}

export { shortChainCode };

function cleanDecimalInput(raw: string): string {
  return raw.replace(/[$,\s]/g, "");
}

const NAMED_ACCENT_COLORS: Record<string, string> = {
  blue: "#38BDF8",
  green: "#22C55E",
  purple: "#A855F7",
  pink: "#EC4899",
  gold: "#FBBF24",
  yellow: "#FACC15",
  red: "#F43F5E",
  crimson: "#F43F5E",
  cyan: "#06B6D4",
  orange: "#FB923C",
  white: "#FFFFFF"
};

function resolveAccentColorInput(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase();
  if (NAMED_ACCENT_COLORS[cleaned]) return NAMED_ACCENT_COLORS[cleaned];
  const hex = cleaned.replace(/^#/, "");
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex.toUpperCase()}`;
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`.toUpperCase();
  }
  return null;
}

function detectImageMime(buf: Buffer): "image/png" | "image/jpeg" | null {
  if (buf.length >= 8 && buf.subarray(0, 4).toString("hex") === "89504e47") {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

function splitTelegramChunks(text: string, maxLen = 3800): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";
  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen && current.length > 0) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function createTelegramBot(services: BotServices): Bot {
  const bot = new Bot(services.config.botToken);
  const sessions = new SessionStore();
  const cachedHandles = new Map<string, string>();
  const tokenRefs = new Map<string, { chain: ChainKey; address: string }>();
  const detectiveRefs = new Map<
    string,
    { chain: ChainKey; address: string; alias?: string; report?: WalletInvestigationReport }
  >();

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

  const registerDetectiveRef = (
    chain: ChainKey,
    address: string,
    extra: { alias?: string; report?: WalletInvestigationReport } = {}
  ): string => {
    const norm = normalizeAddress(chain, address);
    const id = crypto.createHash("sha256").update(`det:${chain}:${norm}`).digest("hex").slice(0, 10);
    detectiveRefs.set(id, { chain, address: norm, ...extra });
    if (detectiveRefs.size > 2500) {
      const oldest = detectiveRefs.keys().next().value;
      if (oldest) detectiveRefs.delete(oldest);
    }
    return id;
  };

  const setPrompt = (telegramId: string, prompt: PendingPrompt, vault?: IUserVault) => {
    sessions.set(telegramId, prompt);
    if (vault && prompt.kind !== "await_access_code") {
      void vault.setSetting("__pending_prompt", JSON.stringify(prompt)).catch(() => {});
    }
  };

  const clearPrompt = (telegramId: string, vault?: IUserVault) => {
    sessions.clear(telegramId);
    if (vault) {
      void vault.setSetting("__pending_prompt", "").catch(() => {});
    }
  };

  const getPrompt = async (telegramId: string, vault: IUserVault): Promise<PendingPrompt | undefined> => {
    const cached = sessions.get(telegramId);
    if (cached) return cached;
    try {
      const raw = await vault.getSetting("__pending_prompt");
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as PendingPrompt;
      if (parsed && typeof parsed === "object" && "kind" in parsed) {
        sessions.set(telegramId, parsed);
        return parsed;
      }
    } catch {
      // ignore invalid stored prompt
    }
    return undefined;
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
      return await ctx.reply(stripMdForFallback(text), {
        reply_markup: kb,
        link_preview_options: { is_disabled: true }
      });
    }
  };

  const safeReplyChunks = async (ctx: Context, text: string, kb?: InlineKeyboard) => {
    const chunks = splitTelegramChunks(text);
    for (let i = 0; i < chunks.length; i++) {
      await safeReply(ctx, chunks[i], i === chunks.length - 1 ? kb : undefined);
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
      } catch (err) {
        const msg = (err as Error)?.message ?? "";
        if (/message is not modified/i.test(msg)) return;
        if (/can't parse entities/i.test(msg)) {
          try {
            return await ctx.editMessageText(stripMdForFallback(text), {
              reply_markup: kb,
              link_preview_options: { is_disabled: true }
            });
          } catch {
            // Fall through to fresh message
          }
        }
      }
    }
    return safeReply(ctx, text, kb);
  };

  const showHome = async (ctx: Context, telegramId: string, edit = false) => {
    const vault = await services.vaultManager.getVault(telegramId);
    clearPrompt(telegramId, vault);
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
    const vault = await services.vaultManager.getVault(telegramId);
    const handle = ctx.from?.username
      ? `@${ctx.from.username}`
      : ctx.from?.first_name?.trim() || "";
    if (handle && cachedHandles.get(telegramId) !== handle) {
      cachedHandles.set(telegramId, handle);
      void vault.setSetting("telegram_handle", handle).catch(() => {});
    }
    return { telegramId, vault };
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

  const buildBuddyButtonsForReport = async (
    vault: IUserVault,
    report: WalletInvestigationReport
  ): Promise<Array<{ address: string; roleBadge: string; refId: string }>> => {
    const existingWatched = new Set(
      (await vault.listWatchedWallets(false)).map((w) => normalizeAddress(w.chain, w.address))
    );
    const out: Array<{ address: string; roleBadge: string; refId: string }> = [];
    for (const b of report.connectedWallets) {
      if (b.isExchangeOrApp) continue;
      if (existingWatched.has(normalizeAddress(report.chain, b.address))) continue;
      out.push({
        address: b.address,
        roleBadge: b.roleBadge,
        refId: registerDetectiveRef(report.chain, b.address, { alias: b.label ?? undefined })
      });
      if (out.length >= 3) break;
    }
    return out;
  };

  const runAndSendWalletDetective = async (
    ctx: Context,
    vault: IUserVault,
    params: { chain: ChainKey | "evm_auto"; address: string; days: number; alias?: string }
  ) => {
    await safeReply(
      ctx,
      `🕵️‍♂️ Investigating \`${shortAddress(params.address, 6, 4)}\` (${params.days}d transfers, balances, launched coins & Twitter)...`
    );
    const report =
      params.chain === "evm_auto"
        ? await services.detective.investigateEvmAuto(params.address, params.days)
        : await services.detective.investigateWallet(params.chain, params.address, params.days);

    const cardRefId = registerDetectiveRef(report.chain, report.address, {
      alias: params.alias,
      report
    });
    const buddyRefs = await buildBuddyButtonsForReport(vault, report);
    const msg = formatDetectiveReportMessage(report, params.alias);
    const kb = buildDetectiveKeyboard({
      cardRefId,
      watchRefId: cardRefId,
      chain: report.chain,
      address: report.address,
      days: report.days,
      buddyRefs
    });
    await safeReplyChunks(ctx, msg, kb);
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
      const vault = await services.vaultManager.getVault(telegramId);
      if (isValidAddressFormat("solana", trimmed) && (!preferredChain || preferredChain === "solana")) {
        await runAndSendWalletDetective(ctx, vault, {
          chain: "solana",
          address: trimmed,
          days: 7
        });
        return;
      }
      if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
        await runAndSendWalletDetective(ctx, vault, {
          chain: preferredChain && preferredChain !== "solana" ? preferredChain : "evm_auto",
          address: trimmed,
          days: 7
        });
        return;
      }
      await safeReply(
        ctx,
        "❌ Couldn't find a coin or valid wallet address there. Paste any Solana or EVM (`0x...`) coin or wallet address!"
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
        refMap,
        trimmed
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
    const [settings, bgDataUrl] = await Promise.all([
      vault.getSettings(),
      vault.getSetting("pnl_bg_data_url")
    ]);
    const traderHandle = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name ?? undefined;

    const png = await services.pnlCards.renderPng({
      theme: settings.pnlTheme,
      accentHex: settings.pnlAccentHex,
      hideAmounts: settings.pnlHideAmounts,
      bgDataUrl,
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

    const safeFileSym = pos.tokenSymbol.replace(/[^a-zA-Z0-9_-]/g, "_") || "token";
    const amountSuffix = settings.pnlHideAmounts
      ? ""
      : ` (${pnlUsd >= 0 ? "+" : ""}${formatUsd(pnlUsd)})`;
    const caption = `🖼️ *${escapeMd(pos.tokenSymbol)}* (${spec.name}) • ${
      roiPct >= 0 ? "+" : ""
    }${roiPct.toFixed(1)}%${amountSuffix}`;
    try {
      await ctx.replyWithPhoto(new InputFile(png, `pnl-${safeFileSym}.png`), {
        caption,
        parse_mode: "Markdown"
      });
    } catch {
      await ctx.replyWithPhoto(new InputFile(png, `pnl-${safeFileSym}.png`), {
        caption: stripMdForFallback(caption)
      });
    }
  };

  const sendSamplePnlPreview = async (ctx: Context, vault: IUserVault) => {
    const [s, bgDataUrl] = await Promise.all([
      vault.getSettings(),
      vault.getSetting("pnl_bg_data_url")
    ]);
    const traderHandle = ctx.from?.username
      ? `@${ctx.from.username}`
      : ctx.from?.first_name ?? undefined;
    const png = await services.pnlCards.renderPng({
      theme: s.pnlTheme,
      accentHex: s.pnlAccentHex,
      hideAmounts: s.pnlHideAmounts,
      bgDataUrl,
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
      traderHandle
    });
    const caption = `🎨 *Evil.fun PnL Card Preview* (${s.pnlTheme.toUpperCase()}${
      s.pnlHideAmounts ? " • Bag Hidden" : ""
    })`;
    return await ctx.replyWithPhoto(new InputFile(png, "evil-fun-pnl-preview.png"), {
      caption,
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
        `🔒 *Welcome to Evil.fun!*\n\nThis is a private trading bot.\nPlease send your *invite pass code* (given to you by the admin) to get started:`
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
    await showReportMenuScreen(ok.vault, ctx, false);
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
      setPrompt(ok.telegramId, { kind: "await_buy_token_ca" }, ok.vault);
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
      await safeReply(ctx, "No trades found yet! Make a trade first.");
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
    const [balances, solUsd, ethUsd] = await Promise.all([
      vault.getBalances(),
      services.market.getNativePriceUsd("solana").catch(() => 0),
      services.market.getNativePriceUsd("ethereum").catch(() => 0)
    ]);
    const lines = [
      "💰 *Your Wallet Balance*",
      "_Pick any chain below to ADD funds (in SOL/ETH or by exact USDT dollar amount!) or set a new total._",
      ""
    ];
    for (const c of [CHAINS.solana, CHAINS.ethereum, CHAINS.base, CHAINS.robinhood]) {
      const b = balances.find((row) => row.chain === c.key);
      const atomic = b?.balanceAtomic ?? 0n;
      const usdPrice = c.key === "solana" ? solUsd : ethUsd;
      const usdVal = nativeAtomicToUsd(atomic, c.nativeDecimals, usdPrice);
      const usdStr = usdPrice > 0 ? ` (~*${formatUsd(usdVal)} USDT*)` : "";
      lines.push(
        `${c.emoji} *${c.name}:* \`${formatExactUnits(atomic, c.nativeDecimals)} ${c.nativeSymbol}\`${usdStr}`
      );
    }
    if (solUsd > 0 || ethUsd > 0) {
      lines.push("");
      lines.push(
        `📊 _Live rates:_ ${solUsd > 0 ? `1 SOL ≈ ${formatUsd(solUsd)}` : ""}${
          solUsd > 0 && ethUsd > 0 ? "  |  " : ""
        }${ethUsd > 0 ? `1 ETH ≈ ${formatUsd(ethUsd)}` : ""}`
      );
    }
    const kb = buildFundsKeyboard();
    if (edit) await safeEditOrReply(ctx, lines.join("\n"), kb);
    else await safeReply(ctx, lines.join("\n"), kb);
  };

  const showReportMenuScreen = async (vault: IUserVault, ctx: Context, edit: boolean) => {
    const wallets = await vault.listWatchedWallets(false);
    const lines = [
      "📊 *Wallet-by-Wallet Weekly Report & Detective*",
      wallets.length > 0
        ? "_Pick ONE watched wallet below to see its full report & connected wallets — then you can pick the next one!_"
        : "_You don't have any watched wallets yet — tap *Investigate Any Address* or watch a wallet first!_"
    ];
    const kb = buildReportKeyboard(wallets);
    if (edit) await safeEditOrReply(ctx, lines.join("\n"), kb);
    else await safeReply(ctx, lines.join("\n"), kb);
  };

  const showPositionsScreen = async (vault: IUserVault, ctx: Context, edit: boolean) => {
    const open = await vault.listOpenPositions();
    if (open.length === 0) {
      const msg = "📈 *Open Positions*\n\nYou have no open trades right now.\nPaste any token address in chat to scan & buy!";
      const kb = new InlineKeyboard()
        .text("🎯 Active Auto-Orders", "nav:orders")
        .text("🏠 Main Menu", "nav:home");
      if (edit) await safeEditOrReply(ctx, msg, kb);
      else await safeReply(ctx, msg, kb);
      return;
    }

    const lines = ["📈 *Your Open Positions*", "_Tap any coin below to sell, set auto take-profit/stop-loss, or get a PnL picture card._", ""];
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
      "👁️ *Instant Wallet Copy-Trading & Alerts*",
      "_Watch any wallet on Solana, Ethereum, Base, or Robinhood Chain. Get instant copy trades OR funding movement alerts!_",
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
      `❓ *How To Use Evil.fun (Simple Guide)*\n\n` +
      `1️⃣ *Add Balance:* Tap *Funds & Balance*, pick Solana, Ethereum, Base, or Robinhood Chain, and add by SOL/ETH or exact USDT dollar value!\n` +
      `2️⃣ *Buy Any Coin:* Just paste any coin address right into this chat! You'll get a safety check and quick Buy buttons.\n` +
      `3️⃣ *Investigate Any Wallet:* Paste any wallet address right into chat to see connected wallets, balances, coins launched & Twitter links!\n` +
      `4️⃣ *Copy Any Wallet Live:* Tap *Watch Wallets*, give it a nickname, and pick your copy size (or \`0\` for Alerts & Reports only).\n` +
      `5️⃣ *Wallet-by-Wallet Weekly Report:* Tap *Weekly Alpha Report* and pick one wallet at a time!\n` +
      `6️⃣ *Custom PnL Cards:* Go to *Settings → Customize PnL Card* to upload your own background picture, choose your color, or hide dollar amounts!\n\n` +
      `*Quick Commands:* \`/menu\`, \`/funds\`, \`/positions\`, \`/watch\`, \`/report\`, \`/pnl\`, \`/settings\``;
    const kb = new InlineKeyboard().text("🏠 Main Menu", "nav:home");
    if (edit) await safeEditOrReply(ctx, text, kb);
    else await safeReply(ctx, text, kb);
  };

  const sendBuySuccess = async (ctx: Context, res: ExecutionResult) => {
    const spec = CHAINS[res.chain];
    const msg =
      `✅ *Buy Complete!* (${spec.name})\n\n` +
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
      `${res.side === "rug_writeoff" ? "💀 *Rugged Position Written Off*" : "✅ *Sell Complete!*"} (${spec.name})\n\n` +
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

  const showPnlStudioScreen = async (vault: IUserVault, ctx: Context, edit: boolean) => {
    const s = await vault.getSettings();
    const text =
      `🎨 *Customize Your Evil.fun PnL Card*\n\n` +
      `• *Theme:* ${s.pnlTheme.toUpperCase()}\n` +
      `• *Accent Color:* ${s.pnlAccentHex ? `\`${s.pnlAccentHex}\`` : "Theme Default"}\n` +
      `• *Custom Background Photo:* ${s.hasPnlBg ? "✅ Uploaded" : "None (using theme gradient)"}\n` +
      `• *Hide Bag Size (ROI % Only):* *${s.pnlHideAmounts ? "ON" : "OFF"}*\n` +
      `• *Trader Tag:* ${ctx.from?.username ? `\`@${escapeMd(ctx.from.username)}\`` : "_Your Telegram username_"}\n\n` +
      `_Tap any option below to customize how your shareable PnL card looks:_`;
    const kb = buildPnlStudioKeyboard(s);
    if (edit) await safeEditOrReply(ctx, text, kb);
    else await safeReply(ctx, text, kb);
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
        setPrompt(telegramId, { kind: "await_buy_token_ca" }, vault);
        return await safeReply(
          ctx,
          "⚡ Paste any *token or wallet address* from Solana, Ethereum, Base, or Robinhood Chain right now:"
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
        return await showReportMenuScreen(vault, ctx, true);
      }

      if (data === "nav:settings") {
        return await safeEditOrReply(
          ctx,
          "⚙️ *Evil.fun Trading & Card Settings*",
          buildSettingsKeyboard(await vault.getSettings())
        );
      }

      if (data === "nav:pnlstudio") {
        return await showPnlStudioScreen(vault, ctx, true);
      }

      if (data === "nav:admin") {
        if (!(await services.adminDb.isAdmin(telegramId))) return;
        return await showAdminScreen(ctx, true);
      }

      // Funds
      if (parts[0] === "funds" && parts[1] === "pick" && isChainKey(parts[2])) {
        const chain = parts[2];
        const spec = CHAINS[chain];
        const [balRow, nativePriceUsd] = await Promise.all([
          vault.getBalance(chain),
          services.market.getNativePriceUsd(chain).catch(() => 0)
        ]);
        const bal = balRow.balanceAtomic;
        const usdVal = nativeAtomicToUsd(bal, spec.nativeDecimals, nativePriceUsd);
        const rateStr =
          nativePriceUsd > 0 ? `\n📊 Live Price: *1 ${spec.nativeSymbol} ≈ ${formatUsd(nativePriceUsd)} USDT*` : "";
        return await safeEditOrReply(
          ctx,
          `${spec.emoji} *${spec.name} Balance*\nCurrent: \`${formatExactUnits(bal, spec.nativeDecimals)} ${spec.nativeSymbol}\`${
            nativePriceUsd > 0 ? ` (~*${formatUsd(usdVal)} USDT*)` : ""
          }${rateStr}\n\nPick a quick *+Add* button, add by exact *USDT dollar value*, or set a new balance:`,
          buildEditChainFundsKeyboard(chain, nativePriceUsd)
        );
      }

      if (parts[0] === "funds" && parts[1] === "add" && isChainKey(parts[2])) {
        const chain = parts[2];
        const spec = CHAINS[chain];
        const amt = parseExactUnits(parts[3], spec.nativeDecimals);
        const [newBal, nativePriceUsd] = await Promise.all([
          vault.addVirtualFunds(chain, amt),
          services.market.getNativePriceUsd(chain).catch(() => 0)
        ]);
        const addedUsd = nativeAtomicToUsd(amt, spec.nativeDecimals, nativePriceUsd);
        const totalUsd = nativeAtomicToUsd(newBal, spec.nativeDecimals, nativePriceUsd);
        await safeReply(
          ctx,
          `✅ Added \`${formatExactUnits(amt, spec.nativeDecimals)} ${spec.nativeSymbol}\`${
            nativePriceUsd > 0 ? ` (≈ *${formatUsd(addedUsd)} USDT*)` : ""
          } to *${spec.name}*!\nNew Balance: \`${formatExactUnits(newBal, spec.nativeDecimals)} ${spec.nativeSymbol}\`${
            nativePriceUsd > 0 ? ` (≈ *${formatUsd(totalUsd)} USDT*)` : ""
          }`
        );
        return await showFundsScreen(vault, ctx, false);
      }

      if (parts[0] === "funds" && parts[1] === "addnative" && isChainKey(parts[2])) {
        const chain = parts[2];
        const spec = CHAINS[chain];
        const price = await services.market.getNativePriceUsd(chain).catch(() => 0);
        setPrompt(telegramId, { kind: "await_add_balance_native", chain }, vault);
        return await safeReply(
          ctx,
          `➕ How much *${spec.nativeSymbol}* do you want to *ADD* to *${spec.name}*?\n${
            price > 0 ? `📊 Live rate: *1 ${spec.nativeSymbol} ≈ ${formatUsd(price)} USDT* (I'll show you the USDT value as soon as you type it!)\n` : ""
          }_Example: \`2.5\` or \`0.0005\`_`
        );
      }

      if (parts[0] === "funds" && parts[1] === "addusd" && isChainKey(parts[2])) {
        const chain = parts[2];
        const spec = CHAINS[chain];
        const price = await services.market.getNativePriceUsd(chain).catch(() => 0);
        setPrompt(telegramId, { kind: "await_add_balance_usd", chain }, vault);
        return await safeReply(
          ctx,
          `💵 Type the *USDT dollar amount* you want to *ADD* to your *${spec.name}* balance:\n${
            price > 0 ? `📊 Live rate right now: *1 ${spec.nativeSymbol} ≈ ${formatUsd(price)} USDT*\n` : ""
          }_Example: \`500\` or \`25.50\` — I will add the exact *${spec.nativeSymbol}* equivalent!_`
        );
      }

      if (parts[0] === "funds" && parts[1] === "set" && isChainKey(parts[2])) {
        const chain = parts[2];
        const spec = CHAINS[chain];
        const amt = parseExactUnits(parts[3], spec.nativeDecimals);
        await vault.setVirtualFunds(chain, amt, true);
        await safeReply(
          ctx,
          `✅ Set your *${spec.name}* balance to \`${formatExactUnits(amt, spec.nativeDecimals)} ${spec.nativeSymbol}\`!`
        );
        return await showFundsScreen(vault, ctx, false);
      }

      if (parts[0] === "funds" && parts[1] === "custom" && isChainKey(parts[2])) {
        const chain = parts[2];
        const spec = CHAINS[chain];
        const price = await services.market.getNativePriceUsd(chain).catch(() => 0);
        setPrompt(telegramId, { kind: "await_set_balance", chain }, vault);
        return await safeReply(
          ctx,
          `✏️ Type the new TOTAL *${spec.nativeSymbol}* balance for *${spec.name}*:\n${
            price > 0 ? `📊 Live rate: *1 ${spec.nativeSymbol} ≈ ${formatUsd(price)} USDT*\n` : ""
          }_(Examples: \`12.5\`, \`0.0025\`, or even \`0.${"0".repeat(spec.nativeDecimals - 1)}1\`)_`
        );
      }

      // Token Trading (stateless callbacks + legacy RAM ref fallbacks)
      const resolveTokenTarget = (kind: "refresh" | "buy" | "custom" | "limit" | "dca") => {
        if (parts[0] === "rf" && kind === "refresh") {
          const ch = chainFromShortCode(parts[1]);
          return ch && parts[2] ? { chain: ch, address: parts[2] } : undefined;
        }
        if (parts[0] === "b" && kind === "buy") {
          const ch = chainFromShortCode(parts[1]);
          return ch && parts[2] ? { chain: ch, address: parts[2], amount: parts[3] } : undefined;
        }
        if (parts[0] === "bc" && kind === "custom") {
          const ch = chainFromShortCode(parts[1]);
          return ch && parts[2] ? { chain: ch, address: parts[2] } : undefined;
        }
        if (parts[0] === "lb" && kind === "limit") {
          const ch = chainFromShortCode(parts[1]);
          return ch && parts[2] ? { chain: ch, address: parts[2] } : undefined;
        }
        if (parts[0] === "db" && kind === "dca") {
          const ch = chainFromShortCode(parts[1]);
          return ch && parts[2] ? { chain: ch, address: parts[2] } : undefined;
        }
        return undefined;
      };

      if (parts[0] === "rf" || parts[0] === "refreshscan") {
        const ref = resolveTokenTarget("refresh") ?? tokenRefs.get(parts[1]);
        if (!ref) return await safeReply(ctx, "⚠️ Token session expired. Please paste the token address again.");
        const snap = await services.market.getTokenSnapshot(ref.chain, ref.address, 500);
        if (!snap) return await safeReply(ctx, "❌ Could not refresh token data.");
        return await sendTokenCard(ctx, telegramId, snap, true);
      }

      if (parts[0] === "b" || parts[0] === "buy") {
        const direct = resolveTokenTarget("buy");
        const ref = direct ?? tokenRefs.get(parts[1]);
        const amtRaw = direct ? direct.amount : parts[2];
        if (!ref || !amtRaw) return await safeReply(ctx, "⚠️ Please paste the token address again.");
        const spec = CHAINS[ref.chain];
        const spendAtomic = parseExactUnits(amtRaw, spec.nativeDecimals);
        const res = await services.trading.executeBuy(vault, {
          chain: ref.chain,
          tokenAddress: ref.address,
          spendNativeAtomic: spendAtomic,
          sourceType: "manual"
        });
        return await sendBuySuccess(ctx, res);
      }

      if (parts[0] === "bc" || parts[0] === "buycustom") {
        const ref = resolveTokenTarget("custom") ?? tokenRefs.get(parts[1]);
        if (!ref) return await safeReply(ctx, "⚠️ Please paste the token address again.");
        const spec = CHAINS[ref.chain];
        setPrompt(telegramId, {
          kind: "await_custom_buy_amount",
          chain: ref.chain,
          tokenAddress: ref.address
        }, vault);
        return await safeReply(
          ctx,
          `✏️ How much *${spec.nativeSymbol}* do you want to spend? (Any decimal allowed)`
        );
      }

      if (parts[0] === "lb" || parts[0] === "limitbuy") {
        const ref = resolveTokenTarget("limit") ?? tokenRefs.get(parts[1]);
        if (!ref) return await safeReply(ctx, "⚠️ Please paste the token address again.");
        const spec = CHAINS[ref.chain];
        setPrompt(telegramId, {
          kind: "await_limit_buy",
          chain: ref.chain,
          tokenAddress: ref.address
        }, vault);
        return await safeReply(
          ctx,
          `🎯 *Set Limit Buy*\nSend: \`<target_market_cap_usd> <spend_${spec.nativeSymbol}>\`\nExample: \`50000 0.5\` (buys 0.5 ${spec.nativeSymbol} if Market Cap drops to \$50,000 or below)`
        );
      }

      if (parts[0] === "db" || parts[0] === "dcabuy") {
        const ref = resolveTokenTarget("dca") ?? tokenRefs.get(parts[1]);
        if (!ref) return await safeReply(ctx, "⚠️ Please paste the token address again.");
        const spec = CHAINS[ref.chain];
        setPrompt(telegramId, {
          kind: "await_dca_buy",
          chain: ref.chain,
          tokenAddress: ref.address
        }, vault);
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
        setPrompt(telegramId, { kind: "await_custom_sell_amount", positionId: posId }, vault);
        return await safeReply(
          ctx,
          `✏️ Enter how many *${escapeMd(pos.tokenSymbol)}* tokens to sell, OR enter a percentage like \`33%\`:`
        );
      }

      if (parts[0] === "posorder") {
        const posId = Number(parts[1]);
        const orderType = parts[2] as "tp" | "sl" | "trailing_stop";
        setPrompt(telegramId, { kind: "await_pos_order", positionId: posId, orderType }, vault);
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
        setPrompt(telegramId, { kind: "await_watch_address", chain }, vault);
        return await safeReply(
          ctx,
          `${CHAINS[chain].emoji} Paste the *${CHAINS[chain].name} wallet address* you want to watch & copy:`
        );
      }

      if (parts[0] === "watch" && parts[1] === "board") {
        const [wallets, openPos, closedPos] = await Promise.all([
          vault.listWatchedWallets(false),
          vault.listOpenPositions(),
          vault.listClosedPositions(500)
        ]);
        return await safeEditOrReply(
          ctx,
          formatWalletLeaderboardMessage(wallets, openPos, closedPos),
          buildWatchersKeyboard(wallets)
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
        if (field === "transferAlerts") {
          await vault.updateWatchedWallet(id, { transferAlerts: !w.transferAlerts });
        }
        if (field === "mirrorSells") await vault.updateWatchedWallet(id, { mirrorSells: !w.mirrorSells });
        if (field === "sellMode") {
          await vault.updateWatchedWallet(id, {
            sellMode: w.sellMode === "proportional" ? "full" : "proportional"
          });
        }
        if (field === "snipeDevLaunches") {
          await vault.updateWatchedWallet(id, { snipeDevLaunches: !w.snipeDevLaunches });
        }
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

      if (parts[0] === "watch" && parts[1] === "rename") {
        const walletId = Number(parts[2]);
        const w = await vault.getWatchedWallet(walletId);
        if (!w) return;
        setPrompt(telegramId, { kind: "await_rename_watch", walletId }, vault);
        return await safeReply(
          ctx,
          `✏️ Type the new nickname for *${escapeMd(w.alias)}* (\`${shortAddress(w.address)}\`):`
        );
      }

      if (parts[0] === "watch" && parts[1] === "editamt") {
        const walletId = Number(parts[2]);
        const w = await vault.getWatchedWallet(walletId);
        if (!w) return;
        const spec = CHAINS[w.chain];
        setPrompt(telegramId, { kind: "await_edit_watch_amount", walletId }, vault);
        return await safeReply(
          ctx,
          `💵 Type the new amount of *${spec.nativeSymbol}* to spend per copied trade (e.g. \`0.25\` or \`0.00005\`), a % like \`10%\`, OR \`0\` for Alert & Investigate Only:`
        );
      }

      if (parts[0] === "watch" && parts[1] === "filter") {
        const walletId = Number(parts[2]);
        const field = parts[3] as "min_mc" | "max_mc" | "min_liq" | "tp_sl" | "trail";
        setPrompt(telegramId, { kind: "await_edit_watch_filter", walletId, field }, vault);
        if (field === "tp_sl") {
          return await safeReply(
            ctx,
            "🎯 Send auto Take-Profit % and Stop-Loss % separated by space (e.g., `100 -50`), or `off` to clear:"
          );
        }
        if (field === "trail") {
          return await safeReply(
            ctx,
            "📈 Send auto Trailing Stop-Loss drop % (e.g., `25` sells if price drops 25% from peak), or `off` to clear:"
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

      // Weekly Reports (Wallet-by-Wallet + Overall)
      if (parts[0] === "report" && parts[1] === "wallet") {
        const walletId = Number(parts[2]);
        const days = Math.max(1, Math.min(90, Number(parts[3] ?? 7)));
        const existing = await vault.getWatchedWallet(walletId);
        if (!existing) return await safeReply(ctx, "❌ Watched wallet not found.");

        await safeReply(
          ctx,
          `⏳ Investigating *${escapeMd(existing.alias)}* and building your ${days}-day report...`
        );
        const result = await services.weeklyReports.generateForWatchedWallet(vault, walletId, days);
        if (!result) return await safeReply(ctx, "❌ Could not build wallet report.");

        const cardRefId = registerDetectiveRef(existing.chain, existing.address, {
          alias: existing.alias,
          report: result.investigation ?? undefined
        });
        const buddyRefs = result.investigation
          ? await buildBuddyButtonsForReport(vault, result.investigation)
          : [];
        const kb = buildWalletReportKeyboard({
          walletId: existing.id,
          chain: existing.chain,
          address: existing.address,
          days,
          cardRefId,
          buddyRefs
        });
        return await safeReplyChunks(ctx, result.formattedText, kb);
      }

      if (parts[0] === "report" && parts[1] === "run") {
        const days = Math.max(1, Math.min(90, Number(parts[2] ?? 7)));
        await safeReply(ctx, `⏳ Building your private ${days}-day vault summary...`);
        const { formattedText } = await services.weeklyReports.generateForUser(vault, days);
        const kb = new InlineKeyboard()
          .text("⬅️ Pick a Wallet Instead", "nav:report")
          .text("🏠 Main Menu", "nav:home");
        return await safeReplyChunks(ctx, formattedText, kb);
      }

      // Wallet Detective Callbacks (both stateless and legacy refs)
      if (data === "det:ask") {
        setPrompt(telegramId, { kind: "await_investigate_address" }, vault);
        return await safeReply(
          ctx,
          "🕵️‍♂️ Paste ANY wallet address (Solana or `0x...` EVM) right now to inspect connected wallets, balances, coins launched & Twitter links!"
        );
      }

      if (parts[0] === "dd" && parts.length >= 4) {
        const targetChain = chainFromShortCode(parts[1]);
        const addr = parts[2];
        const days = Math.max(1, Math.min(90, Number(parts[3] ?? 7)));
        if (!targetChain || !addr || !isValidAddressFormat(targetChain, addr)) {
          return await safeReply(ctx, "❌ Invalid wallet payload.");
        }
        return await runAndSendWalletDetective(ctx, vault, {
          chain: targetChain,
          address: normalizeAddress(targetChain, addr),
          days
        });
      }

      if (parts[0] === "de" && parts.length >= 4) {
        const targetChain = chainFromShortCode(parts[3]);
        const addr = parts[2];
        if (!targetChain || !addr || !isValidAddressFormat(targetChain, addr)) {
          return await safeReply(ctx, "❌ Invalid chain switch payload.");
        }
        return await runAndSendWalletDetective(ctx, vault, {
          chain: targetChain,
          address: normalizeAddress(targetChain, addr),
          days: 7
        });
      }

      if (parts[0] === "dc" && parts.length >= 3) {
        const targetChain = chainFromShortCode(parts[1]);
        const addr = parts[2];
        if (!targetChain || !addr || !isValidAddressFormat(targetChain, addr)) {
          return await safeReply(ctx, "❌ Invalid detective card payload.");
        }
        const norm = normalizeAddress(targetChain, addr);
        const watchedMatch = (await vault.listWatchedWallets(false)).find(
          (w) => w.chain === targetChain && normalizeAddress(w.chain, w.address) === norm
        );
        const cachedRef = detectiveRefs.get(
          crypto.createHash("sha256").update(`det:${targetChain}:${norm}`).digest("hex").slice(0, 10)
        );
        const report =
          cachedRef?.report ?? (await services.detective.investigateWallet(targetChain, norm, 7));
        const s = await vault.getSettings();
        const alias = cachedRef?.alias ?? watchedMatch?.alias;
        const png = await services.pnlCards.renderDetectivePng(
          report,
          s.pnlTheme,
          alias,
          s.pnlAccentHex
        );
        return await ctx.replyWithPhoto(new InputFile(png, `detective-${shortAddress(norm, 4, 4)}.png`), {
          caption: `🕵️‍♂️ *Wallet Detective Card* • ${CHAINS[targetChain].shortBadge} • \`${shortAddress(norm)}\``,
          parse_mode: "Markdown"
        });
      }

      if (parts[0] === "det" && parts[1] === "go") {
        const ref = detectiveRefs.get(parts[2]);
        if (!ref) return await safeReply(ctx, "⚠️ Session expired. Paste the wallet address again!");
        return await runAndSendWalletDetective(ctx, vault, {
          chain: ref.chain,
          address: ref.address,
          days: 7,
          alias: ref.alias
        });
      }

      if (parts[0] === "det" && parts[1] === "days") {
        const ref = detectiveRefs.get(parts[2]);
        const days = Math.max(1, Math.min(90, Number(parts[3] ?? 7)));
        if (!ref) return await safeReply(ctx, "⚠️ Session expired. Paste the wallet address again!");
        return await runAndSendWalletDetective(ctx, vault, {
          chain: ref.chain,
          address: ref.address,
          days,
          alias: ref.alias
        });
      }

      if (parts[0] === "det" && parts[1] === "evm" && isChainKey(parts[3])) {
        const ref = detectiveRefs.get(parts[2]);
        if (!ref) return await safeReply(ctx, "⚠️ Session expired. Paste the wallet address again!");
        return await runAndSendWalletDetective(ctx, vault, {
          chain: parts[3],
          address: ref.address,
          days: 7,
          alias: ref.alias
        });
      }

      if (parts[0] === "det" && parts[1] === "card") {
        const ref = detectiveRefs.get(parts[2]);
        if (!ref) return await safeReply(ctx, "⚠️ Card session expired. Re-run the investigation!");
        const report =
          ref.report ?? (await services.detective.investigateWallet(ref.chain, ref.address, 7));
        const s = await vault.getSettings();
        const png = await services.pnlCards.renderDetectivePng(
          report,
          s.pnlTheme,
          ref.alias,
          s.pnlAccentHex
        );
        return await ctx.replyWithPhoto(new InputFile(png, `detective-${shortAddress(ref.address, 4, 4)}.png`), {
          caption: `🕵️‍♂️ *Wallet Detective Card* • ${CHAINS[ref.chain].shortBadge} • \`${shortAddress(ref.address)}\``,
          parse_mode: "Markdown"
        });
      }

      if (parts[0] === "det" && parts[1] === "watch") {
        const ref = detectiveRefs.get(parts[2]);
        if (!ref) return await safeReply(ctx, "⚠️ Session expired. Paste the address again!");
        setPrompt(telegramId, {
          kind: "await_watch_alias",
          chain: ref.chain,
          address: normalizeAddress(ref.chain, ref.address)
        }, vault);
        return await safeReply(
          ctx,
          `🏷️ Give this *${CHAINS[ref.chain].name}* wallet (\`${shortAddress(ref.address)}\`) a nickname so you remember it:${
            ref.alias ? `\n_(Suggestion: \`${escapeMd(ref.alias)}\`)_` : ""
          }`
        );
      }

      // Stateless live funding alert & detective callbacks: dg:<shortChain>:<address> / dw:<shortChain>:<address>
      if ((parts[0] === "dg" || parts[0] === "dw") && parts.length >= 3) {
        const targetChain = chainFromShortCode(parts[1]);
        const addr = parts.slice(2).join(":");
        if (!targetChain || !isValidAddressFormat(targetChain, addr)) {
          return await safeReply(ctx, "❌ Invalid wallet alert payload.");
        }
        const norm = normalizeAddress(targetChain, addr);
        if (parts[0] === "dg") {
          return await runAndSendWalletDetective(ctx, vault, {
            chain: targetChain,
            address: norm,
            days: 7
          });
        }
        setPrompt(telegramId, {
          kind: "await_watch_alias",
          chain: targetChain,
          address: norm
        }, vault);
        return await safeReply(
          ctx,
          `🏷️ Give this *${CHAINS[targetChain].name}* wallet (\`${shortAddress(norm)}\`) a nickname so you remember it:`
        );
      }

      // Settings
      if (parts[0] === "set" && parts[1] === "slippage") {
        setPrompt(telegramId, { kind: "await_slippage" }, vault);
        return await safeReply(ctx, "💨 Type your new max slippage % (for example: `15` for 15%):");
      }

      if (parts[0] === "set" && parts[1] === "fee" && isChainKey(parts[2])) {
        const chain = parts[2];
        setPrompt(telegramId, { kind: "await_gas_fee", chain }, vault);
        return await safeReply(
          ctx,
          `⛽ Type your network fee in *${CHAINS[chain].nativeSymbol}* (or \`0\` for zero fee):`
        );
      }

      if (parts[0] === "set" && parts[1] === "toggle") {
        const s = await vault.getSettings();
        if (parts[2] === "simMode") {
          await vault.setSetting("sim_mode", s.simMode === "realistic" ? "ideal" : "realistic");
        } else if (parts[2] === "copyNotify") {
          await vault.setSetting("copy_notify", s.copyNotify ? "0" : "1");
        } else if (parts[2] === "notifySkips") {
          await vault.setSetting("notify_skips", s.notifySkips ? "0" : "1");
        } else if (parts[2] === "weeklyReport") {
          await vault.setSetting("weekly_report_enabled", s.weeklyReportEnabled ? "0" : "1");
        } else if (parts[2] === "pnlHideAmounts") {
          await vault.setSetting("pnl_hide_amounts", s.pnlHideAmounts ? "0" : "1");
          return await showPnlStudioScreen(vault, ctx, true);
        }
        return await safeEditOrReply(
          ctx,
          "⚙️ *Evil.fun Trading & Card Settings*",
          buildSettingsKeyboard(await vault.getSettings())
        );
      }

      if (parts[0] === "set" && parts[1] === "theme") {
        await vault.setSetting("pnl_theme", parts[2] as PnlTheme);
        return await safeEditOrReply(
          ctx,
          "⚙️ *Evil.fun Trading & Card Settings*",
          buildSettingsKeyboard(await vault.getSettings())
        );
      }

      if (parts[0] === "pnl") {
        if (parts[1] === "theme") {
          await vault.setSetting("pnl_theme", parts[2] as PnlTheme);
          return await showPnlStudioScreen(vault, ctx, true);
        }
        if (parts[1] === "accent" && parts[2] === "menu") {
          return await safeEditOrReply(
            ctx,
            "🖌️ *Choose Your PnL Card Accent Color*\nPick a preset color below or type any color/hex code:",
            buildAccentColorKeyboard()
          );
        }
        if (parts[1] === "accent" && parts[2] === "set" && parts[3]) {
          const hex = resolveAccentColorInput(parts[3]);
          if (hex) await vault.setSetting("pnl_accent_hex", hex);
          return await showPnlStudioScreen(vault, ctx, true);
        }
        if (parts[1] === "accent" && parts[2] === "clear") {
          await vault.setSetting("pnl_accent_hex", "");
          return await showPnlStudioScreen(vault, ctx, true);
        }
        if (parts[1] === "accent" && parts[2] === "custom") {
          setPrompt(telegramId, { kind: "await_pnl_accent" }, vault);
          return await safeReply(
            ctx,
            "🖌️ Type any hex color (like `#FF5500` or `#00FFAA`) OR a color word (like `red`, `purple`, `gold`, `cyan`, `pink`, `orange`):"
          );
        }
        if (parts[1] === "bg" && parts[2] === "ask") {
          setPrompt(telegramId, { kind: "await_pnl_bg" }, vault);
          return await safeReply(
            ctx,
            "🖼️ *Send your background picture right now!* (Send any photo or JPG/PNG image — best in landscape `16:9` ratio)."
          );
        }
        if (parts[1] === "bg" && parts[2] === "clear") {
          await vault.setSetting("pnl_bg_data_url", "");
          return await showPnlStudioScreen(vault, ctx, true);
        }
      }

      if (data === "set:previewcard") {
        return await sendSamplePnlPreview(ctx, vault);
      }

      // Admin
      if (parts[0] === "admin") {
        if (!(await services.adminDb.isAdmin(telegramId))) return;
        if (parts[1] === "gencode") {
          const maxUses = Number(parts[2] ?? 1);
          setPrompt(telegramId, { kind: "await_admin_code_label", maxUses }, vault);
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
    const pending = await getPrompt(telegramId, vault);

    if (!pending) {
      // Auto-detect pasted token contract address right in chat!
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text) || /^0x[a-fA-F0-9]{40}$/.test(text)) {
        await scanAddressInput(ctx, telegramId, text);
        return;
      }
      await safeReply(
        ctx,
        "💡 Paste any coin OR wallet address right here, or tap /menu to open all controls!"
      );
      return;
    }

    try {
      switch (pending.kind) {
        case "await_set_balance": {
          const spec = CHAINS[pending.chain];
          const atomic = parseExactUnits(cleanDecimalInput(text), spec.nativeDecimals);
          await vault.setVirtualFunds(pending.chain, atomic, true);
          const price = await services.market.getNativePriceUsd(pending.chain).catch(() => 0);
          const usd = nativeAtomicToUsd(atomic, spec.nativeDecimals, price);
          clearPrompt(telegramId, vault);
          await safeReply(
            ctx,
            `✅ Updated *${spec.name}* balance to \`${formatExactUnits(atomic, spec.nativeDecimals)} ${spec.nativeSymbol}\`${
              price > 0 ? ` (≈ *${formatUsd(usd)} USDT*)` : ""
            }!`
          );
          await showFundsScreen(vault, ctx, false);
          return;
        }

        case "await_add_balance_native": {
          const spec = CHAINS[pending.chain];
          const addAtomic = parseExactUnits(cleanDecimalInput(text), spec.nativeDecimals);
          if (addAtomic <= 0n) throw new Error("Enter an amount greater than 0.");
          const [nextBal, price] = await Promise.all([
            vault.addVirtualFunds(pending.chain, addAtomic),
            services.market.getNativePriceUsd(pending.chain).catch(() => 0)
          ]);
          const addedUsd = nativeAtomicToUsd(addAtomic, spec.nativeDecimals, price);
          const totalUsd = nativeAtomicToUsd(nextBal, spec.nativeDecimals, price);
          clearPrompt(telegramId, vault);
          await safeReply(
            ctx,
            `✅ Added \`${formatExactUnits(addAtomic, spec.nativeDecimals)} ${spec.nativeSymbol}\`${
              price > 0 ? ` (≈ *${formatUsd(addedUsd)} USDT*)` : ""
            }!\nNew *${spec.name}* Balance: \`${formatExactUnits(nextBal, spec.nativeDecimals)} ${spec.nativeSymbol}\`${
              price > 0 ? ` (≈ *${formatUsd(totalUsd)} USDT*)` : ""
            }`
          );
          await showFundsScreen(vault, ctx, false);
          return;
        }

        case "await_add_balance_usd": {
          const spec = CHAINS[pending.chain];
          const usdVal = Number(cleanDecimalInput(text));
          if (!Number.isFinite(usdVal) || usdVal <= 0 || usdVal > 1_000_000_000) {
            throw new Error("Enter a valid dollar amount, like `250` or `19.50`.");
          }
          const price = await services.market.getNativePriceUsd(pending.chain);
          if (price <= 0) {
            throw new Error(`Couldn't fetch live ${spec.nativeSymbol} price right now — try adding in ${spec.nativeSymbol} instead.`);
          }
          const addAtomic = usdToNativeAtomic(usdVal, spec.nativeDecimals, price);
          if (addAtomic <= 0n) throw new Error("Dollar amount is too small to convert.");
          const nextBal = await vault.addVirtualFunds(pending.chain, addAtomic);
          const totalUsd = nativeAtomicToUsd(nextBal, spec.nativeDecimals, price);
          clearPrompt(telegramId, vault);
          await safeReply(
            ctx,
            `✅ Added \`${formatExactUnits(addAtomic, spec.nativeDecimals)} ${spec.nativeSymbol}\` (≈ *${formatUsd(usdVal)} USDT* at *${formatUsd(price)}/${spec.nativeSymbol}*)!\nNew *${spec.name}* Balance: \`${formatExactUnits(nextBal, spec.nativeDecimals)} ${spec.nativeSymbol}\` (≈ *${formatUsd(totalUsd)} USDT*)`
          );
          await showFundsScreen(vault, ctx, false);
          return;
        }

        case "await_investigate_address": {
          clearPrompt(telegramId, vault);
          if (isValidAddressFormat("solana", text)) {
            return await runAndSendWalletDetective(ctx, vault, {
              chain: "solana",
              address: text.trim(),
              days: 7
            });
          }
          if (/^0x[a-fA-F0-9]{40}$/.test(text.trim())) {
            return await runAndSendWalletDetective(ctx, vault, {
              chain: "evm_auto",
              address: text.trim(),
              days: 7
            });
          }
          throw new Error("Please paste a valid Solana or `0x...` EVM wallet address.");
        }

        case "await_buy_token_ca": {
          clearPrompt(telegramId, vault);
          await scanAddressInput(ctx, telegramId, text, pending.chain);
          return;
        }

        case "await_custom_buy_amount": {
          const spec = CHAINS[pending.chain];
          const atomic = parseExactUnits(cleanDecimalInput(text), spec.nativeDecimals);
          clearPrompt(telegramId, vault);
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
            clearPrompt(telegramId, vault);
            return await safeReply(ctx, "❌ Position is no longer open.");
          }
          clearPrompt(telegramId, vault);
          if (text.endsWith("%")) {
            const pct = Number(text.slice(0, -1).replace(/,/g, "").trim());
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
          const tokensAtomic = parseExactUnits(cleanDecimalInput(text), pos.tokenDecimals);
          const res = await services.trading.executeSell(vault, {
            positionId: pos.id,
            sellTokensAtomic: tokensAtomic,
            sourceType: "manual"
          });
          return await sendSellSuccess(ctx, res);
        }

        case "await_limit_buy": {
          const [mcStr, amtStr] = text.split(/\s+/);
          const targetMc = Number((mcStr ?? "").replace(/[$,]/g, ""));
          if (!Number.isFinite(targetMc) || targetMc <= 0 || !amtStr) {
            throw new Error("Send two numbers: `<target_mc_usd> <amount>`, e.g. `50000 0.5`");
          }
          const spec = CHAINS[pending.chain];
          const amountAtomic = parseExactUnits(cleanDecimalInput(amtStr), spec.nativeDecimals);
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
          clearPrompt(telegramId, vault);
          return await safeReply(
            ctx,
            `🎯 *Limit Buy #${id} Active!*\nWill buy *${formatExactUnits(amountAtomic, spec.nativeDecimals)} ${spec.nativeSymbol}* of *$${escapeMd(symbol)}* if Market Cap hits ≤ ${formatUsd(targetMc)}.`
          );
        }

        case "await_dca_buy": {
          const [amtStr, minStr, countStr] = text.split(/[\s,]+/).filter(Boolean);
          const intervalMin = Number((minStr ?? "").replace(/,/g, ""));
          const count = Math.floor(Number((countStr ?? "").replace(/,/g, "")));
          if (!amtStr || !Number.isFinite(intervalMin) || intervalMin < 1 || !Number.isFinite(count) || count < 1) {
            throw new Error("Send 3 numbers: `<amount> <minutes> <count>`, e.g. `0.2 15 5`");
          }
          const spec = CHAINS[pending.chain];
          const amountAtomic = parseExactUnits(cleanDecimalInput(amtStr), spec.nativeDecimals);
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
          clearPrompt(telegramId, vault);
          return await safeReply(
            ctx,
            `🔁 *DCA Order #${id} Started!*\nWill buy *${formatExactUnits(amountAtomic, spec.nativeDecimals)} ${spec.nativeSymbol}* of *$${escapeMd(symbol)}* every ${intervalMin}m (${count} times).`
          );
        }

        case "await_pos_order": {
          const pos = await vault.getPositionById(pending.positionId);
          if (!pos || pos.status !== "open") {
            clearPrompt(telegramId, vault);
            return await safeReply(ctx, "❌ Position is no longer open.");
          }
          const [pctStr, sellPctStr] = text.split(/\s+/);
          const trigger = Number((pctStr ?? "").replace(/[%,]/g, ""));
          const sellPct = Math.min(100, Math.max(1, Number((sellPctStr ?? "100").replace(/[%,]/g, ""))));
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
          clearPrompt(telegramId, vault);
          return await safeReply(ctx, `✅ Auto-order saved for *$${escapeMd(pos.tokenSymbol)}*!`);
        }

        case "await_watch_address": {
          if (!isValidAddressFormat(pending.chain, text)) {
            throw new Error(`That doesn't look like a valid ${CHAINS[pending.chain].name} address. Try again:`);
          }
          setPrompt(telegramId, {
            kind: "await_watch_alias",
            chain: pending.chain,
            address: normalizeAddress(pending.chain, text)
          }, vault);
          return await safeReply(
            ctx,
            "🏷️ Give this wallet a nickname so you recognize it in reports (e.g., `AlphaWhale`):"
          );
        }

        case "await_watch_alias": {
          const alias = text.slice(0, 32);
          const spec = CHAINS[pending.chain];
          setPrompt(telegramId, {
            kind: "await_watch_amount",
            chain: pending.chain,
            address: pending.address,
            alias
          }, vault);
          return await safeReply(
            ctx,
            `💵 How much virtual *${spec.nativeSymbol}* should be spent each time *${escapeMd(alias)}* buys?\n\n` +
              `• Type any exact amount (e.g. \`0.25\`, \`0.0005\`, \`0.000000001\`)\n` +
              `• OR type a % of your balance (e.g. \`10%\`)\n` +
              `• OR type \`0\` to *Watch & Alert Only* (great for storage vaults!)`
          );
        }

        case "await_watch_amount": {
          const spec = CHAINS[pending.chain];
          let copyMode: "fixed" | "percent_balance" = "fixed";
          let copyAmountAtomic = 0n;
          let copyPercent = 0;

          if (text.endsWith("%")) {
            copyMode = "percent_balance";
            copyPercent = Number(text.slice(0, -1).replace(/,/g, "").trim());
            if (!Number.isFinite(copyPercent) || copyPercent <= 0 || copyPercent > 100) {
              throw new Error("Percentage must be between 0.01% and 100%.");
            }
          } else {
            copyAmountAtomic = parseExactUnits(cleanDecimalInput(text), spec.nativeDecimals);
            if (copyAmountAtomic < 0n) throw new Error("Amount cannot be negative.");
          }

          let walletId: number;
          try {
            walletId = await vault.addWatchedWallet({
              chain: pending.chain,
              address: pending.address,
              alias: pending.alias,
              copyMode,
              copyAmountAtomic,
              copyPercent
            });
          } catch (err) {
            const msg = (err as Error).message;
            if (/unique|duplicate/i.test(msg)) {
              clearPrompt(telegramId, vault);
              return await safeReply(
                ctx,
                `ℹ️ You are already watching \`${shortAddress(pending.address)}\` on *${spec.name}*! Tap *Watch Wallets* in /menu to rename or edit it.`
              );
            }
            throw err;
          }
          clearPrompt(telegramId, vault);
          await services.walletWatcher.reloadWatchers();

          const w = (await vault.getWatchedWallet(walletId))!;
          await safeReply(
            ctx,
            copyAmountAtomic === 0n && copyMode === "fixed"
              ? `🎉 *Now Watching ${escapeMd(w.alias)} (Alert & Investigate Mode)!*\nYou'll get instant funding alerts + weekly detective reports for *${spec.name}*.`
              : `🎉 *Now Watching ${escapeMd(w.alias)} Live!*\nThe very second this wallet trades on *${spec.name}*, your vault will copy it automatically.`
          );
          return await safeReply(ctx, formatWatchedWalletMessage(w), buildWatcherDetailKeyboard(w));
        }

        case "await_rename_watch": {
          const w = await vault.getWatchedWallet(pending.walletId);
          if (!w) {
            clearPrompt(telegramId, vault);
            return await safeReply(ctx, "❌ Wallet not found.");
          }
          const newAlias = text.slice(0, 32).trim();
          if (!newAlias) throw new Error("Please enter a valid name.");
          await vault.updateWatchedWallet(w.id, { alias: newAlias });
          clearPrompt(telegramId, vault);
          await services.walletWatcher.reloadWatchers();
          const updated = (await vault.getWatchedWallet(w.id))!;
          await safeReply(ctx, `✅ Renamed wallet to *${escapeMd(updated.alias)}*!`);
          return await safeReply(
            ctx,
            formatWatchedWalletMessage(updated),
            buildWatcherDetailKeyboard(updated)
          );
        }

        case "await_edit_watch_amount": {
          const w = await vault.getWatchedWallet(pending.walletId);
          if (!w) {
            clearPrompt(telegramId, vault);
            return await safeReply(ctx, "❌ Wallet not found.");
          }
          const spec = CHAINS[w.chain];
          if (text.endsWith("%")) {
            const pct = Number(text.slice(0, -1).replace(/,/g, "").trim());
            if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
              throw new Error("Percentage must be between 0.01% and 100%.");
            }
            await vault.updateWatchedWallet(w.id, {
              copyMode: "percent_balance",
              copyPercent: pct,
              copyAmountAtomic: 0n
            });
          } else {
            const amt = parseExactUnits(cleanDecimalInput(text), spec.nativeDecimals);
            if (amt < 0n) throw new Error("Amount cannot be negative.");
            await vault.updateWatchedWallet(w.id, {
              copyMode: "fixed",
              copyAmountAtomic: amt,
              copyPercent: 0
            });
          }
          clearPrompt(telegramId, vault);
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
            clearPrompt(telegramId, vault);
            return await safeReply(ctx, "❌ Wallet not found.");
          }
          const isOff = text.toLowerCase() === "off";
          if (pending.field === "tp_sl") {
            if (isOff) {
              await vault.updateWatchedWallet(w.id, { autoTpPct: null, autoSlPct: null });
            } else {
              const [tpStr, slStr] = text.split(/\s+/);
              const tp = Number((tpStr ?? "").replace(/[%,]/g, ""));
              const sl = Number((slStr ?? "").replace(/[%,]/g, ""));
              if (!Number.isFinite(tp) || tp <= 0 || !Number.isFinite(sl) || sl >= 0) {
                throw new Error("Example format: `150 -40` (positive TP, negative SL) or `off`");
              }
              await vault.updateWatchedWallet(w.id, { autoTpPct: tp, autoSlPct: sl });
            }
          } else if (pending.field === "trail") {
            if (isOff) {
              await vault.updateWatchedWallet(w.id, { autoTrailingPct: null });
            } else {
              const trail = Number(text.replace(/[%,\s]/g, ""));
              if (!Number.isFinite(trail) || trail <= 0 || trail >= 100) {
                throw new Error("Enter a percentage between 1 and 99 (e.g., `25`), or `off`.");
              }
              await vault.updateWatchedWallet(w.id, { autoTrailingPct: trail });
            }
          } else {
            const val = isOff ? null : Number(cleanDecimalInput(text));
            if (!isOff && (!Number.isFinite(val) || (val as number) < 0)) {
              throw new Error("Enter a valid dollar number like `25000` or `off`.");
            }
            if (pending.field === "min_mc") await vault.updateWatchedWallet(w.id, { minMcUsd: val });
            if (pending.field === "max_mc") await vault.updateWatchedWallet(w.id, { maxMcUsd: val });
            if (pending.field === "min_liq") await vault.updateWatchedWallet(w.id, { minLiqUsd: val });
          }
          clearPrompt(telegramId, vault);
          await services.walletWatcher.reloadWatchers();
          const updated = (await vault.getWatchedWallet(w.id))!;
          return await safeReply(
            ctx,
            formatWatchedWalletMessage(updated),
            buildWatcherDetailKeyboard(updated)
          );
        }

        case "await_slippage": {
          const pct = Number(text.replace(/[%,\s]/g, ""));
          if (!Number.isFinite(pct) || pct < 0.1 || pct > 90) {
            throw new Error("Enter a slippage % between 0.1 and 90.");
          }
          await vault.setSetting("slippage_bps", String(Math.round(pct * 100)));
          clearPrompt(telegramId, vault);
          return await safeReply(
            ctx,
            `✅ Slippage set to *${pct.toFixed(1)}%*.`,
            buildSettingsKeyboard(await vault.getSettings())
          );
        }

        case "await_gas_fee": {
          const spec = CHAINS[pending.chain];
          const parsed = parseExactUnits(cleanDecimalInput(text), spec.nativeDecimals);
          const formatted = formatExactUnits(parsed, spec.nativeDecimals);
          if (pending.chain === "solana") await vault.setSetting("priority_fee_sol", formatted);
          else await vault.setSetting("evm_gas_eth", formatted);
          clearPrompt(telegramId, vault);
          return await safeReply(
            ctx,
            `✅ Network fee updated to \`${formatted} ${spec.nativeSymbol}\`.`,
            buildSettingsKeyboard(await vault.getSettings())
          );
        }

        case "await_pnl_accent": {
          const hex = resolveAccentColorInput(text);
          if (!hex) {
            throw new Error("Send a hex code like `#FF5500` or a color word like `red`, `purple`, `gold`, `blue`, `green`, `pink`.");
          }
          await vault.setSetting("pnl_accent_hex", hex);
          clearPrompt(telegramId, vault);
          await safeReply(ctx, `✅ PnL Card accent color set to \`${hex}\`!`);
          return await showPnlStudioScreen(vault, ctx, false);
        }

        case "await_pnl_bg": {
          if (text.toLowerCase() === "cancel" || text.toLowerCase() === "skip") {
            clearPrompt(telegramId, vault);
            return await showPnlStudioScreen(vault, ctx, false);
          }
          return await safeReply(
            ctx,
            "🖼️ Please send a *photo* or *PNG/JPG image* right here (or tap a menu button / send `cancel`)."
          );
        }

        case "await_admin_code_label": {
          const label = text.toLowerCase() === "skip" ? undefined : text.slice(0, 40);
          const code = await services.adminDb.generateAccessCode({
            createdBy: telegramId,
            label,
            maxUses: pending.maxUses
          });
          clearPrompt(telegramId, vault);
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

  const handleUploadedPnlBg = async (ctx: Context, fileId: string, fileSize?: number) => {
    const ok = await requireAuthorized(ctx);
    if (!ok) return;
    const { telegramId, vault } = ok;
    const pending = await getPrompt(telegramId, vault);
    if (pending?.kind !== "await_pnl_bg") {
      await safeReply(
        ctx,
        "💡 To use that photo as your PnL Card background, tap *Settings → 🎨 Customize PnL Card → 🖼️ Upload Background Photo* first!"
      );
      return;
    }

    try {
      if (fileSize && fileSize > 1_500_000) {
        throw new Error("That image is larger than 1.5 MB. Please send it as a regular Telegram photo or a smaller PNG/JPG.");
      }
      const file = await ctx.api.getFile(fileId);
      if (!file.file_path) {
        throw new Error("Could not download that image from Telegram.");
      }
      const res = await fetch(
        `https://api.telegram.org/file/bot${services.config.botToken}/${file.file_path}`,
        { signal: AbortSignal.timeout(10_000) }
      );
      if (!res.ok) throw new Error("Failed downloading image from Telegram.");
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 1_600_000) {
        throw new Error("Image is too big (max 1.5 MB). Try sending a compressed photo!");
      }
      const mime = detectImageMime(buf);
      if (!mime) {
        throw new Error("Unsupported image format. Please send a normal photo, JPG, or PNG image.");
      }
      const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
      await vault.setSetting("pnl_bg_data_url", dataUrl);
      clearPrompt(telegramId, vault);
      await safeReply(ctx, "✅ Custom PnL Card background saved! Here is your live preview:");
      await sendSamplePnlPreview(ctx, vault);
      await showPnlStudioScreen(vault, ctx, false);
    } catch (err) {
      await safeReply(ctx, `❌ ${(err as Error).message}`);
    }
  };

  bot.on("message:photo", async (ctx) => {
    const photos = ctx.message.photo;
    if (!photos || photos.length === 0) return;
    const picked =
      [...photos].reverse().find((p) => (p.file_size ?? 0) <= 1_500_000) ?? photos[0];
    await handleUploadedPnlBg(ctx, picked.file_id, picked.file_size);
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    if (!doc) return;
    const mime = doc.mime_type?.toLowerCase() ?? "";
    if (!mime.startsWith("image/")) return;
    await handleUploadedPnlBg(ctx, doc.file_id, doc.file_size);
  });

  bot.catch((err) => {
    console.error("Telegram bot error:", err.error);
  });

  return bot;
}
