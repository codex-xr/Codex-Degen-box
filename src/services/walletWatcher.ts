import http from "node:http";
import { PublicKey } from "@solana/web3.js";
import { erc20Abi, parseAbiItem, PublicClient } from "viem";
import {
  ChainKey,
  CHAINS,
  EVM_CHAIN_KEYS,
  EvmChainKey,
  normalizeAddress
} from "../chains/registry.js";
import { AppConfig } from "../config.js";
import { IAdminDb, IVaultManager, WatchedWalletRow } from "../db/types.js";
import { atomicToNumber } from "../utils/amounts.js";
import { CopyEngine, DetectedWalletSwap } from "./copyEngine.js";
import { EvmClientManager } from "./evmClients.js";
import { SolanaClientManager } from "./solanaClient.js";

export interface DetectedWalletTransfer {
  chain: ChainKey;
  walletAddress: string;
  txHash: string;
  direction: "in" | "out";
  counterparty: string;
  amountNative: number;
  symbol: string;
  detectedAt: number;
}

export type TransferAlertCallback = (
  telegramId: string,
  wallet: WatchedWalletRow,
  transfer: DetectedWalletTransfer
) => Promise<void>;

interface WatcherTarget {
  telegramId: string;
  wallet: WatchedWalletRow;
}

const SOL_SYSTEM_SKIP = new Set([
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXx9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"
]);

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);
const UNISWAP_V2_SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const UNISWAP_V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const UNISWAP_V4_SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const AERODROME_SWAP_TOPIC = "0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b";

export class WalletWatcherService {
  private readonly config: AppConfig;
  private readonly adminDb: IAdminDb;
  private readonly vaultManager: IVaultManager;
  private readonly evmClients: EvmClientManager;
  private readonly solanaClient: SolanaClientManager;
  private readonly copyEngine: CopyEngine;
  private readonly onTransferAlert?: TransferAlertCallback;

  // Map key = `${chain}:${normalizedAddress}` -> list of user watchers
  private targets = new Map<string, WatcherTarget[]>();
  private solanaSubscriptions = new Map<string, number>();
  private solanaLastSigs = new Map<string, string>();
  private evmLastBlocks = new Map<EvmChainKey, bigint>();
  private seenTxKeys = new Set<string>();
  private solanaInFlight = new Set<string>();

  private evmTimer: NodeJS.Timeout | null = null;
  private solanaPollTimer: NodeJS.Timeout | null = null;
  private webhookServer: http.Server | null = null;
  private evmBusy = false;
  private solanaPollBusy = false;

  constructor(params: {
    config: AppConfig;
    adminDb: IAdminDb;
    vaultManager: IVaultManager;
    evmClients: EvmClientManager;
    solanaClient: SolanaClientManager;
    copyEngine: CopyEngine;
    onTransferAlert?: TransferAlertCallback;
  }) {
    this.config = params.config;
    this.adminDb = params.adminDb;
    this.vaultManager = params.vaultManager;
    this.evmClients = params.evmClients;
    this.solanaClient = params.solanaClient;
    this.copyEngine = params.copyEngine;
    this.onTransferAlert = params.onTransferAlert;
  }

  async start(): Promise<void> {
    await this.reloadWatchers();

    // EVM block-level Swap + Transfer scanner for Base & Robinhood Chain
    this.evmTimer = setInterval(() => {
      void this.pollEvmChains();
    }, this.config.evmPollMs);

    // Solana backup poll in case WS drops; primary detection uses real-time WS logsSubscribe
    this.solanaPollTimer = setInterval(() => {
      void this.pollSolanaFallback();
    }, this.config.solanaFallbackPollMs);

    this.startWebhookServer();
  }

  async stop(): Promise<void> {
    if (this.evmTimer) clearInterval(this.evmTimer);
    if (this.solanaPollTimer) clearInterval(this.solanaPollTimer);
    this.evmTimer = null;
    this.solanaPollTimer = null;

    for (const subId of this.solanaSubscriptions.values()) {
      try {
        await this.solanaClient.connection.removeOnLogsListener(subId);
      } catch {
        // ignore
      }
    }
    this.solanaSubscriptions.clear();

    if (this.webhookServer) {
      await new Promise<void>((resolve) => this.webhookServer!.close(() => resolve()));
      this.webhookServer = null;
    }
  }

