import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHAIN_LIST, ChainKey, CHAINS, normalizeAddress } from "../chains/registry.js";

export type SimMode = "realistic" | "ideal";
export type PnlTheme = "cyber" | "solana" | "robinhood" | "gold";
export type CopyMode = "fixed" | "percent_balance";

export interface VirtualBalanceRow {
  chain: ChainKey;
  balanceAtomic: bigint;
  initialBalanceAtomic: bigint;
  updatedAt: number;
}

export interface UserSettings {
  activeChain: ChainKey;
  slippageBps: number;
  priorityFeeSol: string;
  evmGasEth: string;
  simMode: SimMode;
  simDelayMs: number;
  pnlTheme: PnlTheme;
  weeklyReportEnabled: boolean;
  copyNotify: boolean;
}

export interface PositionRow {
  id: number;
  chain: ChainKey;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  tokenDecimals: number;
  pairAddress: string | null;
  dex: string | null;
  sourceType: "manual" | "copy" | "limit" | "dca";
  copiedWalletId: number | null;
  status: "open" | "closed" | "rugged";
  qtyTokenAtomic: bigint;
  initialQtyTokenAtomic: bigint;
  costNativeAtomic: bigint;
  initialCostNativeAtomic: bigint;
  realizedNativeAtomic: bigint;
  costUsd: number;
  initialCostUsd: number;
  realizedUsd: number;
  entryPriceUsd: number;
  lastPriceUsd: number;
  entryMcUsd: number;
  entryLiqUsd: number;
  entryVol5mUsd: number;
  entryTokenAgeSec: number | null;
  peakPriceUsd: number;
  peakMcUsd: number;
  exitPriceUsd: number | null;
  exitMcUsd: number | null;
  openedAt: number;
  closedAt: number | null;
}

export interface TradeRow {
  id: number;
  positionId: number;
  chain: ChainKey;
  side: "buy" | "sell" | "rug_writeoff";
  sourceType: string;
  copiedWalletId: number | null;
  copiedTxHash: string | null;
  tokenAddress: string;
  tokenSymbol: string;
  qtyTokenAtomic: bigint;
  nativeAmountAtomic: bigint;
  feeNativeAtomic: bigint;
  taxBps: number;
  slippageBps: number;
  priceUsd: number;
  nativePriceUsd: number;
  mcUsd: number;
  liqUsd: number;
  vol5mUsd: number;
  tokenAgeSec: number | null;
  securityRisk: string;
  realizedPnlNativeAtomic: bigint;
  realizedPnlUsd: number;
  simDelayMs: number;
  executedAt: number;
}

export interface OrderRow {
  id: number;
  chain: ChainKey;
  tokenAddress: string;
  tokenSymbol: string;
  positionId: number | null;
  orderType: "limit_buy" | "tp" | "sl" | "trailing_stop" | "dca";
  triggerMcUsd: number | null;
  triggerPriceUsd: number | null;
  triggerPnlPct: number | null;
  trailingDropPct: number | null;
  highestPriceUsd: number | null;
  amountNativeAtomic: bigint | null;
  sellPct: number | null;
  dcaIntervalSec: number | null;
  dcaRemaining: number | null;
  nextRunAt: number | null;
  status: "active" | "filled" | "cancelled";
  createdAt: number;
  updatedAt: number;
}

export interface WatchedWalletRow {
  id: number;
  chain: ChainKey;
  address: string;
  alias: string;
  enabled: boolean;
  copyMode: CopyMode;
  copyAmountAtomic: bigint;
  copyPercent: number;
  maxBuyAtomic: bigint | null;
  minMcUsd: number | null;
  maxMcUsd: number | null;
  minLiqUsd: number | null;
  skipIfHeld: boolean;
  mirrorSells: boolean;
  blockRisky: boolean;
  simMode: SimMode;
  autoTpPct: number | null;
  autoSlPct: number | null;
  lastSeenTx: string | null;
  createdAt: number;
}

export interface ObservedSwapRow {
  id: number;
  watchedWalletId: number;
  chain: ChainKey;
  txHash: string;
  side: "buy" | "sell";
  tokenAddress: string;
  tokenSymbol: string | null;
  walletNativeAmountAtomic: bigint | null;
  priceUsdAtEvent: number | null;
  mcUsdAtEvent: number | null;
  liqUsdAtEvent: number | null;
  vol5mUsdAtEvent: number | null;
  tokenAgeSec: number | null;
  dex: string | null;
  actionTaken: string;
  skipReason: string | null;
  observedAt: number;
}

export interface WeeklyReportRow {
  id: number;
  periodStart: number;
  periodEnd: number;
  summaryJson: string;
  reportText: string;
  createdAt: number;
}

const DEFAULT_SETTINGS: UserSettings = {
  activeChain: "solana",
  slippageBps: 1500, // 15% degen default
  priorityFeeSol: "0.001",
  evmGasEth: "0.00005",
  simMode: "realistic",
  simDelayMs: 1500,
  pnlTheme: "cyber",
  weeklyReportEnabled: true,
  copyNotify: true
};

/**
 * Isolated per-user private database (`data/users/<telegramId>.db`).
 * Every single user has their own standalone SQLite file with zero shared tables.
 */
export class UserVault {
  readonly telegramId: string;
  readonly dbPath: string;
  private readonly db: DatabaseSync;

