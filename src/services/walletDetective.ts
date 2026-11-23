import { ChainKey, CHAINS, EvmChainKey, normalizeAddress, shortAddress } from "../chains/registry.js";
import { AppConfig } from "../config.js";
import { atomicToNumber, formatExactUnits } from "../utils/amounts.js";
import { EvmClientManager } from "./evmClients.js";
import { MarketDataService } from "./marketData.js";
import { SolanaClientManager } from "./solanaClient.js";

export interface IdentityInfo {
  domains: string[];
  twitterHandles: string[];
  farcasterHandles: string[];
  pumpUsername: string | null;
  pumpFollowers: number | null;
  linkedEvmWallet: string | null;
  linkedSolWallet: string | null;
  coinSocialTwitters: string[];
}

export interface LaunchedCoinInfo {
  name: string;
  symbol: string;
  address: string;
  mcUsd: number;
  graduated: boolean;
  twitter: string | null;
  createdAtMs: number | null;
}

export interface WalletHoldingInfo {
  symbol: string;
  address: string;
  amountStr: string;
  usdValue: number;
}

export interface Hop2Connection {
  address: string;
  label: string | null;
  count: number;
  direction: "in" | "out" | "both";
}

export interface ConnectedBuddyReport {
  address: string;
  label: string | null;
  isExchangeOrApp: boolean;
  interactionsCount: number;
  inflowNative: number;
  outflowNative: number;
  directionTag: string;
  tokenMovesCount: number;
  lastInteractionAtMs: number | null;
  // Deep stats (for top personal wallets)
  activityCount: number | null;
  lastActiveAtMs: number | null;
  swapsCount: number | null;
  nativeBalance: number | null;
  nativeUsd: number | null;
  topHolding: string | null;
  totalHoldingsUsd: number | null;
  launchedCount: number;
  launchedCoins: LaunchedCoinInfo[];
  identity: IdentityInfo;
  roleBadge: string;
  tradingStyle: string | null;
  hop2Targets: Hop2Connection[];
}

export interface FirstFunderInfo {
  address: string;
  label: string | null;
  amountNative: number;
  timestampMs: number | null;
}

export interface CrossChainGlance {
  chainKey: string;
  chainLabel: string;
  emoji: string;
  balanceNative: number;
  nativeSymbol: string;
  usdValue: number;
  txCount: number;
  explorerUrl: string;
}

export interface WalletInvestigationReport {
  chain: ChainKey;
  address: string;
  days: number;
  roleSummary: string;
  balanceNative: number;
  nativeBalanceStr: string;
  nativeSymbol: string;
  nativeUsd: number;
  topHoldings: WalletHoldingInfo[];
  totalHoldingsUsd: number;
  activityCount: number;
  swapsCount: number;
  transfersCount: number;
  lastActiveAtMs: number | null;
  peakHoursUtc: string | null;
  tradingStyle: string | null;
  firstFunder: FirstFunderInfo | null;
  identity: IdentityInfo;
  launchedCount: number;
  launchedCoins: LaunchedCoinInfo[];
  connectedWallets: ConnectedBuddyReport[];
  crossChainGlances: CrossChainGlance[];
  notes: string[];
  generatedAt: number;
}

const SOL_IGNORED_ACCOUNTS = new Set([
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "So11111111111111111111111111111111111111112",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXx9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"
]);

const SOL_DEX_PROGRAMS = new Set([
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
]);

const KNOWN_SOL_EXCHANGES: Record<string, string> = {
  H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS: "Coinbase Hot",
  GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE: "Coinbase Prime",
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9": "Binance Hot",
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM": "Binance Hot",
  "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S": "Binance",
  "5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD": "OKX Hot",
  AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2: "Bybit Hot",
  FWznbcNXWQuHTawe9RxvQ2LdCENSSH12dsznf4RiouN5: "Kraken",
  BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6: "KuCoin"
};

const KNOWN_EVM_EXCHANGES: Record<string, string> = {
  "0x28c6c06298d514db089934071355e5743bf21d60": "Binance",
  "0x21a31ee1afc51d94c2efccaa2092ad1028285549": "Binance",
  "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": "Binance",
  "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": "Coinbase",
  "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43": "Coinbase",
  "0x503828976d22510aad0201ac7ec88293211d23da": "Coinbase",
  "0x6cc5f688a315f3dc28a7781717a9a7b2a5f9f205": "OKX",
  "0xf89d7b9c864f589bbf53a82105107622b35eaa40": "Bybit",
  "0x2910543af39aba0cd09dbb2d50200b3e800a63d2": "Kraken",
  "0x40b38765696e3d5d8d9d834d8aad4bb6e418e489": "Robinhood"
};

const BLOCKSCOUT_HOSTS: Record<string, { host: string; label: string; emoji: string; explorer: string }> = {
  ethereum: {
    host: "https://eth.blockscout.com",
    label: "Ethereum",
    emoji: "⚪",
    explorer: "https://eth.blockscout.com"
  },
  base: {
    host: "https://base.blockscout.com",
    label: "Base",
    emoji: "🔵",
    explorer: "https://base.blockscout.com"
  },
  robinhood: {
    host: "https://robinhoodchain.blockscout.com",
    label: "Robinhood Chain",
    emoji: "🟢",
    explorer: "https://robinhoodchain.blockscout.com"
  },
  arbitrum: {
    host: "https://arbitrum.blockscout.com",
    label: "Arbitrum",
    emoji: "🔷",
    explorer: "https://arbitrum.blockscout.com"
  },
  polygon: {
    host: "https://polygon.blockscout.com",
    label: "Polygon",
    emoji: "🟪",
    explorer: "https://polygon.blockscout.com"
  }
};