  /**
   * Rebuilds the active watcher index from every authorized user's private vault
   * and syncs Solana WebSocket listeners immediately.
   */
  async reloadWatchers(): Promise<void> {
    const nextTargets = new Map<string, WatcherTarget[]>();
    const activeSolanaAddrs = new Set<string>();

    for (const userId of await this.adminDb.listActiveUserIds()) {
      if (!(await this.vaultManager.hasVault(userId))) continue;
      const vault = await this.vaultManager.getVault(userId);
      for (const w of await vault.listWatchedWallets(true)) {
        const key = `${w.chain}:${normalizeAddress(w.chain, w.address)}`;
        const arr = nextTargets.get(key) ?? [];
        arr.push({ telegramId: userId, wallet: w });
        nextTargets.set(key, arr);
        if (w.chain === "solana") {
          activeSolanaAddrs.add(w.address);
        }
      }
    }

    this.targets = nextTargets;
    await this.syncSolanaWsSubscriptions(activeSolanaAddrs);
  }

  private async syncSolanaWsSubscriptions(activeAddrs: Set<string>): Promise<void> {
    // Unsubscribe removed addresses
    for (const [addr, subId] of [...this.solanaSubscriptions.entries()]) {
      if (!activeAddrs.has(addr)) {
        this.solanaSubscriptions.delete(addr);
        try {
          await this.solanaClient.connection.removeOnLogsListener(subId);
        } catch {
          // ignore
        }
      }
    }

    // Subscribe newly added addresses for sub-second push detection
    for (const addr of activeAddrs) {
      if (this.solanaSubscriptions.has(addr)) continue;
      this.subscribeSolanaAddress(addr);
    }
  }

  private subscribeSolanaAddress(addr: string): boolean {
    try {
      const pubkey = new PublicKey(addr);
      const subId = this.solanaClient.connection.onLogs(
        pubkey,
        (logInfo) => {
          if (logInfo.err) return;
          void this.handleSolanaSignature(addr, logInfo.signature);
        },
        "confirmed"
      );
      this.solanaSubscriptions.set(addr, subId);
      return true;
    } catch {
      // Fallback poll will still pick up transactions if WS subscription fails
      return false;
    }
  }

  private async resubscribeSolanaAddress(addr: string): Promise<void> {
    const oldId = this.solanaSubscriptions.get(addr);
    if (oldId !== undefined) {
      this.solanaSubscriptions.delete(addr);
      try {
        await this.solanaClient.connection.removeOnLogsListener(oldId);
      } catch {
        // ignore
      }
    }
    this.subscribeSolanaAddress(addr);
  }

  private async pollSolanaFallback(): Promise<void> {
    if (this.solanaPollBusy) return;
    this.solanaPollBusy = true;
    try {
      const solAddresses = new Set<string>();
      for (const key of this.targets.keys()) {
        if (key.startsWith("solana:")) solAddresses.add(key.slice("solana:".length));
      }

      for (const addr of solAddresses) {
        try {
          const sigs = await this.solanaRpcSingle<
            Array<{ signature: string; err: unknown; blockTime?: number | null }>
          >("getSignaturesForAddress", [addr, { limit: 25 }]);
          if (!sigs || sigs.length === 0) continue;

          const latest = sigs[0].signature;
          const prev = this.solanaLastSigs.get(addr);

          // Skip historical backfill on first start so we only copy LIVE trades from now on
          if (!prev) {
            this.solanaLastSigs.set(addr, latest);
            continue;
          }

          const pending: Array<{ signature: string; blockTime?: number | null }> = [];
          for (const info of sigs) {
            if (info.signature === prev) break;
            if (info.err) continue;
            pending.push(info);
          }

          if (pending.length === 0) {
            this.solanaLastSigs.set(addr, latest);
            continue;
          }

          // Process oldest -> newest so buys settle before sells
          const chronological = [...pending].reverse();
          let wsMissedOldTx = false;
          let lastCompletedSig = prev;

          for (const item of chronological) {
            const seenBefore = this.seenTxKeys.has(`solana:${addr}:${item.signature}`);
            if (!seenBefore && item.blockTime && Date.now() / 1000 - Number(item.blockTime) > 18) {
              wsMissedOldTx = true;
            }
            const ok = await this.handleSolanaSignature(addr, item.signature);
            if (!ok) {
              // Stop advancing bookmark here so next poll retries failed RPC fetches
              break;
            }
            lastCompletedSig = item.signature;
          }

          this.solanaLastSigs.set(addr, lastCompletedSig);

          if (wsMissedOldTx) {
            await this.resubscribeSolanaAddress(addr);
          }
        } catch {
          // ignore transient RPC issue
        }
      }
    } finally {
      this.solanaPollBusy = false;
    }
  }

