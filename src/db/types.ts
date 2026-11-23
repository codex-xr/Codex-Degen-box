import { ChainKey } from "../chains/registry.js";

export type UserRole = "admin" | "member";
export type SimMode = "realistic" | "ideal";
export type PnlTheme = "cyber" | "solana" | "robinhood" | "gold";
export type CopyMode = "fixed" | "percent_balance";

export interface AuthorizedUser {
  telegramId: string;
  username: string | null;
  firstName: string | null;
  role: UserRole;
  codeUsed: string | null;
  joinedAt: number;
  isBanned: boolean;
}

export interface AccessCode {
  code: string;
  label: string | null;
  role: UserRole;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number;
  usesCount: number;
  revoked: boolean;
}

export type RedeemResult =
  | { ok: true; user: AuthorizedUser; alreadyAuthorized: boolean }
  | { ok: false; reason: string };

export interface VirtualBalanceRow {
  chain: ChainKey;
  balanceAtomic: bigint;
  initialBalanceAtomic: bigint;
  updatedAt: number;
}

export interface UserSettings {
  activeChain: ChainKey;
  slippageBps: number;
  priorityFeeSol: string;
  evmGasEth: string;
  simMode: SimMode;
  simDelayMs: number;
  pnlTheme: PnlTheme;
  weeklyReportEnabled: boolean;
  copyNotify: boolean;
}

export interface PositionRow {
  id: number;
  chain: ChainKey;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  tokenDecimals: number;
  pairAddress: string | null;
  dex: string | null;
  sourceType: "manual" | "copy" | "limit" | "dca";
  copiedWalletId: number | null;
  status: "open" | "closed" | "rugged";
  qtyTokenAtomic: bigint;
  initialQtyTokenAtomic: bigint;
  costNativeAtomic: bigint;
  initialCostNativeAtomic: bigint;
  realizedNativeAtomic: bigint;
  costUsd: number;
  initialCostUsd: number;
  realizedUsd: number;
  entryPriceUsd: number;
  lastPriceUsd: number;
  entryMcUsd: number;
  entryLiqUsd: number;
  entryVol5mUsd: number;
  entryTokenAgeSec: number | null;
  peakPriceUsd: number;
  peakMcUsd: number;
  exitPriceUsd: number | null;
  exitMcUsd: number | null;
  openedAt: number;
  closedAt: number | null;
}

export interface TradeRow {
  id: number;
  positionId: number;
  chain: ChainKey;
  side: "buy" | "sell" | "rug_writeoff";
  sourceType: string;
  copiedWalletId: number | null;
  copiedTxHash: string | null;
  tokenAddress: string;
  tokenSymbol: string;
  qtyTokenAtomic: bigint;
  nativeAmountAtomic: bigint;
  feeNativeAtomic: bigint;
  taxBps: number;
  slippageBps: number;
  priceUsd: number;
  nativePriceUsd: number;
  mcUsd: number;
  liqUsd: number;
  vol5mUsd: number;
  tokenAgeSec: number | null;
  securityRisk: string;
  realizedPnlNativeAtomic: bigint;
  realizedPnlUsd: number;
  simDelayMs: number;
  executedAt: number;
}

export interface OrderRow {
  id: number;
  chain: ChainKey;
  tokenAddress: string;
  tokenSymbol: string;
  positionId: number | null;
  orderType: "limit_buy" | "tp" | "sl" | "trailing_stop" | "dca";
  triggerMcUsd: number | null;
  triggerPriceUsd: number | null;
  triggerPnlPct: number | null;
  trailingDropPct: number | null;
  highestPriceUsd: number | null;
  amountNativeAtomic: bigint | null;
  sellPct: number | null;
  dcaIntervalSec: number | null;
  dcaRemaining: number | null;
  nextRunAt: number | null;
  status: "active" | "filled" | "cancelled";
  createdAt: number;
  updatedAt: number;
}

