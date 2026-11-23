import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { CHAIN_LIST, ChainKey, CHAINS, normalizeAddress } from "../chains/registry.js";
import {
  AccessCode,
  AuthorizedUser,
  CopyMode,
  DEFAULT_USER_SETTINGS,
  IAdminDb,
  IUserVault,
  IVaultManager,
  ObservedSwapRow,
  OrderRow,
  PnlTheme,
  PositionRow,
  RedeemResult,
  SimMode,
  TradeRow,
  UserRole,
  UserSettings,
  VirtualBalanceRow,
  WatchedWalletRow,
  WeeklyReportRow
} from "./types.js";

const txStorage = new AsyncLocalStorage<PoolClient>();

export function createPgPool(databaseUrl: string): Pool {
  const needsSsl =
    databaseUrl.includes("supabase.") ||
    databaseUrl.includes("pooler.") ||
    databaseUrl.includes("sslmode=require");
  return new Pool({
    connectionString: databaseUrl,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined
  });
}

async function runQuery<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  sql: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  const activeClient = txStorage.getStore();
  if (activeClient) {
    return activeClient.query<T>(sql, params);
  }
  return pool.query<T>(sql, params);
}

/**
 * Central admin & invite code registry stored in private unexposed schema `degen_admin`.
 */
export class PostgresAdminDb implements IAdminDb {
  private readonly pool: Pool;
  private readonly maxCabalUsers: number;
  private readonly adminBootstrapCode: string;
  private initialized = false;

