# 🏴‍☠️ Codex Degen Box

A private cabal Telegram demo trading, wallet detective & copy-alpha bot supporting **Solana**, **Ethereum (EVM)**, **Base (`8453`)**, and **Robinhood Chain (`4663`)** — with **100% isolated private storage per user**, admin-generated invite codes, exact lowest-decimal virtual funds with live USDT conversion, instant wallet copy-trading + funding alerts, wallet-by-wallet reports, on-chain Wallet Detective dossiers + PNG cards, and pattern-recognition intelligence.

## Key Features

- **Private Invite Codes:** Only the admin generates invite passes (`/gencode` or Admin Panel) for up to 10 cabal members.
- **Strict Private Vault Per User:** Supports **Supabase / Postgres** (each user gets their own separate private schema `user_<telegram_id>`) or local **SQLite** (separate `data/users/<telegram_id>.db` files) — zero shared trading data between users.
- **Exact Lowest-Decimal Virtual Funds + Live USDT Calculator:** Add virtual funds directly in SOL/ETH OR enter an exact **USDT dollar amount** converted live down to 1 lamport (`0.000000001 SOL`) or 1 wei (`0.000000000000000001 ETH`).
- **Full Degen Trading Controls (Demo):** Paste any token address to scan live price, MC, liquidity, 5m volume, age, and GoPlus/RugCheck safety flags, then execute quick buys, custom exact buys, limit buys, DCA, take-profit, stop-loss, and trailing stops with liquidity-aware slippage and rug detection.
- **Wallet Detective Investigation (Paste Any Wallet OR Weekly Report):** Paste any Solana or EVM (`0x...`) wallet address to inspect top connected wallets, money flow arrows, 7-day activity & trading style, existing balances & coins held, launched coins (Pump.fun & EVM contracts), linked Twitter/X & domains, cross-chain twin wallets, first funder, and 2-hop middleman links — plus shareable **Detective PNG Cards**.
- **Instant Wallet Watching, Naming & Funding Alerts:** Name/rename any watched wallet, choose exact copy amounts (or `0` for Alert & Investigate Only mode), get live alerts whenever a watched storage wallet funds a new wallet, and inspect weekly reports **wallet by wallet**.
- **PNG PnL Cards:** Auto-generated shareable PnL & Detective image cards with selectable themes.

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
