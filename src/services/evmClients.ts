import {
  createPublicClient,
  defineChain,
  erc20Abi,
  fallback,
  http,
  PublicClient,
  webSocket
} from "viem";
import { base, mainnet } from "viem/chains";
import { ChainKey, EvmChainKey, isEvmChainKey } from "../chains/registry.js";
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
  private readonly ethClient: PublicClient;
  private readonly baseClient: PublicClient;
  private readonly robinhoodClient: PublicClient;
  private readonly config: AppConfig;
  private readonly decimalsCache = new Map<string, number>();

  constructor(config: AppConfig) {
    this.config = config;

    // PublicNode (Allnodes) blocks eth_getLogs without a contract address and mainnet.base.org
    // aggressively rate-limits log scans; promote getLogs-friendly RPCs first when those defaults are active.
    const ethUrls = this.buildRpcList(config.ethRpcUrl, [
      "https://eth.drpc.org",
      "https://ethereum-rpc.publicnode.com"
    ], ["publicnode.com"]);
    this.ethClient = createPublicClient({
      chain: mainnet,
      transport: fallback(ethUrls.map((url) => http(url, { timeout: 10_000, retryCount: 1 })))
    }) as PublicClient;

    const baseUrls = this.buildRpcList(config.baseRpcUrl, [
      "https://base.drpc.org",
      "https://1rpc.io/base",
      "https://mainnet.base.org"
    ], ["mainnet.base.org", "publicnode.com"]);
    this.baseClient = createPublicClient({
      chain: base,
      transport: fallback(baseUrls.map((url) => http(url, { timeout: 10_000, retryCount: 1 })))
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

  private buildRpcList(configuredUrl: string, fallbacks: string[], demoteHosts: string[]): string[] {
    const cleaned = configuredUrl.trim();
    const isRestrictedPublic = cleaned && demoteHosts.some((h) => cleaned.includes(h));
    const ordered = isRestrictedPublic
      ? [...fallbacks, cleaned]
      : [cleaned, ...fallbacks];
    return [...new Set(ordered.filter(Boolean))];
  }

  getClient(chain: EvmChainKey): PublicClient {
    if (chain === "ethereum") return this.ethClient;
    return chain === "base" ? this.baseClient : this.robinhoodClient;
  }

  createWsClient(chain: EvmChainKey): PublicClient | null {
    const wsUrl =
      chain === "ethereum"
        ? this.config.ethWsUrl
        : chain === "base"
          ? this.config.baseWsUrl
          : this.config.robinhoodWsUrl;
    if (!wsUrl) return null;
    try {
      const viemChain = chain === "ethereum" ? mainnet : chain === "base" ? base : robinhoodChain;
      return createPublicClient({
        chain: viemChain,
        transport: webSocket(wsUrl, { reconnect: { attempts: 10, delay: 3000 } })
      }) as PublicClient;
    } catch {
      return null;
    }
  }

  async getNativeBalance(chain: EvmChainKey, address: string): Promise<bigint | null> {
    try {
      return await this.getClient(chain).getBalance({ address: address as `0x${string}` });
    } catch {
      return null;
    }
  }

  async getTokenDecimals(chain: EvmChainKey, tokenAddress: string): Promise<number> {
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
      // Fallback to Blockscout API on Robinhood / Ethereum if RPC fails
      const bsHost =
        chain === "robinhood"
          ? "https://robinhoodchain.blockscout.com"
          : chain === "ethereum"
            ? "https://eth.blockscout.com"
            : null;
      if (bsHost) {
        try {
          const res = await fetch(`${bsHost}/api/v2/tokens/${tokenAddress}`, {
            signal: AbortSignal.timeout(5000)
          });
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
    chain: EvmChainKey,
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

  isEvmChain(chain: ChainKey): chain is EvmChainKey {
    return isEvmChainKey(chain);
  }
}
