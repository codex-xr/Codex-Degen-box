import { InlineKeyboard, InputFile } from "grammy";
import { CHAINS, shortAddress } from "./chains/registry.js";
import { loadConfig } from "./config.js";
import { AdminDb } from "./db/adminDb.js";
import { UserVaultManager } from "./db/userVault.js";
import {
  createPgPool,
  PostgresAdminDb,
  PostgresVaultManager
} from "./db/postgresStore.js";
import { IAdminDb, IVaultManager } from "./db/types.js";
import { escapeMd, stripMdForFallback } from "./bot/formatters.js";
import { createTelegramBot, shortChainCode } from "./bot/telegramBot.js";
import { CopyEngine } from "./services/copyEngine.js";
import { EvmClientManager } from "./services/evmClients.js";
import { MarketDataService } from "./services/marketData.js";
import { OrderMonitorService } from "./services/orderMonitor.js";
import { PnlCardRenderer } from "./services/pnlCard.js";
import { SecurityService } from "./services/security.js";
import { SolanaClientManager } from "./services/solanaClient.js";
import { ExecutionResult, TradingEngine } from "./services/tradingEngine.js";
import { WalletDetectiveService } from "./services/walletDetective.js";
import { WalletWatcherService } from "./services/walletWatcher.js";
import { WeeklyReportService } from "./services/weeklyReport.js";
import { formatUsd } from "./utils/amounts.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.botToken) {
    console.error("Missing TELEGRAM_BOT_TOKEN in .env! Copy .env.example to .env and add your bot token.");
    process.exit(1);
  }

  let adminDb: IAdminDb;
  let vaultManager: IVaultManager;
  let closePgPool: (() => Promise<void>) | null = null;

  if (config.databaseUrl) {
    const pool = createPgPool(config.databaseUrl);
    const pgAdmin = new PostgresAdminDb(pool, config.maxCabalUsers, config.adminBootstrapCode);
    await pgAdmin.init();
    adminDb = pgAdmin;
    vaultManager = new PostgresVaultManager(pool);
    closePgPool = () => pool.end();
    console.log("Storage mode: Supabase / Postgres (private per-user schemas)");
  } else {
    adminDb = new AdminDb(config.adminDbPath, config.maxCabalUsers, config.adminBootstrapCode);
    vaultManager = new UserVaultManager(config.userVaultDir);
    console.log("Storage mode: Local SQLite (private per-user .db files)");
  }

  await adminDb.ensureAdminsFromConfig(config.adminTelegramIds);

  const evmClients = new EvmClientManager(config);
  const solanaClient = new SolanaClientManager(config);
  const market = new MarketDataService(config, evmClients, solanaClient);
  const security = new SecurityService();
  const trading = new TradingEngine(market, security);
  const pnlCards = new PnlCardRenderer();
  const detective = new WalletDetectiveService({ config, evmClients, solanaClient, market });
  const weeklyReports = new WeeklyReportService({ config, adminDb, vaultManager, market, detective });

  let botInstance: ReturnType<typeof createTelegramBot> | null = null;

  const notifyUser = async (telegramId: string, text: string, result?: ExecutionResult) => {
    if (!botInstance) return;
    const chunks: string[] = [];
    if (text.length <= 3800) {
      chunks.push(text);
    } else {
      let cur = "";
      for (const line of text.split("\n")) {
        if (cur.length + line.length + 1 > 3800 && cur.length > 0) {
          chunks.push(cur);
          cur = line;
        } else {
          cur = cur ? `${cur}\n${line}` : line;
        }
      }
      if (cur) chunks.push(cur);
    }
    for (const chunk of chunks) {
      try {
        await botInstance.api.sendMessage(telegramId, chunk, {
          parse_mode: "Markdown",
          link_preview_options: { is_disabled: true }
        });
      } catch {
        await botInstance.api
          .sendMessage(telegramId, stripMdForFallback(chunk), {
            link_preview_options: { is_disabled: true }
          })
          .catch(() => {});
      }
    }

    // Automatically deliver a PNG PnL Card whenever a position closes on sell/TP/SL/copy-sell
    if (result && result.positionClosed && result.side !== "buy") {
      try {
        const vault = await vaultManager.getVault(telegramId);
        const pos = await vault.getPositionById(result.positionId);
        if (!pos) return;
        const wallet = pos.copiedWalletId ? await vault.getWatchedWallet(pos.copiedWalletId) : null;
        const [settings, bgDataUrl, user, cachedHandle] = await Promise.all([
          vault.getSettings(),
          vault.getSetting("pnl_bg_data_url"),
          adminDb.getUser(telegramId).catch(() => null),
          vault.getSetting("telegram_handle")
        ]);
        const traderHandle =
          user?.username
            ? `@${user.username}`
            : cachedHandle || user?.firstName || undefined;
        const investedUsd = pos.initialCostUsd > 0 ? pos.initialCostUsd : pos.costUsd;
        const totalPnlUsd = pos.realizedUsd - investedUsd;
        const roiPct = investedUsd > 0 ? (totalPnlUsd / investedUsd) * 100 : -100;
        const png = await pnlCards.renderPng({
          theme: settings.pnlTheme,
          accentHex: settings.pnlAccentHex,
          hideAmounts: settings.pnlHideAmounts,
          bgDataUrl,
          chain: pos.chain,
          tokenSymbol: pos.tokenSymbol,
          sourceLabel: wallet ? `Copied: ${wallet.alias}` : "Auto Trade",
          roiPct,
          pnlNativeAtomic: pos.realizedNativeAtomic - pos.initialCostNativeAtomic,
          pnlUsd: totalPnlUsd,
          investedNativeAtomic: pos.initialCostNativeAtomic,
          entryMcUsd: pos.entryMcUsd,
          currentOrExitMcUsd: pos.exitMcUsd ?? result.mcUsd,
          holdDurationMs: (pos.closedAt ?? Date.now()) - pos.openedAt,
          statusLabel: pos.status.toUpperCase(),
          traderHandle
        });
        const safeFileSym = pos.tokenSymbol.replace(/[^a-zA-Z0-9_-]/g, "_") || "token";
        const amountSuffix = settings.pnlHideAmounts
          ? ""
          : ` (${totalPnlUsd >= 0 ? "+" : ""}${formatUsd(totalPnlUsd)})`;
        await botInstance.api.sendPhoto(telegramId, new InputFile(png, `pnl-${safeFileSym}.png`), {
          caption: `🖼️ $${pos.tokenSymbol} • ${roiPct >= 0 ? "+" : ""}${roiPct.toFixed(1)}%${amountSuffix}`
        });
      } catch {
        // Ignore card error during notification
      }
    }
  };

  const copyEngine = new CopyEngine({
    vaultManager,
    market,
    security,
    trading,
    onNotify: notifyUser
  });

  const walletWatcher = new WalletWatcherService({
    config,
    adminDb,
    vaultManager,
    evmClients,
    solanaClient,
    copyEngine,
    onTransferAlert: async (telegramId, wallet, transfer) => {
      if (!botInstance) return;
      const spec = CHAINS[transfer.chain];
      const sc = shortChainCode(transfer.chain);
      const arrow = transfer.direction === "out" ? "➡️ Sent" : "⬅️ Received";
      const msg =
        `🚨 *Wallet Movement Alert — ${escapeMd(wallet.alias)}* (${spec.shortBadge})\n\n` +
        `${arrow} *${transfer.amountNative.toFixed(4)} ${transfer.symbol}* ${
          transfer.direction === "out" ? "to" : "from"
        }:\n\`${transfer.counterparty}\`\n\n` +
        `_Tap below to investigate or start watching this connected wallet immediately!_`;
      const kb = new InlineKeyboard()
        .text(`🔍 Investigate ${shortAddress(transfer.counterparty, 4, 4)}`, `dg:${sc}:${transfer.counterparty}`)
        .text(`👁️ Watch ${shortAddress(transfer.counterparty, 4, 4)}`, `dw:${sc}:${transfer.counterparty}`);
      try {
        await botInstance.api.sendMessage(telegramId, msg, {
          parse_mode: "Markdown",
          reply_markup: kb,
          link_preview_options: { is_disabled: true }
        });
      } catch {
        await botInstance.api
          .sendMessage(telegramId, stripMdForFallback(msg), {
            reply_markup: kb,
            link_preview_options: { is_disabled: true }
          })
          .catch(() => {});
      }
    }
  });

  const orderMonitor = new OrderMonitorService({
    adminDb,
    vaultManager,
    market,
    security,
    trading,
    onNotify: notifyUser
  });

  botInstance = createTelegramBot({
    config,
    adminDb,
    vaultManager,
    market,
    security,
    trading,
    pnlCards,
    detective,
    weeklyReports,
    walletWatcher
  });

  await botInstance.api
    .setMyCommands([
      { command: "start", description: "Start bot / Enter invite code" },
      { command: "menu", description: "Open main menu" },
      { command: "funds", description: "View & set virtual play funds" },
      { command: "buy", description: "Scan or buy a token" },
      { command: "positions", description: "Open trades & auto-orders" },
      { command: "watch", description: "Watch & copy wallets live" },
      { command: "report", description: "Weekly alpha & pattern report" },
      { command: "pnl", description: "Generate PnL image card" },
      { command: "settings", description: "Trading & card settings" },
      { command: "admin", description: "Admin invite code panel" },
      { command: "help", description: "How everything works" }
    ])
    .catch(() => {});

  await walletWatcher.start();
  orderMonitor.start(config.orderPollMs);
  weeklyReports.startScheduler(async (telegramId, reportText) => {
    await notifyUser(telegramId, reportText);
  });

  const shutdown = async () => {
    console.log("Shutting down Evil.fun...");
    orderMonitor.stop();
    weeklyReports.stopScheduler();
    await walletWatcher.stop();
    await botInstance?.stop();
    await vaultManager.closeAll();
    await adminDb.close();
    if (closePgPool) await closePgPool();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  console.log("Evil.fun is live! Listening for Telegram updates...");
  await botInstance.start();
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
