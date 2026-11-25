import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { escapeMd, formatTokenScanMessage, formatWalletLeaderboardMessage, stripMdForFallback } from "../src/bot/formatters.js";
import {
  buildDetectiveKeyboard,
  buildSettingsKeyboard,
  buildTokenTradeKeyboard,
  buildWatcherDetailKeyboard,
  buildWatchersKeyboard
} from "../src/bot/keyboards.js";
import { ChainKey } from "../src/chains/registry.js";
import { AdminDb } from "../src/db/adminDb.js";
import { UserVaultManager } from "../src/db/userVault.js";
import { loadConfig } from "../src/config.js";
import { CopyEngine } from "../src/services/copyEngine.js";
import { EvmClientManager } from "../src/services/evmClients.js";
import { MarketDataService, TokenSnapshot } from "../src/services/marketData.js";
import { OrderMonitorService } from "../src/services/orderMonitor.js";
import { PnlCardRenderer } from "../src/services/pnlCard.js";
import { SecurityService, TokenSecurityReport } from "../src/services/security.js";
import { SolanaClientManager } from "../src/services/solanaClient.js";
import { TradingEngine } from "../src/services/tradingEngine.js";
import { WalletDetectiveService, WalletInvestigationReport } from "../src/services/walletDetective.js";
import { WalletWatcherService } from "../src/services/walletWatcher.js";
import { WeeklyReportService } from "../src/services/weeklyReport.js";
import { formatExactUnits, parseExactUnits, parseNativeOrUsdInput, usdToNativeAtomic } from "../src/utils/amounts.js";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFakeSnap(overrides: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    chain: "solana",
    address: "So111TokenMint11111111111111111111111111111",
    symbol: "PEPECAT",
    name: "Pepe Cat",
    decimals: 6,
    pairAddress: "Pair111111111111111111111111111111111111111",
    dex: "raydium",
    dexUrl: "https://dexscreener.com/solana/pair",
    priceUsd: 0.001,
    priceNative: 0.00001,
    nativePriceUsd: 100,
    mcUsd: 50_000,
    fdvUsd: 50_000,
    liquidityUsd: 40_000,
    volume5mUsd: 18_000,
    volume1hUsd: 60_000,
    volume24hUsd: 120_000,
    txns5mBuys: 45,
    txns5mSells: 20,
    priceChange5m: 25,
    priceChange1h: 80,
    priceChange24h: 150,
    pairCreatedAtMs: Date.now() - 600_000,
    tokenAgeSec: 600,
    imageUrl: null,
    fetchedAt: Date.now(),
    ...overrides
  };
}

function makeSafeSecurity(chain: ChainKey = "solana"): TokenSecurityReport {
  return {
    chain,
    address: "So111TokenMint11111111111111111111111111111",
    riskLevel: "safe",
    isHoneypot: false,
    cannotBuy: false,
    cannotSellAll: false,
    buyTaxBps: 0,
    sellTaxBps: 0,
    mintable: false,
    freezable: false,
    top10Pct: 18,
    warnings: [],
    source: "test",
    checkedAt: Date.now()
  };
}

test("exact decimal precision down to lowest unit (9 decimals SOL & 18 decimals ETH)", () => {
  const oneLamport = parseExactUnits("0.000000001", 9);
  assert.equal(oneLamport, 1n);
  assert.equal(formatExactUnits(oneLamport, 9), "0.000000001");

  const oneWei = parseExactUnits("0.000000000000000001", 18);
  assert.equal(oneWei, 1n);
  assert.equal(formatExactUnits(oneWei, 18), "0.000000000000000001");

  const largeEth = parseExactUnits("12.345678901234567891", 18);
  assert.equal(formatExactUnits(largeEth, 18), "12.345678901234567891");

  assert.throws(() => parseExactUnits("0.0000000001", 9), /Maximum precision/);
  assert.throws(() => parseExactUnits("-5", 9), /Invalid amount/);
});

test("admin invite codes, max cabal user limit, and user isolation", async () => {
  const tmp = makeTempDir("degen-auth-");
  try {
    const adminDb = new AdminDb(path.join(tmp, "admin.db"), 2, "FIRSTADMIN");
    const vaults = new UserVaultManager(path.join(tmp, "users"));

    // Bootstrap first admin
    const adminRes = await adminDb.redeemCode({
      code: "FIRSTADMIN",
      telegramId: "1001",
      username: "boss"
    });
    assert.equal(adminRes.ok, true);
    if (adminRes.ok) assert.equal(adminRes.user.role, "admin");

    // Admin generates single-use code
    const code1 = await adminDb.generateAccessCode({ createdBy: "1001", label: "Member1", maxUses: 1 });
    const member1 = await adminDb.redeemCode({ code: code1.code, telegramId: "1002", username: "m1" });
    assert.equal(member1.ok, true);

    // Same single-use code cannot be reused by a third user
    const reuse = await adminDb.redeemCode({ code: code1.code, telegramId: "1003" });
    assert.equal(reuse.ok, false);

    // Max cabal user limit (2) blocks new member when reached
    const code2 = await adminDb.generateAccessCode({ createdBy: "1001", label: "Member2", maxUses: 1 });
    const blocked = await adminDb.redeemCode({ code: code2.code, telegramId: "1003" });
    assert.equal(blocked.ok, false);

    // Private vault isolation check: separate DB files & separate funds
    const v1 = await vaults.getVault("1001");
    const v2 = await vaults.getVault("1002");
    assert.notEqual(v1.dbPath, v2.dbPath);
    assert.equal(fs.existsSync(v1.dbPath), true);
    assert.equal(fs.existsSync(v2.dbPath), true);

    await v1.setVirtualFunds("solana", parseExactUnits("50.123456789", 9));
    assert.equal((await v1.getBalance("solana")).balanceAtomic, 50_123_456_789n);
    assert.equal((await v2.getBalance("solana")).balanceAtomic, 0n);

    await vaults.closeAll();
    await adminDb.close();
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    } catch {
      // Windows Defender / SQLite WAL handle may hold temp dir briefly
    }
  }
});

