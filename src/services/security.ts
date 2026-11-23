import { ChainKey, CHAINS, EvmChainKey, normalizeAddress } from "../chains/registry.js";

export type RiskLevel = "safe" | "warning" | "danger" | "unknown";

export interface TokenSecurityReport {
  chain: ChainKey;
  address: string;
  riskLevel: RiskLevel;
  isHoneypot: boolean;
  cannotBuy: boolean;
  cannotSellAll: boolean;
  buyTaxBps: number;
  sellTaxBps: number;
  mintable: boolean;
  freezable: boolean;
  top10Pct: number | null;
  warnings: string[];
  source: string;
  checkedAt: number;
}

export class SecurityService {
  private readonly cache = new Map<string, TokenSecurityReport>();

  async checkToken(chain: ChainKey, address: string, maxAgeMs = 60_000): Promise<TokenSecurityReport> {
    const norm = normalizeAddress(chain, address);
    const cacheKey = `${chain}:${norm}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.checkedAt <= maxAgeMs) {
      return cached;
    }

    const report =
      chain === "solana"
        ? await this.checkSolanaToken(address)
        : await this.checkEvmToken(chain, norm);

    this.cache.set(cacheKey, report);
    return report;
  }

  private async checkEvmToken(chain: EvmChainKey, address: string): Promise<TokenSecurityReport> {
    const goPlusChainId = CHAINS[chain].goPlusChainId;
    const warnings: string[] = [];
    let isHoneypot = false;
    let cannotBuy = false;
    let cannotSellAll = false;
    let buyTaxBps = 0;
    let sellTaxBps = 0;
    let mintable = false;
    let top10Pct: number | null = null;
    let source = "goplus";

    try {
      const res = await fetch(
        `https://api.gopluslabs.io/api/v1/token_security/${goPlusChainId}?contract_addresses=${address}`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (res.ok) {
        const data = (await res.json()) as {
          code?: number;
          result?: Record<string, Record<string, unknown>>;
        };
        const info = data.result?.[address.toLowerCase()];
        if (info) {
          isHoneypot = String(info.is_honeypot ?? "0") === "1";
          cannotBuy = String(info.cannot_buy ?? "0") === "1";
          cannotSellAll = String(info.cannot_sell_all ?? "0") === "1";
          mintable = String(info.is_mintable ?? "0") === "1";
          buyTaxBps = Math.round(Math.max(0, Number(info.buy_tax ?? 0)) * 10_000);
          sellTaxBps = Math.round(Math.max(0, Number(info.sell_tax ?? 0)) * 10_000);

          if (Array.isArray(info.holders)) {
            const sum = (info.holders as Array<{ percent?: string | number }>)
              .slice(0, 10)
              .reduce((acc, h) => acc + Number(h.percent ?? 0) * 100, 0);
            if (Number.isFinite(sum) && sum > 0) top10Pct = Math.min(100, sum);
          }

          if (isHoneypot) warnings.push("Honeypot detected (cannot sell)");
          if (cannotBuy) warnings.push("Buying currently blocked");
          if (cannotSellAll) warnings.push("Cannot sell 100% of balance");
          if (mintable) warnings.push("Owner can mint extra tokens");
          if (String(info.transfer_pausable ?? "0") === "1") warnings.push("Transfers can be paused");
          if (String(info.is_open_source ?? "1") === "0") warnings.push("Contract code is not verified");
          if (sellTaxBps >= 1000) warnings.push(`High sell tax (${(sellTaxBps / 100).toFixed(1)}%)`);
          if (buyTaxBps >= 1000) warnings.push(`High buy tax (${(buyTaxBps / 100).toFixed(1)}%)`);
          if (top10Pct !== null && top10Pct >= 50) {
            warnings.push(`Top 10 holders own ${top10Pct.toFixed(1)}%`);
          }
        } else {
          source = "unindexed";
        }
      }
    } catch {
      source = "unavailable";
    }

    let riskLevel: RiskLevel = "safe";
    if (isHoneypot || cannotSellAll || sellTaxBps >= 5000) {
      riskLevel = "danger";
    } else if (warnings.length > 0) {
      riskLevel = "warning";
    } else if (source === "unavailable" || source === "unindexed") {
      riskLevel = "unknown";
    }

    return {
      chain,
      address,
      riskLevel,
      isHoneypot,
      cannotBuy,
      cannotSellAll,
      buyTaxBps,
      sellTaxBps,
      mintable,
      freezable: false,
      top10Pct,
      warnings,
      source,
      checkedAt: Date.now()
    };
  }

  private async checkSolanaToken(address: string): Promise<TokenSecurityReport> {
    const warnings: string[] = [];
    let isHoneypot = false;
    let cannotSellAll = false;
    let mintable = false;
    let freezable = false;
    let top10Pct: number | null = null;
    let riskLevel: RiskLevel = "unknown";
    let source = "rugcheck";

    const [rcRes, gpRes] = await Promise.allSettled([
      fetch(`https://api.rugcheck.xyz/v1/tokens/${address}/report/summary`, {
        signal: AbortSignal.timeout(6000)
      }),
      fetch(
        `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}`,
        { signal: AbortSignal.timeout(6000) }
      )
    ]);

    if (rcRes.status === "fulfilled" && rcRes.value.ok) {
      try {
        const rc = (await rcRes.value.json()) as {
          score?: number;
          rugged?: boolean;
          risks?: Array<{ name?: string; level?: string; description?: string }>;
        };
        if (rc.rugged) {
          isHoneypot = true;
          riskLevel = "danger";
          warnings.push("Flagged as RUGGED on RugCheck");
        }
        const risks = rc.risks ?? [];
        for (const r of risks.slice(0, 5)) {
          const text = r.name || r.description || "Risk flag";
          warnings.push(text);
          if (r.level === "danger") riskLevel = "danger";
          else if (r.level === "warn" && riskLevel !== "danger") riskLevel = "warning";
        }
        if (risks.length === 0 && !rc.rugged) {
          riskLevel = "safe";
        }
      } catch {
        // ignore parse errors
      }
    }

    if (gpRes.status === "fulfilled" && gpRes.value.ok) {
      try {
        const gp = (await gpRes.value.json()) as {
          result?: Record<string, Record<string, unknown>>;
        };
        const info = gp.result?.[address];
        if (info) {
          source = warnings.length > 0 ? "rugcheck+goplus" : "goplus";
          const mintAuth = info.mintable as { status?: string } | undefined;
          const freezeAuth = info.freezable as { status?: string } | undefined;
          if (mintAuth?.status === "1") {
            mintable = true;
            if (!warnings.some((w) => w.toLowerCase().includes("mint"))) {
              warnings.push("Mint authority enabled");
            }
          }
          if (freezeAuth?.status === "1") {
            freezable = true;
            // Freeze authority makes a token high-risk for copy-filtering (riskLevel="danger"),
            // but does NOT mean the token is already rugged/unsellable when liquidity is live.
            if (!warnings.some((w) => w.toLowerCase().includes("freeze"))) {
              warnings.push("Freeze authority enabled");
            }
          }
          if (Array.isArray(info.holders)) {
            const sum = (info.holders as Array<{ percent?: string | number }>)
              .slice(0, 10)
              .reduce((acc, h) => acc + Number(h.percent ?? 0) * 100, 0);
            if (Number.isFinite(sum) && sum > 0) top10Pct = Math.min(100, sum);
          }
          if (riskLevel === "unknown") {
            riskLevel = warnings.length > 0 ? "warning" : "safe";
          }
        }
      } catch {
        // ignore
      }
    }

    if (freezable || isHoneypot) riskLevel = "danger";

    return {
      chain: "solana",
      address,
      riskLevel,
      isHoneypot,
      cannotBuy: false,
      cannotSellAll,
      buyTaxBps: 0,
      sellTaxBps: 0,
      mintable,
      freezable,
      top10Pct,
      warnings: [...new Set(warnings)].slice(0, 5),
      source,
      checkedAt: Date.now()
    };
  }
}