export interface WatchedWalletRow {
  id: number;
  chain: ChainKey;
  address: string;
  alias: string;
  enabled: boolean;
  copyMode: CopyMode;
  copyAmountAtomic: bigint;
  copyPercent: number;
  maxBuyAtomic: bigint | null;
  minMcUsd: number | null;
  maxMcUsd: number | null;
  minLiqUsd: number | null;
  skipIfHeld: boolean;
  mirrorSells: boolean;
  blockRisky: boolean;
  transferAlerts: boolean;
  simMode: SimMode;
  autoTpPct: number | null;
  autoSlPct: number | null;
  lastSeenTx: string | null;
  createdAt: number;
}

export interface ObservedSwapRow {
  id: number;
  watchedWalletId: number;
  chain: ChainKey;
  txHash: string;
  side: "buy" | "sell";
  tokenAddress: string;
  tokenSymbol: string | null;
  walletNativeAmountAtomic: bigint | null;
  priceUsdAtEvent: number | null;
  mcUsdAtEvent: number | null;
  liqUsdAtEvent: number | null;
  vol5mUsdAtEvent: number | null;
  tokenAgeSec: number | null;
  dex: string | null;
  actionTaken: string;
  skipReason: string | null;
  observedAt: number;
}

export interface WeeklyReportRow {
  id: number;
  periodStart: number;
  periodEnd: number;
  summaryJson: string;
  reportText: string;
  createdAt: number;
}