test("trading engine handles exact lowest-decimal buys, partial/full sells, and rug write-offs", async () => {
  const tmp = makeTempDir("degen-trade-");
  try {
    const config = loadConfig({ dataDir: tmp });
    const vaults = new UserVaultManager(config.userVaultDir);
    const evm = new EvmClientManager(config);
    const sol = new SolanaClientManager(config);
    const market = new MarketDataService(config, evm, sol);
    const sec = new SecurityService();
    const trading = new TradingEngine(market, sec);

    const vault = await vaults.getVault("777");
    await vault.setVirtualFunds("robinhood", parseExactUnits("1.000000000000000001", 18));
    await vault.setSetting("evm_gas_eth", "0");

    // Buy on Robinhood Chain with custom exact Wei balance
    const entrySnap = makeFakeSnap({
      chain: "robinhood",
      address: "0x020bfc650a365f8bb26819deaabf3e21291018b4",
      symbol: "CASHCAT",
      decimals: 18,
      priceUsd: 0.04,
      nativePriceUsd: 2000,
      mcUsd: 40_000,
      liquidityUsd: 100_000
    });

    const buyRes = await trading.executeBuy(vault, {
      chain: "robinhood",
      tokenAddress: entrySnap.address,
      spendNativeAtomic: parseExactUnits("0.5", 18),
      sourceType: "manual",
      snapshotOverride: entrySnap,
      securityOverride: makeSafeSecurity("robinhood")
    });
    assert.equal(buyRes.side, "buy");
    assert.ok(buyRes.qtyTokenAtomic > 0n);
    assert.equal(
      (await vault.getBalance("robinhood")).balanceAtomic,
      parseExactUnits("0.500000000000000001", 18)
    );

    // Price doubles (2x) -> sell 50%
    const exitSnap = makeFakeSnap({
      ...entrySnap,
      priceUsd: 0.08,
      mcUsd: 80_000
    });
    const partialSell = await trading.executeSell(vault, {
      positionId: buyRes.positionId,
      sellPct: 50,
      sourceType: "manual",
      snapshotOverride: exitSnap,
      securityOverride: makeSafeSecurity("robinhood")
    });
    assert.equal(partialSell.positionClosed, false);
    assert.ok(partialSell.realizedPnlUsd > 400);

    // Remaining 50% rugged -> realistic write-off
    const rugSell = await trading.executeSell(vault, {
      positionId: buyRes.positionId,
      sellPct: 100,
      sourceType: "rug",
      snapshotOverride: { ...exitSnap, liquidityUsd: 0, priceUsd: 0 },
      securityOverride: { ...makeSafeSecurity("robinhood"), isHoneypot: true, riskLevel: "danger" }
    });
    assert.equal(rugSell.side, "rug_writeoff");
    assert.equal(rugSell.positionClosed, true);
    assert.equal((await vault.getPositionById(buyRes.positionId))?.status, "rugged");

    await vaults.closeAll();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("copy engine copies buys/sells with exact wallet attribution & generates weekly report", async () => {
  const tmp = makeTempDir("degen-copy-");
  try {
    const config = loadConfig({ dataDir: tmp });
    const adminDb = new AdminDb(config.adminDbPath, 10);
    const vaults = new UserVaultManager(config.userVaultDir);
    const evm = new EvmClientManager(config);
    const sol = new SolanaClientManager(config);

    // Mock market & security calls to run fast offline
    const market = new MarketDataService(config, evm, sol);
    let currentPrice = 0.001;
    let currentMc = 45_000;
    market.getTokenSnapshot = async () =>
      makeFakeSnap({
        priceUsd: currentPrice,
        mcUsd: currentMc,
        liquidityUsd: 80_000,
        tokenAgeSec: 240
      });
    market.getBatchTokenSnapshots = async () => new Map();

    const sec = new SecurityService();
    sec.checkToken = async () => makeSafeSecurity("solana");

    const trading = new TradingEngine(market, sec);
    const notifications: string[] = [];
    const copy = new CopyEngine({
      vaultManager: vaults,
      market,
      security: sec,
      trading,
      onNotify: async (_uid, msg) => {
        notifications.push(msg);
      }
    });

    const vault = await vaults.getVault("555");
    await vault.setVirtualFunds("solana", parseExactUnits("10", 9));
    await vault.setSetting("sim_delay_ms", "0");
    await vault.setSetting("priority_fee_sol", "0");

    const walletId = await vault.addWatchedWallet({
      chain: "solana",
      address: "WhaleWallet11111111111111111111111111111111",
      alias: "SniperWhale",
      copyMode: "fixed",
      copyAmountAtomic: parseExactUnits("2.5", 9),
      simMode: "ideal",
      mirrorSells: true
    });
    const watched = (await vault.getWatchedWallet(walletId))!;

    // Whale buys -> bot copies 2.5 SOL
    await copy.processSwapForUser("555", watched, {
      chain: "solana",
      walletAddress: watched.address,
      txHash: "sig_buy_1",
      side: "buy",
      tokenAddress: "So111TokenMint11111111111111111111111111111",
      walletNativeAmountAtomic: parseExactUnits("5", 9),
      dex: "raydium",
      detectedAt: Date.now() - 180_000
    });

    assert.equal((await vault.getBalance("solana")).balanceAtomic, parseExactUnits("7.5", 9));
    assert.equal((await vault.listOpenPositions()).length, 1);

    // Token pumps 3x, whale sells -> bot mirrors sell
    currentPrice = 0.003;
    currentMc = 135_000;
    await copy.processSwapForUser("555", watched, {
      chain: "solana",
      walletAddress: watched.address,
      txHash: "sig_sell_1",
      side: "sell",
      tokenAddress: "So111TokenMint11111111111111111111111111111",
      walletNativeAmountAtomic: parseExactUnits("15", 9),
      dex: "raydium",
      detectedAt: Date.now()
    });

    assert.equal((await vault.listOpenPositions()).length, 0);
    assert.ok((await vault.getBalance("solana")).balanceAtomic > parseExactUnits("14", 9));
    assert.equal(notifications.length, 2);

    // Weekly intelligence report picks up SniperWhale as top earner + MC/age buckets
    const reports = new WeeklyReportService({ config, adminDb, vaultManager: vaults, market });
    const { summary, formattedText } = await reports.generateForUser(vault, 7);
    assert.equal(summary.wins, 1);
    assert.equal(summary.walletLeaderboard[0]?.alias, "SniperWhale");
    assert.ok(summary.walletLeaderboard[0].netPnlUsd > 400);
    assert.match(formattedText, /SniperWhale/);
    assert.match(formattedText, /Pattern Recognition/);

    await vaults.closeAll();
    await adminDb.close();
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    } catch {
      // Windows Defender / SQLite WAL handle may hold temp dir briefly
    }
  }
});

test("custom PnL card settings persist per user and render with custom bg, accent color, and hidden bag size", async () => {
  const tmp = makeTempDir("degen-pnlstudio-");
  try {
    const config = loadConfig({ dataDir: tmp });
    const vaults = new UserVaultManager(config.userVaultDir);
    const vault = await vaults.getVault("4242");

    await vault.setSetting("pnl_theme", "gold");
    await vault.setSetting("pnl_accent_hex", "#FF5500");
    await vault.setSetting("pnl_hide_amounts", "1");
    const sampleJpeg =
      "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
    await vault.setSetting("pnl_bg_data_url", sampleJpeg);

    const settings = await vault.getSettings();
    assert.equal(settings.pnlTheme, "gold");
    assert.equal(settings.pnlAccentHex, "#FF5500");
    assert.equal(settings.pnlHideAmounts, true);
    assert.equal(settings.hasPnlBg, true);
    assert.equal(await vault.getSetting("pnl_bg_data_url"), sampleJpeg);

    // Also verify loadConfig upgrades generic public BASE_RPC_URL when ALCHEMY_API_KEY is supplied
    const prevBase = process.env.BASE_RPC_URL;
    process.env.BASE_RPC_URL = "https://mainnet.base.org";
    const upgradedCfg = loadConfig({ dataDir: tmp, alchemyApiKey: "test_alch_key", heliusApiKey: "test_hel_key" });
    assert.equal(upgradedCfg.baseRpcUrl, "https://base-mainnet.g.alchemy.com/v2/test_alch_key");
    assert.equal(upgradedCfg.solanaRpcUrl, "https://mainnet.helius-rpc.com/?api-key=test_hel_key");
    if (prevBase === undefined) delete process.env.BASE_RPC_URL;
    else process.env.BASE_RPC_URL = prevBase;

    const renderer = new PnlCardRenderer();
    const bgDataUrl = await vault.getSetting("pnl_bg_data_url");
    const png = await renderer.renderPng({
      theme: settings.pnlTheme,
      accentHex: settings.pnlAccentHex,
      hideAmounts: settings.pnlHideAmounts,
      bgDataUrl,
      chain: "solana",
      tokenSymbol: "EVIL",
      sourceLabel: "Manual Trade",
      roiPct: 512.4,
      pnlNativeAtomic: 5_124_000_000n,
      pnlUsd: 1024.8,
      investedNativeAtomic: 1_000_000_000n,
      entryMcUsd: 25_000,
      currentOrExitMcUsd: 153_100,
      holdDurationMs: 620_000,
      statusLabel: "CLOSED",
      traderHandle: "@evil_trader"
    });
    assert.ok(Buffer.isBuffer(png));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.ok(png.length > 5000);

    await vaults.closeAll();
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    } catch {
      // Windows Defender / SQLite WAL handle may hold temp dir briefly
    }
  }
});

test("PnL card renderer produces valid PNG image buffer across themes", async () => {
  const renderer = new PnlCardRenderer();
  for (const theme of ["cyber", "solana", "robinhood", "gold"] as const) {
    const png = await renderer.renderPng({
      theme,
      chain: theme === "robinhood" ? "robinhood" : "solana",
      tokenSymbol: "CASHCAT",
      sourceLabel: "Copied: SniperWhale",
      roiPct: 245.6,
      pnlNativeAtomic: 2_456_000_000n,
      pnlUsd: 491.2,
      investedNativeAtomic: 1_000_000_000n,
      entryMcUsd: 45_000,
      currentOrExitMcUsd: 155_500,
      holdDurationMs: 185_000,
      statusLabel: "CLOSED",
      traderHandle: "@cabal_test"
    });
    assert.ok(Buffer.isBuffer(png));
    assert.ok(png.length > 5000);
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  }
});

test("USDT conversion, Ethereum EVM chain, wallet rename, wallet-by-wallet investigation & Detective PNG card", async () => {
  const tmp = makeTempDir("degen-detective-");
  const config = loadConfig({ dataDir: tmp });
  const adminDb = new AdminDb(config.adminDbPath, 10);
  const vaults = new UserVaultManager(config.userVaultDir);
  try {
    const evm = new EvmClientManager(config);
    const sol = new SolanaClientManager(config);
    const market = new MarketDataService(config, evm, sol);

    // Verify USDT -> SOL atomic conversion ($200 USDT @ $200/SOL = 1 SOL)
    const convertedSol = usdToNativeAtomic(200, 9, 200);
    assert.equal(convertedSol, 1_000_000_000n);

    const vault = await vaults.getVault("888");
    const balEth = await vault.addVirtualFunds("ethereum", parseExactUnits("0.25", 18));
    assert.equal(balEth, parseExactUnits("0.25", 18));
    const balAfterTopup = await vault.addVirtualFunds("solana", convertedSol);
    assert.equal(balAfterTopup, 1_000_000_000n);

    // Add wallet with alias and rename it, plus $0 watch-only mode
    const wid = await vault.addWatchedWallet({
      chain: "solana",
      address: "VaultWallet11111111111111111111111111111111",
      alias: "OldStorageName",
      copyMode: "fixed",
      copyAmountAtomic: 0n
    });
    await vault.updateWatchedWallet(wid, { alias: "MainColdVault" });
    const renamed = (await vault.getWatchedWallet(wid))!;
    assert.equal(renamed.alias, "MainColdVault");
    assert.equal(renamed.transferAlerts, true);

    // Mock WalletDetectiveService for offline unit testing of wallet-by-wallet reporting + PNG card
    const detective = new WalletDetectiveService({ config, evmClients: evm, solanaClient: sol, market });
    const sampleReport: WalletInvestigationReport = {
      chain: "solana",
      address: renamed.address,
      days: 7,
      roleSummary: "🧊 Storage / Transfer Vault",
      balanceNative: 42.5,
      nativeBalanceStr: "42.5",
      nativeSymbol: "SOL",
      nativeUsd: 8500,
      topHoldings: [{ symbol: "USDC", address: "EPjF", amountStr: "1200", usdValue: 1200 }],
      totalHoldingsUsd: 9700,
      activityCount: 14,
      swapsCount: 0,
      transfersCount: 14,
      lastActiveAtMs: Date.now() - 3600_000,
      peakHoursUtc: "14:00–17:00 UTC",
      tradingStyle: "Transfer / Storage vault",
      firstFunder: { address: "BinanceHot", label: "Binance Hot", amountNative: 50, timestampMs: Date.now() - 86400_000 },
      identity: {
        domains: ["vaultking.sol"],
        twitterHandles: ["vault_king_sol"],
        farcasterHandles: [],
        pumpUsername: null,
        pumpFollowers: null,
        linkedEvmWallet: "0x1234567890123456789012345678901234567890",
        linkedSolWallet: null,
        coinSocialTwitters: []
      },
      launchedCount: 1,
      launchedCoins: [{ name: "VaultCat", symbol: "VCAT", address: "Mint1", mcUsd: 150000, graduated: true, twitter: "vault_king_sol", createdAtMs: null }],
      connectedWallets: [
        {
          address: "SniperBuddy11111111111111111111111111111111",
          label: "sniper.sol",
          isExchangeOrApp: false,
          interactionsCount: 9,
          inflowNative: 12.4,
          outflowNative: 0,
          directionTag: "⬅️ Sent funds INTO this wallet",
          tokenMovesCount: 2,
          lastInteractionAtMs: Date.now() - 1800_000,
          activityCount: 38,
          lastActiveAtMs: Date.now() - 900_000,
          swapsCount: 31,
          nativeBalance: 6.2,
          nativeUsd: 1240,
          topHolding: "$BONK (50000)",
          totalHoldingsUsd: 1500,
          launchedCount: 2,
          launchedCoins: [{ name: "MemeOne", symbol: "MEME", address: "Mint2", mcUsd: 80000, graduated: false, twitter: "sniper_x", createdAtMs: null }],
          identity: {
            domains: ["sniper.sol"],
            twitterHandles: ["sniper_x"],
            farcasterHandles: [],
            pumpUsername: "sniper_pump",
            pumpFollowers: 420,
            linkedEvmWallet: null,
            linkedSolWallet: null,
            coinSocialTwitters: []
          },
          roleBadge: "🪙🔥 Launcher & Trader",
          tradingStyle: "High-frequency trader",
          hop2Targets: [{ address: "Hop2Wallet11111111111111111111111111111111", label: null, count: 4, direction: "out" }]
        }
      ],
      crossChainGlances: [],
      notes: [],
      generatedAt: Date.now()
    };
    detective.investigateWallet = async () => sampleReport;

    const reports = new WeeklyReportService({ config, adminDb, vaultManager: vaults, market, detective });
    const perWallet = await reports.generateForWatchedWallet(vault, wid, 7);
    assert.ok(perWallet);
    assert.match(perWallet.formattedText, /MainColdVault/);
    assert.match(perWallet.formattedText, /sniper\.sol/);
    assert.match(perWallet.formattedText, /@vault\\_king\\_sol/);
    assert.match(perWallet.formattedText, /@sniper\\_x/);
    assert.match(perWallet.formattedText, /\$VCAT/);

    const renderer = new PnlCardRenderer();
    const detPng = await renderer.renderDetectivePng(sampleReport, "cyber", "MainColdVault");
    assert.ok(Buffer.isBuffer(detPng));
    assert.equal(detPng.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  } finally {
    await vaults.closeAll();
    await adminDb.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("freezable tokens block risky copy-buys yet sell cleanly, manual vs copy bags stay isolated, and stateless buttons fit <=64B", async () => {
  const tmp = makeTempDir("degen-bugfixes-");
  try {
    const config = loadConfig({ dataDir: tmp });
    const vaults = new UserVaultManager(config.userVaultDir);
    const evm = new EvmClientManager(config);
    const sol = new SolanaClientManager(config);
    const market = new MarketDataService(config, evm, sol);
    const snap = makeFakeSnap({
      chain: "solana",
      address: "TokenMintFreezable1111111111111111111111111",
      symbol: "PEPE_2",
      priceUsd: 0.01,
      nativePriceUsd: 100,
      mcUsd: 100_000,
      liquidityUsd: 80_000
    });
    market.getTokenSnapshot = async () => snap;

    const sec = new SecurityService();
    const freezableRisky: TokenSecurityReport = {
      ...makeSafeSecurity("solana"),
      address: snap.address,
      riskLevel: "danger",
      freezable: true,
      isHoneypot: false,
      warnings: ["Freeze authority enabled"]
    };
    sec.checkToken = async () => freezableRisky;

    const trading = new TradingEngine(market, sec);
    const notes: string[] = [];
    const copy = new CopyEngine({
      vaultManager: vaults,
      market,
      security: sec,
      trading,
      onNotify: async (_u, msg) => {
        notes.push(msg);
      }
    });

    const vault = await vaults.getVault("999");
    await vault.setVirtualFunds("solana", parseExactUnits("10", 9));
    await vault.setSetting("priority_fee_sol", "0");
    await vault.setSetting("__pending_prompt", JSON.stringify({ kind: "await_slippage" }));
    assert.equal(await vault.getSetting("__pending_prompt"), JSON.stringify({ kind: "await_slippage" }));

    // 1. CopyEngine still blocks risky freezable token when blockRisky=true
    const wid = await vault.addWatchedWallet({
      chain: "solana",
      address: "Trader1111111111111111111111111111111111111",
      alias: "Whale_One*",
      copyMode: "fixed",
      copyAmountAtomic: parseExactUnits("1", 9),
      blockRisky: true,
      simMode: "ideal"
    });
    const watched = (await vault.getWatchedWallet(wid))!;
    await copy.processSwapForUser("999", watched, {
      chain: "solana",
      walletAddress: watched.address,
      txHash: "sig_risk_block",
      side: "buy",
      tokenAddress: snap.address,
      walletNativeAmountAtomic: parseExactUnits("1", 9),
      detectedAt: Date.now()
    });
    assert.equal((await vault.listOpenPositions()).length, 0);
    // Notification escapes special characters and stripMdForFallback leaves zero backslashes
    assert.match(notes[0] ?? "", /Whale\\_One\\\*/);
    assert.doesNotMatch(stripMdForFallback(notes[0] ?? ""), /\\/);

    // 2. Manual buy on freezable token sells cleanly at live market price (NO false $0 rug writeoff)
    const manBuy = await trading.executeBuy(vault, {
      chain: "solana",
      tokenAddress: snap.address,
      spendNativeAtomic: parseExactUnits("2", 9),
      sourceType: "manual"
    });
    const manSell = await trading.executeSell(vault, {
      positionId: manBuy.positionId,
      sellPct: 100,
      sourceType: "manual"
    });
    assert.equal(manSell.side, "sell");
    assert.ok(manSell.nativeAmountAtomic > parseExactUnits("1.8", 9));

    // 3. Copy position and manual position on SAME token stay isolated
    sec.checkToken = async () => makeSafeSecurity("solana");
    const copyBuy = await trading.executeBuy(vault, {
      chain: "solana",
      tokenAddress: snap.address,
      spendNativeAtomic: parseExactUnits("1", 9),
      sourceType: "copy",
      copiedWalletId: wid
    });
    const secondManual = await trading.executeBuy(vault, {
      chain: "solana",
      tokenAddress: snap.address,
      spendNativeAtomic: parseExactUnits("1", 9),
      sourceType: "manual"
    });
    assert.notEqual(copyBuy.positionId, secondManual.positionId);

    // 4. All stateless token & detective inline buttons stay <= 64 bytes even for max 44-char Solana addrs
    const maxSol = "11111111111111111111111111111111111111111111"; // 44 chars
    const tokKb = buildTokenTradeKeyboard("solana", maxSol, "0123456789");
    for (const row of tokKb.inline_keyboard) {
      for (const btn of row) {
        if ("callback_data" in btn && btn.callback_data) {
          assert.ok(Buffer.byteLength(btn.callback_data, "utf8") <= 64, `Too long: ${btn.callback_data}`);
        }
      }
    }
    const detKb = buildDetectiveKeyboard({
      cardRefId: "0123456789",
      watchRefId: "0123456789",
      chain: "solana",
      address: maxSol,
      days: 30,
      buddyRefs: [{ address: maxSol, refId: "0123456789" }]
    });
    for (const row of detKb.inline_keyboard) {
      for (const btn of row) {
        if ("callback_data" in btn && btn.callback_data) {
          assert.ok(Buffer.byteLength(btn.callback_data, "utf8") <= 64, `Too long: ${btn.callback_data}`);
        }
      }
    }

    assert.equal(escapeMd("PEPE_2"), "PEPE\\_2");
    assert.equal(stripMdForFallback("*PEPE\\_2*"), "PEPE_2");

    await vaults.closeAll();
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    } catch {
      // Windows Defender / SQLite WAL handle may hold temp dir briefly
    }
  }
});

test("walletWatcher retries after transient RPC failures and detects coin-to-coin & unparsed SOL buys", async () => {
  const tmp = makeTempDir("degen-watcher-");
  try {
    const config = loadConfig({ dataDir: tmp, heliusApiKey: "" });
    const adminDb = new AdminDb(config.adminDbPath, 10);
    const vaults = new UserVaultManager(config.userVaultDir);
    const evm = new EvmClientManager(config);
    const sol = new SolanaClientManager(config);
    const market = new MarketDataService(config, evm, sol);
    const sec = new SecurityService();
    const trading = new TradingEngine(market, sec);
    const copy = new CopyEngine({
      vaultManager: vaults,
      market,
      security: sec,
      trading,
      onNotify: async () => {}
    });

    const watcher = new WalletWatcherService({
      config,
      adminDb,
      vaultManager: vaults,
      evmClients: evm,
      solanaClient: sol,
      copyEngine: copy
    });

    const dispatched: Array<{ side: string; token: string }> = [];
    (watcher as unknown as { dispatchSwap: (s: { side: string; tokenAddress: string }) => Promise<void> }).dispatchSwap =
      async (s) => {
        dispatched.push({ side: s.side, token: s.tokenAddress });
      };

    // 1. Transient RPC failure returns false so tx is NOT marked permanently seen
    const origFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("rate limited", { status: 429 });
    };
    const okFirst = await watcher.handleSolanaSignature("Wallet11111111111111111111111111111111111111", "sig_retry_1");
    assert.equal(okFirst, false);
    assert.ok(calls >= 2);

    // 2. Retry succeeds once RPC responds with a coin-to-coin swap (SoldMint -> BoughtMint)
    const fakeParsedTx = {
      meta: {
        err: null,
        preBalances: [5_000_000_000],
        postBalances: [4_995_000_000],
        preTokenBalances: [{ owner: "Wallet11111111111111111111111111111111111111", mint: "MintOld111", uiTokenAmount: { amount: "1000" } }],
        postTokenBalances: [{ owner: "Wallet11111111111111111111111111111111111111", mint: "MintNew222", uiTokenAmount: { amount: "5000" } }]
      },
      transaction: { message: { accountKeys: ["Wallet11111111111111111111111111111111111111"] } }
    };
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: fakeParsedTx }), { status: 200 });

    const okRetry = await watcher.handleSolanaSignature("Wallet11111111111111111111111111111111111111", "sig_retry_1");
    globalThis.fetch = origFetch;
    assert.equal(okRetry, true);
    assert.deepEqual(dispatched, [
      { side: "sell", token: "MintOld111" },
      { side: "buy", token: "MintNew222" }
    ]);

    // 3. Helius UNKNOWN router with native SOL spend + bought token still classifies as a BUY
    const heliusSwaps = (
      watcher as unknown as {
        extractSwapsFromHeliusTx: (w: string, sig: string, tx: unknown) => Array<{ side: string; tokenAddress: string }>;
      }
    ).extractSwapsFromHeliusTx("Wallet11111111111111111111111111111111111111", "sig_helius_1", {
      type: "UNKNOWN",
      source: "PUMP_AMM",
      nativeTransfers: [{ fromUserAccount: "Wallet11111111111111111111111111111111111111", toUserAccount: "PoolPDA", amount: 250_000_000 }],
      tokenTransfers: [{ fromUserAccount: "PoolPDA", toUserAccount: "Wallet11111111111111111111111111111111111111", mint: "PumpMint999", tokenAmount: 100000 }]
    });
    assert.equal(heliusSwaps.length, 1);
    assert.equal(heliusSwaps[0].side, "buy");
    assert.equal(heliusSwaps[0].tokenAddress, "PumpMint999");

    await vaults.closeAll();
    await adminDb.close();
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    } catch {
      // ignore Windows SQLite WAL handle
    }
  }
});