  private async solanaRpcSingle<T>(method: string, params: unknown[]): Promise<T | null> {
    const endpoints = [this.config.solanaRpcUrl];
    if (!endpoints.includes("https://solana-rpc.publicnode.com")) {
      endpoints.push("https://solana-rpc.publicnode.com");
    }
    if (!endpoints.includes("https://api.mainnet-beta.solana.com")) {
      endpoints.push("https://api.mainnet-beta.solana.com");
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
        // Try next RPC endpoint
      }
    }
    return null;
  }

  async handleSolanaSignature(walletAddress: string, signature: string): Promise<boolean> {
    const dedupKey = `solana:${walletAddress}:${signature}`;
    if (this.seenTxKeys.has(dedupKey) || this.solanaInFlight.has(dedupKey)) return true;

    this.solanaInFlight.add(dedupKey);
    try {
      const outcome = await this.inspectSolanaTx(walletAddress, signature);
      if (!outcome.fetched) {
        return false;
      }
      this.markSeen(dedupKey);

      for (const swap of outcome.swaps) {
        await this.dispatchSwap(swap);
      }
      if (outcome.swaps.length === 0 && outcome.transfer) {
        await this.dispatchTransfer(outcome.transfer);
      }
      return true;
    } finally {
      this.solanaInFlight.delete(dedupKey);
    }
  }

  private async inspectSolanaTx(
    walletAddress: string,
    signature: string
  ): Promise<{ swaps: DetectedWalletSwap[]; transfer?: DetectedWalletTransfer; fetched: boolean }> {
    const wsol = CHAINS.solana.wrappedNativeAddress;
    const stables = new Set(CHAINS.solana.knownStableAddresses);
    const isQuote = (mint: string) => mint === wsol || stables.has(mint);

    if (this.config.heliusApiKey) {
      try {
        const res = await fetch(
          `https://api.helius-rpc.com/v0/transactions/?api-key=${this.config.heliusApiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ transactions: [signature] }),
            signal: AbortSignal.timeout(6000)
          }
        );
        if (res.ok) {
          const txs = (await res.json()) as Array<{
            type?: string;
            source?: string;
            feePayer?: string;
            nativeTransfers?: Array<{ fromUserAccount?: string; toUserAccount?: string; amount?: number }>;
            tokenTransfers?: Array<{
              fromUserAccount?: string;
              toUserAccount?: string;
              mint?: string;
              tokenAmount?: number;
            }>;
            events?: {
              swap?: {
                nativeInput?: { account?: string; amount?: string };
                nativeOutput?: { account?: string; amount?: string };
                tokenInputs?: Array<{ userAccount?: string; mint?: string; rawTokenAmount?: { tokenAmount?: string } }>;
                tokenOutputs?: Array<{ userAccount?: string; mint?: string; rawTokenAmount?: { tokenAmount?: string } }>;
              };
            };
          }>;
          const tx = txs[0];
          if (tx) {
            const parsed = this.extractSwapsFromHeliusTx(walletAddress, signature, tx);
            if (parsed.length > 0) return { swaps: parsed, fetched: true };

            const hasNonQuoteTokenMove = (tx.tokenTransfers ?? []).some(
              (t) =>
                t.mint &&
                !isQuote(t.mint) &&
                (t.toUserAccount === walletAddress || t.fromUserAccount === walletAddress)
            );

            // If Helius left an unparsed router tx as UNKNOWN while moving non-quote tokens,
            // let standard RPC balance-diff parsing classify it before assuming a plain SOL transfer.
            if (!hasNonQuoteTokenMove) {
              const bigNative = (tx.nativeTransfers ?? []).find(
                (nt) =>
                  (nt.fromUserAccount === walletAddress || nt.toUserAccount === walletAddress) &&
                  Number(nt.amount ?? 0) >= 50_000_000
              );
              if (bigNative) {
                const isOut = bigNative.fromUserAccount === walletAddress;
                const other = isOut ? bigNative.toUserAccount : bigNative.fromUserAccount;
                if (other && other !== walletAddress && !SOL_SYSTEM_SKIP.has(other)) {
                  return {
                    swaps: [],
                    transfer: {
                      chain: "solana",
                      walletAddress,
                      txHash: signature,
                      direction: isOut ? "out" : "in",
                      counterparty: other,
                      amountNative: Number(bigNative.amount) / 1e9,
                      symbol: "SOL",
                      detectedAt: Date.now()
                    },
                    fetched: true
                  };
                }
              }
              return { swaps: [], fetched: true };
            }
          }
        }
      } catch {
        // Fall through to standard RPC balance-diff parser
      }
    }

    try {
      const parsedTx = await this.solanaRpcSingle<RawSolanaParsedTx>("getTransaction", [
        signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }
      ]);
      if (!parsedTx) return { swaps: [], fetched: false };
      if (!parsedTx.meta || parsedTx.meta.err) return { swaps: [], fetched: true };

      const swaps = this.extractSwapsFromSolanaBalanceDiffs(walletAddress, signature, parsedTx);
      if (swaps.length > 0) return { swaps, fetched: true };

      const transfer = this.extractTransferFromSolanaBalanceDiffs(walletAddress, signature, parsedTx);
      return { swaps: [], transfer: transfer ?? undefined, fetched: true };
    } catch {
      return { swaps: [], fetched: false };
    }
  }

  private extractAccountKeys(parsedTx: RawSolanaParsedTx): string[] {
    const baseKeys = (parsedTx.transaction?.message?.accountKeys ?? []).map((k) =>
      typeof k === "string" ? k : typeof k.pubkey === "string" ? k.pubkey : k.pubkey?.toBase58?.() ?? ""
    );
    return [
      ...baseKeys,
      ...(parsedTx.meta?.loadedAddresses?.writable ?? []),
      ...(parsedTx.meta?.loadedAddresses?.readonly ?? [])
    ].filter(Boolean);
  }

  private extractTransferFromSolanaBalanceDiffs(
    walletAddress: string,
    signature: string,
    parsedTx: RawSolanaParsedTx
  ): DetectedWalletTransfer | null {
    const meta = parsedTx.meta;
    if (!meta) return null;
    const keys = this.extractAccountKeys(parsedTx);
    const idx = keys.indexOf(walletAddress);
    if (idx < 0) return null;

    const delta = Number(BigInt(meta.postBalances?.[idx] ?? 0) - BigInt(meta.preBalances?.[idx] ?? 0)) / 1e9;
    if (Math.abs(delta) < 0.05) return null;

    for (let i = 0; i < keys.length; i++) {
      const other = keys[i];
      if (!other || other === walletAddress || SOL_SYSTEM_SKIP.has(other)) continue;
      const otherDelta = Number(BigInt(meta.postBalances?.[i] ?? 0) - BigInt(meta.preBalances?.[i] ?? 0)) / 1e9;
      if (delta < -0.05 && otherDelta > 0.04) {
        return {
          chain: "solana",
          walletAddress,
          txHash: signature,
          direction: "out",
          counterparty: other,
          amountNative: Math.min(-delta, otherDelta),
          symbol: "SOL",
          detectedAt: Date.now()
        };
      }
      if (delta > 0.05 && otherDelta < -0.04) {
        return {
          chain: "solana",
          walletAddress,
          txHash: signature,
          direction: "in",
          counterparty: other,
          amountNative: Math.min(delta, -otherDelta),
          symbol: "SOL",
          detectedAt: Date.now()
        };
      }
    }
    return null;
  }

  private extractSwapsFromHeliusTx(
    walletAddress: string,
    signature: string,
    tx: {
      type?: string;
      source?: string;
      nativeTransfers?: Array<{ fromUserAccount?: string; toUserAccount?: string; amount?: number }>;
      tokenTransfers?: Array<{
        fromUserAccount?: string;
        toUserAccount?: string;
        mint?: string;
        tokenAmount?: number;
      }>;
      events?: {
        swap?: {
          nativeInput?: { account?: string; amount?: string };
          nativeOutput?: { account?: string; amount?: string };
          tokenInputs?: Array<{ userAccount?: string; mint?: string }>;
          tokenOutputs?: Array<{ userAccount?: string; mint?: string }>;
        };
      };
    }
  ): DetectedWalletSwap[] {
    const wsol = CHAINS.solana.wrappedNativeAddress;
    const stables = new Set(CHAINS.solana.knownStableAddresses);
    const isQuote = (mint: string) => mint === wsol || stables.has(mint);

    const tokenIn = new Map<string, number>();
    const tokenOut = new Map<string, number>();

    for (const t of tx.tokenTransfers ?? []) {
      if (!t.mint || !t.tokenAmount || t.tokenAmount <= 0) continue;
      if (t.toUserAccount === walletAddress) {
        tokenIn.set(t.mint, (tokenIn.get(t.mint) ?? 0) + t.tokenAmount);
      }
      if (t.fromUserAccount === walletAddress) {
        tokenOut.set(t.mint, (tokenOut.get(t.mint) ?? 0) + t.tokenAmount);
      }
    }

    let nativeOutLamports = 0;
    let nativeInLamports = 0;
    for (const nt of tx.nativeTransfers ?? []) {
      const amt = Number(nt.amount ?? 0);
      if (amt <= 0) continue;
      if (nt.fromUserAccount === walletAddress && nt.toUserAccount !== walletAddress) {
        nativeOutLamports += amt;
      }
      if (nt.toUserAccount === walletAddress && nt.fromUserAccount !== walletAddress) {
        nativeInLamports += amt;
      }
    }

    const boughtToken = [...tokenIn.entries()].find(([mint]) => !isQuote(mint));
    const soldToken = [...tokenOut.entries()].find(([mint]) => !isQuote(mint));
    const swapEv = tx.events?.swap;
    const swaps: DetectedWalletSwap[] = [];

    if (
      soldToken &&
      (swapEv || tx.type === "SWAP" || tokenIn.size > 0 || nativeInLamports >= 500_000)
    ) {
      const nativeAmt = swapEv?.nativeOutput?.amount
        ? BigInt(swapEv.nativeOutput.amount)
        : nativeInLamports >= 500_000
          ? BigInt(Math.round(nativeInLamports))
          : null;
      swaps.push({
        chain: "solana",
        walletAddress,
        txHash: signature,
        side: "sell",
        tokenAddress: soldToken[0],
        walletNativeAmountAtomic: nativeAmt,
        dex: tx.source,
        detectedAt: Date.now()
      });
    }

    if (
      boughtToken &&
      (swapEv || tx.type === "SWAP" || tokenOut.size > 0 || nativeOutLamports >= 500_000)
    ) {
      const nativeAmt = swapEv?.nativeInput?.amount
        ? BigInt(swapEv.nativeInput.amount)
        : nativeOutLamports >= 500_000
          ? BigInt(Math.round(nativeOutLamports))
          : null;
      swaps.push({
        chain: "solana",
        walletAddress,
        txHash: signature,
        side: "buy",
        tokenAddress: boughtToken[0],
        walletNativeAmountAtomic: nativeAmt,
        dex: tx.source,
        detectedAt: Date.now()
      });
    }

    return swaps;
  }

  private extractSwapsFromSolanaBalanceDiffs(
    walletAddress: string,
    signature: string,
    parsedTx: RawSolanaParsedTx
  ): DetectedWalletSwap[] {
    const meta = parsedTx.meta;
    if (!meta) return [];

    const wsol = CHAINS.solana.wrappedNativeAddress;
    const stables = new Set(CHAINS.solana.knownStableAddresses);
    const isQuote = (mint: string) => mint === wsol || stables.has(mint);

    const preMap = new Map<string, bigint>();
    const postMap = new Map<string, bigint>();

    for (const b of meta.preTokenBalances ?? []) {
      if (b.owner === walletAddress && b.mint) {
        preMap.set(b.mint, (preMap.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount?.amount || "0"));
      }
    }
    for (const b of meta.postTokenBalances ?? []) {
      if (b.owner === walletAddress && b.mint) {
        postMap.set(b.mint, (postMap.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount?.amount || "0"));
      }
    }

    const allMints = new Set([...preMap.keys(), ...postMap.keys()]);
    let boughtMint: string | null = null;
    let soldMint: string | null = null;
    let quoteSpent = false;
    let quoteGained = false;

    for (const mint of allMints) {
      const diff = (postMap.get(mint) ?? 0n) - (preMap.get(mint) ?? 0n);
      if (diff === 0n) continue;
      if (isQuote(mint)) {
        if (diff < 0n) quoteSpent = true;
        if (diff > 0n) quoteGained = true;
      } else {
        if (diff > 0n && !boughtMint) boughtMint = mint;
        if (diff < 0n && !soldMint) soldMint = mint;
      }
    }

    // Native SOL delta on wallet's account index
    const acctKeys = this.extractAccountKeys(parsedTx);
    const idx = acctKeys.indexOf(walletAddress);
    let solDelta = 0n;
    if (idx >= 0 && meta.preBalances?.[idx] !== undefined && meta.postBalances?.[idx] !== undefined) {
      solDelta = BigInt(meta.postBalances[idx]!) - BigInt(meta.preBalances[idx]!);
    }

    const swaps: DetectedWalletSwap[] = [];
    if (soldMint && (solDelta > 100_000n || quoteGained || boughtMint !== null)) {
      swaps.push({
        chain: "solana",
        walletAddress,
        txHash: signature,
        side: "sell",
        tokenAddress: soldMint,
        walletNativeAmountAtomic: solDelta > 0n ? solDelta : null,
        detectedAt: Date.now()
      });
    }

    if (boughtMint && (solDelta < -100_000n || quoteSpent || soldMint !== null)) {
      swaps.push({
        chain: "solana",
        walletAddress,
        txHash: signature,
        side: "buy",
        tokenAddress: boughtMint,
        walletNativeAmountAtomic: solDelta < 0n ? -solDelta : null,
        detectedAt: Date.now()
      });
    }

    return swaps;
  }

  private async pollEvmChains(): Promise<void> {
    if (this.evmBusy) return;
    this.evmBusy = true;
    try {
      await Promise.all(EVM_CHAIN_KEYS.map((chain) => this.scanEvmChain(chain)));
    } finally {
      this.evmBusy = false;
    }
  }

  private async scanEvmChain(chain: EvmChainKey): Promise<void> {
    const watched = new Set<string>();
    let hasTransferAlerts = false;
    for (const [key, targets] of this.targets.entries()) {
      if (key.startsWith(`${chain}:`)) {
        watched.add(key.slice(chain.length + 1) as `0x${string}`);
        if (targets.some((t) => t.wallet.transferAlerts)) {
          hasTransferAlerts = true;
        }
      }
    }
    if (watched.size === 0) return;

    const client = this.evmClients.getClient(chain);
    let latestBlock: bigint;
    try {
      latestBlock = await client.getBlockNumber();
    } catch {
      return;
    }

    const prevBlock = this.evmLastBlocks.get(chain);
    if (prevBlock === undefined) {
      this.evmLastBlocks.set(chain, latestBlock);
      return; // Start watching cleanly from live head
    }
    if (latestBlock <= prevBlock) return;

    const scanStart = latestBlock - prevBlock > 30n ? latestBlock - 30n : prevBlock + 1n;
    const addressList = [...watched] as `0x${string}`[];
    const inspectedInScan = new Set<string>();

    // Scan in <=10-block chunks and advance evmLastBlocks ONLY after each chunk succeeds
    for (let chunkStart = scanStart; chunkStart <= latestBlock; chunkStart += 10n) {
      const chunkEnd = chunkStart + 9n < latestBlock ? chunkStart + 9n : latestBlock;
      const txsToInspect = new Map<string, Set<string>>();
      let chunkScanned = false;

      try {
        const [incomingLogs, outgoingLogs] = await Promise.all([
          client.getLogs({
            event: TRANSFER_EVENT,
            args: { to: addressList },
            fromBlock: chunkStart,
            toBlock: chunkEnd
          }),
          client.getLogs({
            event: TRANSFER_EVENT,
            args: { from: addressList },
            fromBlock: chunkStart,
            toBlock: chunkEnd
          })
        ]);

        for (const log of incomingLogs) {
          const to = log.args.to?.toLowerCase();
          if (!to || !log.transactionHash) continue;
          const set = txsToInspect.get(log.transactionHash) ?? new Set<string>();
          set.add(to);
          txsToInspect.set(log.transactionHash, set);
        }
        for (const log of outgoingLogs) {
          const from = log.args.from?.toLowerCase();
          if (!from || !log.transactionHash) continue;
          const set = txsToInspect.get(log.transactionHash) ?? new Set<string>();
          set.add(from);
          txsToInspect.set(log.transactionHash, set);
        }
        chunkScanned = true;
      } catch {
        // Fallback: scan block transactions directly when an RPC rejects eth_getLogs
        const fallbackBlocks = chunkEnd - chunkStart > 4n ? chunkEnd - 4n : chunkStart;
        let blkOk = false;
        for (let blk = fallbackBlocks; blk <= chunkEnd; blk++) {
          const block = await client.getBlock({ blockNumber: blk, includeTransactions: true }).catch(() => null);
          if (!block) continue;
          blkOk = true;
          for (const tx of block.transactions) {
            if (typeof tx === "string") continue;
            const from = tx.from.toLowerCase();
            if (watched.has(from) && tx.input && tx.input.length > 10) {
              const set = txsToInspect.get(tx.hash) ?? new Set<string>();
              set.add(from);
              txsToInspect.set(tx.hash, set);
            }
          }
        }
        chunkScanned = blkOk;
      }

      if (!chunkScanned) {
        // Leave evmLastBlocks before this failed chunk so next poll retries cleanly
        break;
      }

      for (const [txHash, wallets] of txsToInspect.entries()) {
        inspectedInScan.add(txHash.toLowerCase());
        await this.inspectEvmTransaction(chain, client, txHash as `0x${string}`, [...wallets]);
      }

      this.evmLastBlocks.set(chain, chunkEnd);
    }

    // Check direct native ETH transfers in up to latest 2 blocks if transferAlerts is enabled
    if (hasTransferAlerts && this.onTransferAlert) {
      const startNativeBlk = latestBlock - scanStart > 1n ? latestBlock - 1n : scanStart;
      for (let blk = startNativeBlk; blk <= latestBlock; blk++) {
        const block = await client.getBlock({ blockNumber: blk, includeTransactions: true }).catch(() => null);
        if (!block) continue;
        for (const tx of block.transactions) {
          if (typeof tx === "string") continue;
          if (inspectedInScan.has(tx.hash.toLowerCase())) continue;
          const from = tx.from.toLowerCase();
          const to = tx.to?.toLowerCase() ?? "";
          if (!to || (tx.input && tx.input.length > 2) || tx.value < 5_000_000_000_000_000n) continue;
          if (watched.has(from) && !watched.has(to)) {
            const dedup = `${chain}:${from}:${tx.hash}:xfer`;
            if (!this.markSeen(dedup)) {
              await this.dispatchTransfer({
                chain,
                walletAddress: from,
                txHash: tx.hash,
                direction: "out",
                counterparty: to,
                amountNative: atomicToNumber(tx.value, 18),
                symbol: "ETH",
                detectedAt: Date.now()
              });
            }
          } else if (watched.has(to) && !watched.has(from)) {
            const dedup = `${chain}:${to}:${tx.hash}:xfer`;
            if (!this.markSeen(dedup)) {
              await this.dispatchTransfer({
                chain,
                walletAddress: to,
                txHash: tx.hash,
                direction: "in",
                counterparty: from,
                amountNative: atomicToNumber(tx.value, 18),
                symbol: "ETH",
                detectedAt: Date.now()
              });
            }
          }
        }
      }
    }
  }

  private async inspectEvmTransaction(
    chain: EvmChainKey,
    client: PublicClient,
    txHash: `0x${string}`,
    walletAddresses: string[]
  ): Promise<void> {
    try {
      const [receipt, tx] = await Promise.all([
        client.getTransactionReceipt({ hash: txHash }),
        client.getTransaction({ hash: txHash })
      ]);
      if (receipt.status !== "success") return;

      const hasKnownSwapLog = receipt.logs.some((log) => {
        const t0 = log.topics[0]?.toLowerCase();
        return (
          t0 === UNISWAP_V2_SWAP_TOPIC ||
          t0 === UNISWAP_V3_SWAP_TOPIC ||
          t0 === UNISWAP_V4_SWAP_TOPIC ||
          t0 === AERODROME_SWAP_TOPIC
        );
      });
      const isContractInteraction = Boolean(tx.to && tx.input && tx.input.length > 10);
      if (!isContractInteraction && !hasKnownSwapLog) return; // Ignore simple wallet transfers

      const spec = CHAINS[chain];
      const quoteSet = new Set([
        spec.wrappedNativeAddress.toLowerCase(),
        ...spec.knownStableAddresses.map((a) => a.toLowerCase())
      ]);
      const transferSig = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

      for (const wallet of walletAddresses) {
        const dedupKey = `${chain}:${wallet}:${txHash}`;
        if (this.markSeen(dedupKey)) continue;

        const netFlows = new Map<string, bigint>();
        for (const log of receipt.logs) {
          if (log.topics[0]?.toLowerCase() !== transferSig || log.topics.length < 3) continue;
          const from = `0x${log.topics[1]!.slice(26)}`.toLowerCase();
          const to = `0x${log.topics[2]!.slice(26)}`.toLowerCase();
          const value = log.data && log.data !== "0x" ? BigInt(log.data) : 0n;
          const tokenAddr = log.address.toLowerCase();
          if (to === wallet) {
            netFlows.set(tokenAddr, (netFlows.get(tokenAddr) ?? 0n) + value);
          }
          if (from === wallet) {
            netFlows.set(tokenAddr, (netFlows.get(tokenAddr) ?? 0n) - value);
          }
        }

        let boughtToken: string | null = null;
        let soldToken: string | null = null;
        let quoteSpent = tx.from.toLowerCase() === wallet && tx.value > 0n;
        let quoteReceived = false;
        let quoteNativeSpent: bigint | null = quoteSpent ? tx.value : null;

        for (const [tokenAddr, flow] of netFlows.entries()) {
          if (quoteSet.has(tokenAddr)) {
            if (flow < 0n) {
              quoteSpent = true;
              if (tokenAddr === spec.wrappedNativeAddress.toLowerCase() && !quoteNativeSpent) {
                quoteNativeSpent = -flow;
              }
            }
            if (flow > 0n) quoteReceived = true;
            continue;
          }
          if (flow > 0n && !boughtToken) boughtToken = tokenAddr;
          if (flow < 0n && !soldToken) soldToken = tokenAddr;
        }

        // Prevent copying spam airdrops unless a DEX Swap event fired or quote currency moved
        if (!hasKnownSwapLog && !(boughtToken && quoteSpent) && !(soldToken && quoteReceived)) {
          continue;
        }

        if (soldToken) {
          await this.dispatchSwap({
            chain,
            walletAddress: wallet,
            txHash,
            side: "sell",
            tokenAddress: soldToken,
            walletNativeAmountAtomic: null,
            dex: "uniswap",
            detectedAt: Date.now()
          });
        }

        if (boughtToken) {
          let symbolHint: string | undefined;
          try {
            const sym = await client.readContract({
              address: boughtToken as `0x${string}`,
              abi: erc20Abi,
              functionName: "symbol"
            });
            symbolHint = String(sym);
          } catch {
            // ignore
          }
          await this.dispatchSwap({
            chain,
            walletAddress: wallet,
            txHash,
            side: "buy",
            tokenAddress: boughtToken,
            tokenSymbolHint: symbolHint,
            walletNativeAmountAtomic: quoteNativeSpent,
            dex: "uniswap",
            detectedAt: Date.now()
          });
        }
      }
    } catch {
      // ignore transient RPC failure
    }
  }

  private async dispatchSwap(swap: DetectedWalletSwap): Promise<void> {
    const key = `${swap.chain}:${normalizeAddress(swap.chain, swap.walletAddress)}`;
    const watchers = this.targets.get(key);
    if (!watchers || watchers.length === 0) return;

    await Promise.all(
      watchers.map((w) => this.copyEngine.processSwapForUser(w.telegramId, w.wallet, swap))
    );
  }

  private async dispatchTransfer(transfer: DetectedWalletTransfer): Promise<void> {
    if (!this.onTransferAlert) return;
    const key = `${transfer.chain}:${normalizeAddress(transfer.chain, transfer.walletAddress)}`;
    const watchers = this.targets.get(key);
    if (!watchers || watchers.length === 0) return;

    await Promise.all(
      watchers
        .filter((t) => t.wallet.transferAlerts)
        .map((t) => this.onTransferAlert!(t.telegramId, t.wallet, transfer))
    );
  }

  private startWebhookServer(): void {
    if (!this.config.webhookPort) return;
    try {
      this.webhookServer = http.createServer((req, res) => {
        if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
          // Light DB heartbeat ensures both Render and Supabase Free stay awake on keep-alive pings
          void this.adminDb.ping().then((dbOk) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, db: dbOk, service: "codex-degen-box" }));
          });
          return;
        }
        if (req.method !== "POST" || req.url !== "/helius-webhook") {
          res.writeHead(404).end("Not found");
          return;
        }
        if (
          this.config.webhookSecret &&
          req.headers.authorization !== `Bearer ${this.config.webhookSecret}` &&
          req.headers.authorization !== this.config.webhookSecret
        ) {
          res.writeHead(401).end("Unauthorized");
          return;
        }

        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          res.writeHead(200).end("OK");
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Array<{
              signature?: string;
              accountData?: Array<{ account?: string }>;
            }>;
            for (const tx of body) {
              if (!tx.signature) continue;
              const accts = new Set((tx.accountData ?? []).map((a) => a.account).filter(Boolean));
              for (const key of this.targets.keys()) {
                if (!key.startsWith("solana:")) continue;
                const addr = key.slice("solana:".length);
                if (accts.has(addr)) {
                  void this.handleSolanaSignature(addr, tx.signature);
                }
              }
            }
          } catch {
            // ignore malformed payload
          }
        });
      });

      this.webhookServer.listen(this.config.webhookPort, "0.0.0.0", () => {
        // Listening silently
      });
      this.webhookServer.on("error", () => {
        // Port already in use or restricted - WS + poll still operate cleanly
      });
    } catch {
      // ignore
    }
  }

  private markSeen(key: string): boolean {
    if (this.seenTxKeys.has(key)) return true;
    this.seenTxKeys.add(key);
    if (this.seenTxKeys.size > 5000) {
      const oldest = this.seenTxKeys.values().next().value;
      if (oldest) this.seenTxKeys.delete(oldest);
    }
    return false;
  }
}

interface RawSolanaParsedTx {
  meta?: {
    err?: unknown;
    preBalances?: number[];
    postBalances?: number[];
    loadedAddresses?: { writable?: string[]; readonly?: string[] };
    preTokenBalances?: Array<{ owner?: string; mint?: string; uiTokenAmount?: { amount?: string } }>;
    postTokenBalances?: Array<{ owner?: string; mint?: string; uiTokenAmount?: { amount?: string } }>;
  } | null;
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey?: string | { toBase58?: () => string } }>;
    };
  };
}
