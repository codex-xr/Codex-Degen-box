import { ChainKey, CHAINS, isChainKey, normalizeAddress } from "../chains/registry.js";
import { AppConfig } from "../config.js";
import { EvmClientManager } from "./evmClients.js";
import { SolanaClientManager } from "./solanaClient.js";

export interface TokenSnapshot {
  chain: ChainKey;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  pairAddress: string;
  dex: string;
  dexUrl: string;
  priceUsd: number;
  priceNative: number;
  nativePriceUsd: number;
  mcUsd: number;
  fdvUsd: number;
  liquidityUsd: number;
  volume5mUsd: number;
  volume1hUsd: number;
  volume24hUsd: number;
  txns5mBuys: number;
  txns5mSells: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange24h: number;
  pairCreatedAtMs: number | null;
  tokenAgeSec: number | null;
  imageUrl: string | null;
  fetchedAt: number;
}

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: {
    m5?: { buys?: number; sells?: number };
  };
  volume?: {
    m5?: number;
    h1?: number;
    h6?: number;
    h24?: number;
  };
  priceChange?: {
    m5?: number;
    h1?: number;
    h24?: number;
  };
  liquidity?: {
    usd?: number;
    base?: number;
    quote?: number;
  };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: { imageUrl?: string };
}

export class MarketDataService {
  private readonly config: AppConfig;
  private readonly evmClients: EvmClientManager;
  private readonly solanaClient: SolanaClientManager;
  private readonly nativePriceCache = new Map<string, { price: number; ts: number }>();
  private readonly snapshotCache = new Map<string, { snap: TokenSnapshot; ts: number }>();

  constructor(
    config: AppConfig,
    evmClients: EvmClientManager,
    solanaClient: SolanaClientManager
  ) {
    this.config = config;
    this.evmClients = evmClients;
    this.solanaClient = solanaClient;
  }

