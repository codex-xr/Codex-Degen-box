import {
  createPublicClient,
  defineChain,
  erc20Abi,
  fallback,
  http,
  PublicClient,
  webSocket
} from "viem";
import { base } from "viem/chains";
import { ChainKey } from "../chains/registry.js";
import { AppConfig } from "../config.js";

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-mainnet.gateway.tatum.io"],
      webSocket: ["wss://feed.mainnet.chain.robinhood.com"]
    }
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" }
  }
});

export class EvmClientManager {
  private readonly baseClient: PublicClient;
  private readonly robinhoodClient: PublicClient;
  private readonly config: AppConfig;
  private readonly decimalsCache = new Map<string, number>();

  constructor(config: AppConfig) {
    this.config = config;
    this.baseClient = createPublicClient({
      chain: base,
      transport: http(config.baseRpcUrl, { timeout: 10_000, retryCount: 2 })
    }) as PublicClient;

    const rhTransports = [http(config.robinhoodRpcUrl, { timeout: 10_000, retryCount: 1 })];
    if (config.robinhoodFallbackRpcUrl && config.robinhoodFallbackRpcUrl !== config.robinhoodRpcUrl) {
      rhTransports.push(http(config.robinhoodFallbackRpcUrl, { timeout: 10_000, retryCount: 1 }));
    }

    this.robinhoodClient = createPublicClient({
      chain: robinhoodChain,
      transport: fallback(rhTransports)
    }) as PublicClient;
  }

  getClient(chain: "base" | "robinhood"): PublicClient {
    return chain === "base" ? this.baseClient : this.robinhoodClient;
  }

  createWsClient(chain: "base" | "robinhood"): PublicClient | null {
    const wsUrl = chain === "base" ? this.config.baseWsUrl : this.config.robinhoodWsUrl;
    if (!wsUrl) return null;
    try {
      return createPublicClient({
        chain: chain === "base" ? base : robinhoodChain,
        transport: webSocket(wsUrl, { reconnect: { attempts: 10, delay: 3000 } })
      }) as PublicClient;
    } catch {
      return null;
    }
  }

  async getTokenDecimals(chain: "base" | "robinhood", tokenAddress: string): Promise<number> {
    const cacheKey = `${chain}:${tokenAddress.toLowerCase()}`;
    const cached = this.decimalsCache.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const client = this.getClient(chain);
      const decimals = await client.readContract({
        address: tokenAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: "decimals"
      });
      const num = Number(decimals);
      if (Number.isInteger(num) && num >= 0 && num <= 36) {
        this.decimalsCache.set(cacheKey, num);
        return num;
      }
    } catch {
      // Fallback to Blockscout API on Robinhood Chain if RPC fails
      if (chain === "robinhood") {
        try {
          const res = await fetch(
            `https://robinhoodchain.blockscout.com/api/v2/tokens/${tokenAddress}`,
            { signal: AbortSignal.timeout(5000) }
          );
          if (res.ok) {
            const json = (await res.json()) as { decimals?: string | number };
            const num = Number(json.decimals);
            if (Number.isInteger(num) && num >= 0 && num <= 36) {
              this.decimalsCache.set(cacheKey, num);
              return num;
            }
          }
        } catch {
          // ignore
        }
      }
    }
    return 18;
  }

  async getTokenMetadata(
    chain: "base" | "robinhood",
    tokenAddress: string
  ): Promise<{ symbol: string; name: string; decimals: number } | null> {
    try {
      const client = this.getClient(chain);
      const addr = tokenAddress as `0x${string}`;
      const [symbol, name, decimals] = await Promise.all([
        client.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({ address: addr, abi: erc20Abi, functionName: "name" }),
        this.getTokenDecimals(chain, tokenAddress)
      ]);
      return { symbol: String(symbol), name: String(name), decimals };
    } catch {
      return null;
    }
  }

  isEvmChain(chain: ChainKey): chain is "base" | "robinhood" {
    return chain === "base" || chain === "robinhood";
  }
}
