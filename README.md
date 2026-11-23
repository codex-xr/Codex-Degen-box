# 🏴‍☠️ Codex Degen Box

A private cabal Telegram demo trading & copy-alpha bot supporting **Solana**, **Base**, and **Robinhood Chain (`4663`)** — with **100% isolated private storage per user**, admin-generated invite codes, exact lowest-decimal virtual funds, instant wallet copy-trading, PNG PnL cards, and weekly pattern-recognition intelligence reports.

## Key Features

- **Private Invite Codes:** Only the admin generates invite passes (`/gencode` or Admin Panel) for up to 10 cabal members.
- **Strict Private Vault Per User:** Supports **Supabase / Postgres** (each user gets their own separate private schema `user_<telegram_id>`) or local **SQLite** (separate `data/users/<telegram_id>.db` files) — zero shared trading data between users.
- **Exact Lowest-Decimal Virtual Funds:** Set custom starting virtual money per chain down to 1 lamport (`0.000000001 SOL`) or 1 wei (`0.000000000000000001 ETH`).
- **Full Degen Trading Controls (Demo):** Paste any token address to scan live price, MC, liquidity, 5m volume, age, and GoPlus/RugCheck safety flags, then execute quick buys, custom exact buys, limit buys, DCA, take-profit, stop-loss, and trailing stops with liquidity-aware slippage and rug detection.
- **Instant Wallet Watching & Copy-Trading:** Watch any wallet on Solana, Base, or Robinhood Chain, choose exact copy amounts from your balance (or `%`), filter by MC/liquidity/safety, mirror sells, and compare Realistic delay vs. Ideal fills.
- **PNG PnL Cards:** Auto-generated shareable PnL image cards with selectable themes.
- **Weekly Alpha & Pattern Report:** Ranks watched wallets by net profit, breaks down chain performance, scores wallet copyability (0–100), and identifies winning MC/age/hold-time patterns.

## 24/7 Free Cloud Hosting (Render + Supabase + Wake-Up Ping)

1. Connect this GitHub repository on **Render** using [render.yaml](file:///render.yaml) (or create a Docker Web Service with Health Check `/health`).
2. Add the environment variables:
   - `TELEGRAM_BOT_TOKEN`
   - `DATABASE_URL` (your Supabase Session Pooler URI)
   - `ADMIN_TELEGRAM_IDS` (your Telegram numeric user ID)
3. Set up a free wake-up ping (for example on `cron-job.org`) to `GET https://<your-render-app>.onrender.com/health` every **5–10 minutes** so both Render Free and Supabase Free stay awake 24/7.

## Local Setup

1. Copy `.env.example` to `.env` and fill in `TELEGRAM_BOT_TOKEN`, `ADMIN_TELEGRAM_IDS` (or `ADMIN_BOOTSTRAP_CODE`), and optionally `DATABASE_URL`.
2. Install & build:
   ```bash
   npm install
   npm run build
   npm start
   ```
   *(On Windows PowerShell if `npm` script execution is restricted, use `npm.cmd`.)*