  constructor(telegramId: string, dbPath: string) {
    this.telegramId = telegramId;
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
    this.seedDefaults();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS virtual_balances (
        chain TEXT PRIMARY KEY,
        balance_atomic TEXT NOT NULL DEFAULT '0',
        initial_balance_atomic TEXT NOT NULL DEFAULT '0',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain TEXT NOT NULL,
        token_address TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        token_name TEXT NOT NULL,
        token_decimals INTEGER NOT NULL DEFAULT 18,
        pair_address TEXT,
        dex TEXT,
        source_type TEXT NOT NULL DEFAULT 'manual',
        copied_wallet_id INTEGER,
        status TEXT NOT NULL DEFAULT 'open',
        qty_token_atomic TEXT NOT NULL,
        initial_qty_token_atomic TEXT NOT NULL,
        cost_native_atomic TEXT NOT NULL,
        initial_cost_native_atomic TEXT NOT NULL,
        realized_native_atomic TEXT NOT NULL DEFAULT '0',
        cost_usd REAL NOT NULL DEFAULT 0,
        initial_cost_usd REAL NOT NULL DEFAULT 0,
        realized_usd REAL NOT NULL DEFAULT 0,
        entry_price_usd REAL NOT NULL,
        last_price_usd REAL NOT NULL,
        entry_mc_usd REAL NOT NULL DEFAULT 0,
        entry_liq_usd REAL NOT NULL DEFAULT 0,
        entry_vol_5m_usd REAL NOT NULL DEFAULT 0,
        entry_token_age_sec INTEGER,
        peak_price_usd REAL NOT NULL DEFAULT 0,
        peak_mc_usd REAL NOT NULL DEFAULT 0,
        exit_price_usd REAL,
        exit_mc_usd REAL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status, chain);

      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER NOT NULL,
        chain TEXT NOT NULL,
        side TEXT NOT NULL,
        source_type TEXT NOT NULL,
        copied_wallet_id INTEGER,
        copied_tx_hash TEXT,
        token_address TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        qty_token_atomic TEXT NOT NULL,
        native_amount_atomic TEXT NOT NULL,
        fee_native_atomic TEXT NOT NULL DEFAULT '0',
        tax_bps INTEGER NOT NULL DEFAULT 0,
        slippage_bps INTEGER NOT NULL DEFAULT 0,
        price_usd REAL NOT NULL,
        native_price_usd REAL NOT NULL,
        mc_usd REAL NOT NULL DEFAULT 0,
        liq_usd REAL NOT NULL DEFAULT 0,
        vol_5m_usd REAL NOT NULL DEFAULT 0,
        token_age_sec INTEGER,
        security_risk TEXT NOT NULL DEFAULT 'unknown',
        realized_pnl_native_atomic TEXT NOT NULL DEFAULT '0',
        realized_pnl_usd REAL NOT NULL DEFAULT 0,
        sim_delay_ms INTEGER NOT NULL DEFAULT 0,
        executed_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_trades_time ON trades(executed_at);
      CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(copied_wallet_id, executed_at);

      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain TEXT NOT NULL,
        token_address TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        position_id INTEGER,
        order_type TEXT NOT NULL,
        trigger_mc_usd REAL,
        trigger_price_usd REAL,
        trigger_pnl_pct REAL,
        trailing_drop_pct REAL,
        highest_price_usd REAL,
        amount_native_atomic TEXT,
        sell_pct REAL,
        dca_interval_sec INTEGER,
        dca_remaining INTEGER,
        next_run_at INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, chain);