  constructor(pool: Pool, maxCabalUsers = 10, adminBootstrapCode = "") {
    this.pool = pool;
    this.maxCabalUsers = maxCabalUsers;
    this.adminBootstrapCode = adminBootstrapCode.trim();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS degen_admin;
      REVOKE ALL ON SCHEMA degen_admin FROM PUBLIC;

      CREATE TABLE IF NOT EXISTS degen_admin.authorized_users (
        telegram_id TEXT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        role TEXT NOT NULL DEFAULT 'member',
        code_used TEXT,
        joined_at BIGINT NOT NULL,
        is_banned SMALLINT NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS degen_admin.access_codes (
        code TEXT PRIMARY KEY,
        label TEXT,
        role TEXT NOT NULL DEFAULT 'member',
        created_by TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT,
        max_uses INTEGER NOT NULL DEFAULT 1,
        uses_count INTEGER NOT NULL DEFAULT 0,
        revoked SMALLINT NOT NULL DEFAULT 0
      );

      ALTER TABLE degen_admin.authorized_users ENABLE ROW LEVEL SECURITY;
      ALTER TABLE degen_admin.access_codes ENABLE ROW LEVEL SECURITY;
    `);
    this.initialized = true;
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1 FROM degen_admin.authorized_users LIMIT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // Pool lifecycle is managed by PostgresStore owner or closed on shutdown
  }

  async ensureAdminsFromConfig(adminIds: Set<string>): Promise<void> {
    await this.init();
    const now = Date.now();
    for (const id of adminIds) {
      await this.pool.query(
        `INSERT INTO degen_admin.authorized_users (telegram_id, role, code_used, joined_at, is_banned)
         VALUES ($1, 'admin', 'ENV_CONFIG', $2, 0)
         ON CONFLICT (telegram_id) DO UPDATE SET role = 'admin', is_banned = 0`,
        [id, now]
      );
    }
  }

  async getUser(telegramId: string): Promise<AuthorizedUser | null> {
    await this.init();
    const res = await this.pool.query(
      `SELECT * FROM degen_admin.authorized_users WHERE telegram_id = $1`,
      [telegramId]
    );
    return res.rows[0] ? this.mapUser(res.rows[0]) : null;
  }

  async isAuthorized(telegramId: string): Promise<{ authorized: boolean; user: AuthorizedUser | null }> {
    const user = await this.getUser(telegramId);
    if (!user || user.isBanned) return { authorized: false, user };
    return { authorized: true, user };
  }

  async isAdmin(telegramId: string): Promise<boolean> {
    const user = await this.getUser(telegramId);
    return Boolean(user && !user.isBanned && user.role === "admin");
  }

  async countActiveUsers(): Promise<number> {
    await this.init();
    const res = await this.pool.query(
      `SELECT COUNT(*)::int AS cnt FROM degen_admin.authorized_users WHERE is_banned = 0`
    );
    return Number(res.rows[0]?.cnt ?? 0);
  }

  async countActiveAdmins(): Promise<number> {
    await this.init();
    const res = await this.pool.query(
      `SELECT COUNT(*)::int AS cnt FROM degen_admin.authorized_users WHERE is_banned = 0 AND role = 'admin'`
    );
    return Number(res.rows[0]?.cnt ?? 0);
  }

  async listActiveUserIds(): Promise<string[]> {
    await this.init();
    const res = await this.pool.query(
      `SELECT telegram_id FROM degen_admin.authorized_users WHERE is_banned = 0 ORDER BY joined_at ASC`
    );
    return res.rows.map((r) => String(r.telegram_id));
  }

  async listUsers(): Promise<AuthorizedUser[]> {
    await this.init();
    const res = await this.pool.query(
      `SELECT * FROM degen_admin.authorized_users ORDER BY joined_at ASC`
    );
    return res.rows.map((r) => this.mapUser(r));
  }

  async generateAccessCode(params: {
    createdBy: string;
    label?: string;
    maxUses?: number;
    expiresInHours?: number | null;
    role?: UserRole;
  }): Promise<AccessCode> {
    await this.init();
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const randomChunk = (len: number) => {
      const bytes = crypto.randomBytes(len);
      let out = "";
      for (let i = 0; i < len; i++) {
        out += alphabet[bytes[i] % alphabet.length];
      }
      return out;
    };
    const code = `CABAL-${randomChunk(4)}-${randomChunk(4)}`;
    const now = Date.now();
    const maxUses = Math.max(1, Math.floor(params.maxUses ?? 1));
    const expiresAt =
      params.expiresInHours && params.expiresInHours > 0
        ? now + Math.floor(params.expiresInHours * 3600_000)
        : null;
    const role: UserRole = params.role === "admin" ? "admin" : "member";

    await this.pool.query(
      `INSERT INTO degen_admin.access_codes (code, label, role, created_by, created_at, expires_at, max_uses, uses_count, revoked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0)`,
      [code, params.label ?? null, role, params.createdBy, now, expiresAt, maxUses]
    );

    return {
      code,
      label: params.label ?? null,
      role,
      createdBy: params.createdBy,
      createdAt: now,
      expiresAt,
      maxUses,
      usesCount: 0,
      revoked: false
    };
  }

  async listAccessCodes(includeExhausted = false): Promise<AccessCode[]> {
    await this.init();
    const query = includeExhausted
      ? `SELECT * FROM degen_admin.access_codes ORDER BY created_at DESC LIMIT 50`
      : `SELECT * FROM degen_admin.access_codes WHERE revoked = 0 AND uses_count < max_uses ORDER BY created_at DESC LIMIT 50`;
    const res = await this.pool.query(query);
    return res.rows.map((r) => this.mapCode(r));
  }

  async revokeAccessCode(codeInput: string): Promise<boolean> {
    await this.init();
    const code = codeInput.trim().toUpperCase();
    const res = await this.pool.query(
      `UPDATE degen_admin.access_codes SET revoked = 1 WHERE code = $1 AND revoked = 0`,
      [code]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async banUser(telegramId: string): Promise<boolean> {
    await this.init();
    const res = await this.pool.query(
      `UPDATE degen_admin.authorized_users SET is_banned = 1 WHERE telegram_id = $1`,
      [telegramId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async unbanUser(telegramId: string): Promise<boolean> {
    await this.init();
    const res = await this.pool.query(
      `UPDATE degen_admin.authorized_users SET is_banned = 0 WHERE telegram_id = $1`,
      [telegramId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async redeemCode(params: {
    code: string;
    telegramId: string;
    username?: string | null;
    firstName?: string | null;
  }): Promise<RedeemResult> {
    await this.init();
    const rawCode = params.code.trim();
    const upperCode = rawCode.toUpperCase();
    const now = Date.now();

    const existing = await this.getUser(params.telegramId);
    if (existing) {
      if (existing.isBanned) {
        return { ok: false, reason: "Your access has been disabled by the admin." };
      }
      return { ok: true, user: existing, alreadyAuthorized: true };
    }

    if (
      this.adminBootstrapCode.length > 0 &&
      rawCode === this.adminBootstrapCode &&
      (await this.countActiveAdmins()) === 0
    ) {
      await this.pool.query(
        `INSERT INTO degen_admin.authorized_users (telegram_id, username, first_name, role, code_used, joined_at, is_banned)
         VALUES ($1, $2, $3, 'admin', 'BOOTSTRAP', $4, 0)`,
        [params.telegramId, params.username ?? null, params.firstName ?? null, now]
      );
      return {
        ok: true,
        user: (await this.getUser(params.telegramId))!,
        alreadyAuthorized: false
      };
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const codeRes = await client.query(
        `SELECT * FROM degen_admin.access_codes WHERE code = $1 FOR UPDATE`,
        [upperCode]
      );
      if (codeRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "That invite code is not valid." };
      }

      const codeObj = this.mapCode(codeRes.rows[0]);
      if (codeObj.revoked) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "That invite code has been cancelled by the admin." };
      }
      if (codeObj.expiresAt !== null && now > codeObj.expiresAt) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "That invite code has expired." };
      }
      if (codeObj.usesCount >= codeObj.maxUses) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "That invite code has already been used." };
      }

      const cntRes = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM degen_admin.authorized_users WHERE is_banned = 0`
      );
      const activeCount = Number(cntRes.rows[0]?.cnt ?? 0);
      if (codeObj.role !== "admin" && activeCount >= this.maxCabalUsers) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          reason: `This private group already reached its limit of ${this.maxCabalUsers} members.`
        };
      }

      await client.query(
        `INSERT INTO degen_admin.authorized_users (telegram_id, username, first_name, role, code_used, joined_at, is_banned)
         VALUES ($1, $2, $3, $4, $5, $6, 0)`,
        [
          params.telegramId,
          params.username ?? null,
          params.firstName ?? null,
          codeObj.role,
          codeObj.code,
          now
        ]
      );

      await client.query(
        `UPDATE degen_admin.access_codes SET uses_count = uses_count + 1 WHERE code = $1`,
        [codeObj.code]
      );

      await client.query("COMMIT");
      return {
        ok: true,
        user: (await this.getUser(params.telegramId))!,
        alreadyAuthorized: false
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private mapUser(row: Record<string, unknown>): AuthorizedUser {
    return {
      telegramId: String(row.telegram_id),
      username: row.username ? String(row.username) : null,
      firstName: row.first_name ? String(row.first_name) : null,
      role: row.role === "admin" ? "admin" : "member",
      codeUsed: row.code_used ? String(row.code_used) : null,
      joinedAt: Number(row.joined_at),
      isBanned: Number(row.is_banned) === 1
    };
  }

  private mapCode(row: Record<string, unknown>): AccessCode {
    return {
      code: String(row.code),
      label: row.label ? String(row.label) : null,
      role: row.role === "admin" ? "admin" : "member",
      createdBy: String(row.created_by),
      createdAt: Number(row.created_at),
      expiresAt: row.expires_at !== null && row.expires_at !== undefined ? Number(row.expires_at) : null,
      maxUses: Number(row.max_uses),
      usesCount: Number(row.uses_count),
      revoked: Number(row.revoked) === 1
    };
  }
}