test("walletWatcher HTTP server handles GET/HEAD health safely and routes /telegram-webhook", async () => {
  const tmp = makeTempDir("degen-http-");
  const freePort = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });

  try {
    const config = loadConfig({
      dataDir: tmp,
      webhookPort: freePort,
      evmPollMs: 600_000,
      solanaFallbackPollMs: 600_000
    });
    const adminDb = new AdminDb(config.adminDbPath, 10);
    adminDb.ping = async () => {
      throw new Error("Simulated transient DB failure");
    };
    const vaults = new UserVaultManager(config.userVaultDir);
    const evm = new EvmClientManager(config);
    const sol = new SolanaClientManager(config);
    const market = new MarketDataService(config, evm, sol);
    const sec = new SecurityService();
    const trading = new TradingEngine(market, sec);
    const copy = new CopyEngine({
      vaultManager: vaults,
      market,
      security: sec,
      trading,
      onNotify: async () => {}
    });

    let webhookHit = false;
    const watcher = new WalletWatcherService({
      config,
      adminDb,
      vaultManager: vaults,
      evmClients: evm,
      solanaClient: sol,
      copyEngine: copy,
      onTelegramWebhook: (req, res) => {
        webhookHit = true;
        req.resume();
        res.writeHead(200).end("TG_OK");
      }
    });

    await watcher.start();
    // Wait briefly for server socket bind
    await new Promise((r) => setTimeout(r, 80));

    const getRes = await fetch(`http://127.0.0.1:${freePort}/health?ping=1`);
    assert.equal(getRes.status, 200);
    const json = (await getRes.json()) as { ok: boolean; db: boolean };
    assert.equal(json.ok, true);
    assert.equal(json.db, false);

    const headRes = await fetch(`http://127.0.0.1:${freePort}/`, { method: "HEAD" });
    assert.equal(headRes.status, 200);

    const tgRes = await fetch(`http://127.0.0.1:${freePort}/telegram-webhook`, {
      method: "POST",
      body: JSON.stringify({ update_id: 1 })
    });
    assert.equal(tgRes.status, 200);
    assert.equal(await tgRes.text(), "TG_OK");
    assert.equal(webhookHit, true);

    await watcher.stop();
    await vaults.closeAll();
    await adminDb.close();
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    } catch {
      // ignore Windows SQLite WAL handle
    }
  }
});

