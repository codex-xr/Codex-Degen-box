import "dotenv/config";
import path from "node:path";

function parseNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIdList(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  if (!raw) return set;
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (/^\d+$/.test(trimmed)) set.add(trimmed);
  }
  return set;
}

export interface AppConfig {
  botToken: string;
  adminTelegramIds: Set<string>;
  adminBootstrapCode: string;
  maxCabalUsers: number;
  dataDir: string;
  adminDbPath: string;
  userVaultDir: string;
  databaseUrl: string;
  heliusApiKey: string;
  solanaRpcUrl: string;
  solanaWsUrl: string;
  baseRpcUrl: string;
  baseWsUrl: string;
  robinhoodRpcUrl: string;
  robinhoodFallbackRpcUrl: string;
  robinhoodWsUrl: string;
  birdeyeApiKey: string;
  geminiApiKey: string;
  openaiApiKey: string;
  webhookPort: number;
  webhookSecret: string;
  orderPollMs: number;
  evmPollMs: number;
  solanaFallbackPollMs: number;
  weeklyReportDayUtc: number;
  weeklyReportHourUtc: number;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = path.resolve(overrides.dataDir ?? process.env.DATA_DIR ?? "./data");
  const heliusApiKey = (overrides.heliusApiKey ?? process.env.HELIUS_API_KEY ?? "").trim();

  const defaultSolRpc = heliusApiKey
    ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
    : "https://api.mainnet-beta.solana.com";
  const defaultSolWs = heliusApiKey
    ? `wss://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
    : "wss://api.mainnet-beta.solana.com";

  return {
    botToken: (overrides.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "").trim(),
    adminTelegramIds: overrides.adminTelegramIds ?? parseIdList(process.env.ADMIN_TELEGRAM_IDS),
    adminBootstrapCode: (overrides.adminBootstrapCode ?? process.env.ADMIN_BOOTSTRAP_CODE ?? "").trim(),
    maxCabalUsers: overrides.maxCabalUsers ?? parseNumberEnv("MAX_CABAL_USERS", 10),
    dataDir,
    adminDbPath: overrides.adminDbPath ?? path.join(dataDir, "admin.db"),
    userVaultDir: overrides.userVaultDir ?? path.join(dataDir, "users"),
    databaseUrl: (overrides.databaseUrl ?? process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim(),
    heliusApiKey,
    solanaRpcUrl: (overrides.solanaRpcUrl ?? process.env.SOLANA_RPC_URL ?? defaultSolRpc).trim(),
    solanaWsUrl: (overrides.solanaWsUrl ?? process.env.SOLANA_WS_URL ?? defaultSolWs).trim(),
    baseRpcUrl: (overrides.baseRpcUrl ?? process.env.BASE_RPC_URL ?? "https://mainnet.base.org").trim(),
    baseWsUrl: (overrides.baseWsUrl ?? process.env.BASE_WS_URL ?? "wss://base-rpc.publicnode.com").trim(),
    robinhoodRpcUrl: (
      overrides.robinhoodRpcUrl ??
      process.env.ROBINHOOD_RPC_URL ??
      "https://rpc.mainnet.chain.robinhood.com"
    ).trim(),
    robinhoodFallbackRpcUrl: (
      overrides.robinhoodFallbackRpcUrl ??
      process.env.ROBINHOOD_FALLBACK_RPC_URL ??
      "https://robinhood-mainnet.gateway.tatum.io"
    ).trim(),
    robinhoodWsUrl: (
      overrides.robinhoodWsUrl ??
      process.env.ROBINHOOD_WS_URL ??
      "wss://feed.mainnet.chain.robinhood.com"
    ).trim(),
    birdeyeApiKey: (overrides.birdeyeApiKey ?? process.env.BIRDEYE_API_KEY ?? "").trim(),
    geminiApiKey: (overrides.geminiApiKey ?? process.env.GEMINI_API_KEY ?? "").trim(),
    openaiApiKey: (overrides.openaiApiKey ?? process.env.OPENAI_API_KEY ?? "").trim(),
    webhookPort: overrides.webhookPort ?? parseNumberEnv("PORT", parseNumberEnv("WEBHOOK_PORT", 8787)),
    webhookSecret: (overrides.webhookSecret ?? process.env.HELIUS_WEBHOOK_SECRET ?? "").trim(),
    orderPollMs: overrides.orderPollMs ?? parseNumberEnv("ORDER_POLL_MS", 5000),
    evmPollMs: overrides.evmPollMs ?? parseNumberEnv("EVM_POLL_MS", 2500),
    solanaFallbackPollMs: overrides.solanaFallbackPollMs ?? parseNumberEnv("SOLANA_FALLBACK_POLL_MS", 5000),
    weeklyReportDayUtc: overrides.weeklyReportDayUtc ?? parseNumberEnv("WEEKLY_REPORT_DAY_UTC", 0),
    weeklyReportHourUtc: overrides.weeklyReportHourUtc ?? parseNumberEnv("WEEKLY_REPORT_HOUR_UTC", 18)
  };
}
