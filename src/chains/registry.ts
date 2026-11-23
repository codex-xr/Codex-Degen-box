export type ChainKey = "solana" | "ethereum" | "base" | "robinhood";
export type EvmChainKey = "ethereum" | "base" | "robinhood";

export const EVM_CHAIN_KEYS: EvmChainKey[] = ["ethereum", "base", "robinhood"];

export interface ChainSpec {
  key: ChainKey;
  name: string;
  shortBadge: string;
  emoji: string;
  vm: "svm" | "evm";
  evmChainId: number | null;
  dexScreenerChainId: string;
  goPlusChainId: string;
  nativeSymbol: string;
  nativeDecimals: number;
  wrappedNativeAddress: string;
  knownStableAddresses: string[];
  explorerBaseUrl: string;
  txPathPrefix: string;
  tokenPathPrefix: string;
  addressPathPrefix: string;
  defaultBuyPresets: string[];
  defaultGasFeeNative: string;
  accentHex: string;
}

export const CHAINS: Record<ChainKey, ChainSpec> = {
  solana: {
    key: "solana",
    name: "Solana",
    shortBadge: "SOL",
    emoji: "🟣",
    vm: "svm",
    evmChainId: null,
    dexScreenerChainId: "solana",
    goPlusChainId: "solana",
    nativeSymbol: "SOL",
    nativeDecimals: 9,
    wrappedNativeAddress: "So11111111111111111111111111111111111111112",
    knownStableAddresses: [
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
    ],
    explorerBaseUrl: "https://solscan.io",
    txPathPrefix: "/tx/",
    tokenPathPrefix: "/token/",
    addressPathPrefix: "/account/",
    defaultBuyPresets: ["0.1", "0.5", "1", "5"],
    defaultGasFeeNative: "0.001",
    accentHex: "#9945FF"
  },
  ethereum: {
    key: "ethereum",
    name: "Ethereum",
    shortBadge: "ETH",
    emoji: "⚪",
    vm: "evm",
    evmChainId: 1,
    dexScreenerChainId: "ethereum",
    goPlusChainId: "1",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    wrappedNativeAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    knownStableAddresses: [
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "0xdAC17F958D2ee523a2206206994597C13D831ec7"
    ],
    explorerBaseUrl: "https://eth.blockscout.com",
    txPathPrefix: "/tx/",
    tokenPathPrefix: "/token/",
    addressPathPrefix: "/address/",
    defaultBuyPresets: ["0.01", "0.05", "0.1", "0.5"],
    defaultGasFeeNative: "0.0005",
    accentHex: "#627EEA"
  },
  base: {
    key: "base",
    name: "Base",
    shortBadge: "BASE",
    emoji: "🔵",
    vm: "evm",
    evmChainId: 8453,
    dexScreenerChainId: "base",
    goPlusChainId: "8453",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    wrappedNativeAddress: "0x4200000000000000000000000000000000000006",
    knownStableAddresses: [
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA"
    ],
    explorerBaseUrl: "https://basescan.org",
    txPathPrefix: "/tx/",
    tokenPathPrefix: "/token/",
    addressPathPrefix: "/address/",
    defaultBuyPresets: ["0.01", "0.05", "0.1", "0.5"],
    defaultGasFeeNative: "0.00005",
    accentHex: "#0052FF"
  },
  robinhood: {
    key: "robinhood",
    name: "Robinhood Chain",
    shortBadge: "HOOD",
    emoji: "🟢",
    vm: "evm",
    evmChainId: 4663,
    dexScreenerChainId: "robinhood",
    goPlusChainId: "4663",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    wrappedNativeAddress: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    knownStableAddresses: [],
    explorerBaseUrl: "https://robinhoodchain.blockscout.com",
    txPathPrefix: "/tx/",
    tokenPathPrefix: "/token/",
    addressPathPrefix: "/address/",
    defaultBuyPresets: ["0.01", "0.05", "0.1", "0.5"],
    defaultGasFeeNative: "0.00005",
    accentHex: "#00C805"
  }
};

export const CHAIN_LIST: ChainSpec[] = [CHAINS.solana, CHAINS.ethereum, CHAINS.base, CHAINS.robinhood];

export function isChainKey(value: string): value is ChainKey {
  return value === "solana" || value === "ethereum" || value === "base" || value === "robinhood";
}

export function isEvmChainKey(value: string): value is EvmChainKey {
  return value === "ethereum" || value === "base" || value === "robinhood";
}

export function getChain(key: ChainKey): ChainSpec {
  return CHAINS[key];
}

export function normalizeAddress(chain: ChainKey, address: string): string {
  const trimmed = address.trim();
  if (CHAINS[chain].vm === "evm") {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

export function isValidAddressFormat(chain: ChainKey, address: string): boolean {
  const trimmed = address.trim();
  if (CHAINS[chain].vm === "evm") {
    return /^0x[a-fA-F0-9]{40}$/.test(trimmed);
  }
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);
}

export function detectChainFromAddress(address: string): ChainKey | null {
  const trimmed = address.trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) return "solana";
  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return null; // Could be Ethereum, Base, or Robinhood
  return null;
}

export function explorerAddressUrl(chain: ChainKey, address: string): string {
  const c = CHAINS[chain];
  return `${c.explorerBaseUrl}${c.addressPathPrefix}${address}`;
}

export function shortAddress(address: string, left = 6, right = 4): string {
  if (address.length <= left + right + 3) return address;
  return `${address.slice(0, left)}...${address.slice(-right)}`;
}

export function explorerTxUrl(chain: ChainKey, txHash: string): string {
  const c = CHAINS[chain];
  return `${c.explorerBaseUrl}${c.txPathPrefix}${txHash}`;
}

export function explorerTokenUrl(chain: ChainKey, address: string): string {
  const c = CHAINS[chain];
  return `${c.explorerBaseUrl}${c.tokenPathPrefix}${address}`;
}
