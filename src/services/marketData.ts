import { ChainKey, CHAINS, isChainKey, normalizeAddress } from "../chains/registry.js";
import { AppConfig } from "../config.js";
import { EvmClientManager } from "./evmClients.js";
import { SolanaClientManager } from "./solanaClient.js";

const CHAINLINK_AGGREGATOR_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" }
    ]
  }
] as const;

const CHAINLINK_ETH_USD_BASE = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" as const;
const CHAINLINK_ETH_USD_ETH = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" as const;
const CHAINLINK_SOL_USD_ETH = "0x4ffC43a60e009B551865A93d232E33Fce9f01507" as const;

async function firstPositivePrice(tasks: Array<() => Promise<number>>): Promise<number> {
  try {
    return await Promise.any(
      tasks.map(async (fn) => {
        const val = await fn();
        if (!Number.isFinite(val) || val <= 0) {
          throw new Error("Non-positive price");
        }
        return val;
      })
    );
  } catch {
    return 0;
  }
}

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
  private readonly pendingNativePrice = new Map<string, Promise<number>>();
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
    const assetKey = CHAINS[chain].nativeSymbol === "SOL" ? "SOL" : "ETH";
    const cached = this.nativePriceCache.get(assetKey);
    if (cached && Date.now() - cached.ts < 20_000) {
      return cached.price;
    }

    const inflight = this.pendingNativePrice.get(assetKey);
    if (inflight) return inflight;

    const job = (async () => {
      const price = await this.fetchNativePriceFresh(assetKey);
      if (price > 0) {
        this.nativePriceCache.set(assetKey, { price, ts: Date.now() });
        return price;
      }
      return cached?.price ?? 0;
    })().finally(() => {
      this.pendingNativePrice.delete(assetKey);
    });

    this.pendingNativePrice.set(assetKey, job);
    return job;
  }

  private async fetchNativePriceFresh(assetKey: "SOL" | "ETH"): Promise<number> {
    const wrapped =
      assetKey === "SOL"
        ? CHAINS.solana.wrappedNativeAddress
        : CHAINS.base.wrappedNativeAddress;
    const dexChain = assetKey === "SOL" ? "solana" : "base";

    const dexPrice = await this.fetchDexScreenerNativePrice(dexChain, wrapped);
    if (dexPrice > 0) return dexPrice;

    if (assetKey === "SOL") {
      return firstPositivePrice([
        () => this.fetchHeliusAssetPriceUsd(CHAINS.solana.wrappedNativeAddress),
        () => this.fetchGeckoTerminalPriceUsd("solana", CHAINS.solana.wrappedNativeAddress),
        () => this.fetchChainlinkUsd("ethereum", CHAINLINK_SOL_USD_ETH),
        () => this.fetchCoinGeckoPriceUsd("solana")
      ]);
    }

    return firstPositivePrice([
      () => this.fetchChainlinkUsd("base", CHAINLINK_ETH_USD_BASE),
      () => this.fetchChainlinkUsd("ethereum", CHAINLINK_ETH_USD_ETH),
      () => this.fetchGeckoTerminalPriceUsd("eth", CHAINS.ethereum.wrappedNativeAddress),
      () => this.fetchCoinGeckoPriceUsd("ethereum")
    ]);
  }

  private async fetchDexScreenerNativePrice(dexChain: string, wrapped: string): Promise<number> {
    try {
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/${dexChain}/${wrapped}`, {
        signal: AbortSignal.timeout(4000)
      });
      if (!res.ok) return 0;
      const pairs = (await res.json()) as DexScreenerPair[];
      if (!Array.isArray(pairs)) return 0;
      const valid = pairs
        .filter((p) => p?.baseToken?.address?.toLowerCase() === wrapped.toLowerCase() && Number(p.priceUsd) > 0)
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      return valid[0] ? Number(valid[0].priceUsd) : 0;
    } catch {
      return 0;
    }
  }

  private async fetchHeliusAssetPriceUsd(mint: string): Promise<number> {
    if (!this.config.heliusApiKey) return 0;
    try {
      const res = await fetch(this.config.solanaRpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: mint } }),
        signal: AbortSignal.timeout(4000)
      });
      if (!res.ok) return 0;
      const json = (await res.json()) as {
        result?: { token_info?: { price_info?: { price_per_token?: number } } };
      };
      const price = Number(json.result?.token_info?.price_info?.price_per_token ?? 0);
      return Number.isFinite(price) && price > 0 ? price : 0;
    } catch {
      return 0;
    }
  }

  private async fetchGeckoTerminalPriceUsd(network: string, address: string): Promise<number> {
    try {
      const tokenPath = network === "solana" ? address : address.toLowerCase();
      const res = await fetch(
        `https://api.geckoterminal.com/api/v2/simple/networks/${network}/token_price/${tokenPath}`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (!res.ok) return 0;
      const json = (await res.json()) as {
        data?: { attributes?: { token_prices?: Record<string, string> } };
      };
      const prices = json.data?.attributes?.token_prices ?? {};
      const val = Number(prices[address] ?? prices[address.toLowerCase()] ?? Object.values(prices)[0] ?? 0);
      return Number.isFinite(val) && val > 0 ? val : 0;
    } catch {
      return 0;
    }
  }

  private async fetchCoinGeckoPriceUsd(cgId: string): Promise<number> {
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (!res.ok) return 0;
      const data = (await res.json()) as Record<string, { usd?: number }>;
      const price = Number(data[cgId]?.usd ?? 0);
      return Number.isFinite(price) && price > 0 ? price : 0;
    } catch {
      return 0;
    }
  }

  private async fetchChainlinkUsd(chain: "ethereum" | "base", aggregatorAddress: `0x${string}`): Promise<number> {
    try {
      const client = this.evmClients.getClient(chain);
      const round = await Promise.race([
        client.readContract({
          address: aggregatorAddress,
          abi: CHAINLINK_AGGREGATOR_ABI,
          functionName: "latestRoundData"
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Chainlink timeout")), 4000))
      ]);
      const answer = Array.isArray(round) ? BigInt(round[1]) : 0n;
      if (answer <= 0n) return 0;
      const price = Number(answer) / 1e8;
      return Number.isFinite(price) && price > 0 ? price : 0;
    } catch {
      return 0;
    }
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
        if (!Array.isArray(pairs)) continue;
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