test("marketData recovers SOL and ETH USD prices via Helius, GeckoTerminal, and Chainlink when DexScreener and CoinGecko 429", async () => {
  const tmp = makeTempDir("degen-price-");
  const origFetch = globalThis.fetch;
  try {
    const config = loadConfig({ dataDir: tmp, heliusApiKey: "test_helius_key" });
    const sol = new SolanaClientManager(config);
    const mockEvm = {
      getClient: (chain: string) => ({
        readContract: async () =>
          chain === "ethereum"
            ? [1n, 7_425_000_000n, 0n, 0n, 1n] // $74.25 SOL/USD
            : [1n, 176_500_000_000n, 0n, 0n, 1n] // $1765.00 ETH/USD
      })
    } as unknown as EvmClientManager;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("dexscreener.com") || url.includes("coingecko.com")) {
        return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
      }
      if (url.includes("helius-rpc.com")) {
        return new Response(
          JSON.stringify({ result: { token_info: { price_info: { price_per_token: 74.5 } } } }),
          { status: 200 }
        );
      }
      if (url.includes("geckoterminal.com")) {
        return new Response(JSON.stringify({ error: "down" }), { status: 503 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const market = new MarketDataService(config, mockEvm, sol);
    const [solUsd, ethUsd, baseEthUsd] = await Promise.all([
      market.getNativePriceUsd("solana"),
      market.getNativePriceUsd("ethereum"),
      market.getNativePriceUsd("base")
    ]);
    assert.ok(solUsd > 70, `Expected SOL USD fallback > 70, got ${solUsd}`);
    assert.equal(ethUsd, 1765);
    assert.equal(baseEthUsd, 1765);
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  }
});

test("copyEngine copies brand-new unindexed PumpSwap buys via on-chain fallback and skips nameless LP mints", async () => {
  const tmp = makeTempDir("degen-onchain-copy-");
  const origFetch = globalThis.fetch;
  try {
    const config = loadConfig({ dataDir: tmp, heliusApiKey: "test_helius_key" });
    const vaults = new UserVaultManager(config.userVaultDir);
    const evm = new EvmClientManager(config);
    const sol = new SolanaClientManager(config);

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("dexscreener.com")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("geckoterminal.com") || url.includes("pump.fun")) {
        return new Response(JSON.stringify({}), { status: 404 });
      }
      if (url.includes("helius-rpc.com")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const assetId = body?.params?.id;
        if (assetId === "So11111111111111111111111111111111111111112") {
          return new Response(
            JSON.stringify({ result: { token_info: { price_info: { price_per_token: 75 } } } }),
            { status: 200 }
          );
        }
        if (assetId === "FreshPumpMint1111111111111111111111111111111") {
          return new Response(
            JSON.stringify({
              result: {
                content: { metadata: { symbol: "FRESH", name: "Fresh Launch" } },
                token_info: { symbol: "FRESH", decimals: 6, supply: 1_000_000_000_000_000 }
              }
            }),
            { status: 200 }
          );
        }
        if (assetId === "NamelessLpMint111111111111111111111111111111") {
          return new Response(
            JSON.stringify({
              result: { token_info: { decimals: 9, supply: 14_142_135_623_630 } }
            }),
            { status: 200 }
          );
        }
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const market = new MarketDataService(config, evm, sol);
    const sec = new SecurityService();
    sec.checkToken = async () => makeSafeSecurity("solana");
    const trading = new TradingEngine(market, sec);
    const notes: string[] = [];
    const copy = new CopyEngine({
      vaultManager: vaults,
      market,
      security: sec,
      trading,
      onNotify: async (_uid, msg) => {
        notes.push(msg);
      },
      snapshotRetryDelaysMs: [0]
    });

    const vault = await vaults.getVault("999");
    await vault.setVirtualFunds("solana", parseExactUnits("1", 9));
    await vault.setSetting("sim_delay_ms", "0");
    await vault.setSetting("priority_fee_sol", "0");

    const wId = await vault.addWatchedWallet({
      chain: "solana",
      address: "WhaleFresh11111111111111111111111111111111",
      alias: "$8k+",
      copyMode: "percent_balance",
      copyAmountAtomic: 0n,
      copyPercent: 5,
      blockRisky: false,
      simMode: "ideal"
    });
    const watched = (await vault.getWatchedWallet(wId))!;

    // 1. Real unindexed PumpSwap coin -> recovered cleanly from on-chain swap ratio + Helius metadata
    await copy.processSwapForUser("999", watched, {
      chain: "solana",
      walletAddress: watched.address,
      txHash: "sig_fresh_buy",
      side: "buy",
      tokenAddress: "FreshPumpMint1111111111111111111111111111111",
      walletNativeAmountAtomic: 100_000_000n, // 0.1 SOL ($7.50)
      walletTokenAmount: 375_000, // => $0.00002/token ($20k MC)
      dex: "PUMP_AMM",
      detectedAt: Date.now()
    });

    // 2. Nameless LP mint -> still safely skipped
    await copy.processSwapForUser("999", watched, {
      chain: "solana",
      walletAddress: watched.address,
      txHash: "sig_lp_mint",
      side: "buy",
      tokenAddress: "NamelessLpMint111111111111111111111111111111",
      walletNativeAmountAtomic: 100_000_000n,
      walletTokenAmount: 500,
      dex: "RAYDIUM",
      detectedAt: Date.now()
    });

    const open = await vault.listOpenPositions();
    assert.equal(open.length, 1);
    assert.equal(open[0].tokenSymbol, "FRESH");
    assert.ok(open[0].entryMcUsd >= 19_000 && open[0].entryMcUsd <= 21_000, `MC=${open[0].entryMcUsd}`);
    assert.ok(notes.some((n) => n.includes("Instant Copy Buy") && n.includes("FRESH")));

    // 3. Deployer mint-all transaction (0.015 SOL fee -> 100% of supply = $1.12 bogus MC) MUST be rejected
    const mintSnap = await market.buildOnChainSolanaSnapshot({
      tokenAddress: "FreshPumpMint1111111111111111111111111111111",
      walletNativeAmountAtomic: 15_254_779n,
      walletTokenAmount: 1_000_000_000,
      dex: "onchain"
    });
    assert.equal(mintSnap, null);

    // 4. Helius mint-to-self / pass-through pool seeding tx produces 0 swaps
    const adminDb2 = new AdminDb(config.adminDbPath, 10);
    const watcher2 = new WalletWatcherService({
      config,
      adminDb: adminDb2,
      vaultManager: vaults,
      evmClients: evm,
      solanaClient: sol,
      copyEngine: copy
    });
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            type: "UNKNOWN",
            nativeTransfers: [
              {
                fromUserAccount: "CreatorWallet1111111111111111111111111111111",
                toUserAccount: "Sys",
                amount: 15_254_779
              }
            ],
            tokenTransfers: [
              {
                fromUserAccount: "",
                toUserAccount: "CreatorWallet1111111111111111111111111111111",
                mint: "FreshPumpMint1111111111111111111111111111111",
                tokenAmount: 1_000_000_000
              },
              {
                fromUserAccount: "CreatorWallet1111111111111111111111111111111",
                toUserAccount: "PoolPDA",
                mint: "FreshPumpMint1111111111111111111111111111111",
                tokenAmount: 1_000_000_000
              }
            ]
          }
        ]),
        { status: 200 }
      )) as typeof fetch;

    const parsedMintTx = await (
      watcher2 as unknown as {
        inspectSolanaTx: (w: string, sig: string) => Promise<{ swaps: Array<{ isDevLaunch?: boolean }>; fetched: boolean }>;
      }
    ).inspectSolanaTx("CreatorWallet1111111111111111111111111111111", "sig_mint_create");
    assert.equal(parsedMintTx.fetched, true);
    assert.equal(parsedMintTx.swaps.length, 1);
    assert.equal(parsedMintTx.swaps[0].isDevLaunch, true);

    // Ensure non-dev-sniping watcher ignores that dev launch safely without buying
    await copy.processSwapForUser("999", watched, parsedMintTx.swaps[0] as never);
    assert.equal((await vault.listOpenPositions()).length, 1);

    await adminDb2.close();
    await vaults.closeAll();
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  }
});

