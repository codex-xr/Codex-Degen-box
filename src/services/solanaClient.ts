import { Connection, PublicKey } from "@solana/web3.js";
import { AppConfig } from "../config.js";

export class SolanaClientManager {
  readonly connection: Connection;
  private readonly decimalsCache = new Map<string, number>();

  constructor(config: AppConfig) {
    this.connection = new Connection(config.solanaRpcUrl, {
      commitment: "confirmed",
      wsEndpoint: config.solanaWsUrl || undefined
    });
  }

  async getTokenDecimals(mintAddress: string): Promise<number> {
    const cached = this.decimalsCache.get(mintAddress);
    if (cached !== undefined) return cached;

    try {
      const info = await this.connection.getParsedAccountInfo(new PublicKey(mintAddress));
      const data = info.value?.data;
      if (data && typeof data === "object" && "parsed" in data) {
        const parsed = data.parsed as { info?: { decimals?: number } };
        const dec = parsed?.info?.decimals;
        if (typeof dec === "number" && dec >= 0 && dec <= 18) {
          this.decimalsCache.set(mintAddress, dec);
          return dec;
        }
      }
    } catch {
      // Fallback: Pump.fun and most SPL meme coins use 6 or 9 decimals
    }
    return 6;
  }
}
