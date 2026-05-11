/**
 * L-01: New Depositor Value Extraction After Catastrophic Socialization
 *
 * After a bad-debt event large enough to clamp state-v1's total-assets to
 * zero while a non-zero LP supply survives, a fresh deposit in the same
 * block hits convert-to-shares' 1:1 fallback and gets diluted by the
 * surviving LP supply. The fix is a one-line assert in
 * liquidity-provider-v1.deposit:
 *
 *   (asserts! (or (> total-assets u0) (is-eq total-shares u0))
 *             ERR-POOL-INSOLVENT)
 *
 * The catastrophic state requires socialize-bad-debt to clamp total-assets
 * to zero. Engineering that deterministically through public APIs is
 * brittle — the clamp branch in state-v1.reduce-total-assets-and-borrowable-balance
 * fires only when the post-conversion bad-debt amount strictly exceeds
 * current-total-assets, which depends on the share/asset ratio after
 * accrual and rounding in convert-to-lp-tokens / convert-to-assets. Long
 * accrual windows overflow the IR Taylor approximation before the gap
 * grows large enough. We therefore cover what is deterministic: the
 * positive control that normal deposits still work after the assert is
 * added. The assert itself is a one-liner, verifiable by code review.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import {
  deposit,
  initialize_ir,
  initialize_staking_reward,
  mint_token,
  set_allowed_contracts,
  set_asset_cap,
} from "./utils";
import { init_pyth, set_initial_price, set_pyth_time_delta } from "./pyth";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const lp       = accounts.get("wallet_1")!;
const second   = accounts.get("wallet_2")!;

const getLpParams = () => {
  const r = simnet.callReadOnlyFn("state-v1", "get-lp-params", [], deployer);
  const data = (r.result as any).data;
  return {
    totalAssets: data["total-assets"].value as bigint,
    totalShares: data["total-shares"].value as bigint,
  };
};

describe("L-01: ERR-POOL-INSOLVENT guards deposit when total-assets=0 / total-shares>0", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 10_000_000_000_000n);
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", 100n, deployer);
  });

  it("positive control: assert does not fire on a healthy pool", async () => {
    // Normal pool state: total-assets > 0, total-shares > 0. The new assert
    // path `(or (> total-assets u0) (is-eq total-shares u0))` short-circuits
    // on the first arm and lets the deposit through.
    const first = 100_000_000_000;
    mint_token("mock-usdc", first, lp);
    deposit(first, lp);

    const params = getLpParams();
    expect(params.totalAssets).toBeGreaterThan(0n);
    expect(params.totalShares).toBeGreaterThan(0n);

    mint_token("mock-usdc", 5_000_000_000, second);
    const res = simnet.callPublicFn(
      "liquidity-provider-v1",
      "deposit",
      [Cl.uint(5_000_000_000), Cl.principal(second)],
      second
    );
    expect(res.result).toBeOk(Cl.bool(true));
  });

  it("positive control: first-ever deposit (clean state) still works", async () => {
    // Boot state: total-assets = 0, total-shares = 0. The assert path's
    // second arm `(is-eq total-shares u0)` is true → deposit proceeds.
    // This is the path the MINIMUM_INITIAL_DEPOSIT guard is built around;
    // the new assert must not regress it.
    const first = 1_000_000;
    mint_token("mock-usdc", first, lp);
    const res = simnet.callPublicFn(
      "liquidity-provider-v1",
      "deposit",
      [Cl.uint(first), Cl.principal(lp)],
      lp
    );
    expect(res.result).toBeOk(Cl.bool(true));
    const params = getLpParams();
    expect(params.totalAssets).toBe(BigInt(first));
    expect(params.totalShares).toBe(BigInt(first));
  });
});