test("dev-launch pool snipe, Option B SL, proportional sells, cross-wallet LP exit, leaderboard & callbacks", async () => {
  const tmp = makeTempDir("degen-patches-");
  const origFetch = globalThis.fetch;
  try {
    const config = loadConfig({ dataDir: tmp, heliusApiKey: "test_helius_key" });
    const adminDb = new AdminDb(config.adminDbPath, 10, "BOOT-TEST");
    const authRes = await adminDb.redeemCode({ code: "BOOT-TEST", telegramId: "888", username: "devtester" });
    assert.equal(authRes.ok, true);
    const vaults = new UserVaultManager(config.userVaultDir);
    const evm = new EvmClientManager(config);
    const sol = new SolanaClientManager(config);

    let liveSpotPrice = 0.000015;
    let liveSpotLiq = 30_000;
    let liveSpotMc = 15_000;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("dexscreener.com")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("geckoterminal.com") || url.includes("pump.fun")) {
        return new Response(JSON.stringify({}), { status: 404 });
      }
      if (url.includes("helius-rpc.com")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const id = body?.params?.id;
        if (id === "So11111111111111111111111111111111111111112") {
          return new Response(
            JSON.stringify({ result: { token_info: { price_info: { price_per_token: 75 } } } }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            result: {
              content: { metadata: { symbol: "LAUNCH", name: "Launch Coin" } },
              token_info: { symbol: "LAUNCH", decimals: 6, supply: 1_000_000_000_000_000 }
            }
          }),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const market = new MarketDataService(config, evm, sol);
    const sec = new SecurityService();
    sec.checkToken = async () => makeSafeSecurity("solana");
    const trading = new TradingEngine(market, sec);
    const alerts: string[] = [];
    const copy = new CopyEngine({
      vaultManager: vaults,
      market,
      security: sec,
      trading,
      onNotify: async (_uid, msg) => {
        alerts.push(msg);
      },
      snapshotRetryDelaysMs: [0]
    });

    const vault = await vaults.getVault("888");
    await vault.setVirtualFunds("solana", parseExactUnits("2", 9));
    await vault.setSetting("sim_delay_ms", "0");
    await vault.setSetting("priority_fee_sol", "0");
    await vault.setSetting("notify_skips", "1");

    const devId = await vault.addWatchedWallet({
      chain: "solana",
      address: "DevSniperWallet11111111111111111111111111111",
      alias: "$706k",
      copyMode: "fixed",
      copyAmountAtomic: parseExactUnits("0.1", 9),
      snipeDevLaunches: true,
      autoTpPct: 100,
      autoSlPct: -50,
      autoTrailingPct: 25,
      simMode: "ideal",
      blockRisky: false
    });
    const traderId = await vault.addWatchedWallet({
      chain: "solana",
      address: "PropTraderWallet111111111111111111111111111",
      alias: "Refill",
      copyMode: "fixed",
      copyAmountAtomic: parseExactUnits("0.2", 9),
      sellMode: "proportional",
      mirrorSells: true,
      autoSlPct: -50,
      simMode: "ideal",
      blockRisky: false
    });
    const devWallet = (await vault.getWatchedWallet(devId))!;
    const traderWallet = (await vault.getWatchedWallet(traderId))!;

    // 1. Dev seeds new pool: 200 SOL ($15,000) + 1B tokens -> real opening MC ~$15K (never $1.12)
    await copy.processSwapForUser("888", devWallet, {
      chain: "solana",
      walletAddress: devWallet.address,
      txHash: "sig_pool_seed",
      side: "buy",
      tokenAddress: "LaunchCoinMint111111111111111111111111111111",
      walletNativeAmountAtomic: parseExactUnits("200", 9),
      walletTokenAmount: 1_000_000_000,
      isDevLaunch: true,
      launchPoolSol: 200,
      launchPoolTokens: 1_000_000_000,
      dex: "pumpswap",
      detectedAt: Date.now()
    });

    const openAfterLaunch = await vault.listOpenPositions();
    assert.equal(openAfterLaunch.length, 1);
    assert.ok(openAfterLaunch[0].entryMcUsd >= 14_000 && openAfterLaunch[0].entryMcUsd <= 16_000);
    const activeOrders = await vault.listActiveOrders();
    assert.deepEqual(
      activeOrders.map((o) => o.orderType).sort(),
      ["sl", "tp", "trailing_stop"]
    );
    // Disable trailing stop on this specific SL test position so Option B -30% dip tests SL isolation cleanly
    const trailOrd = activeOrders.find((o) => o.orderType === "trailing_stop");
    if (trailOrd) await vault.setOrderStatus(trailOrd.id, "cancelled");

    // 2. Mock OrderMonitor snapshots: -30% dip with 75% lower liq does NOT exit early (Option B), then -55% SL triggers cleanly!
    market.getBatchTokenSnapshots = async () =>
      new Map([
        [
          "LaunchCoinMint111111111111111111111111111111",
          makeFakeSnap({
            address: "LaunchCoinMint111111111111111111111111111111",
            symbol: "LAUNCH",
            priceUsd: liveSpotPrice,
            nativePriceUsd: 75,
            mcUsd: liveSpotMc,
            liquidityUsd: liveSpotLiq
          })
        ]
      ]);
    const monitor = new OrderMonitorService({
      adminDb,
      vaultManager: vaults,
      market,
      security: sec,
      trading,
      onNotify: async (_uid, msg) => {
        alerts.push(msg);
      }
    });

    // Normal -30% dip (even if liquidity fell sharply) leaves position open under Option B
    liveSpotPrice = 0.0000105;
    liveSpotMc = 10_500;
    liveSpotLiq = 6_000;
    await monitor.tick();
    assert.equal((await vault.listOpenPositions()).length, 1);

    // Hits -55% SL (past -50%) -> closes automatically via SL
    liveSpotPrice = 0.0000067;
    liveSpotMc = 6_700;
    liveSpotLiq = 12_000;
    await monitor.tick();
    assert.equal((await vault.listOpenPositions()).length, 0);
    assert.ok(alerts.some((a) => a.includes("Stop Loss") && a.includes("Triggered")));

    // 3. Proportional copy sell (trader sells 25% -> only 25% of position is sold)
    liveSpotPrice = 0.00002;
    liveSpotMc = 20_000;
    liveSpotLiq = 30_000;
    market.getTokenSnapshot = async () =>
      makeFakeSnap({
        address: "RunnerCoinMint111111111111111111111111111111",
        symbol: "RUNNER",
        priceUsd: 0.00002,
        nativePriceUsd: 75,
        mcUsd: 20_000,
        liquidityUsd: 30_000
      });
    await copy.processSwapForUser("888", traderWallet, {
      chain: "solana",
      walletAddress: traderWallet.address,
      txHash: "sig_runner_buy",
      side: "buy",
      tokenAddress: "RunnerCoinMint111111111111111111111111111111",
      walletNativeAmountAtomic: parseExactUnits("1", 9),
      detectedAt: Date.now()
    });
    const beforePartial = (await vault.listOpenPositions())[0];
    await copy.processSwapForUser("888", traderWallet, {
      chain: "solana",
      walletAddress: traderWallet.address,
      txHash: "sig_runner_sell_25",
      side: "sell",
      tokenAddress: "RunnerCoinMint111111111111111111111111111111",
      walletNativeAmountAtomic: parseExactUnits("0.3", 9),
      walletSellPct: 25,
      detectedAt: Date.now()
    });
    const afterPartial = (await vault.listOpenPositions())[0];
    assert.ok(afterPartial);
    assert.ok(afterPartial.qtyTokenAtomic < beforePartial.qtyTokenAtomic);
    assert.ok(alerts.some((a) => a.includes("Instant Copy Sell (25%)")));

    // 4. Cross-wallet danger exit when another watched dev wallet removes LP on RUNNER
    await copy.handleCrossWalletDangerSell({
      telegramId: "888",
      triggerWalletAlias: "$706k",
      triggerWalletId: devId,
      chain: "solana",
      tokenAddress: "RunnerCoinMint111111111111111111111111111111",
      txHash: "sig_lp_pull",
      reason: "removed pool liquidity"
    });
    assert.equal((await vault.listOpenPositions()).length, 0);
    assert.ok(alerts.some((a) => a.includes("Cross-Wallet Exit Guard")));

    // 5. Leaderboard & keyboard callback limits (<= 64B)
    const closedAll = await vault.listClosedPositions(50);
    const board = formatWalletLeaderboardMessage([devWallet, traderWallet], [], closedAll);
    assert.ok(board.includes("Wallet Copy Leaderboard"));
    assert.ok(board.includes("$706k"));

    for (const kb of [
      buildWatchersKeyboard([devWallet, traderWallet]),
      buildWatcherDetailKeyboard(devWallet),
      buildSettingsKeyboard(await vault.getSettings()),
      buildTokenTradeKeyboard("solana", "So11111111111111111111111111111111111111112", "0123456789"),
      buildTokenTradeKeyboard("robinhood", "0x6B7a90776DeC2378E133c10fCd978847973b3906", "0123456789")
    ]) {
      for (const row of kb.inline_keyboard) {
        for (const btn of row) {
          if ("callback_data" in btn && btn.callback_data) {
            assert.ok(Buffer.byteLength(btn.callback_data, "utf8") <= 64, `Too long: ${btn.callback_data}`);
          }
        }
      }
    }

    await vaults.closeAll();
    await adminDb.close();
  } finally {
    globalThis.fetch = origFetch;
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    } catch {
      // ignore Windows SQLite WAL file handle release delay
    }
  }
});