export interface IAdminDb {
  init(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
  ensureAdminsFromConfig(adminIds: Set<string>): Promise<void>;
  getUser(telegramId: string): Promise<AuthorizedUser | null>;
  isAuthorized(telegramId: string): Promise<{ authorized: boolean; user: AuthorizedUser | null }>;
  isAdmin(telegramId: string): Promise<boolean>;
  countActiveUsers(): Promise<number>;
  countActiveAdmins(): Promise<number>;
  listActiveUserIds(): Promise<string[]>;
  listUsers(): Promise<AuthorizedUser[]>;
  generateAccessCode(params: {
    createdBy: string;
    label?: string;
    maxUses?: number;
    expiresInHours?: number | null;
    role?: UserRole;
  }): Promise<AccessCode>;
  listAccessCodes(includeExhausted?: boolean): Promise<AccessCode[]>;
  revokeAccessCode(codeInput: string): Promise<boolean>;
  banUser(telegramId: string): Promise<boolean>;
  unbanUser(telegramId: string): Promise<boolean>;
  redeemCode(params: {
    code: string;
    telegramId: string;
    username?: string | null;
    firstName?: string | null;
  }): Promise<RedeemResult>;
}

export interface IUserVault {
  readonly telegramId: string;
  readonly locationLabel: string;
  close(): Promise<void>;
  runInTransaction<T>(fn: () => Promise<T>): Promise<T>;
  getBalances(): Promise<VirtualBalanceRow[]>;
  getBalance(chain: ChainKey): Promise<VirtualBalanceRow>;
  setVirtualFunds(chain: ChainKey, newBalanceAtomic: bigint, resetInitial?: boolean): Promise<void>;
  addVirtualFunds(chain: ChainKey, addAtomic: bigint): Promise<bigint>;
  adjustBalance(chain: ChainKey, deltaAtomic: bigint): Promise<bigint>;
  getSettings(): Promise<UserSettings>;
  setSetting(key: string, value: string): Promise<void>;
  getOpenPosition(chain: ChainKey, tokenAddress: string, copiedWalletId?: number | null): Promise<PositionRow | null>;
  getPositionById(id: number): Promise<PositionRow | null>;
  listOpenPositions(chain?: ChainKey): Promise<PositionRow[]>;
  listClosedPositions(limit?: number): Promise<PositionRow[]>;
  createPosition(input: {
    chain: ChainKey;
    tokenAddress: string;
    tokenSymbol: string;
    tokenName: string;
    tokenDecimals: number;
    pairAddress: string | null;
    dex: string | null;
    sourceType: "manual" | "copy" | "limit" | "dca";
    copiedWalletId: number | null;
    qtyTokenAtomic: bigint;
    costNativeAtomic: bigint;
    costUsd: number;
    entryPriceUsd: number;
    entryMcUsd: number;
    entryLiqUsd: number;
    entryVol5mUsd: number;
    entryTokenAgeSec: number | null;
    openedAt: number;
  }): Promise<number>;
  addToPosition(params: {
    id: number;
    addedTokensAtomic: bigint;
    addedNativeAtomic: bigint;
    addedCostUsd: number;
    newPriceUsd: number;
    newMcUsd: number;
  }): Promise<void>;
  reduceOrClosePosition(params: {
    id: number;
    soldTokensAtomic: bigint;
    receivedNativeAtomic: bigint;
    receivedUsd: number;
    priceUsd: number;
    mcUsd: number;
    statusIfZero?: "closed" | "rugged";
    closedAt: number;
  }): Promise<{ closed: boolean; costBasisSoldNative: bigint; costBasisSoldUsd: number }>;
  updatePositionMark(id: number, lastPriceUsd: number, mcUsd: number): Promise<void>;
  recordTrade(input: Omit<TradeRow, "id">): Promise<number>;
  listTradesBetween(startMs: number, endMs: number): Promise<TradeRow[]>;
  listRecentTrades(limit?: number): Promise<TradeRow[]>;
  listPositionsInPeriod(startMs: number, endMs: number): Promise<PositionRow[]>;
  createOrder(input: Omit<OrderRow, "id" | "createdAt" | "updatedAt" | "status">): Promise<number>;
  listActiveOrders(chain?: ChainKey): Promise<OrderRow[]>;
  updateOrderHighestPrice(id: number, highestPriceUsd: number): Promise<void>;
  advanceDcaOrder(id: number, remaining: number, nextRunAt: number | null): Promise<void>;
  setOrderStatus(id: number, status: "active" | "filled" | "cancelled"): Promise<boolean>;
  addWatchedWallet(input: {
    chain: ChainKey;
    address: string;
    alias: string;
    copyMode: CopyMode;
    copyAmountAtomic: bigint;
    copyPercent?: number;
    maxBuyAtomic?: bigint | null;
    minMcUsd?: number | null;
    maxMcUsd?: number | null;
    minLiqUsd?: number | null;
    skipIfHeld?: boolean;
    mirrorSells?: boolean;
    blockRisky?: boolean;
    transferAlerts?: boolean;
    simMode?: SimMode;
    autoTpPct?: number | null;
    autoSlPct?: number | null;
  }): Promise<number>;
  listWatchedWallets(onlyEnabled?: boolean): Promise<WatchedWalletRow[]>;
  getWatchedWallet(id: number): Promise<WatchedWalletRow | null>;
  updateWatchedWallet(
    id: number,
    patch: Partial<{
      alias: string;
      enabled: boolean;
      copyMode: CopyMode;
      copyAmountAtomic: bigint;
      copyPercent: number;
      maxBuyAtomic: bigint | null;
      minMcUsd: number | null;
      maxMcUsd: number | null;
      minLiqUsd: number | null;
      skipIfHeld: boolean;
      mirrorSells: boolean;
      blockRisky: boolean;
      transferAlerts: boolean;
      simMode: SimMode;
      autoTpPct: number | null;
      autoSlPct: number | null;
      lastSeenTx: string | null;
    }>
  ): Promise<void>;
  deleteWatchedWallet(id: number): Promise<boolean>;
  recordObservedSwap(input: Omit<ObservedSwapRow, "id">): Promise<boolean>;
  listObservedSwapsBetween(startMs: number, endMs: number): Promise<ObservedSwapRow[]>;
  saveWeeklyReport(input: Omit<WeeklyReportRow, "id" | "createdAt">): Promise<number>;
  getLatestWeeklyReport(): Promise<WeeklyReportRow | null>;
}

export interface IVaultManager {
  getVault(telegramId: string): Promise<IUserVault>;
  hasVault(telegramId: string): Promise<boolean>;
  closeAll(): Promise<void>;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  activeChain: "solana",
  slippageBps: 1500,
  priorityFeeSol: "0.001",
  evmGasEth: "0.00005",
  simMode: "realistic",
  simDelayMs: 1500,
  pnlTheme: "cyber",
  weeklyReportEnabled: true,
  copyNotify: true
};
