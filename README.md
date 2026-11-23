# 🏴‍☠️ Codex Degen Box

A private cabal Telegram demo trading & copy-alpha bot supporting **Solana**, **Base**, and **Robinhood Chain (`4663`)** — with **100% isolated private SQLite databases per user**, admin-generated invite codes, exact lowest-decimal virtual funds, instant wallet copy-trading, PNG PnL cards, and weekly pattern-recognition intelligence reports.

## Key Features

- **Private Invite Codes (`AdminDb`):** Only the admin generates invite passes (`/gencode` or Admin Panel) for up to 10 cabal members.
- **Strict Private Vault Per User:** Every user gets their own separate SQLite file (`data/users/<telegram_id>.db`) — zero shared balances, trades, watched wallets, or reports.
- **Exact Lowest-Decimal Virtual Funds:** Set custom starting virtual money per chain down to 1 lamport (`0.000000001 SOL`) or 1 wei (`0.000000000000000001 ETH`).
- **Full Degen Trading Controls (Demo):** Paste any token address to scan live price, MC, liquidity, 5m volume, age, and GoPlus/RugCheck safety flags, then execute quick buys, custom exact buys, limit buys, DCA, take-profit, stop-loss, and trailing stops with liquidity-aware slippage and rug detection.
- **Instant Wallet Watching & Copy-Trading:** Watch any wallet on Solana, Base, or Robinhood Chain, choose exact copy amounts from your balance (or `%`), filter by MC/liquidity/safety, mirror sells, and compare Realistic delay vs. Ideal fills.
- **PNG PnL Cards:** Auto-generated shareable PnL image cards with selectable themes.
- **Weekly Alpha & Pattern Report:** Ranks watched wallets by net profit, breaks down chain performance, scores wallet copyability (0–100), and identifies winning MC/age/hold-time patterns.

## Quick Setup

1. Copy `.env.example` to `.env` and fill in:
   - `TELEGRAM_BOT_TOKEN` (from `@BotFather`)
   - `ADMIN_TELEGRAM_IDS` (your Telegram numeric user ID, or set `ADMIN_BOOTSTRAP_CODE` and send `/start YOUR_CODE` on first launch)
   - Optional: `HELIUS_API_KEY` for ultra-fast Solana swap streaming, `GEMINI_API_KEY` / `OPENAI_API_KEY` for AI coaching summaries
2. Install & build:
   ```bash
   npm install
   npm run build
   npm start
   ```
   Or run in development mode:
   ```bash
   npm run dev
   ```
   *(On Windows PowerShell if `npm` script execution is restricted, use `npm.cmd`.)*
