import { Cl, type ClarityValue } from "@stacks/transactions";
import type { Chain, TxResult } from "./chain.ts";
import type { Account } from "./keys.ts";
import { priceUpdate } from "./prices.ts";

const cp = (chain: Chain, name: string) => Cl.contractPrincipal(chain.deployer, name);
const buffer = (bytes: Uint8Array) => Cl.buffer(bytes);

export async function deposit(chain: Chain, actor: Account, amount: bigint, recipient = actor.address): Promise<TxResult> {
  return chain.call(actor, "liquidity-provider-v1", "deposit", [Cl.uint(amount), Cl.principal(recipient)]);
}

export async function withdraw(chain: Chain, actor: Account, amount: bigint, recipient = actor.address): Promise<TxResult> {
  return chain.call(actor, "liquidity-provider-v1", "withdraw", [Cl.uint(amount), Cl.principal(recipient)]);
}

export async function redeem(chain: Chain, actor: Account, shares: bigint): Promise<TxResult> {
  return chain.call(actor, "liquidity-provider-v1", "redeem", [Cl.uint(shares), Cl.principal(actor.address)]);
}

export async function addCollateral(chain: Chain, actor: Account, token: string, amount: bigint): Promise<TxResult> {
  return chain.call(actor, "borrower-v1", "add-collateral", [cp(chain, token), Cl.uint(amount), Cl.none()]);
}

export async function removeCollateral(chain: Chain, actor: Account, token: string, amount: bigint): Promise<TxResult> {
  return chain.call(actor, "borrower-v1", "remove-collateral", [
    buffer(await priceUpdate(chain)),
    cp(chain, token),
    Cl.uint(amount),
    Cl.none(),
  ]);
}

export async function borrow(chain: Chain, actor: Account, amount: bigint): Promise<TxResult> {
  return chain.call(actor, "borrower-v1", "borrow", [buffer(await priceUpdate(chain)), Cl.uint(amount), Cl.none()]);
}

export async function repay(chain: Chain, actor: Account, amount: bigint, onBehalfOf?: string): Promise<TxResult> {
  return chain.call(actor, "borrower-v1", "repay", [
    Cl.uint(amount),
    onBehalfOf ? Cl.some(Cl.principal(onBehalfOf)) : Cl.none(),
  ]);
}

export async function liquidate(
  chain: Chain,
  liquidator: Account,
  token: string,
  user: string,
  repayAmount: bigint,
  minCollateralExpected = 0n,
): Promise<TxResult> {
  return chain.call(liquidator, "liquidator-v1", "liquidate-collateral", [
    buffer(await priceUpdate(chain)),
    cp(chain, token),
    Cl.principal(user),
    Cl.uint(repayAmount),
    Cl.uint(minCollateralExpected),
  ]);
}

export type BatchEntry = { user: string; repayAmount: bigint; minCollateralExpected: bigint };

export async function batchLiquidate(
  chain: Chain,
  liquidator: Account,
  token: string,
  entries: BatchEntry[],
): Promise<TxResult> {
  return chain.call(liquidator, "liquidator-v1", "batch-liquidate", [
    buffer(await priceUpdate(chain)),
    cp(chain, token),
    Cl.list(
      entries.map((entry) =>
        Cl.some(
          Cl.tuple({
            user: Cl.principal(entry.user),
            "liquidator-repay-amount": Cl.uint(entry.repayAmount),
            "min-collateral-expected": Cl.uint(entry.minCollateralExpected),
          }),
        ),
      ),
    ),
  ]);
}

export async function stake(chain: Chain, actor: Account, lpTokens: bigint): Promise<TxResult> {
  return chain.call(actor, "staking-v1", "stake", [Cl.uint(lpTokens)]);
}

export async function initiateUnstake(chain: Chain, actor: Account, stakedLpTokens: bigint): Promise<TxResult> {
  return chain.call(actor, "staking-v1", "initiate-unstake", [Cl.uint(stakedLpTokens)]);
}

export async function finalizeUnstake(chain: Chain, actor: Account, index: bigint): Promise<TxResult> {
  return chain.call(actor, "staking-v1", "finalize-unstake", [Cl.uint(index)]);
}

export async function flashLoan(
  chain: Chain,
  actor: Account,
  amount: bigint,
  callback: string,
  data: ClarityValue = Cl.none(),
): Promise<TxResult> {
  return chain.call(actor, "flash-loan-v1", "flash-loan", [Cl.uint(amount), cp(chain, callback), data]);
}

/** Asserts that `action` aborts with a specific contract error code (e.g. "u20002"). */
export async function expectAbort(action: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(code)) return;
    throw new Error(`expected abort ${code}, got: ${message}`);
  }
  throw new Error(`expected abort ${code}, but the call succeeded`);
}