test("USDT-equivalent coin buy conversion, token card display, and buy execution", async () => {
  const solUsd = 100;
  const ethUsd = 2000;

  // Explicit Buy-by-USDT prompt mode ("50" or "25.50" -> converts via live price)
  const forced = parseNativeOrUsdInput({
    raw: "50",
    nativeDecimals: 9,
    nativeSymbol: "SOL",
    nativePriceUsd: solUsd,
    forceUsd: true
  });
  assert.equal(forced.isUsd, true);
  assert.equal(forced.usdAmount, 50);
  assert.equal(forced.nativeAmountAtomic, parseExactUnits("0.5", 9));

  // Explicit USD/USDT suffix & prefix inside regular prompts ("$100", "25 usdt", "100usdt", "25$", "0.25 SOL")
  const ethFromUsdt = parseNativeOrUsdInput({
    raw: "100 usdt",
    nativeDecimals: 18,
    nativeSymbol: "ETH",
    nativePriceUsd: ethUsd
  });
  assert.equal(ethFromUsdt.isUsd, true);
  assert.equal(ethFromUsdt.nativeAmountAtomic, parseExactUnits("0.05", 18));

  const ethNoSpace = parseNativeOrUsdInput({
    raw: "100usdt",
    nativeDecimals: 18,
    nativeSymbol: "ETH",
    nativePriceUsd: ethUsd
  });
  assert.equal(ethNoSpace.isUsd, true);
  assert.equal(ethNoSpace.nativeAmountAtomic, parseExactUnits("0.05", 18));

  const solDollarSuffix = parseNativeOrUsdInput({
    raw: "25$",
    nativeDecimals: 9,
    nativeSymbol: "SOL",
    nativePriceUsd: solUsd
  });
  assert.equal(solDollarSuffix.isUsd, true);
  assert.equal(solDollarSuffix.nativeAmountAtomic, parseExactUnits("0.25", 9));

  const solDirect = parseNativeOrUsdInput({
    raw: "0.25 SOL",
    nativeDecimals: 9,
    nativeSymbol: "SOL",
    nativePriceUsd: 0
  });
  assert.equal(solDirect.isUsd, false);
  assert.equal(solDirect.nativeAmountAtomic, parseExactUnits("0.25", 9));

  assert.throws(
    () =>
      parseNativeOrUsdInput({
        raw: "$50",
        nativeDecimals: 9,
        nativeSymbol: "SOL",
        nativePriceUsd: 0
      }),
    /Couldn't fetch live SOL price/
  );

  // Token scan card shows USDT equivalent alongside native balance + Buy by USDT Value button
  const snap = makeFakeSnap({ nativePriceUsd: 100 });
  const scanMsg = formatTokenScanMessage(snap, makeSafeSecurity("solana"), parseExactUnits("2.5", 9));
  assert.ok(scanMsg.includes("$250.00 USDT"));

  const kb = buildTokenTradeKeyboard("solana", snap.address, "abc1234567");
  const allButtons = kb.inline_keyboard.flat();
  const usdBtn = allButtons.find((b) => "text" in b && b.text.includes("Buy by USDT Value"));
  assert.ok(usdBtn && "callback_data" in usdBtn);
  assert.ok(usdBtn.callback_data!.startsWith("bu:s:"));

  // Execute actual buy using USD-converted atomic amount
  const tmp = makeTempDir("degen-buyusd-");
  try {
    const adminDb = new AdminDb(path.join(tmp, "admin.db"), 5, "CODE1");
    await adminDb.redeemCode({ code: "CODE1", telegramId: "555", username: "u555" });
    const vaults = new UserVaultManager(path.join(tmp, "users"));
    const vault = await vaults.getVault("555");
    await vault.setVirtualFunds("solana", parseExactUnits("2", 9));
    await vault.setSetting("priority_fee_sol", "0");

    const cfg = loadConfig({ dataDir: tmp });
    const evm = new EvmClientManager(cfg);
    const sol = new SolanaClientManager(cfg);
    const market = new MarketDataService(cfg, evm, sol);
    const sec = new SecurityService(cfg, evm, sol);
    market.getTokenSnapshot = async () => snap;
    sec.checkToken = async () => makeSafeSecurity("solana");

    const trading = new TradingEngine(market, sec);
    const spend = parseNativeOrUsdInput({
      raw: "50",
      nativeDecimals: 9,
      nativeSymbol: "SOL",
      nativePriceUsd: 100,
      forceUsd: true
    });
    const buyRes = await trading.executeBuy(vault, {
      chain: "solana",
      tokenAddress: snap.address,
      spendNativeAtomic: spend.nativeAmountAtomic,
      sourceType: "manual"
    });
    assert.equal(buyRes.nativeAmountAtomic, parseExactUnits("0.5", 9));
    assert.ok(buyRes.qtyTokenAtomic > 0n);

    await vaults.closeAll();
    await adminDb.close();
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    } catch {
      // ignore Windows SQLite WAL file handle release delay
    }
  }
});
