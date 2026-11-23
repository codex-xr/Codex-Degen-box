import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHAIN_LIST, ChainKey, CHAINS, normalizeAddress } from "../chains/registry.js";
import {
  CopyMode,
  DEFAULT_USER_SETTINGS,
  IUserVault,
  IVaultManager,
  ObservedSwapRow,
  OrderRow,
  PnlTheme,
  PositionRow,
  SellMode,
  SimMode,
  TradeRow,
  UserSettings,
  VirtualBalanceRow,
  WatchedWalletRow,
  WeeklyReportRow
} from "./types.js";
export * from "./types.js";

/**
 * Isolated per-user private SQLite database (`data/users/<telegramId>.db`).
 * Used automatically when running locally without DATABASE_URL.
 */
export class UserVault implements IUserVault {
  readonly telegramId: string;
  readonly dbPath: string;
  readonly locationLabel: string;
  private readonly db: DatabaseSync;
  private inTx = false;

  constructor(telegramId: string, dbPath: string) {
    this.telegramId = telegramId;
    this.dbPath = dbPath;
    this.locationLabel = dbPath;
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
        transfer_alerts INTEGER NOT NULL DEFAULT 1,
        snipe_dev_launches INTEGER NOT NULL DEFAULT 0,
        sell_mode TEXT NOT NULL DEFAULT 'full',
        sim_mode TEXT NOT NULL DEFAULT 'realistic',
        auto_tp_pct REAL,
        auto_sl_pct REAL,
        auto_trailing_pct REAL,
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

    const cols = this.db.prepare(`PRAGMA table_info(watched_wallets)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "transfer_alerts")) {
      this.db.exec(`ALTER TABLE watched_wallets ADD COLUMN transfer_alerts INTEGER NOT NULL DEFAULT 1;`);
    }
    if (!cols.some((c) => c.name === "snipe_dev_launches")) {
      this.db.exec(`ALTER TABLE watched_wallets ADD COLUMN snipe_dev_launches INTEGER NOT NULL DEFAULT 0;`);
    }
    if (!cols.some((c) => c.name === "sell_mode")) {
      this.db.exec(`ALTER TABLE watched_wallets ADD COLUMN sell_mode TEXT NOT NULL DEFAULT 'full';`);
    }
    if (!cols.some((c) => c.name === "auto_trailing_pct")) {
      this.db.exec(`ALTER TABLE watched_wallets ADD COLUMN auto_trailing_pct REAL;`);
    }
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
      active_chain: DEFAULT_USER_SETTINGS.activeChain,
      slippage_bps: String(DEFAULT_USER_SETTINGS.slippageBps),
      priority_fee_sol: DEFAULT_USER_SETTINGS.priorityFeeSol,
      evm_gas_eth: DEFAULT_USER_SETTINGS.evmGasEth,
      sim_mode: DEFAULT_USER_SETTINGS.simMode,
      sim_delay_ms: String(DEFAULT_USER_SETTINGS.simDelayMs),
      pnl_theme: DEFAULT_USER_SETTINGS.pnlTheme,
      weekly_report_enabled: DEFAULT_USER_SETTINGS.weeklyReportEnabled ? "1" : "0",
      copy_notify: DEFAULT_USER_SETTINGS.copyNotify ? "1" : "0",
      notify_skips: DEFAULT_USER_SETTINGS.notifySkips ? "1" : "0"
    };
    const insertSetting = this.db.prepare(
      `INSERT OR IGNORE INTO user_settings (key, value) VALUES (?, ?)`
    );
    for (const [k, v] of Object.entries(defaults)) {
      insertSetting.run(k, v);
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTx) return fn();
    this.inTx = true;
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = await fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  async getBalances(): Promise<VirtualBalanceRow[]> {
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

  async getBalance(chain: ChainKey): Promise<VirtualBalanceRow> {
    const row = this.db
      .prepare(`SELECT * FROM virtual_balances WHERE chain = ?`)
      .get(chain) as Record<string, unknown> | undefined;
    return {
      chain,
      balanceAtomic: BigInt(String(row?.balance_atomic ?? "0")),
      initialBalanceAtomic: BigInt(String(row?.initial_balance_atomic ?? "0")),
      updatedAt: Number(row?.updated_at ?? Date.now())
    };
  }

  async setVirtualFunds(chain: ChainKey, newBalanceAtomic: bigint, resetInitial = true): Promise<void> {
    if (newBalanceAtomic < 0n) throw new Error("Balance cannot be negative.");
    const now = Date.now();
    if (resetInitial) {
      this.db
        .prepare(
          `INSERT INTO virtual_balances (chain, balance_atomic, initial_balance_atomic, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(chain) DO UPDATE SET
             balance_atomic = excluded.balance_atomic,
             initial_balance_atomic = excluded.initial_balance_atomic,
             updated_at = excluded.updated_at`
        )
        .run(chain, newBalanceAtomic.toString(), newBalanceAtomic.toString(), now);
    } else {
      this.db
        .prepare(
          `INSERT INTO virtual_balances (chain, balance_atomic, initial_balance_atomic, updated_at)
           VALUES (?, ?, '0', ?)
           ON CONFLICT(chain) DO UPDATE SET
             balance_atomic = excluded.balance_atomic,
             updated_at = excluded.updated_at`
        )
        .run(chain, newBalanceAtomic.toString(), now);
    }
  }

  async addVirtualFunds(chain: ChainKey, addAtomic: bigint): Promise<bigint> {
    if (addAtomic <= 0n) throw new Error("Amount to add must be greater than zero.");
    const cur = await this.getBalance(chain);
    const nextBal = cur.balanceAtomic + addAtomic;
    const nextInitial = cur.initialBalanceAtomic + addAtomic;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO virtual_balances (chain, balance_atomic, initial_balance_atomic, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chain) DO UPDATE SET
           balance_atomic = excluded.balance_atomic,
           initial_balance_atomic = excluded.initial_balance_atomic,
           updated_at = excluded.updated_at`
      )
      .run(chain, nextBal.toString(), nextInitial.toString(), now);
    return nextBal;
  }

  async adjustBalance(chain: ChainKey, deltaAtomic: bigint): Promise<bigint> {
    const current = (await this.getBalance(chain)).balanceAtomic;
    const next = current + deltaAtomic;
    if (next < 0n) {
      throw new Error(`Insufficient virtual ${CHAINS[chain].nativeSymbol} balance.`);
    }
    await this.setVirtualFunds(chain, next, false);
    return next;
  }

  async getSettings(): Promise<UserSettings> {
    const rows = this.db
      .prepare(
        `SELECT key, CASE WHEN key = 'pnl_bg_data_url' AND value <> '' THEN '1' ELSE value END AS value FROM user_settings`
      )
      .all() as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const rawAccent = map.get("pnl_accent_hex")?.trim();
    return {
      activeChain: (map.get("active_chain") as ChainKey) ?? DEFAULT_USER_SETTINGS.activeChain,
      slippageBps: Number(map.get("slippage_bps") ?? DEFAULT_USER_SETTINGS.slippageBps),
      priorityFeeSol: map.get("priority_fee_sol") ?? DEFAULT_USER_SETTINGS.priorityFeeSol,
      evmGasEth: map.get("evm_gas_eth") ?? DEFAULT_USER_SETTINGS.evmGasEth,
      simMode: (map.get("sim_mode") as SimMode) ?? DEFAULT_USER_SETTINGS.simMode,
      simDelayMs: Number(map.get("sim_delay_ms") ?? DEFAULT_USER_SETTINGS.simDelayMs),
      pnlTheme: (map.get("pnl_theme") as PnlTheme) ?? DEFAULT_USER_SETTINGS.pnlTheme,
      pnlAccentHex: rawAccent && /^#[0-9a-fA-F]{6}$/.test(rawAccent) ? rawAccent : null,
      pnlHideAmounts: map.get("pnl_hide_amounts") === "1",
      hasPnlBg: map.get("pnl_bg_data_url") === "1",
      weeklyReportEnabled: (map.get("weekly_report_enabled") ?? "1") === "1",
      copyNotify: (map.get("copy_notify") ?? "1") === "1",
      notifySkips: map.get("notify_skips") === "1"
    };
  }

  async getSetting(key: string): Promise<string | null> {
    const row = this.db.prepare(`SELECT value FROM user_settings WHERE key = ?`).get(key) as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO user_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  async getOpenPosition(
    chain: ChainKey,
    tokenAddress: string,
    copiedWalletId?: number | null
  ): Promise<PositionRow | null> {
    const norm = normalizeAddress(chain, tokenAddress);
    const row =
      copiedWalletId === null
        ? (this.db
            .prepare(
              `SELECT * FROM positions
               WHERE status = 'open' AND chain = ? AND token_address = ? AND copied_wallet_id IS NULL
               ORDER BY id DESC LIMIT 1`
            )
            .get(chain, norm) as Record<string, unknown> | undefined)
        : copiedWalletId !== undefined
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

  async getPositionById(id: number): Promise<PositionRow | null> {
    const row = this.db
      .prepare(`SELECT * FROM positions WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapPosition(row) : null;
  }

  async listOpenPositions(chain?: ChainKey): Promise<PositionRow[]> {
    const rows = chain
      ? (this.db
          .prepare(`SELECT * FROM positions WHERE status = 'open' AND chain = ? ORDER BY opened_at DESC`)
          .all(chain) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at DESC`)
          .all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapPosition(r));
  }

  async listClosedPositions(limit = 20): Promise<PositionRow[]> {
    const rows = this.db
      .prepare(`SELECT * FROM positions WHERE status != 'open' ORDER BY closed_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapPosition(r));
  }

  async createPosition(input: Parameters<IUserVault["createPosition"]>[0]): Promise<number> {
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

  async addToPosition(params: Parameters<IUserVault["addToPosition"]>[0]): Promise<void> {
    const pos = await this.getPositionById(params.id);
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

  async reduceOrClosePosition(
    params: Parameters<IUserVault["reduceOrClosePosition"]>[0]
  ): Promise<{ closed: boolean; costBasisSoldNative: bigint; costBasisSoldUsd: number }> {
    const pos = await this.getPositionById(params.id);
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

  async updatePositionMark(id: number, lastPriceUsd: number, mcUsd: number): Promise<void> {
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

  async recordTrade(input: Omit<TradeRow, "id">): Promise<number> {
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

  async listTradesBetween(startMs: number, endMs: number): Promise<TradeRow[]> {
    const rows = this.db
      .prepare(`SELECT * FROM trades WHERE executed_at >= ? AND executed_at <= ? ORDER BY executed_at ASC`)
      .all(startMs, endMs) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapTrade(r));
  }

  async listRecentTrades(limit = 20): Promise<TradeRow[]> {
    const rows = this.db
      .prepare(`SELECT * FROM trades ORDER BY executed_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapTrade(r));
  }

  async listPositionsInPeriod(startMs: number, endMs: number): Promise<PositionRow[]> {
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

  async createOrder(input: Omit<OrderRow, "id" | "createdAt" | "updatedAt" | "status">): Promise<number> {
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

  async listActiveOrders(chain?: ChainKey): Promise<OrderRow[]> {
    const rows = chain
      ? (this.db
          .prepare(`SELECT * FROM orders WHERE status = 'active' AND chain = ? ORDER BY created_at DESC`)
          .all(chain) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM orders WHERE status = 'active' ORDER BY created_at DESC`)
          .all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapOrder(r));
  }

  async updateOrderHighestPrice(id: number, highestPriceUsd: number): Promise<void> {
    this.db
      .prepare(`UPDATE orders SET highest_price_usd = ?, updated_at = ? WHERE id = ?`)
      .run(highestPriceUsd, Date.now(), id);
  }

  async advanceDcaOrder(id: number, remaining: number, nextRunAt: number | null): Promise<void> {
    const status = remaining <= 0 ? "filled" : "active";
    this.db
      .prepare(`UPDATE orders SET dca_remaining = ?, next_run_at = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(remaining, nextRunAt, status, Date.now(), id);
  }

  async setOrderStatus(id: number, status: "active" | "filled" | "cancelled"): Promise<boolean> {
    const res = this.db
      .prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), id);
    return Number(res.changes) > 0;
  }

  async addWatchedWallet(input: Parameters<IUserVault["addWatchedWallet"]>[0]): Promise<number> {
    const norm = normalizeAddress(input.chain, input.address);
    const now = Date.now();
    const res = this.db
      .prepare(
        `INSERT INTO watched_wallets (
          chain, address, alias, enabled, copy_mode, copy_amount_atomic, copy_percent, max_buy_atomic,
          min_mc_usd, max_mc_usd, min_liq_usd, skip_if_held, mirror_sells, block_risky, transfer_alerts,
          snipe_dev_launches, sell_mode, sim_mode, auto_tp_pct, auto_sl_pct, auto_trailing_pct, created_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        (input.transferAlerts ?? true) ? 1 : 0,
        (input.snipeDevLaunches ?? false) ? 1 : 0,
        input.sellMode ?? "full",
        input.simMode ?? "realistic",
        input.autoTpPct ?? null,
        input.autoSlPct ?? null,
        input.autoTrailingPct ?? null,
        now
      );
    return Number(res.lastInsertRowid);
  }

  async listWatchedWallets(onlyEnabled = false): Promise<WatchedWalletRow[]> {
    const rows = onlyEnabled
      ? (this.db
          .prepare(`SELECT * FROM watched_wallets WHERE enabled = 1 ORDER BY id ASC`)
          .all() as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM watched_wallets ORDER BY id ASC`)
          .all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapWatchedWallet(r));
  }

  async getWatchedWallet(id: number): Promise<WatchedWalletRow | null> {
    const row = this.db
      .prepare(`SELECT * FROM watched_wallets WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapWatchedWallet(row) : null;
  }

  async updateWatchedWallet(
    id: number,
    patch: Parameters<IUserVault["updateWatchedWallet"]>[1]
  ): Promise<void> {
    const current = await this.getWatchedWallet(id);
    if (!current) return;
    this.db
      .prepare(
        `UPDATE watched_wallets SET
          alias = ?, enabled = ?, copy_mode = ?, copy_amount_atomic = ?, copy_percent = ?,
          max_buy_atomic = ?, min_mc_usd = ?, max_mc_usd = ?, min_liq_usd = ?,
          skip_if_held = ?, mirror_sells = ?, block_risky = ?, transfer_alerts = ?,
          snipe_dev_launches = ?, sell_mode = ?, sim_mode = ?,
          auto_tp_pct = ?, auto_sl_pct = ?, auto_trailing_pct = ?, last_seen_tx = ?
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
        (patch.transferAlerts ?? current.transferAlerts) ? 1 : 0,
        (patch.snipeDevLaunches ?? current.snipeDevLaunches) ? 1 : 0,
        patch.sellMode ?? current.sellMode,
        patch.simMode ?? current.simMode,
        patch.autoTpPct !== undefined ? patch.autoTpPct : current.autoTpPct,
        patch.autoSlPct !== undefined ? patch.autoSlPct : current.autoSlPct,
        patch.autoTrailingPct !== undefined ? patch.autoTrailingPct : current.autoTrailingPct,
        patch.lastSeenTx !== undefined ? patch.lastSeenTx : current.lastSeenTx,
        id
      );
  }

  async deleteWatchedWallet(id: number): Promise<boolean> {
    const res = this.db.prepare(`DELETE FROM watched_wallets WHERE id = ?`).run(id);
    return Number(res.changes) > 0;
  }

  async recordObservedSwap(input: Omit<ObservedSwapRow, "id">): Promise<boolean> {
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

  async listObservedSwapsBetween(startMs: number, endMs: number): Promise<ObservedSwapRow[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM observed_wallet_swaps
         WHERE observed_at >= ? AND observed_at <= ?
         ORDER BY observed_at ASC`
      )
      .all(startMs, endMs) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapObservedSwap(r));
  }

  async saveWeeklyReport(input: Omit<WeeklyReportRow, "id" | "createdAt">): Promise<number> {
    const res = this.db
      .prepare(
        `INSERT INTO weekly_reports (period_start, period_end, summary_json, report_text, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.periodStart, input.periodEnd, input.summaryJson, input.reportText, Date.now());
    return Number(res.lastInsertRowid);
  }

  async getLatestWeeklyReport(): Promise<WeeklyReportRow | null> {
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
      transferAlerts: row.transfer_alerts === null || row.transfer_alerts === undefined ? true : Number(row.transfer_alerts) === 1,
      snipeDevLaunches: Number(row.snipe_dev_launches ?? 0) === 1,
      sellMode: (row.sell_mode ? String(row.sell_mode) : "full") as SellMode,
      simMode: String(row.sim_mode) as SimMode,
      autoTpPct: row.auto_tp_pct !== null ? Number(row.auto_tp_pct) : null,
      autoSlPct: row.auto_sl_pct !== null ? Number(row.auto_sl_pct) : null,
      autoTrailingPct:
        row.auto_trailing_pct !== null && row.auto_trailing_pct !== undefined
          ? Number(row.auto_trailing_pct)
          : null,
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

export class UserVaultManager implements IVaultManager {
  private readonly vaultDir: string;
  private readonly vaults = new Map<string, UserVault>();

  constructor(vaultDir: string) {
    this.vaultDir = vaultDir;
    fs.mkdirSync(vaultDir, { recursive: true });
  }

  async getVault(telegramId: string): Promise<UserVault> {
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

  async hasVault(telegramId: string): Promise<boolean> {
    if (!/^\d+$/.test(telegramId)) return false;
    return fs.existsSync(path.join(this.vaultDir, `${telegramId}.db`));
  }

  async closeAll(): Promise<void> {
    for (const v of this.vaults.values()) {
      await v.close();
    }
    this.vaults.clear();
  }
}
