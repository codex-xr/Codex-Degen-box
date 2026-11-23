import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type UserRole = "admin" | "member";

export interface AuthorizedUser {
  telegramId: string;
  username: string | null;
  firstName: string | null;
  role: UserRole;
  codeUsed: string | null;
  joinedAt: number;
  isBanned: boolean;
}

export interface AccessCode {
  code: string;
  label: string | null;
  role: UserRole;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number;
  usesCount: number;
  revoked: boolean;
}

export type RedeemResult =
  | { ok: true; user: AuthorizedUser; alreadyAuthorized: boolean }
  | { ok: false; reason: string };

/**
 * Central gatekeeper DB: ONLY holds invite codes and Telegram user authorization.
 * Zero balances, trades, watched wallets, or reports ever live here.
 */
export class AdminDb {
  private readonly db: DatabaseSync;
  private readonly maxCabalUsers: number;
  private readonly adminBootstrapCode: string;

  constructor(dbPath: string, maxCabalUsers = 10, adminBootstrapCode = "") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.maxCabalUsers = maxCabalUsers;
    this.adminBootstrapCode = adminBootstrapCode.trim();
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS authorized_users (
        telegram_id TEXT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        role TEXT NOT NULL DEFAULT 'member',
        code_used TEXT,
        joined_at INTEGER NOT NULL,
        is_banned INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS access_codes (
        code TEXT PRIMARY KEY,
        label TEXT,
        role TEXT NOT NULL DEFAULT 'member',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        max_uses INTEGER NOT NULL DEFAULT 1,
        uses_count INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  ensureAdminsFromConfig(adminIds: Set<string>): void {
    const now = Date.now();
    const upsert = this.db.prepare(`
      INSERT INTO authorized_users (telegram_id, role, code_used, joined_at, is_banned)
      VALUES (?, 'admin', 'ENV_CONFIG', ?, 0)
      ON CONFLICT(telegram_id) DO UPDATE SET role = 'admin', is_banned = 0
    `);
    for (const id of adminIds) {
      upsert.run(id, now);
    }
  }

  getUser(telegramId: string): AuthorizedUser | null {
    const row = this.db
      .prepare(`SELECT * FROM authorized_users WHERE telegram_id = ?`)
      .get(telegramId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapUser(row);
  }

  isAuthorized(telegramId: string): { authorized: boolean; user: AuthorizedUser | null } {
    const user = this.getUser(telegramId);
    if (!user || user.isBanned) return { authorized: false, user };
    return { authorized: true, user };
  }

  isAdmin(telegramId: string): boolean {
    const user = this.getUser(telegramId);
    return Boolean(user && !user.isBanned && user.role === "admin");
  }

  countActiveUsers(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM authorized_users WHERE is_banned = 0`)
      .get() as { cnt: number };
    return Number(row.cnt);
  }

  countActiveAdmins(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM authorized_users WHERE is_banned = 0 AND role = 'admin'`)
      .get() as { cnt: number };
    return Number(row.cnt);
  }

  listActiveUserIds(): string[] {
    const rows = this.db
      .prepare(`SELECT telegram_id FROM authorized_users WHERE is_banned = 0 ORDER BY joined_at ASC`)
      .all() as Array<{ telegram_id: string }>;
    return rows.map((r) => r.telegram_id);
  }

  listUsers(): AuthorizedUser[] {
    const rows = this.db
      .prepare(`SELECT * FROM authorized_users ORDER BY joined_at ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapUser(r));
  }

  generateAccessCode(params: {
    createdBy: string;
    label?: string;
    maxUses?: number;
    expiresInHours?: number | null;
    role?: UserRole;
  }): AccessCode {
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

    this.db
      .prepare(
        `INSERT INTO access_codes (code, label, role, created_by, created_at, expires_at, max_uses, uses_count, revoked)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`
      )
      .run(code, params.label ?? null, role, params.createdBy, now, expiresAt, maxUses);

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

  listAccessCodes(includeExhausted = false): AccessCode[] {
    const query = includeExhausted
      ? `SELECT * FROM access_codes ORDER BY created_at DESC LIMIT 50`
      : `SELECT * FROM access_codes WHERE revoked = 0 AND uses_count < max_uses ORDER BY created_at DESC LIMIT 50`;
    const rows = this.db.prepare(query).all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapCode(r));
  }

  revokeAccessCode(codeInput: string): boolean {
    const code = codeInput.trim().toUpperCase();
    const res = this.db
      .prepare(`UPDATE access_codes SET revoked = 1 WHERE code = ? AND revoked = 0`)
      .run(code);
    return Number(res.changes) > 0;
  }

  banUser(telegramId: string): boolean {
    const res = this.db
      .prepare(`UPDATE authorized_users SET is_banned = 1 WHERE telegram_id = ?`)
      .run(telegramId);
    return Number(res.changes) > 0;
  }

  unbanUser(telegramId: string): boolean {
    const res = this.db
      .prepare(`UPDATE authorized_users SET is_banned = 0 WHERE telegram_id = ?`)
      .run(telegramId);
    return Number(res.changes) > 0;
  }

  redeemCode(params: {
    code: string;
    telegramId: string;
    username?: string | null;
    firstName?: string | null;
  }): RedeemResult {
    const rawCode = params.code.trim();
    const upperCode = rawCode.toUpperCase();
    const now = Date.now();

    const existing = this.getUser(params.telegramId);
    if (existing) {
      if (existing.isBanned) {
        return { ok: false, reason: "Your access has been disabled by the admin." };
      }
      return { ok: true, user: existing, alreadyAuthorized: true };
    }

    // Optional first-admin bootstrap secret from .env
    if (
      this.adminBootstrapCode.length > 0 &&
      rawCode === this.adminBootstrapCode &&
      this.countActiveAdmins() === 0
    ) {
      this.db
        .prepare(
          `INSERT INTO authorized_users (telegram_id, username, first_name, role, code_used, joined_at, is_banned)
           VALUES (?, ?, ?, 'admin', 'BOOTSTRAP', ?, 0)`
        )
        .run(params.telegramId, params.username ?? null, params.firstName ?? null, now);
      return {
        ok: true,
        user: this.getUser(params.telegramId)!,
        alreadyAuthorized: false
      };
    }

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const codeRow = this.db
        .prepare(`SELECT * FROM access_codes WHERE code = ?`)
        .get(upperCode) as Record<string, unknown> | undefined;

      if (!codeRow) {
        this.db.exec("ROLLBACK;");
        return { ok: false, reason: "That invite code is not valid." };
      }

      const codeObj = this.mapCode(codeRow);
      if (codeObj.revoked) {
        this.db.exec("ROLLBACK;");
        return { ok: false, reason: "That invite code has been cancelled by the admin." };
      }
      if (codeObj.expiresAt !== null && now > codeObj.expiresAt) {
        this.db.exec("ROLLBACK;");
        return { ok: false, reason: "That invite code has expired." };
      }
      if (codeObj.usesCount >= codeObj.maxUses) {
        this.db.exec("ROLLBACK;");
        return { ok: false, reason: "That invite code has already been used." };
      }

      if (codeObj.role !== "admin" && this.countActiveUsers() >= this.maxCabalUsers) {
        this.db.exec("ROLLBACK;");
        return {
          ok: false,
          reason: `This private group already reached its limit of ${this.maxCabalUsers} members.`
        };
      }

      this.db
        .prepare(
          `INSERT INTO authorized_users (telegram_id, username, first_name, role, code_used, joined_at, is_banned)
           VALUES (?, ?, ?, ?, ?, ?, 0)`
        )
        .run(
          params.telegramId,
          params.username ?? null,
          params.firstName ?? null,
          codeObj.role,
          codeObj.code,
          now
        );

      this.db
        .prepare(`UPDATE access_codes SET uses_count = uses_count + 1 WHERE code = ?`)
        .run(codeObj.code);

      this.db.exec("COMMIT;");
      return {
        ok: true,
        user: this.getUser(params.telegramId)!,
        alreadyAuthorized: false
      };
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
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
