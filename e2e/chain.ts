import {
  makeContractCall,
  makeContractDeploy,
  makeSTXTokenTransfer,
  Cl,
  cvToHex,
  hexToCV,
  cvToString,
  type ClarityValue,
} from "@stacks/transactions";
import type { Account } from "./keys.ts";

const API_URL = "http://localhost:3999";
const NODE_URL = "http://localhost:20443";

export type TxResult = { txid: string; status: "success"; result?: string };
export type TxOutcome = { ok: boolean; txid: string; status: string; repr?: string };

/** Returns the nonce the next transaction for `address` must use, preferring the chain when it is ahead. */
export function nextNonce(cache: Map<string, number>, address: string, chainNonce: number): number {
  const cached = cache.get(address);
  const nonce = cached !== undefined && cached > chainNonce ? cached : chainNonce;
  cache.set(address, nonce + 1);
  return nonce;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Chain {
  readonly apiUrl: string;
  readonly nodeUrl: string;
  readonly deployer: string;
  private nonces = new Map<string, number>();
  private queues = new Map<string, Promise<unknown>>();

  constructor(deployer: string, opts: { apiUrl?: string; nodeUrl?: string } = {}) {
    this.deployer = deployer;
    this.apiUrl = opts.apiUrl ?? API_URL;
    this.nodeUrl = opts.nodeUrl ?? NODE_URL;
  }

  private enqueue<T>(address: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(address) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.queues.set(
      address,
      run.catch(() => undefined),
    );
    return run;
  }

  private async accountNonce(address: string): Promise<number> {
    const res = await fetch(`${this.apiUrl}/v2/accounts/${address}?proof=0`);
    if (!res.ok) throw new Error(`account read failed for ${address}: ${res.status}`);
    const json = (await res.json()) as { nonce: number };
    return json.nonce;
  }

  async nonce(account: Account): Promise<number> {
    const chainNonce = await this.accountNonce(account.address);
    return nextNonce(this.nonces, account.address, chainNonce);
  }

  async call(
    account: Account,
    contract: string,
    fn: string,
    args: ClarityValue[],
    opts: { fee?: bigint; deployer?: string } = {},
  ): Promise<TxResult> {
    const outcome = await this.tryCall(account, contract, fn, args, opts);
    if (!outcome.ok) {
      throw new Error(`${contract}.${fn} aborted (${outcome.status}): ${outcome.repr ?? "no result"}`);
    }
    return { txid: outcome.txid, status: "success", result: outcome.repr };
  }

  async tryCall(
    account: Account,
    contract: string,
    fn: string,
    args: ClarityValue[],
    opts: { fee?: bigint; deployer?: string } = {},
  ): Promise<TxOutcome> {
    return this.enqueue(account.address, async () => {
      const tx = await makeContractCall({
        contractAddress: opts.deployer ?? this.deployer,
        contractName: contract,
        functionName: fn,
        functionArgs: args,
        senderKey: account.privateKey,
        network: "testnet",
        // The default deny mode aborts any call that moves a token, which every market op does.
        postConditionMode: "allow",
        fee: opts.fee ?? 10_000n,
        nonce: await this.nonce(account),
      });
      return this.broadcastAndWait(tx.serializeBytes());
    });
  }

  async transfer(account: Account, recipient: string, amount: bigint): Promise<TxResult> {
    const outcome = await this.enqueue(account.address, async () => {
      const tx = await makeSTXTokenTransfer({
        recipient,
        amount,
        senderKey: account.privateKey,
        network: "testnet",
        fee: 10_000n,
        nonce: await this.nonce(account),
      });
      return this.broadcastAndWait(tx.serializeBytes());
    });
    if (!outcome.ok) throw new Error(`stx transfer aborted: ${outcome.repr ?? outcome.status}`);
    return { txid: outcome.txid, status: "success" };
  }

  async deploy(account: Account, name: string, code: string): Promise<TxResult> {
    const outcome = await this.enqueue(account.address, async () => {
      const tx = await makeContractDeploy({
        contractName: name,
        codeBody: code,
        senderKey: account.privateKey,
        network: "testnet",
        fee: 100_000n,
        nonce: await this.nonce(account),
      });
      return this.broadcastAndWait(tx.serializeBytes());
    });
    if (!outcome.ok) throw new Error(`${name} deploy aborted: ${outcome.repr ?? outcome.status}`);
    return { txid: outcome.txid, status: "success" };
  }

  private async broadcastAndWait(bytes: Uint8Array): Promise<TxOutcome> {
    const res = await fetch(`${this.nodeUrl}/v2/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`broadcast rejected (${res.status}): ${body}`);
    const txid = JSON.parse(body) as string;
    return this.waitTx(txid);
  }

  async waitTx(txid: string, timeoutMs = 180_000): Promise<TxOutcome> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await fetch(`${this.apiUrl}/extended/v1/tx/${txid}`, { redirect: "follow" });
      if (res.ok) {
        const json = (await res.json()) as {
          tx_status: string;
          tx_result?: { repr?: string };
        };
        if (json.tx_status !== "pending") {
          return {
            ok: json.tx_status === "success",
            txid,
            status: json.tx_status,
            repr: json.tx_result?.repr,
          };
        }
      }
      await sleep(250);
    }
    throw new Error(`transaction ${txid} not confirmed in ${timeoutMs}ms`);
  }

  async blockHeight(): Promise<number> {
    const res = await fetch(`${this.apiUrl}/v2/info`);
    const json = (await res.json()) as { stacks_tip_height: number };
    return json.stacks_tip_height;
  }

  async waitBlocks(count: number, timeoutMs = 180_000): Promise<number> {
    return this.enqueue("__blocks__", async () => {
      const target = (await this.blockHeight()) + count;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const height = await this.blockHeight();
        if (height >= target) return height;
        await sleep(250);
      }
      throw new Error(`chain did not advance ${count} blocks in ${timeoutMs}ms`);
    });
  }

  async read(contract: string, fn: string, args: ClarityValue[] = [], sender?: string): Promise<ClarityValue> {
    const res = await fetch(`${this.apiUrl}/v2/contracts/call-read/${this.deployer}/${contract}/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: sender ?? this.deployer,
        arguments: args.map((arg) => cvToHex(arg)),
      }),
    });
    if (!res.ok) throw new Error(`read ${contract}.${fn} failed: ${res.status}`);
    const json = (await res.json()) as { okay: boolean; result?: string; cause?: string };
    if (!json.okay || !json.result) {
      throw new Error(`read ${contract}.${fn} errored: ${json.result ?? json.cause ?? "unknown"}`);
    }
    return hexToCV(json.result);
  }
}

export const u = (value: number | bigint) => Cl.uint(BigInt(value));
export const principal = (address: string) => Cl.principal(address);
export const contractPrincipal = (address: string, name: string) => Cl.contractPrincipal(address, name);
export const cv = (value: ClarityValue) => cvToString(value);