function emptyIdentity(): IdentityInfo {
  return {
    domains: [],
    twitterHandles: [],
    farcasterHandles: [],
    pumpUsername: null,
    pumpFollowers: null,
    linkedEvmWallet: null,
    linkedSolWallet: null,
    coinSocialTwitters: []
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeTwitterHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let cleaned = raw.trim();
  if (!cleaned) return null;
  const match = cleaned.match(/(?:x\.com|twitter\.com)\/(@?[A-Za-z0-9_]{1,30})/i);
  if (match?.[1]) cleaned = match[1];
  cleaned = cleaned.replace(/^@+/, "");
  if (!/^[A-Za-z0-9_]{1,20}$/.test(cleaned)) return null;
  if (cleaned.toLowerCase() === "i" || cleaned.toLowerCase() === "intent") return null;
  return cleaned;
}

function looksLikeExchangeLabel(label: string | null | undefined): boolean {
  if (!label) return false;
  return /(binance|coinbase|kraken|okx|bybit|kucoin|mexc|gate|bitget|robinhood|gemini|huobi|htx)/i.test(
    label
  );
}

function summarizePeakHours(hourCounts: number[]): string | null {
  let max = 0;
  let bestStart = 0;
  for (let h = 0; h < 24; h++) {
    const windowSum = hourCounts[h] + hourCounts[(h + 1) % 24] + hourCounts[(h + 2) % 24];
    if (windowSum > max) {
      max = windowSum;
      bestStart = h;
    }
  }
  if (max < 2) return null;
  const end = (bestStart + 3) % 24;
  return `${String(bestStart).padStart(2, "0")}:00–${String(end).padStart(2, "0")}:00 UTC`;
}

function formatDirectionTag(inflow: number, outflow: number, tokenMoves: number): string {
  const hasIn = inflow > 0.0005;
  const hasOut = outflow > 0.0005;
  if (hasIn && hasOut) return "↔️ Both ways";
  if (hasIn) return "⬅️ Sent funds INTO this wallet";
  if (hasOut) return "➡️ Received starter funds FROM this wallet";
  return tokenMoves > 0 ? "🪙 Token transfers" : "🔗 Interacted";
}

function classifyWalletRole(params: {
  isExchange: boolean;
  launchedCount: number;
  swapsCount: number;
  activityCount: number;
  nativeBalance: number;
}): string {
  if (params.isExchange) return "🏦 Exchange";
  if (params.launchedCount > 0 && params.swapsCount >= 3) return "🪙🔥 Launcher & Trader";
  if (params.launchedCount > 0) return "🪙 Coin Launcher";
  if (params.swapsCount >= 4) return "🔥 Active Trader";
  if (params.activityCount <= 2 && params.nativeBalance > 0.05) return "🧊 Quiet Vault / Fresh";
  if (params.swapsCount === 0 && params.activityCount > 0) return "🧊 Storage / Transfer Vault";
  return params.activityCount <= 3 ? "🆕 Low Activity" : "👤 Active Wallet";
}

export class WalletDetectiveService {
  private readonly config: AppConfig;
  private readonly evmClients: EvmClientManager;
  private readonly solanaClient: SolanaClientManager;
  private readonly market: MarketDataService;
  private readonly cache = new Map<string, { report: WalletInvestigationReport; ts: number }>();

  constructor(params: {
    config: AppConfig;
    evmClients: EvmClientManager;
    solanaClient: SolanaClientManager;
    market: MarketDataService;
  }) {
    this.config = params.config;
    this.evmClients = params.evmClients;
    this.solanaClient = params.solanaClient;
    this.market = params.market;
  }

  async investigateWallet(
    chain: ChainKey,
    address: string,
    days = 7,
    forceFresh = false
  ): Promise<WalletInvestigationReport> {
    const norm = normalizeAddress(chain, address);
    const cacheKey = `${chain}:${norm}:${days}`;
    if (!forceFresh) {
      const hit = this.cache.get(cacheKey);
      if (hit && Date.now() - hit.ts < 120_000) {
        return hit.report;
      }
    }

    const report =
      chain === "solana"
        ? await this.investigateSolana(norm, days)
        : await this.investigateEvm(chain, norm, days);

    this.cache.set(cacheKey, { report, ts: Date.now() });
    return report;
  }

  /**
   * Scans an EVM address across Ethereum, Base, Robinhood (and Arbitrum/Polygon balance glance)
   * and returns the richest chain report + cross-chain overview.
   */
  async investigateEvmAuto(
    address: string,
    days = 7
  ): Promise<WalletInvestigationReport> {
    const norm = address.trim().toLowerCase();
    const glances = await this.probeEvmCrossChainGlances(norm);
    // Pick best chain that actually has history/balance (prefer ethereum / robinhood / base)
    const active = glances
      .filter((g) => g.chainKey === "ethereum" || g.chainKey === "robinhood" || g.chainKey === "base")
      .sort((a, b) => (b.txCount > 0 ? 1 : 0) - (a.txCount > 0 ? 1 : 0) || b.usdValue - a.usdValue || b.txCount - a.txCount);

    const chosenChain: EvmChainKey =
      (active[0]?.chainKey as EvmChainKey | undefined) ?? "ethereum";
    const report = await this.investigateWallet(chosenChain, norm, days);
    report.crossChainGlances = glances;
    return report;
  }

  // ==================== Identity & Coin Launches ====================

  async lookupIdentity(chain: ChainKey | "any", address: string): Promise<IdentityInfo> {
    const id = emptyIdentity();
    const tasks: Promise<void>[] = [];

    tasks.push(
      (async () => {
        try {
          const res = await fetch(`https://api.web3.bio/profile/${encodeURIComponent(address)}`, {
            signal: AbortSignal.timeout(5500)
          });
          if (!res.ok) return;
          const profiles = (await res.json()) as Array<{
            platform?: string;
            identity?: string;
            address?: string;
            displayName?: string;
            links?: { twitter?: { handle?: string } };
          }>;
          if (!Array.isArray(profiles)) return;
          for (const p of profiles) {
            if (p.identity && (p.identity.endsWith(".eth") || p.identity.endsWith(".sol") || p.identity.endsWith(".sns"))) {
              if (!id.domains.includes(p.identity)) id.domains.push(p.identity);
            }
            if (p.platform === "farcaster" && p.identity) {
              if (!id.farcasterHandles.includes(p.identity)) id.farcasterHandles.push(p.identity);
            }
            const tw = normalizeTwitterHandle(p.links?.twitter?.handle);
            if (tw && !id.twitterHandles.includes(tw)) {
              id.twitterHandles.push(tw);
            }
            if (p.address && /^0x[a-fA-F0-9]{40}$/.test(p.address) && p.address.toLowerCase() !== address.toLowerCase()) {
              if (!id.linkedEvmWallet) id.linkedEvmWallet = p.address.toLowerCase();
            }
            if (
              p.address &&
              /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.address) &&
              p.address !== address
            ) {
              if (!id.linkedSolWallet) id.linkedSolWallet = p.address;
            }
          }
        } catch {
          // Ignore transient web3.bio error
        }
      })()
    );

    if (chain === "solana") {
      tasks.push(
        (async () => {
          try {
            const res = await fetch(`https://frontend-api-v3.pump.fun/users/${encodeURIComponent(address)}`, {
              signal: AbortSignal.timeout(5500)
            });
            if (!res.ok) return;
            const u = (await res.json()) as {
              username?: string | null;
              followers?: number | null;
              x_username?: string | null;
              canonical_evm_wallet?: string | null;
            };
            if (u.username) id.pumpUsername = u.username;
            if (typeof u.followers === "number") id.pumpFollowers = u.followers;
            const xw = normalizeTwitterHandle(u.x_username);
            if (xw && !id.twitterHandles.includes(xw)) id.twitterHandles.push(xw);
            if (u.canonical_evm_wallet && /^0x[a-fA-F0-9]{40}$/.test(u.canonical_evm_wallet)) {
              id.linkedEvmWallet = u.canonical_evm_wallet.toLowerCase();
            }
          } catch {
            // Ignore pump.fun profile error
          }
        })()
      );
    }

    await Promise.all(tasks);
    return id;
  }

  private async fetchSolanaLaunchedCoins(
    address: string
  ): Promise<{ count: number; coins: LaunchedCoinInfo[] }> {
    try {
      const res = await fetch(
        `https://frontend-api-v3.pump.fun/coins-v2/user-created-coins/${encodeURIComponent(address)}?offset=0&limit=10`,
        { signal: AbortSignal.timeout(5500) }
      );
      if (!res.ok) return { count: 0, coins: [] };
      const data = (await res.json()) as {
        count?: number;
        coins?: Array<{
          name?: string;
          symbol?: string;
          mint?: string;
          usd_market_cap?: number;
          complete?: boolean;
          raydium_pool?: string | null;
          twitter?: string | null;
          created_timestamp?: number;
        }>;
      };
      const coins: LaunchedCoinInfo[] = (data.coins ?? []).slice(0, 6).map((c) => ({
        name: c.name ?? "Unknown",
        symbol: c.symbol ?? "?",
        address: c.mint ?? "",
        mcUsd: Number(c.usd_market_cap ?? 0),
        graduated: Boolean(c.complete || c.raydium_pool),
        twitter: normalizeTwitterHandle(c.twitter),
        createdAtMs: typeof c.created_timestamp === "number" ? c.created_timestamp : null
      }));
      return {
        count: typeof data.count === "number" ? data.count : coins.length,
        coins
      };
    } catch {
      return { count: 0, coins: [] };
    }
  }

  // ==================== Solana Investigation ====================

  private async investigateSolana(address: string, days: number): Promise<WalletInvestigationReport> {
    const notes: string[] = [];
    const now = Date.now();
    const cutoffSec = Math.floor((now - days * 86_400_000) / 1000);

    const [nativePriceUsd, balRes, sigs, holdings, identity, launched] = await Promise.all([
      this.market.getNativePriceUsd("solana"),
      this.solanaRpcSingle<{ value?: number }>("getBalance", [address, { commitment: "confirmed" }]).then(
        (r) => r?.value ?? 0
      ),
      this.solanaRpcSingle<
        Array<{ signature: string; err: unknown; blockTime?: number | null }>
      >("getSignaturesForAddress", [address, { limit: 65 }]).then((r) => r ?? []),
      this.fetchSolanaHoldings(address),
      this.lookupIdentity("solana", address),
      this.fetchSolanaLaunchedCoins(address)
    ]);

    for (const c of launched.coins) {
      if (c.twitter && !identity.coinSocialTwitters.includes(c.twitter)) {
        identity.coinSocialTwitters.push(c.twitter);
      }
    }

    const balanceNative = atomicToNumber(BigInt(balRes), 9);
    const nativeUsd = balanceNative * nativePriceUsd;
    const totalHoldingsUsd = nativeUsd + holdings.reduce((acc, h) => acc + h.usdValue, 0);

    const validSigsInWindow = sigs.filter(
      (s) => s.err === null && (s.blockTime === null || s.blockTime === undefined || Number(s.blockTime) >= cutoffSec)
    );
    const lastActiveAtMs = sigs[0]?.blockTime ? Number(sigs[0].blockTime) * 1000 : null;

    // Fetch parsed transactions (Helius Enhanced when key exists, otherwise batched public JSON-RPC)
    const counterMap = new Map<
      string,
      {
        interactionsCount: number;
        inflowNative: number;
        outflowNative: number;
        tokenMovesCount: number;
        lastInteractionAtMs: number | null;
      }
    >();
    const hourCounts = new Array<number>(24).fill(0);
    let swapsCount = 0;
    let transfersCount = 0;
    let firstFunder: FirstFunderInfo | null = null;

    const addCounterparty = (
      other: string,
      inSol: number,
      outSol: number,
      tokenMove: boolean,
      tsMs: number | null
    ) => {
      if (!other || other === address || SOL_IGNORED_ACCOUNTS.has(other)) return;
      const cur = counterMap.get(other) ?? {
        interactionsCount: 0,
        inflowNative: 0,
        outflowNative: 0,
        tokenMovesCount: 0,
        lastInteractionAtMs: null
      };
      cur.interactionsCount += 1;
      cur.inflowNative += inSol;
      cur.outflowNative += outSol;
      if (tokenMove) cur.tokenMovesCount += 1;
      if (tsMs && (!cur.lastInteractionAtMs || tsMs > cur.lastInteractionAtMs)) {
        cur.lastInteractionAtMs = tsMs;
      }
      counterMap.set(other, cur);
    };

    const initialCap = this.config.heliusApiKey ? 60 : 28;
    const sigSample = validSigsInWindow.slice(0, initialCap);
    let parsedCount = sigSample.length;

    const processTxList = (
      txList: Awaited<ReturnType<WalletDetectiveService["fetchSolanaTransactionsBatch"]>>
    ) => {
      for (const tx of txList) {
        if (!tx || tx.meta?.err) continue;
        const tsMs = tx.blockTime ? tx.blockTime * 1000 : null;
        if (tsMs) hourCounts[new Date(tsMs).getUTCHours()] += 1;

        const staticKeys = (tx.transaction?.message?.accountKeys ?? []).map((k) =>
          typeof k === "string" ? k : k.pubkey
        );
        const accountKeys = [
          ...staticKeys,
          ...(tx.meta?.loadedAddresses?.writable ?? []),
          ...(tx.meta?.loadedAddresses?.readonly ?? [])
        ];
        const usesDex = accountKeys.some((k) => SOL_DEX_PROGRAMS.has(k));
        if (usesDex) swapsCount += 1;
        else transfersCount += 1;

        const preBals = tx.meta?.preBalances ?? [];
        const postBals = tx.meta?.postBalances ?? [];
        const mainIdx = accountKeys.indexOf(address);
        const mainSolDelta =
          mainIdx >= 0 ? ((postBals[mainIdx] ?? 0) - (preBals[mainIdx] ?? 0)) / 1e9 : 0;

        const touchedInTx = new Set<string>();
        if (!usesDex) {
          for (let i = 0; i < accountKeys.length; i++) {
            const k = accountKeys[i];
            if (!k || k === address || SOL_IGNORED_ACCOUNTS.has(k)) continue;
            const delta = ((postBals[i] ?? 0) - (preBals[i] ?? 0)) / 1e9;
            if (mainSolDelta < -0.002 && delta > 0.002) {
              addCounterparty(k, 0, Math.min(-mainSolDelta, delta), false, tsMs);
              touchedInTx.add(k);
            } else if (mainSolDelta > 0.002 && delta < -0.002) {
              addCounterparty(k, Math.min(mainSolDelta, -delta), 0, false, tsMs);
              touchedInTx.add(k);
            }
          }

          const preTok = new Map<string, { mint: string; owner: string; amt: number }>();
          for (const tb of tx.meta?.preTokenBalances ?? []) {
            if (tb.owner && tb.mint) {
              preTok.set(`${tb.owner}:${tb.mint}`, {
                mint: tb.mint,
                owner: tb.owner,
                amt: Number(tb.uiTokenAmount?.uiAmount ?? 0)
              });
            }
          }
          const ownerMintDiff = new Map<string, number>();
          for (const tb of tx.meta?.postTokenBalances ?? []) {
            if (!tb.owner || !tb.mint) continue;
            const key = `${tb.owner}:${tb.mint}`;
            const prev = preTok.get(key)?.amt ?? 0;
            const cur = Number(tb.uiTokenAmount?.uiAmount ?? 0);
            ownerMintDiff.set(key, cur - prev);
          }
          for (const [k, v] of preTok.entries()) {
            if (!ownerMintDiff.has(k)) ownerMintDiff.set(k, -v.amt);
          }

          for (const [key, diff] of ownerMintDiff.entries()) {
            const [owner, mint] = key.split(":");
            if (!owner || owner === address || SOL_IGNORED_ACCOUNTS.has(owner) || Math.abs(diff) <= 0) continue;
            const mainDiff = ownerMintDiff.get(`${address}:${mint}`) ?? 0;
            if ((mainDiff < 0 && diff > 0) || (mainDiff > 0 && diff < 0)) {
              if (!touchedInTx.has(owner)) {
                addCounterparty(owner, 0, 0, true, tsMs);
                touchedInTx.add(owner);
              }
            }
          }
        }
      }
    };

    if (sigSample.length > 0) {
      processTxList(await this.fetchSolanaTransactionsBatch(sigSample.map((s) => s.signature)));
      if (counterMap.size === 0 && validSigsInWindow.length > sigSample.length) {
        const extraSigs = validSigsInWindow.slice(sigSample.length, initialCap + 20);
        if (extraSigs.length > 0) {
          parsedCount += extraSigs.length;
          processTxList(await this.fetchSolanaTransactionsBatch(extraSigs.map((s) => s.signature)));
        }
      }
    }

    if (validSigsInWindow.length > parsedCount) {
      notes.push(`Analyzed latest ${parsedCount} of ${validSigsInWindow.length} active moves in ${days}d.`);
    }

    // Attempt First-Ever Funder lookup when wallet history fits in one page
    if (sigs.length > 0 && sigs.length < 65) {
      const oldestSig = sigs[sigs.length - 1];
      if (oldestSig && oldestSig.err === null) {
        const [oldestTx] = await this.fetchSolanaTransactionsBatch([oldestSig.signature]);
        if (oldestTx && !oldestTx.meta?.err) {
          const keys = (oldestTx.transaction?.message?.accountKeys ?? []).map((k) =>
            typeof k === "string" ? k : k.pubkey
          );
          const preB = oldestTx.meta?.preBalances ?? [];
          const postB = oldestTx.meta?.postBalances ?? [];
          const mainIdx = keys.indexOf(address);
          const mainGain = mainIdx >= 0 ? ((postB[mainIdx] ?? 0) - (preB[mainIdx] ?? 0)) / 1e9 : 0;
          if (mainGain > 0.001) {
            for (let i = 0; i < keys.length; i++) {
              const k = keys[i];
              if (!k || k === address || SOL_IGNORED_ACCOUNTS.has(k)) continue;
              const loss = ((preB[i] ?? 0) - (postB[i] ?? 0)) / 1e9;
              if (loss > 0.001) {
                firstFunder = {
                  address: k,
                  label: KNOWN_SOL_EXCHANGES[k] ?? null,
                  amountNative: Math.min(mainGain, loss),
                  timestampMs: oldestTx.blockTime ? oldestTx.blockTime * 1000 : null
                };
                break;
              }
            }
          }
        }
      }
    }

    // Sort buddies by interactions + SOL volume
    const rawBuddies = [...counterMap.entries()]
      .sort((a, b) => {
        const exA = KNOWN_SOL_EXCHANGES[a[0]] ? 1 : 0;
        const exB = KNOWN_SOL_EXCHANGES[b[0]] ? 1 : 0;
        if (exA !== exB) return exA - exB; // Prefer personal wallets near top while still showing exchanges
        if (b[1].interactionsCount !== a[1].interactionsCount) {
          return b[1].interactionsCount - a[1].interactionsCount;
        }
        return b[1].inflowNative + b[1].outflowNative - (a[1].inflowNative + a[1].outflowNative);
      })
      .slice(0, 8);

    const buddies: ConnectedBuddyReport[] = rawBuddies.map(([addr, stats]) => {
      const exLabel = KNOWN_SOL_EXCHANGES[addr] ?? null;
      return {
        address: addr,
        label: exLabel,
        isExchangeOrApp: Boolean(exLabel),
        interactionsCount: stats.interactionsCount,
        inflowNative: stats.inflowNative,
        outflowNative: stats.outflowNative,
        directionTag: formatDirectionTag(stats.inflowNative, stats.outflowNative, stats.tokenMovesCount),
        tokenMovesCount: stats.tokenMovesCount,
        lastInteractionAtMs: stats.lastInteractionAtMs,
        activityCount: null,
        lastActiveAtMs: null,
        swapsCount: null,
        nativeBalance: null,
        nativeUsd: null,
        topHolding: null,
        totalHoldingsUsd: null,
        launchedCount: 0,
        launchedCoins: [],
        identity: emptyIdentity(),
        roleBadge: exLabel ? "🏦 Exchange" : "🔗 Connected Wallet",
        tradingStyle: null,
        hop2Targets: []
      };
    });

    // Deep-investigate top 4 personal buddy wallets
    const personalBuddies = buddies.filter((b) => !b.isExchangeOrApp).slice(0, 4);
    for (let idx = 0; idx < personalBuddies.length; idx++) {
      await this.enrichSolanaBuddy(personalBuddies[idx], nativePriceUsd, days, idx < 2, address);
      await sleep(120);
    }

    return {
      chain: "solana",
      address,
      days,
      roleSummary: classifyWalletRole({
        isExchange: Boolean(KNOWN_SOL_EXCHANGES[address]),
        launchedCount: launched.count,
        swapsCount,
        activityCount: validSigsInWindow.length,
        nativeBalance: balanceNative
      }),
      balanceNative,
      nativeBalanceStr: formatExactUnits(BigInt(balRes), 9, 6),
      nativeSymbol: "SOL",
      nativeUsd,
      topHoldings: holdings.slice(0, 6),
      totalHoldingsUsd,
      activityCount: validSigsInWindow.length,
      swapsCount,
      transfersCount,
      lastActiveAtMs,
      peakHoursUtc: summarizePeakHours(hourCounts),
      tradingStyle:
        swapsCount >= 12
          ? "Frequent active trader"
          : swapsCount >= 3
            ? "Selective trader"
            : transfersCount > 0
              ? "Transfer / Storage vault"
              : null,
      firstFunder,
      identity,
      launchedCount: launched.count,
      launchedCoins: launched.coins,
      connectedWallets: buddies,
      crossChainGlances: [],
      notes,
      generatedAt: now
    };
  }

  private async enrichSolanaBuddy(
    buddy: ConnectedBuddyReport,
    solPriceUsd: number,
    days: number,
    checkHop2: boolean,
    excludeMain: string
  ): Promise<void> {
    const cutoffSec = Math.floor((Date.now() - days * 86_400_000) / 1000);
    try {
      const [balRes, sigs, holdings, identity, launched] = await Promise.all([
        this.solanaRpcSingle<{ value?: number }>("getBalance", [buddy.address, { commitment: "confirmed" }]).then(
          (r) => r?.value ?? 0
        ),
        this.solanaRpcSingle<
          Array<{ signature: string; err: unknown; blockTime?: number | null }>
        >("getSignaturesForAddress", [buddy.address, { limit: 40 }]).then((r) => r ?? []),
        this.fetchSolanaHoldings(buddy.address, 3),
        this.lookupIdentity("solana", buddy.address),
        this.fetchSolanaLaunchedCoins(buddy.address)
      ]);

      buddy.nativeBalance = atomicToNumber(BigInt(balRes), 9);
      buddy.nativeUsd = buddy.nativeBalance * solPriceUsd;
      buddy.topHolding = holdings[0] ? `$${holdings[0].symbol} (${holdings[0].amountStr})` : null;
      buddy.totalHoldingsUsd = buddy.nativeUsd + holdings.reduce((a, h) => a + h.usdValue, 0);
      buddy.identity = identity;
      buddy.launchedCount = launched.count;
      buddy.launchedCoins = launched.coins;
      if (!buddy.label) {
        buddy.label = identity.domains[0] ?? identity.pumpUsername ?? null;
      }
      if (identity.linkedEvmWallet) {
        // Carry twin EVM hint forward
      }

      const inWindow = sigs.filter(
        (s) => s.err === null && (!s.blockTime || Number(s.blockTime) >= cutoffSec)
      );
      buddy.activityCount = inWindow.length;
      buddy.lastActiveAtMs = sigs[0]?.blockTime ? Number(sigs[0].blockTime) * 1000 : null;

      // Sample up to 6 recent txs of buddy to detect swaps + 2-hop transfers
      const sampleSigs = inWindow.slice(0, 6).map((s) => s.signature);
      let swaps = 0;
      const hop2Map = new Map<string, { count: number; inCount: number; outCount: number }>();

      if (sampleSigs.length > 0) {
        const txs = await this.fetchSolanaTransactionsBatch(sampleSigs);
        for (const tx of txs) {
          if (!tx || tx.meta?.err) continue;
          const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) =>
            typeof k === "string" ? k : k.pubkey
          );
          const usesDex = keys.some((k) => SOL_DEX_PROGRAMS.has(k));
          if (usesDex) {
            swaps += 1;
          } else if (checkHop2) {
            const preB = tx.meta?.preBalances ?? [];
            const postB = tx.meta?.postBalances ?? [];
            const bIdx = keys.indexOf(buddy.address);
            const bDelta = bIdx >= 0 ? ((postB[bIdx] ?? 0) - (preB[bIdx] ?? 0)) / 1e9 : 0;
            for (let i = 0; i < keys.length; i++) {
              const other = keys[i];
              if (!other || other === buddy.address || other === excludeMain || SOL_IGNORED_ACCOUNTS.has(other)) {
                continue;
              }
              const oDelta = ((postB[i] ?? 0) - (preB[i] ?? 0)) / 1e9;
              if (bDelta < -0.005 && oDelta > 0.005) {
                const cur = hop2Map.get(other) ?? { count: 0, inCount: 0, outCount: 0 };
                cur.count += 1;
                cur.outCount += 1;
                hop2Map.set(other, cur);
              } else if (bDelta > 0.005 && oDelta < -0.005) {
                const cur = hop2Map.get(other) ?? { count: 0, inCount: 0, outCount: 0 };
                cur.count += 1;
                cur.inCount += 1;
                hop2Map.set(other, cur);
              }
            }
          }
        }
      }

      // Scale estimated swaps if buddy had >6 txs
      buddy.swapsCount =
        inWindow.length > sampleSigs.length && sampleSigs.length > 0
          ? Math.round((swaps / sampleSigs.length) * inWindow.length)
          : swaps;

      buddy.roleBadge = classifyWalletRole({
        isExchange: buddy.isExchangeOrApp,
        launchedCount: buddy.launchedCount,
        swapsCount: buddy.swapsCount,
        activityCount: buddy.activityCount,
        nativeBalance: buddy.nativeBalance
      });
      buddy.tradingStyle =
        buddy.swapsCount >= 10
          ? "High-frequency trader"
          : buddy.swapsCount >= 2
            ? "Active coin trader"
            : "Transfer / storage wallet";

      if (checkHop2 && hop2Map.size > 0) {
        buddy.hop2Targets = [...hop2Map.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 2)
          .map(([addr, s]) => ({
            address: addr,
            label: KNOWN_SOL_EXCHANGES[addr] ?? null,
            count: s.count,
            direction: s.inCount > 0 && s.outCount > 0 ? "both" : s.outCount > 0 ? "out" : "in"
          }));
      }
    } catch {
      // Keep base stats if enrichment fails
    }
  }

  private async fetchSolanaHoldings(address: string, limit = 8): Promise<WalletHoldingInfo[]> {
    try {
      const [splRes, tok22Res] = await Promise.all([
        this.solanaRpcSingle<{ value?: Array<{ account?: { data?: unknown } }> }>(
          "getTokenAccountsByOwner",
          [address, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed" }]
        ),
        this.solanaRpcSingle<{ value?: Array<{ account?: { data?: unknown } }> }>(
          "getTokenAccountsByOwner",
          [address, { programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }, { encoding: "jsonParsed" }]
        )
      ]);

      const mintAmounts = new Map<string, number>();
      for (const acc of [...(splRes?.value ?? []), ...(tok22Res?.value ?? [])]) {
        const info = (acc.account?.data as { parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number } } } })
          ?.parsed?.info;
        const mint = info?.mint;
        const amt = Number(info?.tokenAmount?.uiAmount ?? 0);
        if (!mint || !Number.isFinite(amt) || amt <= 0) continue;
        mintAmounts.set(mint, (mintAmounts.get(mint) ?? 0) + amt);
      }

      if (mintAmounts.size === 0) return [];
      const topMints = [...mintAmounts.keys()].slice(0, 25);
      const snaps = await this.market.getBatchTokenSnapshots("solana", topMints);

      const list: WalletHoldingInfo[] = [];
      for (const mint of topMints) {
        const amt = mintAmounts.get(mint) ?? 0;
        const snap = snaps.get(mint);
        const usdValue = snap ? amt * snap.priceUsd : 0;
        if (!snap && list.length >= limit) continue;
        list.push({
          symbol: snap?.symbol ?? shortAddress(mint, 4, 4),
          address: mint,
          amountStr: amt >= 1000 ? Math.round(amt).toLocaleString("en-US") : amt.toPrecision(4),
          usdValue
        });
      }

      return list.sort((a, b) => b.usdValue - a.usdValue).slice(0, limit);
    } catch {
      return [];
    }
  }

  private async fetchSolanaTransactionsBatch(
    signatures: string[]
  ): Promise<
    Array<{
      blockTime?: number | null;
      meta?: {
        err?: unknown;
        preBalances?: number[];
        postBalances?: number[];
        loadedAddresses?: { writable?: string[]; readonly?: string[] };
        preTokenBalances?: Array<{ owner?: string; mint?: string; uiTokenAmount?: { uiAmount?: number } }>;
        postTokenBalances?: Array<{ owner?: string; mint?: string; uiTokenAmount?: { uiAmount?: number } }>;
      } | null;
      transaction?: {
        message?: {
          accountKeys?: Array<string | { pubkey: string }>;
        };
      };
    } | null>
  > {
    if (signatures.length === 0) return [];
    const results: Array<any> = [];
    const batchSize = 5;

    for (let i = 0; i < signatures.length; i += batchSize) {
      const chunk = signatures.slice(i, i + batchSize);
      const payload = chunk.map((sig, idx) => ({
        jsonrpc: "2.0",
        id: idx + 1,
        method: "getTransaction",
        params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]
      }));

      let batchOk = false;
      try {
        const res = await fetch(this.config.solanaRpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000)
        });
        if (res.ok) {
          const json = (await res.json()) as Array<{ id?: number; result?: unknown; error?: unknown }>;
          if (Array.isArray(json) && json.some((item) => item.result !== undefined && item.result !== null)) {
            json.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
            for (const item of json) results.push(item.result ?? null);
            batchOk = true;
          }
        }
      } catch {
        // Fall through to single-call publicnode fallback
      }

      if (!batchOk) {
        const singles = await Promise.all(
          chunk.map((sig) =>
            this.solanaRpcSingle("getTransaction", [
              sig,
              { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }
            ])
          )
        );
        results.push(...singles);
      }
      if (i + batchSize < signatures.length) {
        await sleep(160);
      }
    }

    return results;
  }

  private async solanaRpcSingle<T>(method: string, params: unknown[]): Promise<T | null> {
    const endpoints = [this.config.solanaRpcUrl];
    if (!endpoints.includes("https://solana-rpc.publicnode.com")) {
      endpoints.push("https://solana-rpc.publicnode.com");
    }
    for (const rpcUrl of endpoints) {
      try {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) continue;
        const json = (await res.json()) as { result?: T; error?: unknown };
        if (json.result !== undefined && !json.error) {
          return json.result;
        }
      } catch {
        // Try next endpoint
      }
    }
    return null;
  }

  // ==================== EVM Investigation (Ethereum, Base, Robinhood) ====================

  private async investigateEvm(
    chain: EvmChainKey,
    address: string,
    days: number
  ): Promise<WalletInvestigationReport> {
    const notes: string[] = [];
    const now = Date.now();
    const cutoffMs = now - days * 86_400_000;
    const bs = BLOCKSCOUT_HOSTS[chain];

    const [ethPriceUsd, rpcBal, identity, bsProfile, bsTxs, bsTokenTransfers, bsTokens] =
      await Promise.all([
        this.market.getNativePriceUsd(chain),
        this.evmClients.getNativeBalance(chain, address),
        this.lookupIdentity(chain, address),
        this.fetchBlockscoutJson<{
          coin_balance?: string;
          ens_domain_name?: string | null;
        }>(`${bs.host}/api/v2/addresses/${address}`),
        this.fetchBlockscoutJson<{ items?: BlockscoutTxItem[] }>(
          `${bs.host}/api/v2/addresses/${address}/transactions`
        ),
        this.fetchBlockscoutJson<{ items?: BlockscoutTokenTransferItem[] }>(
          `${bs.host}/api/v2/addresses/${address}/token-transfers`
        ),
        this.fetchBlockscoutJson<BlockscoutTokenBalanceItem[]>(
          `${bs.host}/api/v2/addresses/${address}/token-balances`
        )
      ]);

    if (bsProfile?.ens_domain_name && !identity.domains.includes(bsProfile.ens_domain_name)) {
      identity.domains.push(bsProfile.ens_domain_name);
    }

    const balWei =
      rpcBal !== null
        ? rpcBal
        : bsProfile?.coin_balance
          ? BigInt(bsProfile.coin_balance)
          : 0n;
    const balanceNative = atomicToNumber(balWei, 18);
    const nativeUsd = balanceNative * ethPriceUsd;

    const holdings: WalletHoldingInfo[] = [];
    if (Array.isArray(bsTokens)) {
      for (const tb of bsTokens) {
        const sym = tb.token?.symbol;
        const addr = tb.token?.address_hash ?? "";
        const dec = Number(tb.token?.decimals ?? 18);
        if (!sym || !tb.value) continue;
        const amt = atomicToNumber(BigInt(tb.value), Number.isFinite(dec) ? dec : 18);
        if (amt <= 0) continue;
        const usd = amt * Number(tb.token?.exchange_rate ?? 0);
        holdings.push({
          symbol: sym,
          address: addr,
          amountStr: amt >= 1000 ? Math.round(amt).toLocaleString("en-US") : amt.toPrecision(4),
          usdValue: usd
        });
      }
      holdings.sort((a, b) => b.usdValue - a.usdValue);
    }

    const totalHoldingsUsd = nativeUsd + holdings.reduce((a, h) => a + h.usdValue, 0);

    // Build interaction stats from Blockscout txs/transfers (or Alchemy fallback on Base)
    const counterMap = new Map<
      string,
      {
        label: string | null;
        isExchange: boolean;
        interactionsCount: number;
        inflowNative: number;
        outflowNative: number;
        tokenMovesCount: number;
        lastInteractionAtMs: number | null;
      }
    >();
    const launchedCoins: LaunchedCoinInfo[] = [];
    const hourCounts = new Array<number>(24).fill(0);
    let swapsCount = 0;
    let transfersCount = 0;
    let activityCount = 0;
    let lastActiveAtMs: number | null = null;
    let firstFunder: FirstFunderInfo | null = null;

    const recordCounter = (
      addr: string,
      label: string | null,
      isContract: boolean,
      inEth: number,
      outEth: number,
      tokenMove: boolean,
      tsMs: number | null
    ) => {
      const lower = addr.toLowerCase();
      if (!lower || lower === address || lower === "0x0000000000000000000000000000000000000000") return;
      const exLabel = KNOWN_EVM_EXCHANGES[lower] ?? (looksLikeExchangeLabel(label) ? label! : null);
      // Skip non-exchange contracts (routers/pools) so only personal wallets & exchanges remain
      if (isContract && !exLabel) return;

      const cur = counterMap.get(lower) ?? {
        label: exLabel ?? label,
        isExchange: Boolean(exLabel),
        interactionsCount: 0,
        inflowNative: 0,
        outflowNative: 0,
        tokenMovesCount: 0,
        lastInteractionAtMs: null
      };
      cur.interactionsCount += 1;
      cur.inflowNative += inEth;
      cur.outflowNative += outEth;
      if (tokenMove) cur.tokenMovesCount += 1;
      if (tsMs && (!cur.lastInteractionAtMs || tsMs > cur.lastInteractionAtMs)) {
        cur.lastInteractionAtMs = tsMs;
      }
      counterMap.set(lower, cur);
    };

    const items = bsTxs?.items ?? [];
    if (items.length > 0) {
      if (items[0].timestamp) lastActiveAtMs = Date.parse(items[0].timestamp);

      for (const tx of items) {
        const tsMs = tx.timestamp ? Date.parse(tx.timestamp) : null;
        const fromAddr = tx.from?.hash?.toLowerCase() ?? "";
        const toAddr = tx.to?.hash?.toLowerCase() ?? "";
        const valEth = tx.value ? atomicToNumber(BigInt(tx.value), 18) : 0;

        // Detect contract / coin launches across ALL history returned!
        if (
          tx.created_contract?.hash ||
          tx.transaction_types?.includes("contract_creation")
        ) {
          launchedCoins.push({
            name: tx.created_contract?.name ?? "Smart Contract / Token",
            symbol: "CA",
            address: tx.created_contract?.hash ?? "",
            mcUsd: 0,
            graduated: false,
            twitter: null,
            createdAtMs: tsMs
          });
        }

        if (tsMs && tsMs < cutoffMs) continue;
        activityCount += 1;
        if (tsMs) hourCounts[new Date(tsMs).getUTCHours()] += 1;

        const isSwapOrContract =
          Boolean(tx.to?.is_contract) || Boolean(tx.transaction_types?.includes("contract_call"));
        if (isSwapOrContract) swapsCount += 1;
        else transfersCount += 1;

        if (fromAddr === address && toAddr) {
          recordCounter(
            toAddr,
            tx.to?.name ?? tx.to?.ens_domain_name ?? null,
            Boolean(tx.to?.is_contract),
            0,
            valEth,
            false,
            tsMs
          );
        } else if (toAddr === address && fromAddr) {
          recordCounter(
            fromAddr,
            tx.from?.name ?? tx.from?.ens_domain_name ?? null,
            Boolean(tx.from?.is_contract),
            valEth,
            0,
            false,
            tsMs
          );
        }
      }

      // First funder check from oldest visible item if wallet isn't massive
      if (items.length < 50) {
        for (let i = items.length - 1; i >= 0; i--) {
          const tx = items[i];
          const toAddr = tx.to?.hash?.toLowerCase();
          const fromAddr = tx.from?.hash?.toLowerCase();
          const valEth = tx.value ? atomicToNumber(BigInt(tx.value), 18) : 0;
          if (toAddr === address && fromAddr && valEth > 0) {
            firstFunder = {
              address: fromAddr,
              label: KNOWN_EVM_EXCHANGES[fromAddr] ?? tx.from?.name ?? null,
              amountNative: valEth,
              timestampMs: tx.timestamp ? Date.parse(tx.timestamp) : null
            };
            break;
          }
        }
      }

      for (const tt of bsTokenTransfers?.items ?? []) {
        const tsMs = tt.timestamp ? Date.parse(tt.timestamp) : null;
        if (tsMs && tsMs < cutoffMs) continue;
        const fromAddr = tt.from?.hash?.toLowerCase() ?? "";
        const toAddr = tt.to?.hash?.toLowerCase() ?? "";
        if (fromAddr === address && toAddr) {
          recordCounter(toAddr, tt.to?.name ?? null, Boolean(tt.to?.is_contract), 0, 0, true, tsMs);
        } else if (toAddr === address && fromAddr) {
          recordCounter(fromAddr, tt.from?.name ?? null, Boolean(tt.from?.is_contract), 0, 0, true, tsMs);
        }
      }
    } else if (chain === "base" && this.config.alchemyApiKey) {
      // Fallback to Alchemy Asset Transfers on Base when configured
      const alch = await this.fetchAlchemyBaseTransfers(address, days);
      activityCount = alch.totalCount;
      lastActiveAtMs = alch.lastActiveAtMs;
      swapsCount = alch.swapsCount;
      transfersCount = alch.transfersCount;
      for (const c of alch.counterparties) {
        recordCounter(c.address, null, false, c.inEth, c.outEth, c.tokenMoves > 0, c.lastMs);
      }
      if (alch.note) notes.push(alch.note);
    } else if (!bsTxs && chain === "base") {
      notes.push(
        "Base public history server is offline right now (balance, .base.eth & Twitter still checked!). Cross-chain activity on Ethereum/Robinhood is shown below."
      );
    }

    const rawBuddies = [...counterMap.entries()]
      .sort((a, b) => {
        if (a[1].isExchange !== b[1].isExchange) return a[1].isExchange ? 1 : -1;
        if (b[1].interactionsCount !== a[1].interactionsCount) {
          return b[1].interactionsCount - a[1].interactionsCount;
        }
        return b[1].inflowNative + b[1].outflowNative - (a[1].inflowNative + a[1].outflowNative);
      })
      .slice(0, 8);

    const buddies: ConnectedBuddyReport[] = rawBuddies.map(([addr, st]) => ({
      address: addr,
      label: st.label,
      isExchangeOrApp: st.isExchange,
      interactionsCount: st.interactionsCount,
      inflowNative: st.inflowNative,
      outflowNative: st.outflowNative,
      directionTag: formatDirectionTag(st.inflowNative, st.outflowNative, st.tokenMovesCount),
      tokenMovesCount: st.tokenMovesCount,
      lastInteractionAtMs: st.lastInteractionAtMs,
      activityCount: null,
      lastActiveAtMs: null,
      swapsCount: null,
      nativeBalance: null,
      nativeUsd: null,
      topHolding: null,
      totalHoldingsUsd: null,
      launchedCount: 0,
      launchedCoins: [],
      identity: emptyIdentity(),
      roleBadge: st.isExchange ? "🏦 Exchange" : "🔗 Connected Wallet",
      tradingStyle: null,
      hop2Targets: []
    }));

    // Enrich top 4 personal buddy wallets on this EVM chain
    const personalBuddies = buddies.filter((b) => !b.isExchangeOrApp).slice(0, 4);
    for (let idx = 0; idx < personalBuddies.length; idx++) {
      await this.enrichEvmBuddy(chain, bs.host, personalBuddies[idx], ethPriceUsd, cutoffMs, idx < 2, address);
    }

    return {
      chain,
      address,
      days,
      roleSummary: classifyWalletRole({
        isExchange: Boolean(KNOWN_EVM_EXCHANGES[address]),
        launchedCount: launchedCoins.length,
        swapsCount,
        activityCount,
        nativeBalance: balanceNative
      }),
      balanceNative,
      nativeBalanceStr: formatExactUnits(balWei, 18, 6),
      nativeSymbol: "ETH",
      nativeUsd,
      topHoldings: holdings.slice(0, 6),
      totalHoldingsUsd,
      activityCount,
      swapsCount,
      transfersCount,
      lastActiveAtMs,
      peakHoursUtc: summarizePeakHours(hourCounts),
      tradingStyle:
        swapsCount >= 12
          ? "Frequent active EVM trader"
          : swapsCount >= 3
            ? "Selective trader"
            : transfersCount > 0
              ? "Transfer / Storage vault"
              : null,
      firstFunder,
      identity,
      launchedCount: launchedCoins.length,
      launchedCoins: launchedCoins.slice(0, 6),
      connectedWallets: buddies,
      crossChainGlances: [],
      notes,
      generatedAt: now
    };
  }

  private async enrichEvmBuddy(
    chain: EvmChainKey,
    bsHost: string,
    buddy: ConnectedBuddyReport,
    ethPriceUsd: number,
    cutoffMs: number,
    checkHop2: boolean,
    excludeMain: string
  ): Promise<void> {
    try {
      const [balWei, bsAddr, bsTxs, bsToks, identity] = await Promise.all([
        this.evmClients.getNativeBalance(chain, buddy.address),
        this.fetchBlockscoutJson<{ coin_balance?: string; ens_domain_name?: string | null }>(
          `${bsHost}/api/v2/addresses/${buddy.address}`
        ),
        this.fetchBlockscoutJson<{ items?: BlockscoutTxItem[] }>(
          `${bsHost}/api/v2/addresses/${buddy.address}/transactions`
        ),
        this.fetchBlockscoutJson<BlockscoutTokenBalanceItem[]>(
          `${bsHost}/api/v2/addresses/${buddy.address}/token-balances`
        ),
        this.lookupIdentity(chain, buddy.address)
      ]);

      const wei = balWei ?? (bsAddr?.coin_balance ? BigInt(bsAddr.coin_balance) : 0n);
      buddy.nativeBalance = atomicToNumber(wei, 18);
      buddy.nativeUsd = buddy.nativeBalance * ethPriceUsd;
      buddy.identity = identity;
      if (bsAddr?.ens_domain_name && !buddy.identity.domains.includes(bsAddr.ens_domain_name)) {
        buddy.identity.domains.push(bsAddr.ens_domain_name);
      }
      if (!buddy.label) {
        buddy.label = buddy.identity.domains[0] ?? null;
      }

      let tokenUsdSum = 0;
      if (Array.isArray(bsToks) && bsToks.length > 0) {
        const sorted = [...bsToks].sort((a, b) => {
          const va =
            atomicToNumber(BigInt(a.value || "0"), Number(a.token?.decimals ?? 18)) *
            Number(a.token?.exchange_rate ?? 0);
          const vb =
            atomicToNumber(BigInt(b.value || "0"), Number(b.token?.decimals ?? 18)) *
            Number(b.token?.exchange_rate ?? 0);
          return vb - va;
        });
        for (const t of sorted) {
          tokenUsdSum +=
            atomicToNumber(BigInt(t.value || "0"), Number(t.token?.decimals ?? 18)) *
            Number(t.token?.exchange_rate ?? 0);
        }
        const top = sorted[0];
        if (top?.token?.symbol && top.value) {
          const amt = atomicToNumber(BigInt(top.value), Number(top.token.decimals ?? 18));
          buddy.topHolding = `$${top.token.symbol} (${amt >= 100 ? Math.round(amt) : amt.toPrecision(3)})`;
        }
      }
      buddy.totalHoldingsUsd = buddy.nativeUsd + tokenUsdSum;

      const items = bsTxs?.items ?? [];
      if (items[0]?.timestamp) buddy.lastActiveAtMs = Date.parse(items[0].timestamp);

      let actCount = 0;
      let swaps = 0;
      const launched: LaunchedCoinInfo[] = [];
      const hop2Map = new Map<string, { label: string | null; count: number; inC: number; outC: number }>();

      for (const tx of items) {
        const tsMs = tx.timestamp ? Date.parse(tx.timestamp) : null;
        if (tx.created_contract?.hash || tx.transaction_types?.includes("contract_creation")) {
          launched.push({
            name: tx.created_contract?.name ?? "Smart Contract / Token",
            symbol: "CA",
            address: tx.created_contract?.hash ?? "",
            mcUsd: 0,
            graduated: false,
            twitter: null,
            createdAtMs: tsMs
          });
        }
        if (tsMs && tsMs < cutoffMs) continue;
        actCount += 1;
        if (tx.to?.is_contract || tx.transaction_types?.includes("contract_call")) swaps += 1;

        if (checkHop2 && !tx.to?.is_contract && !tx.from?.is_contract) {
          const from = tx.from?.hash?.toLowerCase();
          const to = tx.to?.hash?.toLowerCase();
          const other = from === buddy.address ? to : from;
          if (other && other !== buddy.address && other !== excludeMain) {
            const cur = hop2Map.get(other) ?? {
              label:
                KNOWN_EVM_EXCHANGES[other] ??
                (from === buddy.address ? tx.to?.name : tx.from?.name) ??
                null,
              count: 0,
              inC: 0,
              outC: 0
            };
            cur.count += 1;
            if (from === buddy.address) cur.outC += 1;
            else cur.inC += 1;
            hop2Map.set(other, cur);
          }
        }
      }

      buddy.activityCount = actCount;
      buddy.swapsCount = swaps;
      buddy.launchedCount = launched.length;
      buddy.launchedCoins = launched.slice(0, 4);
      buddy.roleBadge = classifyWalletRole({
        isExchange: buddy.isExchangeOrApp,
        launchedCount: buddy.launchedCount,
        swapsCount: swaps,
        activityCount: actCount,
        nativeBalance: buddy.nativeBalance
      });
      buddy.tradingStyle =
        swaps >= 8 ? "Frequent trader" : swaps >= 2 ? "Active trader" : "Transfer / storage wallet";

      if (checkHop2 && hop2Map.size > 0) {
        buddy.hop2Targets = [...hop2Map.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 2)
          .map(([addr, s]) => ({
            address: addr,
            label: s.label,
            count: s.count,
            direction: s.inC > 0 && s.outC > 0 ? "both" : s.outC > 0 ? "out" : "in"
          }));
      }
    } catch {
      // Ignore partial buddy enrichment error
    }
  }

  private async probeEvmCrossChainGlances(address: string): Promise<CrossChainGlance[]> {
    const ethUsd = await this.market.getNativePriceUsd("ethereum").catch(() => 0);
    const probes = Object.entries(BLOCKSCOUT_HOSTS).map(async ([key, meta]): Promise<CrossChainGlance | null> => {
      try {
        const [addrJson, txJson] = await Promise.all([
          this.fetchBlockscoutJson<{ coin_balance?: string; exchange_rate?: string }>(
            `${meta.host}/api/v2/addresses/${address}`
          ),
          this.fetchBlockscoutJson<{ items?: Array<{ hash?: string }> }>(
            `${meta.host}/api/v2/addresses/${address}/transactions`
          )
        ]);
        let balNative = addrJson?.coin_balance ? atomicToNumber(BigInt(addrJson.coin_balance), 18) : 0;
        if (!addrJson && (key === "ethereum" || key === "base" || key === "robinhood")) {
          const rpcBal = await this.evmClients.getNativeBalance(key as EvmChainKey, address);
          if (rpcBal !== null) balNative = atomicToNumber(rpcBal, 18);
        }
        const rate = key === "polygon" ? Number(addrJson?.exchange_rate ?? 0) : ethUsd;
        const txCount = txJson?.items?.length ?? 0;
        return {
          chainKey: key,
          chainLabel: meta.label,
          emoji: meta.emoji,
          balanceNative: balNative,
          nativeSymbol: key === "polygon" ? "POL" : "ETH",
          usdValue: balNative * rate,
          txCount,
          explorerUrl: `${meta.explorer}/address/${address}`
        };
      } catch {
        return null;
      }
    });

    const settled = await Promise.all(probes);
    return settled.filter((g): g is CrossChainGlance => g !== null && (g.balanceNative > 0 || g.txCount > 0));
  }

  private async fetchBlockscoutJson<T>(url: string): Promise<T | null> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6500) });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  private async fetchAlchemyBaseTransfers(
    address: string,
    days: number
  ): Promise<{
    totalCount: number;
    lastActiveAtMs: number | null;
    swapsCount: number;
    transfersCount: number;
    counterparties: Array<{
      address: string;
      inEth: number;
      outEth: number;
      tokenMoves: number;
      lastMs: number | null;
    }>;
    note?: string;
  }> {
    const url = `https://base-mainnet.g.alchemy.com/v2/${this.config.alchemyApiKey}`;
    const cutoffMs = Date.now() - days * 86_400_000;
    const map = new Map<
      string,
      { inEth: number; outEth: number; tokenMoves: number; lastMs: number | null }
    >();
    let totalCount = 0;
    let lastActiveAtMs: number | null = null;

    const runQuery = async (direction: "fromAddress" | "toAddress") => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "alchemy_getAssetTransfers",
          params: [
            {
              [direction]: address,
              category: ["external", "erc20"],
              withMetadata: true,
              maxCount: "0x64",
              order: "desc"
            }
          ]
        }),
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) return;
      const json = (await res.json()) as {
        result?: {
          transfers?: Array<{
            from?: string;
            to?: string;
            value?: number | null;
            asset?: string;
            category?: string;
            metadata?: { blockTimestamp?: string };
          }>;
        };
      };
      for (const t of json.result?.transfers ?? []) {
        const tsMs = t.metadata?.blockTimestamp ? Date.parse(t.metadata.blockTimestamp) : null;
        if (tsMs && (!lastActiveAtMs || tsMs > lastActiveAtMs)) lastActiveAtMs = tsMs;
        if (tsMs && tsMs < cutoffMs) continue;
        totalCount += 1;
        const other =
          direction === "fromAddress" ? t.to?.toLowerCase() : t.from?.toLowerCase();
        if (!other || other === address) continue;
        const cur = map.get(other) ?? { inEth: 0, outEth: 0, tokenMoves: 0, lastMs: null };
        if (t.category === "external" && typeof t.value === "number") {
          if (direction === "toAddress") cur.inEth += t.value;
          else cur.outEth += t.value;
        } else {
          cur.tokenMoves += 1;
        }
        if (tsMs && (!cur.lastMs || tsMs > cur.lastMs)) cur.lastMs = tsMs;
        map.set(other, cur);
      }
    };

    try {
      await Promise.all([runQuery("fromAddress"), runQuery("toAddress")]);
    } catch {
      return { totalCount: 0, lastActiveAtMs: null, swapsCount: 0, transfersCount: 0, counterparties: [] };
    }

    return {
      totalCount,
      lastActiveAtMs,
      swapsCount: 0,
      transfersCount: totalCount,
      counterparties: [...map.entries()].map(([addr, s]) => ({
        address: addr,
        ...s
      }))
    };
  }
}

interface BlockscoutTxItem {
  hash?: string;
  timestamp?: string;
  value?: string;
  transaction_types?: string[];
  created_contract?: { hash?: string; name?: string | null } | null;
  from?: {
    hash?: string;
    name?: string | null;
    ens_domain_name?: string | null;
    is_contract?: boolean;
  };
  to?: {
    hash?: string;
    name?: string | null;
    ens_domain_name?: string | null;
    is_contract?: boolean;
  } | null;
}

interface BlockscoutTokenTransferItem {
  timestamp?: string;
  from?: { hash?: string; name?: string | null; is_contract?: boolean };
  to?: { hash?: string; name?: string | null; is_contract?: boolean };
}

interface BlockscoutTokenBalanceItem {
  value?: string;
  token?: {
    address_hash?: string;
    symbol?: string;
    decimals?: string | number;
    exchange_rate?: string | number | null;
  };
}
