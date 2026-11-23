const SCALE = 10n ** 18n;

/**
 * Parses a decimal string into exact smallest integer units (atomic units) without float drift.
 * Supports inputs down to the smallest unit (e.g., 9 decimals for SOL, 18 for ETH).
 */
export function parseExactUnits(raw: string, decimals: number): bigint {
  const cleaned = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error(`Invalid amount "${raw}". Enter a positive number like 1.5 or 0.000000001.`);
  }

  const [wholePart, fracPart = ""] = cleaned.split(".");
  if (fracPart.length > decimals) {
    throw new Error(
      `Too many decimal places (${fracPart.length}). Maximum precision for this asset is ${decimals} decimals.`
    );
  }

  const paddedFrac = fracPart.padEnd(decimals, "0");
  const combined = `${wholePart}${paddedFrac}`.replace(/^0+/, "") || "0";
  return BigInt(combined);
}

/**
 * Formats atomic integer units back to a clean exact decimal string.
 * By default preserves every non-zero digit down to the lowest decimal.
 */
export function formatExactUnits(
  atomic: bigint,
  decimals: number,
  maxDisplayDecimals?: number
): string {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const str = abs.toString().padStart(decimals + 1, "0");
  const splitIdx = str.length - decimals;
  const whole = str.slice(0, splitIdx);
  let frac = decimals > 0 ? str.slice(splitIdx) : "";

  if (maxDisplayDecimals !== undefined && frac.length > maxDisplayDecimals) {
    frac = frac.slice(0, maxDisplayDecimals);
  }
  frac = frac.replace(/0+$/, "");

  const prefix = negative ? "-" : "";
  return frac.length > 0 ? `${prefix}${whole}.${frac}` : `${prefix}${whole}`;
}

/**
 * Converts a finite JS number (e.g. a live USD price) into a high-precision scaled BigInt (1e18).
 */
export function floatToScaled18(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  const fixed = value.toFixed(18);
  return parseExactUnits(fixed, 18);
}

export function scaled18ToNumber(scaled: bigint): number {
  return Number(formatExactUnits(scaled, 18, 12));
}

export function atomicToNumber(atomic: bigint, decimals: number): number {
  return Number(formatExactUnits(atomic, decimals, Math.min(decimals, 12)));
}

/**
 * Converts native atomic amount (e.g. lamports / wei) -> USD value as JS number.
 */
export function nativeAtomicToUsd(
  nativeAtomic: bigint,
  nativeDecimals: number,
  nativePriceUsd: number
): number {
  if (nativeAtomic === 0n || nativePriceUsd <= 0) return 0;
  return atomicToNumber(nativeAtomic, nativeDecimals) * nativePriceUsd;
}

/**
 * Converts a USD/USDT amount -> exact native atomic units using high-precision integer math.
 */
export function usdToNativeAtomic(
  usdAmount: number,
  nativeDecimals: number,
  nativePriceUsd: number
): bigint {
  if (!Number.isFinite(usdAmount) || usdAmount <= 0 || usdAmount > 1_000_000_000) return 0n;
  if (!Number.isFinite(nativePriceUsd) || nativePriceUsd <= 0) return 0n;
  const usdScaled = floatToScaled18(usdAmount);
  const priceScaled = floatToScaled18(nativePriceUsd);
  if (priceScaled <= 0n) return 0n;
  const nativeScale = 10n ** BigInt(nativeDecimals);
  return (usdScaled * nativeScale) / priceScaled;
}

/**
 * Computes how many token atomic units are received when spending `nativeNetAtomic`
 * at effective token price `tokenPriceNative` (expressed in native per 1 token).
 */
export function computeTokensForNativeSpend(
  nativeNetAtomic: bigint,
  nativeDecimals: number,
  tokenDecimals: number,
  nativePriceUsd: number,
  effectiveTokenPriceUsd: number
): bigint {
  if (nativeNetAtomic <= 0n || nativePriceUsd <= 0 || effectiveTokenPriceUsd <= 0) {
    return 0n;
  }
  const nativeUsdScaled = floatToScaled18(nativePriceUsd);
  const tokenUsdScaled = floatToScaled18(effectiveTokenPriceUsd);
  if (tokenUsdScaled <= 0n) return 0n;

  const nativeScale = 10n ** BigInt(nativeDecimals);
  const tokenScale = 10n ** BigInt(tokenDecimals);

  // tokensAtomic = nativeNetAtomic * nativePriceUsd / effectiveTokenPriceUsd * (tokenScale / nativeScale)
  const numerator = nativeNetAtomic * nativeUsdScaled * tokenScale;
  const denominator = tokenUsdScaled * nativeScale;
  return numerator / denominator;
}

/**
 * Computes gross native atomic units received when selling `tokenAtomic` at `effectiveTokenPriceUsd`.
 */
export function computeNativeForTokenSell(
  tokenAtomic: bigint,
  tokenDecimals: number,
  nativeDecimals: number,
  nativePriceUsd: number,
  effectiveTokenPriceUsd: number
): bigint {
  if (tokenAtomic <= 0n || nativePriceUsd <= 0 || effectiveTokenPriceUsd <= 0) {
    return 0n;
  }
  const nativeUsdScaled = floatToScaled18(nativePriceUsd);
  const tokenUsdScaled = floatToScaled18(effectiveTokenPriceUsd);
  if (nativeUsdScaled <= 0n) return 0n;

  const nativeScale = 10n ** BigInt(nativeDecimals);
  const tokenScale = 10n ** BigInt(tokenDecimals);

  const numerator = tokenAtomic * tokenUsdScaled * nativeScale;
  const denominator = nativeUsdScaled * tokenScale;
  return numerator / denominator;
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs === 0) return "$0.00";
  if (abs < 0.0001) return `${sign}$${abs.toExponential(2)}`;
  if (abs < 1) return `${sign}$${abs.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function formatCompactPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value < 0.000001) return `$${value.toExponential(2)}`;
  if (value < 0.01) return `$${value.toFixed(7).replace(/0+$/, "")}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return formatUsd(value);
}

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const days = Math.floor(hr / 24);
  return `${days}d ${hr % 24}h`;
}

export { SCALE };
