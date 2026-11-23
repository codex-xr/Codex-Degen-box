import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AdminDb } from "../src/db/adminDb.js";
import { UserVaultManager } from "../src/db/userVault.js";
import { loadConfig } from "../src/config.js";
import { CopyEngine } from "../src/services/copyEngine.js";
import { EvmClientManager } from "../src/services/evmClients.js";
import { MarketDataService, TokenSnapshot } from "../src/services/marketData.js";
import { PnlCardRenderer } from "../src/services/pnlCard.js";
import { SecurityService, TokenSecurityReport } from "../src/services/security.js";
import { SolanaClientManager } from "../src/services/solanaClient.js";
import { TradingEngine } from "../src/services/tradingEngine.js";
import { WeeklyReportService } from "../src/services/weeklyReport.js";
import { formatExactUnits, parseExactUnits } from "../src/utils/amounts.js";

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

function makeSafeSecurity(chain: "solana" | "base" | "robinhood" = "solana"): TokenSecurityReport {
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

test("admin invite codes, max cabal user limit, and user isolation", () => {
  const tmp = makeTempDir("degen-auth-");
  try {
    const adminDb = new AdminDb(path.join(tmp, "admin.db"), 2, "FIRSTADMIN");
    const vaults = new UserVaultManager(path.join(tmp, "users"));

    // Bootstrap first admin
    const adminRes = adminDb.redeemCode({
      code: "FIRSTADMIN",
      telegramId: "1001",
      username: "boss"
    });
    assert.equal(adminRes.ok, true);
    if (adminRes.ok) assert.equal(adminRes.user.role, "admin");

    // Admin generates single-use code
    const code1 = adminDb.generateAccessCode({ createdBy: "1001", label: "Member1", maxUses: 1 });
    const member1 = adminDb.redeemCode({ code: code1.code, telegramId: "1002", username: "m1" });
    assert.equal(member1.ok, true);

    // Same single-use code cannot be reused by a third user
    const reuse = adminDb.redeemCode({ code: code1.code, telegramId: "1003" });
    assert.equal(reuse.ok, false);

    // Max cabal user limit (2) blocks new member when reached
    const code2 = adminDb.generateAccessCode({ createdBy: "1001", label: "Member2", maxUses: 1 });
    const blocked = adminDb.redeemCode({ code: code2.code, telegramId: "1003" });
    assert.equal(blocked.ok, false);

    // Private vault isolation check: separate DB files & separate funds
    const v1 = vaults.getVault("1001");
    const v2 = vaults.getVault("1002");
    assert.notEqual(v1.dbPath, v2.dbPath);
    assert.equal(fs.existsSync(v1.dbPath), true);
    assert.equal(fs.existsSync(v2.dbPath), true);

    v1.setVirtualFunds("solana", parseExactUnits("50.123456789", 9));
    assert.equal(v1.getBalance("solana").balanceAtomic, 50_123_456_789n);
    assert.equal(v2.getBalance("solana").balanceAtomic, 0n);

    vaults.closeAll();
    adminDb.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
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

    const vault = vaults.getVault("777");
    vault.setVirtualFunds("robinhood", parseExactUnits("1.000000000000000001", 18));
    vault.setSetting("evm_gas_eth", "0");

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
      vault.getBalance("robinhood").balanceAtomic,
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
    assert.equal(vault.getPositionById(buyRes.positionId)?.status, "rugged");

    vaults.closeAll();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
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

    const vault = vaults.getVault("555");
    vault.setVirtualFunds("solana", parseExactUnits("10", 9));
    vault.setSetting("sim_delay_ms", "0");
    vault.setSetting("priority_fee_sol", "0");

    const walletId = vault.addWatchedWallet({
      chain: "solana",
      address: "WhaleWallet11111111111111111111111111111111",
      alias: "SniperWhale",
      copyMode: "fixed",
      copyAmountAtomic: parseExactUnits("2.5", 9),
      simMode: "ideal",
      mirrorSells: true
    });
    const watched = vault.getWatchedWallet(walletId)!;

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

    assert.equal(vault.getBalance("solana").balanceAtomic, parseExactUnits("7.5", 9));
    assert.equal(vault.listOpenPositions().length, 1);

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

    assert.equal(vault.listOpenPositions().length, 0);
    assert.ok(vault.getBalance("solana").balanceAtomic > parseExactUnits("14", 9));
    assert.equal(notifications.length, 2);

    // Weekly intelligence report picks up SniperWhale as top earner + MC/age buckets
    const reports = new WeeklyReportService({ config, adminDb, vaultManager: vaults, market });
    const { summary, formattedText } = await reports.generateForUser(vault, 7);
    assert.equal(summary.wins, 1);
    assert.equal(summary.walletLeaderboard[0]?.alias, "SniperWhale");
    assert.ok(summary.walletLeaderboard[0].netPnlUsd > 400);
    assert.match(formattedText, /SniperWhale/);
    assert.match(formattedText, /Pattern Recognition/);

    vaults.closeAll();
    adminDb.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
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