      CREATE TABLE IF NOT EXISTS watched_wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain TEXT NOT NULL,
        address TEXT NOT NULL,
        alias TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        copy_mode TEXT NOT NULL DEFAULT 'fixed',
        copy_amount_atomic TEXT NOT NULL DEFAULT '0',
        copy_percent REAL NOT NULL DEFAULT 0,
        max_buy_atomic TEXT,
        min_mc_usd REAL,
        max_mc_usd REAL,
        min_liq_usd REAL,
        skip_if_held INTEGER NOT NULL DEFAULT 1,
        mirror_sells INTEGER NOT NULL DEFAULT 1,
        block_risky INTEGER NOT NULL DEFAULT 1,
        sim_mode TEXT NOT NULL DEFAULT 'realistic',
        auto_tp_pct REAL,
        auto_sl_pct REAL,
        last_seen_tx TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(chain, address)
      );

      CREATE TABLE IF NOT EXISTS observed_wallet_swaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        watched_wallet_id INTEGER NOT NULL,
        chain TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        side TEXT NOT NULL,
        token_address TEXT NOT NULL,
        token_symbol TEXT,
        wallet_native_amount_atomic TEXT,
        price_usd_at_event REAL,
        mc_usd_at_event REAL,
        liq_usd_at_event REAL,
        vol_5m_usd_at_event REAL,
        token_age_sec INTEGER,
        dex TEXT,
        action_taken TEXT NOT NULL,
        skip_reason TEXT,
        observed_at INTEGER NOT NULL,
        UNIQUE(watched_wallet_id, tx_hash, side, token_address)
      );

      CREATE TABLE IF NOT EXISTS weekly_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL,
        summary_json TEXT NOT NULL,
        report_text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  private seedDefaults(): void {
    const now = Date.now();
    const insertBal = this.db.prepare(
      `INSERT OR IGNORE INTO virtual_balances (chain, balance_atomic, initial_balance_atomic, updated_at)
       VALUES (?, '0', '0', ?)`
    );
    for (const c of CHAIN_LIST) {
      insertBal.run(c.key, now);
    }

    const defaults: Record<string, string> = {
      active_chain: DEFAULT_SETTINGS.activeChain,
      slippage_bps: String(DEFAULT_SETTINGS.slippageBps),
      priority_fee_sol: DEFAULT_SETTINGS.priorityFeeSol,
      evm_gas_eth: DEFAULT_SETTINGS.evmGasEth,
      sim_mode: DEFAULT_SETTINGS.simMode,
      sim_delay_ms: String(DEFAULT_SETTINGS.simDelayMs),
      pnl_theme: DEFAULT_SETTINGS.pnlTheme,
      weekly_report_enabled: DEFAULT_SETTINGS.weeklyReportEnabled ? "1" : "0",
      copy_notify: DEFAULT_SETTINGS.copyNotify ? "1" : "0"
    };
    const insertSetting = this.db.prepare(
      `INSERT OR IGNORE INTO user_settings (key, value) VALUES (?, ?)`
    );
    for (const [k, v] of Object.entries(defaults)) {
      insertSetting.run(k, v);
    }
  }

  close(): void {
    this.db.close();
  }

  runInTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  // === Virtual Balances ===

  getBalances(): VirtualBalanceRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM virtual_balances`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      chain: String(r.chain) as ChainKey,
      balanceAtomic: BigInt(String(r.balance_atomic)),
      initialBalanceAtomic: BigInt(String(r.initial_balance_atomic)),
      updatedAt: Number(r.updated_at)
    }));
  }

  getBalance(chain: ChainKey): VirtualBalanceRow {
    const row = this.db
      .prepare(`SELECT * FROM virtual_balances WHERE chain = ?`)
      .get(chain) as Record<string, unknown>;
    return {
      chain,
      balanceAtomic: BigInt(String(row.balance_atomic)),
      initialBalanceAtomic: BigInt(String(row.initial_balance_atomic)),
      updatedAt: Number(row.updated_at)
    };
  }

  setVirtualFunds(chain: ChainKey, newBalanceAtomic: bigint, resetInitial = true): void {
    if (newBalanceAtomic < 0n) throw new Error("Balance cannot be negative.");
    const now = Date.now();
    if (resetInitial) {
      this.db
        .prepare(
          `UPDATE virtual_balances
           SET balance_atomic = ?, initial_balance_atomic = ?, updated_at = ?
           WHERE chain = ?`
        )
        .run(newBalanceAtomic.toString(), newBalanceAtomic.toString(), now, chain);
    } else {
      this.db
        .prepare(`UPDATE virtual_balances SET balance_atomic = ?, updated_at = ? WHERE chain = ?`)
        .run(newBalanceAtomic.toString(), now, chain);
    }
  }

  adjustBalance(chain: ChainKey, deltaAtomic: bigint): bigint {
    const current = this.getBalance(chain).balanceAtomic;
    const next = current + deltaAtomic;
    if (next < 0n) {
      throw new Error(`Insufficient virtual ${CHAINS[chain].nativeSymbol} balance.`);
    }
    this.setVirtualFunds(chain, next, false);
    return next;
  }

  // === Settings ===

  getSettings(): UserSettings {
    const rows = this.db
      .prepare(`SELECT key, value FROM user_settings`)
      .all() as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    return {
      activeChain: (map.get("active_chain") as ChainKey) ?? DEFAULT_SETTINGS.activeChain,
      slippageBps: Number(map.get("slippage_bps") ?? DEFAULT_SETTINGS.slippageBps),
      priorityFeeSol: map.get("priority_fee_sol") ?? DEFAULT_SETTINGS.priorityFeeSol,
      evmGasEth: map.get("evm_gas_eth") ?? DEFAULT_SETTINGS.evmGasEth,
      simMode: (map.get("sim_mode") as SimMode) ?? DEFAULT_SETTINGS.simMode,
      simDelayMs: Number(map.get("sim_delay_ms") ?? DEFAULT_SETTINGS.simDelayMs),
      pnlTheme: (map.get("pnl_theme") as PnlTheme) ?? DEFAULT_SETTINGS.pnlTheme,
      weeklyReportEnabled: (map.get("weekly_report_enabled") ?? "1") === "1",
      copyNotify: (map.get("copy_notify") ?? "1") === "1"
    };
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO user_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  // === Positions ===

  getOpenPosition(chain: ChainKey, tokenAddress: string, copiedWalletId?: number | null): PositionRow | null {
    const norm = normalizeAddress(chain, tokenAddress);
    const row =
      copiedWalletId !== undefined && copiedWalletId !== null
        ? (this.db
            .prepare(
              `SELECT * FROM positions
               WHERE status = 'open' AND chain = ? AND token_address = ? AND copied_wallet_id = ?
               ORDER BY id DESC LIMIT 1`
            )
            .get(chain, norm, copiedWalletId) as Record<string, unknown> | undefined)
        : (this.db
            .prepare(
              `SELECT * FROM positions
               WHERE status = 'open' AND chain = ? AND token_address = ?
               ORDER BY id DESC LIMIT 1`
            )
            .get(chain, norm) as Record<string, unknown> | undefined);
    return row ? this.mapPosition(row) : null;
  }

  getPositionById(id: number): PositionRow | null {
    const row = this.db
      .prepare(`SELECT * FROM positions WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapPosition(row) : null;
  }

  listOpenPositions(chain?: ChainKey): PositionRow[] {
    const rows = chain
      ? (this.db
          .prepare(`SELECT * FROM positions WHERE status = 'open' AND chain = ? ORDER BY opened_at DESC`)
          .all(chain) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at DESC`)
          .all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapPosition(r));
  }

  listClosedPositions(limit = 20): PositionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM positions WHERE status != 'open' ORDER BY closed_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapPosition(r));
  }

  createPosition(input: {
    chain: ChainKey;
    tokenAddress: string;
    tokenSymbol: string;
    tokenName: string;
    tokenDecimals: number;
    pairAddress: string | null;
    dex: string | null;
    sourceType: "manual" | "copy" | "limit" | "dca";
    copiedWalletId: number | null;
    qtyTokenAtomic: bigint;
    costNativeAtomic: bigint;
    costUsd: number;
    entryPriceUsd: number;
    entryMcUsd: number;
    entryLiqUsd: number;
    entryVol5mUsd: number;
    entryTokenAgeSec: number | null;
    openedAt: number;
  }): number {
    const norm = normalizeAddress(input.chain, input.tokenAddress);
    const res = this.db
      .prepare(
        `INSERT INTO positions (
          chain, token_address, token_symbol, token_name, token_decimals, pair_address, dex,
          source_type, copied_wallet_id, status,
          qty_token_atomic, initial_qty_token_atomic, cost_native_atomic, initial_cost_native_atomic,
          realized_native_atomic, cost_usd, initial_cost_usd, realized_usd,
          entry_price_usd, last_price_usd, entry_mc_usd, entry_liq_usd, entry_vol_5m_usd, entry_token_age_sec,
          peak_price_usd, peak_mc_usd, opened_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, '0', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.chain,
        norm,
        input.tokenSymbol,
        input.tokenName,
        input.tokenDecimals,
        input.pairAddress,
        input.dex,
        input.sourceType,
        input.copiedWalletId,
        input.qtyTokenAtomic.toString(),
        input.qtyTokenAtomic.toString(),
        input.costNativeAtomic.toString(),
        input.costNativeAtomic.toString(),
        input.costUsd,
        input.costUsd,
        input.entryPriceUsd,
        input.entryPriceUsd,
        input.entryMcUsd,
        input.entryLiqUsd,
        input.entryVol5mUsd,
        input.entryTokenAgeSec,
        input.entryPriceUsd,
        input.entryMcUsd,
        input.openedAt
      );
    return Number(res.lastInsertRowid);
  }

  addToPosition(params: {
    id: number;
    addedTokensAtomic: bigint;
    addedNativeAtomic: bigint;
    addedCostUsd: number;
    newPriceUsd: number;
    newMcUsd: number;
  }): void {
    const pos = this.getPositionById(params.id);
    if (!pos) throw new Error("Position not found");

    const nextQty = pos.qtyTokenAtomic + params.addedTokensAtomic;
    const nextInitQty = pos.initialQtyTokenAtomic + params.addedTokensAtomic;
    const nextCostNative = pos.costNativeAtomic + params.addedNativeAtomic;
    const nextInitCostNative = pos.initialCostNativeAtomic + params.addedNativeAtomic;
    const nextCostUsd = pos.costUsd + params.addedCostUsd;
    const nextInitCostUsd = pos.initialCostUsd + params.addedCostUsd;
    const weightedEntryPrice =
      nextQty > 0n
        ? (pos.entryPriceUsd * Number(pos.qtyTokenAtomic) + params.newPriceUsd * Number(params.addedTokensAtomic)) /
          Number(nextQty)
        : params.newPriceUsd;

    this.db
      .prepare(
        `UPDATE positions SET
          qty_token_atomic = ?, initial_qty_token_atomic = ?,
          cost_native_atomic = ?, initial_cost_native_atomic = ?,
          cost_usd = ?, initial_cost_usd = ?, entry_price_usd = ?, last_price_usd = ?,
          peak_price_usd = MAX(peak_price_usd, ?), peak_mc_usd = MAX(peak_mc_usd, ?)
         WHERE id = ?`
      )
      .run(
        nextQty.toString(),
        nextInitQty.toString(),
        nextCostNative.toString(),
        nextInitCostNative.toString(),
        nextCostUsd,
        nextInitCostUsd,
        weightedEntryPrice,
        params.newPriceUsd,
        params.newPriceUsd,
        params.newMcUsd,
        params.id
      );
  }

  reduceOrClosePosition(params: {
    id: number;
    soldTokensAtomic: bigint;
    receivedNativeAtomic: bigint;
    receivedUsd: number;
    priceUsd: number;
    mcUsd: number;
    statusIfZero?: "closed" | "rugged";
    closedAt: number;
  }): { closed: boolean; costBasisSoldNative: bigint; costBasisSoldUsd: number } {
    const pos = this.getPositionById(params.id);
    if (!pos) throw new Error("Position not found");
    if (params.soldTokensAtomic > pos.qtyTokenAtomic) {
      throw new Error("Cannot sell more tokens than held.");
    }

    const remainingQty = pos.qtyTokenAtomic - params.soldTokensAtomic;
    const costBasisSoldNative =
      pos.qtyTokenAtomic > 0n ? (pos.costNativeAtomic * params.soldTokensAtomic) / pos.qtyTokenAtomic : 0n;
    const ratioSold = pos.qtyTokenAtomic > 0n ? Number(params.soldTokensAtomic) / Number(pos.qtyTokenAtomic) : 1;
    const costBasisSoldUsd = pos.costUsd * ratioSold;

    const nextCostNative = pos.costNativeAtomic - costBasisSoldNative;
    const nextCostUsd = Math.max(0, pos.costUsd - costBasisSoldUsd);
    const nextRealizedNative = pos.realizedNativeAtomic + params.receivedNativeAtomic;
    const nextRealizedUsd = pos.realizedUsd + params.receivedUsd;
    const isClosed = remainingQty === 0n;

    this.db
      .prepare(
        `UPDATE positions SET
          qty_token_atomic = ?, cost_native_atomic = ?, cost_usd = ?,
          realized_native_atomic = ?, realized_usd = ?,
          last_price_usd = ?, peak_price_usd = MAX(peak_price_usd, ?), peak_mc_usd = MAX(peak_mc_usd, ?),
          status = ?, exit_price_usd = ?, exit_mc_usd = ?, closed_at = ?
         WHERE id = ?`
      )
      .run(
        remainingQty.toString(),
        nextCostNative.toString(),
        nextCostUsd,
        nextRealizedNative.toString(),
        nextRealizedUsd,
        params.priceUsd,
        params.priceUsd,
        params.mcUsd,
        isClosed ? (params.statusIfZero ?? "closed") : "open",
        isClosed ? params.priceUsd : pos.exitPriceUsd,
        isClosed ? params.mcUsd : pos.exitMcUsd,
        isClosed ? params.closedAt : null,
        params.id
      );

    return { closed: isClosed, costBasisSoldNative, costBasisSoldUsd };
  }

  updatePositionMark(id: number, lastPriceUsd: number, mcUsd: number): void {
    this.db
      .prepare(
        `UPDATE positions SET
          last_price_usd = ?,
          peak_price_usd = MAX(peak_price_usd, ?),
          peak_mc_usd = MAX(peak_mc_usd, ?)
         WHERE id = ?`
      )
      .run(lastPriceUsd, lastPriceUsd, mcUsd, id);
  }

  // === Trades ===

  recordTrade(input: Omit<TradeRow, "id">): number {
    const res = this.db
      .prepare(
        `INSERT INTO trades (
          position_id, chain, side, source_type, copied_wallet_id, copied_tx_hash,
          token_address, token_symbol, qty_token_atomic, native_amount_atomic, fee_native_atomic,
          tax_bps, slippage_bps, price_usd, native_price_usd, mc_usd, liq_usd, vol_5m_usd,
          token_age_sec, security_risk, realized_pnl_native_atomic, realized_pnl_usd,
          sim_delay_ms, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.positionId,
        input.chain,
        input.side,
        input.sourceType,
        input.copiedWalletId,
        input.copiedTxHash,
        normalizeAddress(input.chain, input.tokenAddress),
        input.tokenSymbol,
        input.qtyTokenAtomic.toString(),
        input.nativeAmountAtomic.toString(),
        input.feeNativeAtomic.toString(),
        input.taxBps,
        input.slippageBps,
        input.priceUsd,
        input.nativePriceUsd,
        input.mcUsd,
        input.liqUsd,
        input.vol5mUsd,
        input.tokenAgeSec,
        input.securityRisk,
        input.realizedPnlNativeAtomic.toString(),
        input.realizedPnlUsd,
        input.simDelayMs,
        input.executedAt
      );
    return Number(res.lastInsertRowid);
  }

  listTradesBetween(startMs: number, endMs: number): TradeRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM trades WHERE executed_at >= ? AND executed_at <= ? ORDER BY executed_at ASC`)
      .all(startMs, endMs) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapTrade(r));
  }

  listRecentTrades(limit = 20): TradeRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM trades ORDER BY executed_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapTrade(r));
  }

  listPositionsInPeriod(startMs: number, endMs: number): PositionRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM positions
         WHERE (opened_at >= ? AND opened_at <= ?)
            OR (closed_at IS NOT NULL AND closed_at >= ? AND closed_at <= ?)
         ORDER BY opened_at ASC`
      )
      .all(startMs, endMs, startMs, endMs) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapPosition(r));
  }

  // === Orders ===

  createOrder(input: Omit<OrderRow, "id" | "createdAt" | "updatedAt" | "status">): number {
    const now = Date.now();
    const res = this.db
      .prepare(
        `INSERT INTO orders (
          chain, token_address, token_symbol, position_id, order_type,
          trigger_mc_usd, trigger_price_usd, trigger_pnl_pct, trailing_drop_pct, highest_price_usd,
          amount_native_atomic, sell_pct, dca_interval_sec, dca_remaining, next_run_at,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      )
      .run(
        input.chain,
        normalizeAddress(input.chain, input.tokenAddress),
        input.tokenSymbol,
        input.positionId,
        input.orderType,
        input.triggerMcUsd,
        input.triggerPriceUsd,
        input.triggerPnlPct,
        input.trailingDropPct,
        input.highestPriceUsd,
        input.amountNativeAtomic !== null ? input.amountNativeAtomic.toString() : null,
        input.sellPct,
        input.dcaIntervalSec,
        input.dcaRemaining,
        input.nextRunAt,
        now,
        now
      );
    return Number(res.lastInsertRowid);
  }

  listActiveOrders(chain?: ChainKey): OrderRow[] {
    const rows = chain
      ? (this.db
          .prepare(`SELECT * FROM orders WHERE status = 'active' AND chain = ? ORDER BY created_at DESC`)
          .all(chain) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM orders WHERE status = 'active' ORDER BY created_at DESC`)
          .all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapOrder(r));
  }

  updateOrderHighestPrice(id: number, highestPriceUsd: number): void {
    this.db
      .prepare(`UPDATE orders SET highest_price_usd = ?, updated_at = ? WHERE id = ?`)
      .run(highestPriceUsd, Date.now(), id);
  }

  advanceDcaOrder(id: number, remaining: number, nextRunAt: number | null): void {
    const status = remaining <= 0 ? "filled" : "active";
    this.db
      .prepare(`UPDATE orders SET dca_remaining = ?, next_run_at = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(remaining, nextRunAt, status, Date.now(), id);
  }

  setOrderStatus(id: number, status: "active" | "filled" | "cancelled"): boolean {
    const res = this.db
      .prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), id);
    return Number(res.changes) > 0;
  }

  // === Watched Wallets ===

  addWatchedWallet(input: {
    chain: ChainKey;
    address: string;
    alias: string;
    copyMode: CopyMode;
    copyAmountAtomic: bigint;
    copyPercent?: number;
    maxBuyAtomic?: bigint | null;
    minMcUsd?: number | null;
    maxMcUsd?: number | null;
    minLiqUsd?: number | null;
    skipIfHeld?: boolean;
    mirrorSells?: boolean;
    blockRisky?: boolean;
    simMode?: SimMode;
    autoTpPct?: number | null;
    autoSlPct?: number | null;
  }): number {
    const norm = normalizeAddress(input.chain, input.address);
    const now = Date.now();
    const res = this.db
      .prepare(
        `INSERT INTO watched_wallets (
          chain, address, alias, enabled, copy_mode, copy_amount_atomic, copy_percent, max_buy_atomic,
          min_mc_usd, max_mc_usd, min_liq_usd, skip_if_held, mirror_sells, block_risky,
          sim_mode, auto_tp_pct, auto_sl_pct, created_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.chain,
        norm,
        input.alias.trim(),
        input.copyMode,
        input.copyAmountAtomic.toString(),
        input.copyPercent ?? 0,
        input.maxBuyAtomic ? input.maxBuyAtomic.toString() : null,
        input.minMcUsd ?? null,
        input.maxMcUsd ?? null,
        input.minLiqUsd ?? null,
        (input.skipIfHeld ?? true) ? 1 : 0,
        (input.mirrorSells ?? true) ? 1 : 0,
        (input.blockRisky ?? true) ? 1 : 0,
        input.simMode ?? "realistic",
        input.autoTpPct ?? null,
        input.autoSlPct ?? null,
        now
      );
    return Number(res.lastInsertRowid);
  }

  listWatchedWallets(onlyEnabled = false): WatchedWalletRow[] {
    const rows = onlyEnabled
      ? (this.db
          .prepare(`SELECT * FROM watched_wallets WHERE enabled = 1 ORDER BY id ASC`)
          .all() as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM watched_wallets ORDER BY id ASC`)
          .all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapWatchedWallet(r));
  }

  getWatchedWallet(id: number): WatchedWalletRow | null {
    const row = this.db
      .prepare(`SELECT * FROM watched_wallets WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapWatchedWallet(row) : null;
  }

  updateWatchedWallet(
    id: number,
    patch: Partial<{
      alias: string;
      enabled: boolean;
      copyMode: CopyMode;
      copyAmountAtomic: bigint;
      copyPercent: number;
      maxBuyAtomic: bigint | null;
      minMcUsd: number | null;
      maxMcUsd: number | null;
      minLiqUsd: number | null;
      skipIfHeld: boolean;
      mirrorSells: boolean;
      blockRisky: boolean;
      simMode: SimMode;
      autoTpPct: number | null;
      autoSlPct: number | null;
      lastSeenTx: string | null;
    }>
  ): void {
    const current = this.getWatchedWallet(id);
    if (!current) return;
    this.db
      .prepare(
        `UPDATE watched_wallets SET
          alias = ?, enabled = ?, copy_mode = ?, copy_amount_atomic = ?, copy_percent = ?,
          max_buy_atomic = ?, min_mc_usd = ?, max_mc_usd = ?, min_liq_usd = ?,
          skip_if_held = ?, mirror_sells = ?, block_risky = ?, sim_mode = ?,
          auto_tp_pct = ?, auto_sl_pct = ?, last_seen_tx = ?
         WHERE id = ?`
      )
      .run(
        patch.alias ?? current.alias,
        (patch.enabled ?? current.enabled) ? 1 : 0,
        patch.copyMode ?? current.copyMode,
        (patch.copyAmountAtomic ?? current.copyAmountAtomic).toString(),
        patch.copyPercent ?? current.copyPercent,
        (patch.maxBuyAtomic !== undefined ? patch.maxBuyAtomic : current.maxBuyAtomic)?.toString() ?? null,
        patch.minMcUsd !== undefined ? patch.minMcUsd : current.minMcUsd,
        patch.maxMcUsd !== undefined ? patch.maxMcUsd : current.maxMcUsd,
        patch.minLiqUsd !== undefined ? patch.minLiqUsd : current.minLiqUsd,
        (patch.skipIfHeld ?? current.skipIfHeld) ? 1 : 0,
        (patch.mirrorSells ?? current.mirrorSells) ? 1 : 0,
        (patch.blockRisky ?? current.blockRisky) ? 1 : 0,
        patch.simMode ?? current.simMode,
        patch.autoTpPct !== undefined ? patch.autoTpPct : current.autoTpPct,
        patch.autoSlPct !== undefined ? patch.autoSlPct : current.autoSlPct,
        patch.lastSeenTx !== undefined ? patch.lastSeenTx : current.lastSeenTx,
        id
      );
  }

  deleteWatchedWallet(id: number): boolean {
    const res = this.db.prepare(`DELETE FROM watched_wallets WHERE id = ?`).run(id);
    return Number(res.changes) > 0;
  }

  // === Observed Swaps ===

  recordObservedSwap(input: Omit<ObservedSwapRow, "id">): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO observed_wallet_swaps (
          watched_wallet_id, chain, tx_hash, side, token_address, token_symbol,
          wallet_native_amount_atomic, price_usd_at_event, mc_usd_at_event, liq_usd_at_event,
          vol_5m_usd_at_event, token_age_sec, dex, action_taken, skip_reason, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.watchedWalletId,
        input.chain,
        input.txHash,
        input.side,
        normalizeAddress(input.chain, input.tokenAddress),
        input.tokenSymbol,
        input.walletNativeAmountAtomic !== null ? input.walletNativeAmountAtomic.toString() : null,
        input.priceUsdAtEvent,
        input.mcUsdAtEvent,
        input.liqUsdAtEvent,
        input.vol5mUsdAtEvent,
        input.tokenAgeSec,
        input.dex,
        input.actionTaken,
        input.skipReason,
        input.observedAt
      );
    return Number(res.changes) > 0;
  }

  listObservedSwapsBetween(startMs: number, endMs: number): ObservedSwapRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM observed_wallet_swaps
         WHERE observed_at >= ? AND observed_at <= ?
         ORDER BY observed_at ASC`
      )
      .all(startMs, endMs) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapObservedSwap(r));
  }

  // === Weekly Reports ===

  saveWeeklyReport(input: Omit<WeeklyReportRow, "id" | "createdAt">): number {
    const res = this.db
      .prepare(
        `INSERT INTO weekly_reports (period_start, period_end, summary_json, report_text, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.periodStart, input.periodEnd, input.summaryJson, input.reportText, Date.now());
    return Number(res.lastInsertRowid);
  }

  getLatestWeeklyReport(): WeeklyReportRow | null {
    const row = this.db
      .prepare(`SELECT * FROM weekly_reports ORDER BY created_at DESC LIMIT 1`)
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      periodStart: Number(row.period_start),
      periodEnd: Number(row.period_end),
      summaryJson: String(row.summary_json),
      reportText: String(row.report_text),
      createdAt: Number(row.created_at)
    };
  }

  // === Mappers ===

  private mapPosition(row: Record<string, unknown>): PositionRow {
    return {
      id: Number(row.id),
      chain: String(row.chain) as ChainKey,
      tokenAddress: String(row.token_address),
      tokenSymbol: String(row.token_symbol),
      tokenName: String(row.token_name),
      tokenDecimals: Number(row.token_decimals),
      pairAddress: row.pair_address ? String(row.pair_address) : null,
      dex: row.dex ? String(row.dex) : null,
      sourceType: String(row.source_type) as PositionRow["sourceType"],
      copiedWalletId: row.copied_wallet_id !== null ? Number(row.copied_wallet_id) : null,
      status: String(row.status) as PositionRow["status"],
      qtyTokenAtomic: BigInt(String(row.qty_token_atomic)),
      initialQtyTokenAtomic: BigInt(String(row.initial_qty_token_atomic)),
      costNativeAtomic: BigInt(String(row.cost_native_atomic)),
      initialCostNativeAtomic: BigInt(String(row.initial_cost_native_atomic)),
      realizedNativeAtomic: BigInt(String(row.realized_native_atomic)),
      costUsd: Number(row.cost_usd),
      initialCostUsd: Number(row.initial_cost_usd ?? row.cost_usd ?? 0),
      realizedUsd: Number(row.realized_usd),
      entryPriceUsd: Number(row.entry_price_usd),
      lastPriceUsd: Number(row.last_price_usd),
      entryMcUsd: Number(row.entry_mc_usd),
      entryLiqUsd: Number(row.entry_liq_usd),
      entryVol5mUsd: Number(row.entry_vol_5m_usd),
      entryTokenAgeSec: row.entry_token_age_sec !== null ? Number(row.entry_token_age_sec) : null,
      peakPriceUsd: Number(row.peak_price_usd),
      peakMcUsd: Number(row.peak_mc_usd),
      exitPriceUsd: row.exit_price_usd !== null ? Number(row.exit_price_usd) : null,
      exitMcUsd: row.exit_mc_usd !== null ? Number(row.exit_mc_usd) : null,
      openedAt: Number(row.opened_at),
      closedAt: row.closed_at !== null ? Number(row.closed_at) : null
    };
  }

  private mapTrade(row: Record<string, unknown>): TradeRow {
    return {
      id: Number(row.id),
      positionId: Number(row.position_id),
      chain: String(row.chain) as ChainKey,
      side: String(row.side) as TradeRow["side"],
      sourceType: String(row.source_type),
      copiedWalletId: row.copied_wallet_id !== null ? Number(row.copied_wallet_id) : null,
      copiedTxHash: row.copied_tx_hash ? String(row.copied_tx_hash) : null,
      tokenAddress: String(row.token_address),
      tokenSymbol: String(row.token_symbol),
      qtyTokenAtomic: BigInt(String(row.qty_token_atomic)),
      nativeAmountAtomic: BigInt(String(row.native_amount_atomic)),
      feeNativeAtomic: BigInt(String(row.fee_native_atomic)),
      taxBps: Number(row.tax_bps),
      slippageBps: Number(row.slippage_bps),
      priceUsd: Number(row.price_usd),
      nativePriceUsd: Number(row.native_price_usd),
      mcUsd: Number(row.mc_usd),
      liqUsd: Number(row.liq_usd),
      vol5mUsd: Number(row.vol_5m_usd),
      tokenAgeSec: row.token_age_sec !== null ? Number(row.token_age_sec) : null,
      securityRisk: String(row.security_risk),
      realizedPnlNativeAtomic: BigInt(String(row.realized_pnl_native_atomic)),
      realizedPnlUsd: Number(row.realized_pnl_usd),
      simDelayMs: Number(row.sim_delay_ms),
      executedAt: Number(row.executed_at)
    };
  }

  private mapOrder(row: Record<string, unknown>): OrderRow {
    return {
      id: Number(row.id),
      chain: String(row.chain) as ChainKey,
      tokenAddress: String(row.token_address),
      tokenSymbol: String(row.token_symbol),
      positionId: row.position_id !== null ? Number(row.position_id) : null,
      orderType: String(row.order_type) as OrderRow["orderType"],
      triggerMcUsd: row.trigger_mc_usd !== null ? Number(row.trigger_mc_usd) : null,
      triggerPriceUsd: row.trigger_price_usd !== null ? Number(row.trigger_price_usd) : null,
      triggerPnlPct: row.trigger_pnl_pct !== null ? Number(row.trigger_pnl_pct) : null,
      trailingDropPct: row.trailing_drop_pct !== null ? Number(row.trailing_drop_pct) : null,
      highestPriceUsd: row.highest_price_usd !== null ? Number(row.highest_price_usd) : null,
      amountNativeAtomic: row.amount_native_atomic ? BigInt(String(row.amount_native_atomic)) : null,
      sellPct: row.sell_pct !== null ? Number(row.sell_pct) : null,
      dcaIntervalSec: row.dca_interval_sec !== null ? Number(row.dca_interval_sec) : null,
      dcaRemaining: row.dca_remaining !== null ? Number(row.dca_remaining) : null,
      nextRunAt: row.next_run_at !== null ? Number(row.next_run_at) : null,
      status: String(row.status) as OrderRow["status"],
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  private mapWatchedWallet(row: Record<string, unknown>): WatchedWalletRow {
    return {
      id: Number(row.id),
      chain: String(row.chain) as ChainKey,
      address: String(row.address),
      alias: String(row.alias),
      enabled: Number(row.enabled) === 1,
      copyMode: String(row.copy_mode) as CopyMode,
      copyAmountAtomic: BigInt(String(row.copy_amount_atomic)),
      copyPercent: Number(row.copy_percent),
      maxBuyAtomic: row.max_buy_atomic ? BigInt(String(row.max_buy_atomic)) : null,
      minMcUsd: row.min_mc_usd !== null ? Number(row.min_mc_usd) : null,
      maxMcUsd: row.max_mc_usd !== null ? Number(row.max_mc_usd) : null,
      minLiqUsd: row.min_liq_usd !== null ? Number(row.min_liq_usd) : null,
      skipIfHeld: Number(row.skip_if_held) === 1,
      mirrorSells: Number(row.mirror_sells) === 1,
      blockRisky: Number(row.block_risky) === 1,
      simMode: String(row.sim_mode) as SimMode,
      autoTpPct: row.auto_tp_pct !== null ? Number(row.auto_tp_pct) : null,
      autoSlPct: row.auto_sl_pct !== null ? Number(row.auto_sl_pct) : null,
      lastSeenTx: row.last_seen_tx ? String(row.last_seen_tx) : null,
      createdAt: Number(row.created_at)
    };
  }

  private mapObservedSwap(row: Record<string, unknown>): ObservedSwapRow {
    return {
      id: Number(row.id),
      watchedWalletId: Number(row.watched_wallet_id),
      chain: String(row.chain) as ChainKey,
      txHash: String(row.tx_hash),
      side: String(row.side) as "buy" | "sell",
      tokenAddress: String(row.token_address),
      tokenSymbol: row.token_symbol ? String(row.token_symbol) : null,
      walletNativeAmountAtomic: row.wallet_native_amount_atomic
        ? BigInt(String(row.wallet_native_amount_atomic))
        : null,
      priceUsdAtEvent: row.price_usd_at_event !== null ? Number(row.price_usd_at_event) : null,
      mcUsdAtEvent: row.mc_usd_at_event !== null ? Number(row.mc_usd_at_event) : null,
      liqUsdAtEvent: row.liq_usd_at_event !== null ? Number(row.liq_usd_at_event) : null,
      vol5mUsdAtEvent: row.vol_5m_usd_at_event !== null ? Number(row.vol_5m_usd_at_event) : null,
      tokenAgeSec: row.token_age_sec !== null ? Number(row.token_age_sec) : null,
      dex: row.dex ? String(row.dex) : null,
      actionTaken: String(row.action_taken),
      skipReason: row.skip_reason ? String(row.skip_reason) : null,
      observedAt: Number(row.observed_at)
    };
  }
}

export class UserVaultManager {
  private readonly vaultDir: string;
  private readonly vaults = new Map<string, UserVault>();

  constructor(vaultDir: string) {
    this.vaultDir = vaultDir;
    fs.mkdirSync(vaultDir, { recursive: true });
  }

  getVault(telegramId: string): UserVault {
    if (!/^\d+$/.test(telegramId)) {
      throw new Error(`Invalid Telegram ID "${telegramId}"`);
    }
    let vault = this.vaults.get(telegramId);
    if (!vault) {
      const dbPath = path.join(this.vaultDir, `${telegramId}.db`);
      vault = new UserVault(telegramId, dbPath);
      this.vaults.set(telegramId, vault);
    }
    return vault;
  }

  hasVault(telegramId: string): boolean {
    if (!/^\d+$/.test(telegramId)) return false;
    return fs.existsSync(path.join(this.vaultDir, `${telegramId}.db`));
  }

  closeAll(): void {
    for (const v of this.vaults.values()) {
      v.close();
    }
    this.vaults.clear();
  }
}