  async getNativePriceUsd(chain: ChainKey): Promise<number> {
    const assetKey = CHAINS[chain].nativeSymbol; // SOL or ETH
    const cached = this.nativePriceCache.get(assetKey);
    if (cached && Date.now() - cached.ts < 15_000) {
      return cached.price;
    }

    let price = 0;
    try {
      const wrapped =
        assetKey === "SOL"
          ? CHAINS.solana.wrappedNativeAddress
          : CHAINS.base.wrappedNativeAddress;
      const dexChain = assetKey === "SOL" ? "solana" : "base";
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/${dexChain}/${wrapped}`, {
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        const pairs = (await res.json()) as DexScreenerPair[];
        const valid = pairs
          .filter((p) => p.baseToken.address.toLowerCase() === wrapped.toLowerCase() && Number(p.priceUsd) > 0)
          .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
        if (valid[0]) {
          price = Number(valid[0].priceUsd);
        }
      }
    } catch {
      // Fallback below
    }

    if (price <= 0) {
      try {
        const cgId = assetKey === "SOL" ? "solana" : "ethereum";
        const res = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd`,
          { signal: AbortSignal.timeout(6000) }
        );
        if (res.ok) {
          const data = (await res.json()) as Record<string, { usd?: number }>;
          price = Number(data[cgId]?.usd ?? 0);
        }
      } catch {
        // Fallback to last known cached value if transient outage
      }
    }

    if (price > 0) {
      this.nativePriceCache.set(assetKey, { price, ts: Date.now() });
      return price;
    }
    return cached?.price ?? 0;
  }

  async lookupToken(
    chain: ChainKey | null,
    address: string,
    maxAgeMs = 4000
  ): Promise<TokenSnapshot[]> {
    const trimmed = address.trim();
    if (chain) {
      const norm = normalizeAddress(chain, trimmed);
      const cacheKey = `${chain}:${norm}`;
      const cached = this.snapshotCache.get(cacheKey);
      if (cached && Date.now() - cached.ts <= maxAgeMs) {
        return [cached.snap];
      }
    }

    const pairs = await this.fetchDexScreenerPairs(chain, trimmed);
    if (pairs.length === 0) return [];

    // Group best liquidity pair per supported chain
    const byChain = new Map<ChainKey, DexScreenerPair>();
    for (const pair of pairs) {
      const mappedChain = this.mapDexScreenerChain(pair.chainId);
      if (!mappedChain) continue;
      if (chain && mappedChain !== chain) continue;
      if (pair.baseToken.address.toLowerCase() !== trimmed.toLowerCase()) continue;

      const existing = byChain.get(mappedChain);
      const liq = pair.liquidity?.usd ?? 0;
      const existingLiq = existing?.liquidity?.usd ?? -1;
      if (!existing || liq > existingLiq) {
        byChain.set(mappedChain, pair);
      }
    }

    const snapshots: TokenSnapshot[] = [];
    for (const [foundChain, pair] of byChain.entries()) {
      const snap = await this.pairToSnapshot(foundChain, pair);
      if (snap) {
        this.snapshotCache.set(`${foundChain}:${normalizeAddress(foundChain, snap.address)}`, {
          snap,
          ts: Date.now()
        });
        snapshots.push(snap);
      }
    }

    return snapshots.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  }

  async getTokenSnapshot(
    chain: ChainKey,
    address: string,
    maxAgeMs = 4000
  ): Promise<TokenSnapshot | null> {
    const results = await this.lookupToken(chain, address, maxAgeMs);
    return results[0] ?? null;
  }

  async getBatchTokenSnapshots(
    chain: ChainKey,
    addresses: string[]
  ): Promise<Map<string, TokenSnapshot>> {
    const out = new Map<string, TokenSnapshot>();
    const unique = [...new Set(addresses.map((a) => normalizeAddress(chain, a)))];
    if (unique.length === 0) return out;

    const now = Date.now();
    const toFetch: string[] = [];
    for (const addr of unique) {
      const cached = this.snapshotCache.get(`${chain}:${addr}`);
      if (cached && now - cached.ts <= 3500) {
        out.set(addr, cached.snap);
      } else {
        toFetch.push(addr);
      }
    }

    const dexChain = CHAINS[chain].dexScreenerChainId;
    const chunkSize = 25;
    for (let i = 0; i < toFetch.length; i += chunkSize) {
      const chunk = toFetch.slice(i, i + chunkSize);
      try {
        const res = await fetch(
          `https://api.dexscreener.com/tokens/v1/${dexChain}/${chunk.join(",")}`,
          { signal: AbortSignal.timeout(7000) }
        );
        if (!res.ok) continue;
        const pairs = (await res.json()) as DexScreenerPair[];
        const bestByAddr = new Map<string, DexScreenerPair>();
        for (const p of pairs) {
          if (this.mapDexScreenerChain(p.chainId) !== chain) continue;
          const baseAddr = normalizeAddress(chain, p.baseToken.address);
          const prev = bestByAddr.get(baseAddr);
          if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? -1)) {
            bestByAddr.set(baseAddr, p);
          }
        }
        for (const [addr, pair] of bestByAddr.entries()) {
          const snap = await this.pairToSnapshot(chain, pair);
          if (snap) {
            out.set(addr, snap);
            this.snapshotCache.set(`${chain}:${addr}`, { snap, ts: Date.now() });
          }
        }
      } catch {
        // Ignore transient batch error
      }
    }

    return out;
  }

  private async fetchDexScreenerPairs(
    chain: ChainKey | null,
    address: string
  ): Promise<DexScreenerPair[]> {
    try {
      const url = chain
        ? `https://api.dexscreener.com/tokens/v1/${CHAINS[chain].dexScreenerChainId}/${address}`
        : `https://api.dexscreener.com/latest/dex/tokens/${address}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
      if (!res.ok) return [];
      const data = (await res.json()) as DexScreenerPair[] | { pairs?: DexScreenerPair[] | null };
      if (Array.isArray(data)) return data;
      return data.pairs ?? [];
    } catch {
      return [];
    }
  }

  private mapDexScreenerChain(chainId: string): ChainKey | null {
    const lower = chainId.toLowerCase();
    if (isChainKey(lower)) return lower;
    return null;
  }

  private async pairToSnapshot(
    chain: ChainKey,
    pair: DexScreenerPair
  ): Promise<TokenSnapshot | null> {
    const priceUsd = Number(pair.priceUsd ?? 0);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

    const nativePriceUsd = await this.getNativePriceUsd(chain);
    const priceNative =
      Number(pair.priceNative ?? 0) > 0
        ? Number(pair.priceNative)
        : nativePriceUsd > 0
          ? priceUsd / nativePriceUsd
          : 0;

    const tokenAddr = pair.baseToken.address;
    const decimals =
      chain === "solana"
        ? await this.solanaClient.getTokenDecimals(tokenAddr)
        : await this.evmClients.getTokenDecimals(chain, tokenAddr);

    const now = Date.now();
    const pairCreatedAtMs = pair.pairCreatedAt ? Number(pair.pairCreatedAt) : null;
    const tokenAgeSec =
      pairCreatedAtMs && pairCreatedAtMs > 0
        ? Math.max(0, Math.floor((now - pairCreatedAtMs) / 1000))
        : null;

    return {
      chain,
      address: tokenAddr,
      symbol: pair.baseToken.symbol || "UNKNOWN",
      name: pair.baseToken.name || pair.baseToken.symbol || "Unknown Token",
      decimals,
      pairAddress: pair.pairAddress,
      dex: pair.dexId || "dex",
      dexUrl: pair.url || "",
      priceUsd,
      priceNative,
      nativePriceUsd,
      mcUsd: Number(pair.marketCap ?? pair.fdv ?? 0),
      fdvUsd: Number(pair.fdv ?? pair.marketCap ?? 0),
      liquidityUsd: Number(pair.liquidity?.usd ?? 0),
      volume5mUsd: Number(pair.volume?.m5 ?? 0),
      volume1hUsd: Number(pair.volume?.h1 ?? 0),
      volume24hUsd: Number(pair.volume?.h24 ?? 0),
      txns5mBuys: Number(pair.txns?.m5?.buys ?? 0),
      txns5mSells: Number(pair.txns?.m5?.sells ?? 0),
      priceChange5m: Number(pair.priceChange?.m5 ?? 0),
      priceChange1h: Number(pair.priceChange?.h1 ?? 0),
      priceChange24h: Number(pair.priceChange?.h24 ?? 0),
      pairCreatedAtMs,
      tokenAgeSec,
      imageUrl: pair.info?.imageUrl ?? null,
      fetchedAt: now
    };
  }
}
