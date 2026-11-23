import { InputFile } from "grammy";
import { loadConfig } from "./config.js";
import { AdminDb } from "./db/adminDb.js";
import { UserVaultManager } from "./db/userVault.js";
import { createTelegramBot } from "./bot/telegramBot.js";
import { CopyEngine } from "./services/copyEngine.js";
import { EvmClientManager } from "./services/evmClients.js";
import { MarketDataService } from "./services/marketData.js";
import { OrderMonitorService } from "./services/orderMonitor.js";
import { PnlCardRenderer } from "./services/pnlCard.js";
import { SecurityService } from "./services/security.js";
import { SolanaClientManager } from "./services/solanaClient.js";
import { ExecutionResult, TradingEngine } from "./services/tradingEngine.js";
import { WalletWatcherService } from "./services/walletWatcher.js";
import { WeeklyReportService } from "./services/weeklyReport.js";
import { formatUsd } from "./utils/amounts.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.botToken) {
    console.error("Missing TELEGRAM_BOT_TOKEN in .env! Copy .env.example to .env and add your bot token.");
    process.exit(1);
  }

  const adminDb = new AdminDb(config.adminDbPath, config.maxCabalUsers, config.adminBootstrapCode);
  adminDb.ensureAdminsFromConfig(config.adminTelegramIds);

  const vaultManager = new UserVaultManager(config.userVaultDir);
  const evmClients = new EvmClientManager(config);
  const solanaClient = new SolanaClientManager(config);
  const market = new MarketDataService(config, evmClients, solanaClient);
  const security = new SecurityService();
  const trading = new TradingEngine(market, security);
  const pnlCards = new PnlCardRenderer();
  const weeklyReports = new WeeklyReportService({ config, adminDb, vaultManager, market });

  let botInstance: ReturnType<typeof createTelegramBot> | null = null;

  const notifyUser = async (telegramId: string, text: string, result?: ExecutionResult) => {
    if (!botInstance) return;
    try {
      await botInstance.api.sendMessage(telegramId, text, {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true }
      });
    } catch {
      await botInstance.api
        .sendMessage(telegramId, text.replace(/[*_`]/g, ""))
        .catch(() => {});
    }

    // Automatically deliver a PNG PnL Card whenever a position closes on sell/TP/SL/copy-sell
    if (result && result.positionClosed && result.side !== "buy") {
      try {
        const vault = vaultManager.getVault(telegramId);
        const pos = vault.getPositionById(result.positionId);
        if (!pos) return;
        const wallet = pos.copiedWalletId ? vault.getWatchedWallet(pos.copiedWalletId) : null;
        const investedUsd = pos.initialCostUsd > 0 ? pos.initialCostUsd : pos.costUsd;
        const totalPnlUsd = pos.realizedUsd - investedUsd;
        const roiPct = investedUsd > 0 ? (totalPnlUsd / investedUsd) * 100 : -100;
        const png = await pnlCards.renderPng({
          theme: vault.getSettings().pnlTheme,
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
          statusLabel: pos.status.toUpperCase()
        });
        await botInstance.api.sendPhoto(telegramId, new InputFile(png, `pnl-${pos.tokenSymbol}.png`), {
          caption: `🖼️ $${pos.tokenSymbol} • ${roiPct >= 0 ? "+" : ""}${roiPct.toFixed(1)}% (${
            totalPnlUsd >= 0 ? "+" : ""
          }${formatUsd(totalPnlUsd)})`
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
    copyEngine
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
    console.log("Shutting down Codex Degen Box...");
    orderMonitor.stop();
    weeklyReports.stopScheduler();
    await walletWatcher.stop();
    await botInstance?.stop();
    vaultManager.closeAll();
    adminDb.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  console.log("Codex Degen Box is live! Listening for Telegram updates...");
  await botInstance.start();
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
