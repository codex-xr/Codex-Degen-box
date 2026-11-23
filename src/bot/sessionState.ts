import { ChainKey } from "../chains/registry.js";

export type PendingPrompt =
  | { kind: "await_access_code" }
  | { kind: "await_set_balance"; chain: ChainKey }
  | { kind: "await_buy_token_ca"; chain?: ChainKey }
  | { kind: "await_custom_buy_amount"; chain: ChainKey; tokenAddress: string }
  | { kind: "await_custom_sell_amount"; positionId: number }
  | { kind: "await_limit_buy"; chain: ChainKey; tokenAddress: string }
  | { kind: "await_dca_buy"; chain: ChainKey; tokenAddress: string }
  | { kind: "await_pos_order"; positionId: number; orderType: "tp" | "sl" | "trailing_stop" }
  | { kind: "await_watch_address"; chain: ChainKey }
  | { kind: "await_watch_alias"; chain: ChainKey; address: string }
  | { kind: "await_watch_amount"; chain: ChainKey; address: string; alias: string }
  | { kind: "await_edit_watch_amount"; walletId: number }
  | { kind: "await_edit_watch_filter"; walletId: number; field: "min_mc" | "max_mc" | "min_liq" | "tp_sl" }
  | { kind: "await_slippage" }
  | { kind: "await_gas_fee"; chain: ChainKey }
  | { kind: "await_admin_code_label"; maxUses: number };

export class SessionStore {
  private readonly prompts = new Map<string, PendingPrompt>();

  set(telegramId: string, prompt: PendingPrompt): void {
    this.prompts.set(telegramId, prompt);
  }

  get(telegramId: string): PendingPrompt | undefined {
    return this.prompts.get(telegramId);
  }

  clear(telegramId: string): void {
    this.prompts.delete(telegramId);
  }
}