/**
 * Isolated per-user private Postgres schema (`user_<telegramId>`).
 * Every user has completely separate tables inside their own unexposed schema.
 */
export class PostgresUserVault implements IUserVault {
  readonly telegramId: string;
  readonly locationLabel: string;
  private readonly schema: string;
  private readonly pool: Pool;

  constructor(telegramId: string, pool: Pool) {
    if (!/^\d+$/.test(telegramId)) {
      throw new Error(`Invalid Telegram ID "${telegramId}"`);
    }
    this.telegramId = telegramId;
    this.schema = `user_${telegramId}`;
    this.locationLabel = `postgres://${this.schema}`;
    this.pool = pool;
  }

  private t(table: string): string {
    return `${this.schema}.${table}`;
  }

  async init(): Promise<void> {
    const s = this.schema;
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS ${s};
      REVOKE ALL ON SCHEMA ${s} FROM PUBLIC;

      CREATE TABLE IF NOT EXISTS ${s}.virtual_balances (
        chain TEXT PRIMARY KEY,
        balance_atomic TEXT NOT NULL DEFAULT '0',
        initial_balance_atomic TEXT NOT NULL DEFAULT '0',
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${s}.user_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${s}.positions (
        id BIGSERIAL PRIMARY KEY,
        chain TEXT NOT NULL,
        token_address TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        token_name TEXT NOT NULL,
        token_decimals INTEGER NOT NULL DEFAULT 18,
        pair_address TEXT,
        dex TEXT,
        source_type TEXT NOT NULL DEFAULT 'manual',
        copied_wallet_id BIGINT,
        status TEXT NOT NULL DEFAULT 'open',
        qty_token_atomic TEXT NOT NULL,
        initial_qty_token_atomic TEXT NOT NULL,
        cost_native_atomic TEXT NOT NULL,
        initial_cost_native_atomic TEXT NOT NULL,
        realized_native_atomic TEXT NOT NULL DEFAULT '0',
        cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        initial_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        realized_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        entry_price_usd DOUBLE PRECISION NOT NULL,
        last_price_usd DOUBLE PRECISION NOT NULL,
        entry_mc_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        entry_liq_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        entry_vol_5m_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        entry_token_age_sec INTEGER,
        peak_price_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        peak_mc_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        exit_price_usd DOUBLE PRECISION,
        exit_mc_usd DOUBLE PRECISION,
        opened_at BIGINT NOT NULL,
        closed_at BIGINT
      );

      CREATE INDEX IF NOT EXISTS idx_positions_status ON ${s}.positions(status, chain);

      CREATE TABLE IF NOT EXISTS ${s}.trades (
        id BIGSERIAL PRIMARY KEY,
        position_id BIGINT NOT NULL,
        chain TEXT NOT NULL,
        side TEXT NOT NULL,
        source_type TEXT NOT NULL,
        copied_wallet_id BIGINT,
        copied_tx_hash TEXT,
        token_address TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        qty_token_atomic TEXT NOT NULL,
        native_amount_atomic TEXT NOT NULL,
        fee_native_atomic TEXT NOT NULL DEFAULT '0',
        tax_bps INTEGER NOT NULL DEFAULT 0,
        slippage_bps INTEGER NOT NULL DEFAULT 0,
        price_usd DOUBLE PRECISION NOT NULL,
        native_price_usd DOUBLE PRECISION NOT NULL,
        mc_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        liq_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        vol_5m_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        token_age_sec INTEGER,
        security_risk TEXT NOT NULL DEFAULT 'unknown',
        realized_pnl_native_atomic TEXT NOT NULL DEFAULT '0',
        realized_pnl_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        sim_delay_ms INTEGER NOT NULL DEFAULT 0,
        executed_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_trades_time ON ${s}.trades(executed_at);
      CREATE INDEX IF NOT EXISTS idx_trades_wallet ON ${s}.trades(copied_wallet_id, executed_at);

      CREATE TABLE IF NOT EXISTS ${s}.orders (
        id BIGSERIAL PRIMARY KEY,
        chain TEXT NOT NULL,
        token_address TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        position_id BIGINT,
        order_type TEXT NOT NULL,
        trigger_mc_usd DOUBLE PRECISION,
        trigger_price_usd DOUBLE PRECISION,
        trigger_pnl_pct DOUBLE PRECISION,
        trailing_drop_pct DOUBLE PRECISION,
        highest_price_usd DOUBLE PRECISION,
        amount_native_atomic TEXT,
        sell_pct DOUBLE PRECISION,
        dca_interval_sec INTEGER,
        dca_remaining INTEGER,
        next_run_at BIGINT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_orders_status ON ${s}.orders(status, chain);

      CREATE TABLE IF NOT EXISTS ${s}.watched_wallets (
        id BIGSERIAL PRIMARY KEY,
        chain TEXT NOT NULL,
        address TEXT NOT NULL,
        alias TEXT NOT NULL,
        enabled SMALLINT NOT NULL DEFAULT 1,
        copy_mode TEXT NOT NULL DEFAULT 'fixed',
        copy_amount_atomic TEXT NOT NULL DEFAULT '0',
        copy_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
        max_buy_atomic TEXT,
        min_mc_usd DOUBLE PRECISION,
        max_mc_usd DOUBLE PRECISION,
        min_liq_usd DOUBLE PRECISION,
        skip_if_held SMALLINT NOT NULL DEFAULT 1,
        mirror_sells SMALLINT NOT NULL DEFAULT 1,
        block_risky SMALLINT NOT NULL DEFAULT 1,
        transfer_alerts SMALLINT NOT NULL DEFAULT 1,
        sim_mode TEXT NOT NULL DEFAULT 'realistic',
        auto_tp_pct DOUBLE PRECISION,
        auto_sl_pct DOUBLE PRECISION,
        last_seen_tx TEXT,
        created_at BIGINT NOT NULL,
        UNIQUE(chain, address)
      );

      CREATE TABLE IF NOT EXISTS ${s}.observed_wallet_swaps (
        id BIGSERIAL PRIMARY KEY,
        watched_wallet_id BIGINT NOT NULL,
        chain TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        side TEXT NOT NULL,
        token_address TEXT NOT NULL,
        token_symbol TEXT,
        wallet_native_amount_atomic TEXT,
        price_usd_at_event DOUBLE PRECISION,
        mc_usd_at_event DOUBLE PRECISION,
        liq_usd_at_event DOUBLE PRECISION,
        vol_5m_usd_at_event DOUBLE PRECISION,
        token_age_sec INTEGER,
        dex TEXT,
        action_taken TEXT NOT NULL,
        skip_reason TEXT,
        observed_at BIGINT NOT NULL,
        UNIQUE(watched_wallet_id, tx_hash, side, token_address)
      );

      CREATE TABLE IF NOT EXISTS ${s}.weekly_reports (
        id BIGSERIAL PRIMARY KEY,
        period_start BIGINT NOT NULL,
        period_end BIGINT NOT NULL,
        summary_json TEXT NOT NULL,
        report_text TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );

      ALTER TABLE ${s}.watched_wallets ADD COLUMN IF NOT EXISTS transfer_alerts SMALLINT NOT NULL DEFAULT 1;
      ALTER TABLE ${s}.virtual_balances ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${s}.user_settings ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${s}.positions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${s}.trades ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${s}.orders ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${s}.watched_wallets ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${s}.observed_wallet_swaps ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${s}.weekly_reports ENABLE ROW LEVEL SECURITY;
    `);

    const now = Date.now();
    for (const c of CHAIN_LIST) {
      await this.pool.query(
        `INSERT INTO ${this.t("virtual_balances")} (chain, balance_atomic, initial_balance_atomic, updated_at)
         VALUES ($1, '0', '0', $2) ON CONFLICT (chain) DO NOTHING`,
        [c.key, now]
      );
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
      copy_notify: DEFAULT_USER_SETTINGS.copyNotify ? "1" : "0"
    };
    for (const [k, v] of Object.entries(defaults)) {
      await this.pool.query(
        `INSERT INTO ${this.t("user_settings")} (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [k, v]
      );
    }
  }

  async close(): Promise<void> {
    // Pool closed by PostgresVaultManager
  }

  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const existing = txStorage.getStore();
    if (existing) {
      return fn();
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await txStorage.run(client, fn);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async getBalances(): Promise<VirtualBalanceRow[]> {
    const res = await runQuery(this.pool, `SELECT * FROM ${this.t("virtual_balances")}`);
    return res.rows.map((r) => ({
      chain: String(r.chain) as ChainKey,
      balanceAtomic: BigInt(String(r.balance_atomic)),
      initialBalanceAtomic: BigInt(String(r.initial_balance_atomic)),
      updatedAt: Number(r.updated_at)
    }));
  }

  async getBalance(chain: ChainKey): Promise<VirtualBalanceRow> {
    const res = await runQuery(
      this.pool,
      `SELECT * FROM ${this.t("virtual_balances")} WHERE chain = $1`,
      [chain]
    );
    const row = res.rows[0];
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
      await runQuery(
        this.pool,
        `INSERT INTO ${this.t("virtual_balances")} (chain, balance_atomic, initial_balance_atomic, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (chain) DO UPDATE SET
           balance_atomic = EXCLUDED.balance_atomic,
           initial_balance_atomic = EXCLUDED.initial_balance_atomic,
           updated_at = EXCLUDED.updated_at`,
        [chain, newBalanceAtomic.toString(), newBalanceAtomic.toString(), now]
      );
    } else {
      await runQuery(
        this.pool,
        `INSERT INTO ${this.t("virtual_balances")} (chain, balance_atomic, initial_balance_atomic, updated_at)
         VALUES ($1, $2, '0', $3)
         ON CONFLICT (chain) DO UPDATE SET
           balance_atomic = EXCLUDED.balance_atomic,
           updated_at = EXCLUDED.updated_at`,
        [chain, newBalanceAtomic.toString(), now]
      );
    }
  }

  async addVirtualFunds(chain: ChainKey, addAtomic: bigint): Promise<bigint> {
    if (addAtomic <= 0n) throw new Error("Amount to add must be greater than zero.");
    const cur = await this.getBalance(chain);
    const nextBal = cur.balanceAtomic + addAtomic;
    const nextInitial = cur.initialBalanceAtomic + addAtomic;
    const now = Date.now();
    await runQuery(
      this.pool,
      `INSERT INTO ${this.t("virtual_balances")} (chain, balance_atomic, initial_balance_atomic, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (chain) DO UPDATE SET
         balance_atomic = EXCLUDED.balance_atomic,
         initial_balance_atomic = EXCLUDED.initial_balance_atomic,
         updated_at = EXCLUDED.updated_at`,
      [chain, nextBal.toString(), nextInitial.toString(), now]
    );
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
    const res = await runQuery(
      this.pool,
      `SELECT key, CASE WHEN key = 'pnl_bg_data_url' AND value <> '' THEN '1' ELSE value END AS value FROM ${this.t(
        "user_settings"
      )}`
    );
    const map = new Map(res.rows.map((r) => [String(r.key), String(r.value)]));
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
      copyNotify: (map.get("copy_notify") ?? "1") === "1"
    };
  }

  async getSetting(key: string): Promise<string | null> {
    const res = await runQuery(
      this.pool,
      `SELECT value FROM ${this.t("user_settings")} WHERE key = $1`,
      [key]
    );
    return res.rows[0]?.value !== undefined ? String(res.rows[0].value) : null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await runQuery(
      this.pool,
      `INSERT INTO ${this.t("user_settings")} (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  }

  async getOpenPosition(
    chain: ChainKey,
    tokenAddress: string,
    copiedWalletId?: number | null
  ): Promise<PositionRow | null> {
    const norm = normalizeAddress(chain, tokenAddress);
    const res =
      copiedWalletId === null
        ? await runQuery(
            this.pool,
            `SELECT * FROM ${this.t("positions")}
             WHERE status = 'open' AND chain = $1 AND token_address = $2 AND copied_wallet_id IS NULL
             ORDER BY id DESC LIMIT 1`,
            [chain, norm]
          )
        : copiedWalletId !== undefined
          ? await runQuery(
              this.pool,
              `SELECT * FROM ${this.t("positions")}
               WHERE status = 'open' AND chain = $1 AND token_address = $2 AND copied_wallet_id = $3
               ORDER BY id DESC LIMIT 1`,
              [chain, norm, copiedWalletId]
            )
          : await runQuery(
              this.pool,
              `SELECT * FROM ${this.t("positions")}
               WHERE status = 'open' AND chain = $1 AND token_address = $2
               ORDER BY id DESC LIMIT 1`,
              [chain, norm]
            );
    return res.rows[0] ? this.mapPosition(res.rows[0]) : null;
  }

  async getPositionById(id: number): Promise<PositionRow | null> {
    const res = await runQuery(this.pool, `SELECT * FROM ${this.t("positions")} WHERE id = $1`, [id]);
    return res.rows[0] ? this.mapPosition(res.rows[0]) : null;
  }

  async listOpenPositions(chain?: ChainKey): Promise<PositionRow[]> {
    const res = chain
      ? await runQuery(
          this.pool,
          `SELECT * FROM ${this.t("positions")} WHERE status = 'open' AND chain = $1 ORDER BY opened_at DESC`,
          [chain]
        )
      : await runQuery(
          this.pool,
          `SELECT * FROM ${this.t("positions")} WHERE status = 'open' ORDER BY opened_at DESC`
        );
    return res.rows.map((r) => this.mapPosition(r));
  }

  async listClosedPositions(limit = 20): Promise<PositionRow[]> {
    const res = await runQuery(
      this.pool,
      `SELECT * FROM ${this.t("positions")} WHERE status != 'open' ORDER BY closed_at DESC LIMIT $1`,
      [limit]
    );
    return res.rows.map((r) => this.mapPosition(r));
  }

  async createPosition(input: Parameters<IUserVault["createPosition"]>[0]): Promise<number> {
    const norm = normalizeAddress(input.chain, input.tokenAddress);
    const res = await runQuery(
      this.pool,
      `INSERT INTO ${this.t("positions")} (
        chain, token_address, token_symbol, token_name, token_decimals, pair_address, dex,
        source_type, copied_wallet_id, status,
        qty_token_atomic, initial_qty_token_atomic, cost_native_atomic, initial_cost_native_atomic,
        realized_native_atomic, cost_usd, initial_cost_usd, realized_usd,
        entry_price_usd, last_price_usd, entry_mc_usd, entry_liq_usd, entry_vol_5m_usd, entry_token_age_sec,
        peak_price_usd, peak_mc_usd, opened_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10, $11, $12, $13, '0', $14, $15, 0, $16, $17, $18, $19, $20, $21, $22, $23, $24)
      RETURNING id`,
      [
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
      ]
    );
    return Number(res.rows[0].id);
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

    await runQuery(
      this.pool,
      `UPDATE ${this.t("positions")} SET
        qty_token_atomic = $1, initial_qty_token_atomic = $2,
        cost_native_atomic = $3, initial_cost_native_atomic = $4,
        cost_usd = $5, initial_cost_usd = $6, entry_price_usd = $7, last_price_usd = $8,
        peak_price_usd = GREATEST(peak_price_usd, $9), peak_mc_usd = GREATEST(peak_mc_usd, $10)
       WHERE id = $11`,
      [
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
      ]
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

    await runQuery(
      this.pool,
      `UPDATE ${this.t("positions")} SET
        qty_token_atomic = $1, cost_native_atomic = $2, cost_usd = $3,
        realized_native_atomic = $4, realized_usd = $5,
        last_price_usd = $6, peak_price_usd = GREATEST(peak_price_usd, $7), peak_mc_usd = GREATEST(peak_mc_usd, $8),
        status = $9, exit_price_usd = $10, exit_mc_usd = $11, closed_at = $12
       WHERE id = $13`,
      [
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
      ]
    );

    return { closed: isClosed, costBasisSoldNative, costBasisSoldUsd };
  }

  async updatePositionMark(id: number, lastPriceUsd: number, mcUsd: number): Promise<void> {
    await runQuery(
      this.pool,
      `UPDATE ${this.t("positions")} SET
        last_price_usd = $1,
        peak_price_usd = GREATEST(peak_price_usd, $2),
        peak_mc_usd = GREATEST(peak_mc_usd, $3)
       WHERE id = $4`,
      [lastPriceUsd, lastPriceUsd, mcUsd, id]
    );
  }

  async recordTrade(input: Omit<TradeRow, "id">): Promise<number> {
    const res = await runQuery(
      this.pool,
      `INSERT INTO ${this.t("trades")} (
        position_id, chain, side, source_type, copied_wallet_id, copied_tx_hash,
        token_address, token_symbol, qty_token_atomic, native_amount_atomic, fee_native_atomic,
        tax_bps, slippage_bps, price_usd, native_price_usd, mc_usd, liq_usd, vol_5m_usd,
        token_age_sec, security_risk, realized_pnl_native_atomic, realized_pnl_usd,
        sim_delay_ms, executed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
      RETURNING id`,
      [
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
      ]
    );
    return Number(res.rows[0].id);
  }

  async listTradesBetween(startMs: number, endMs: number): Promise<TradeRow[]> {
    const res = await runQuery(
      this.pool,
      `SELECT * FROM ${this.t("trades")} WHERE executed_at >= $1 AND executed_at <= $2 ORDER BY executed_at ASC`,
      [startMs, endMs]
    );
    return res.rows.map((r) => this.mapTrade(r));
  }

  async listRecentTrades(limit = 20): Promise<TradeRow[]> {
    const res = await runQuery(
      this.pool,
      `SELECT * FROM ${this.t("trades")} ORDER BY executed_at DESC LIMIT $1`,
      [limit]
    );
    return res.rows.map((r) => this.mapTrade(r));
  }

  async listPositionsInPeriod(startMs: number, endMs: number): Promise<PositionRow[]> {
    const res = await runQuery(
      this.pool,
      `SELECT * FROM ${this.t("positions")}
       WHERE (opened_at >= $1 AND opened_at <= $2)
          OR (closed_at IS NOT NULL AND closed_at >= $3 AND closed_at <= $4)
       ORDER BY opened_at ASC`,
      [startMs, endMs, startMs, endMs]
    );
    return res.rows.map((r) => this.mapPosition(r));
  }

  async createOrder(input: Omit<OrderRow, "id" | "createdAt" | "updatedAt" | "status">): Promise<number> {
    const now = Date.now();
    const res = await runQuery(
      this.pool,
      `INSERT INTO ${this.t("orders")} (
        chain, token_address, token_symbol, position_id, order_type,
        trigger_mc_usd, trigger_price_usd, trigger_pnl_pct, trailing_drop_pct, highest_price_usd,
        amount_native_atomic, sell_pct, dca_interval_sec, dca_remaining, next_run_at,
        status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'active', $16, $17)
      RETURNING id`,
      [
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
      ]
    );
    return Number(res.rows[0].id);
  }

  async listActiveOrders(chain?: ChainKey): Promise<OrderRow[]> {
    const res = chain
      ? await runQuery(
          this.pool,
          `SELECT * FROM ${this.t("orders")} WHERE status = 'active' AND chain = $1 ORDER BY created_at DESC`,
          [chain]
        )
      : await runQuery(
          this.pool,
          `SELECT * FROM ${this.t("orders")} WHERE status = 'active' ORDER BY created_at DESC`
        );
    return res.rows.map((r) => this.mapOrder(r));
  }

  async updateOrderHighestPrice(id: number, highestPriceUsd: number): Promise<void> {
    await runQuery(
      this.pool,
      `UPDATE ${this.t("orders")} SET highest_price_usd = $1, updated_at = $2 WHERE id = $3`,
      [highestPriceUsd, Date.now(), id]
    );
  }

  async advanceDcaOrder(id: number, remaining: number, nextRunAt: number | null): Promise<void> {
    const status = remaining <= 0 ? "filled" : "active";
    await runQuery(
      this.pool,
      `UPDATE ${this.t("orders")} SET dca_remaining = $1, next_run_at = $2, status = $3, updated_at = $4 WHERE id = $5`,
      [remaining, nextRunAt, status, Date.now(), id]
    );
  }

  async setOrderStatus(id: number, status: "active" | "filled" | "cancelled"): Promise<boolean> {
    const res = await runQuery(
      this.pool,
      `UPDATE ${this.t("orders")} SET status = $1, updated_at = $2 WHERE id = $3`,
      [status, Date.now(), id]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async addWatchedWallet(input: Parameters<IUserVault["addWatchedWallet"]>[0]): Promise<number> {
    const norm = normalizeAddress(input.chain, input.address);
    const now = Date.now();
    const res = await runQuery(
      this.pool,
      `INSERT INTO ${this.t("watched_wallets")} (
        chain, address, alias, enabled, copy_mode, copy_amount_atomic, copy_percent, max_buy_atomic,
        min_mc_usd, max_mc_usd, min_liq_usd, skip_if_held, mirror_sells, block_risky, transfer_alerts,
        sim_mode, auto_tp_pct, auto_sl_pct, created_at
      ) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING id`,
      [
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
        input.simMode ?? "realistic",
        input.autoTpPct ?? null,
        input.autoSlPct ?? null,
        now
      ]
    );
    return Number(res.rows[0].id);
  }

  async listWatchedWallets(onlyEnabled = false): Promise<WatchedWalletRow[]> {
    const res = onlyEnabled
      ? await runQuery(this.pool, `SELECT * FROM ${this.t("watched_wallets")} WHERE enabled = 1 ORDER BY id ASC`)
      : await runQuery(this.pool, `SELECT * FROM ${this.t("watched_wallets")} ORDER BY id ASC`);
    return res.rows.map((r) => this.mapWatchedWallet(r));
  }

  async getWatchedWallet(id: number): Promise<WatchedWalletRow | null> {
    const res = await runQuery(
      this.pool,
      `SELECT * FROM ${this.t("watched_wallets")} WHERE id = $1`,
      [id]
    );
    return res.rows[0] ? this.mapWatchedWallet(res.rows[0]) : null;
  }

  async updateWatchedWallet(
    id: number,
    patch: Parameters<IUserVault["updateWatchedWallet"]>[1]
  ): Promise<void> {
    const current = await this.getWatchedWallet(id);
    if (!current) return;
    await runQuery(
      this.pool,
      `UPDATE ${this.t("watched_wallets")} SET
        alias = $1, enabled = $2, copy_mode = $3, copy_amount_atomic = $4, copy_percent = $5,
        max_buy_atomic = $6, min_mc_usd = $7, max_mc_usd = $8, min_liq_usd = $9,
        skip_if_held = $10, mirror_sells = $11, block_risky = $12, transfer_alerts = $13, sim_mode = $14,
        auto_tp_pct = $15, auto_sl_pct = $16, last_seen_tx = $17
       WHERE id = $18`,
      [
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
        patch.simMode ?? current.simMode,
        patch.autoTpPct !== undefined ? patch.autoTpPct : current.autoTpPct,
        patch.autoSlPct !== undefined ? patch.autoSlPct : current.autoSlPct,
        patch.lastSeenTx !== undefined ? patch.lastSeenTx : current.lastSeenTx,
        id
      ]
    );
  }

  async deleteWatchedWallet(id: number): Promise<boolean> {
    const res = await runQuery(
      this.pool,
      `DELETE FROM ${this.t("watched_wallets")} WHERE id = $1`,
      [id]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async recordObservedSwap(input: Omit<ObservedSwapRow, "id">): Promise<boolean> {
    const res = await runQuery(
      this.pool,
      `INSERT INTO ${this.t("observed_wallet_swaps")} (
        watched_wallet_id, chain, tx_hash, side, token_address, token_symbol,
        wallet_native_amount_atomic, price_usd_at_event, mc_usd_at_event, liq_usd_at_event,
        vol_5m_usd_at_event, token_age_sec, dex, action_taken, skip_reason, observed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (watched_wallet_id, tx_hash, side, token_address) DO NOTHING`,
      [
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
      ]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async listObservedSwapsBetween(startMs: number, endMs: number): Promise<ObservedSwapRow[]> {
    const res = await runQuery(
      this.pool,
      `SELECT * FROM ${this.t("observed_wallet_swaps")}
       WHERE observed_at >= $1 AND observed_at <= $2 ORDER BY observed_at ASC`,
      [startMs, endMs]
    );
    return res.rows.map((r) => this.mapObservedSwap(r));
  }

  async saveWeeklyReport(input: Omit<WeeklyReportRow, "id" | "createdAt">): Promise<number> {
    const res = await runQuery(
      this.pool,
      `INSERT INTO ${this.t("weekly_reports")} (period_start, period_end, summary_json, report_text, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.periodStart, input.periodEnd, input.summaryJson, input.reportText, Date.now()]
    );
    return Number(res.rows[0].id);
  }

  async getLatestWeeklyReport(): Promise<WeeklyReportRow | null> {
    const res = await runQuery(
      this.pool,
      `SELECT * FROM ${this.t("weekly_reports")} ORDER BY created_at DESC LIMIT 1`
    );
    const row = res.rows[0];
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
      copiedWalletId: row.copied_wallet_id !== null && row.copied_wallet_id !== undefined ? Number(row.copied_wallet_id) : null,
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
      entryTokenAgeSec:
        row.entry_token_age_sec !== null && row.entry_token_age_sec !== undefined
          ? Number(row.entry_token_age_sec)
          : null,
      peakPriceUsd: Number(row.peak_price_usd),
      peakMcUsd: Number(row.peak_mc_usd),
      exitPriceUsd: row.exit_price_usd !== null && row.exit_price_usd !== undefined ? Number(row.exit_price_usd) : null,
      exitMcUsd: row.exit_mc_usd !== null && row.exit_mc_usd !== undefined ? Number(row.exit_mc_usd) : null,
      openedAt: Number(row.opened_at),
      closedAt: row.closed_at !== null && row.closed_at !== undefined ? Number(row.closed_at) : null
    };
  }

  private mapTrade(row: Record<string, unknown>): TradeRow {
    return {
      id: Number(row.id),
      positionId: Number(row.position_id),
      chain: String(row.chain) as ChainKey,
      side: String(row.side) as TradeRow["side"],
      sourceType: String(row.source_type),
      copiedWalletId: row.copied_wallet_id !== null && row.copied_wallet_id !== undefined ? Number(row.copied_wallet_id) : null,
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
      tokenAgeSec:
        row.token_age_sec !== null && row.token_age_sec !== undefined ? Number(row.token_age_sec) : null,
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
      positionId: row.position_id !== null && row.position_id !== undefined ? Number(row.position_id) : null,
      orderType: String(row.order_type) as OrderRow["orderType"],
      triggerMcUsd: row.trigger_mc_usd !== null && row.trigger_mc_usd !== undefined ? Number(row.trigger_mc_usd) : null,
      triggerPriceUsd:
        row.trigger_price_usd !== null && row.trigger_price_usd !== undefined ? Number(row.trigger_price_usd) : null,
      triggerPnlPct:
        row.trigger_pnl_pct !== null && row.trigger_pnl_pct !== undefined ? Number(row.trigger_pnl_pct) : null,
      trailingDropPct:
        row.trailing_drop_pct !== null && row.trailing_drop_pct !== undefined ? Number(row.trailing_drop_pct) : null,
      highestPriceUsd:
        row.highest_price_usd !== null && row.highest_price_usd !== undefined ? Number(row.highest_price_usd) : null,
      amountNativeAtomic: row.amount_native_atomic ? BigInt(String(row.amount_native_atomic)) : null,
      sellPct: row.sell_pct !== null && row.sell_pct !== undefined ? Number(row.sell_pct) : null,
      dcaIntervalSec:
        row.dca_interval_sec !== null && row.dca_interval_sec !== undefined ? Number(row.dca_interval_sec) : null,
      dcaRemaining:
        row.dca_remaining !== null && row.dca_remaining !== undefined ? Number(row.dca_remaining) : null,
      nextRunAt: row.next_run_at !== null && row.next_run_at !== undefined ? Number(row.next_run_at) : null,
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
      minMcUsd: row.min_mc_usd !== null && row.min_mc_usd !== undefined ? Number(row.min_mc_usd) : null,
      maxMcUsd: row.max_mc_usd !== null && row.max_mc_usd !== undefined ? Number(row.max_mc_usd) : null,
      minLiqUsd: row.min_liq_usd !== null && row.min_liq_usd !== undefined ? Number(row.min_liq_usd) : null,
      skipIfHeld: Number(row.skip_if_held) === 1,
      mirrorSells: Number(row.mirror_sells) === 1,
      blockRisky: Number(row.block_risky) === 1,
      transferAlerts: row.transfer_alerts === null || row.transfer_alerts === undefined ? true : Number(row.transfer_alerts) === 1,
      simMode: String(row.sim_mode) as SimMode,
      autoTpPct: row.auto_tp_pct !== null && row.auto_tp_pct !== undefined ? Number(row.auto_tp_pct) : null,
      autoSlPct: row.auto_sl_pct !== null && row.auto_sl_pct !== undefined ? Number(row.auto_sl_pct) : null,
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
      priceUsdAtEvent:
        row.price_usd_at_event !== null && row.price_usd_at_event !== undefined
          ? Number(row.price_usd_at_event)
          : null,
      mcUsdAtEvent:
        row.mc_usd_at_event !== null && row.mc_usd_at_event !== undefined ? Number(row.mc_usd_at_event) : null,
      liqUsdAtEvent:
        row.liq_usd_at_event !== null && row.liq_usd_at_event !== undefined ? Number(row.liq_usd_at_event) : null,
      vol5mUsdAtEvent:
        row.vol_5m_usd_at_event !== null && row.vol_5m_usd_at_event !== undefined
          ? Number(row.vol_5m_usd_at_event)
          : null,
      tokenAgeSec:
        row.token_age_sec !== null && row.token_age_sec !== undefined ? Number(row.token_age_sec) : null,
      dex: row.dex ? String(row.dex) : null,
      actionTaken: String(row.action_taken),
      skipReason: row.skip_reason ? String(row.skip_reason) : null,
      observedAt: Number(row.observed_at)
    };
  }
}

export class PostgresVaultManager implements IVaultManager {
  private readonly pool: Pool;
  private readonly vaults = new Map<string, PostgresUserVault>();
  private readonly initPromises = new Map<string, Promise<PostgresUserVault>>();
  private readonly knownSchemas = new Set<string>();

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async getVault(telegramId: string): Promise<PostgresUserVault> {
    if (!/^\d+$/.test(telegramId)) {
      throw new Error(`Invalid Telegram ID "${telegramId}"`);
    }
    const existing = this.vaults.get(telegramId);
    if (existing) return existing;

    const inFlight = this.initPromises.get(telegramId);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const vault = new PostgresUserVault(telegramId, this.pool);
      await vault.init();
      this.vaults.set(telegramId, vault);
      this.knownSchemas.add(`user_${telegramId}`);
      this.initPromises.delete(telegramId);
      return vault;
    })();

    this.initPromises.set(telegramId, promise);
    return promise;
  }

  async hasVault(telegramId: string): Promise<boolean> {
    if (!/^\d+$/.test(telegramId)) return false;
    const schemaName = `user_${telegramId}`;
    if (this.knownSchemas.has(schemaName)) return true;

    const res = await this.pool.query(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1 LIMIT 1`,
      [schemaName]
    );
    if (res.rows.length > 0) {
      this.knownSchemas.add(schemaName);
      return true;
    }
    return false;
  }

  async closeAll(): Promise<void> {
    this.vaults.clear();
    this.initPromises.clear();
  }
}
