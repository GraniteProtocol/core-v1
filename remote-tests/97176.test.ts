// Immunefi 97176 - unclamped proportional interest split underflows immutable state-v1.
//
// This file runs against the live USDCx market contracts and on-chain state, forked at a
// pinned block height (Clarinet remote_data). It tests the report's own arming sequence:
// a victim with accrued interest, dust repayments on the victim's behalf, then a full
// repay. The master-build run (97176-master.test.ts) is the separate control that shows
// the same split does underflow where the pool's accrued-interest gap is zero.
//
// Fork: initial_height 9411000 (2026-11-04).
// Anchor state-v1: SP3M2BYF7RGF8WKW5FVDNJ6WR8D7AR9BHDXAKPXZE
// Live market:     SPSX722NK9V3A8D3CVQT0CDY4EBQ3E9FSDDE61FT

import { describe, expect, it } from "vitest";
import { tx } from "@stacks/clarinet-sdk";
import { Cl, cvToJSON } from "@stacks/transactions";
import { buildEvmUpdate, buildLazerPayload, PROP, TEST_PUBKEY } from "../tests/lazer";

const ANCHOR = "SP3M2BYF7RGF8WKW5FVDNJ6WR8D7AR9BHDXAKPXZE";
const MARKET = "SPSX722NK9V3A8D3CVQT0CDY4EBQ3E9FSDDE61FT";
const ORACLE = "SPMV5HDZ4EMB8XY7HAYT3XW0DF7DZ4E8XEG2J1T8";
const USDCX = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";
const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const SBTC_ADDR = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";

const VICTIM = "SP1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2XG1V316";
const ATTACKER = "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7";

const COLLATERAL = 20_000_000_000n; // 200 sBTC
const SBTC_PRICE = 10_000_000_000_000n;
const USDCX_PRICE = 100_000_000n;
const VICTIM_BORROW = 765_239_831_241n; // the live debt bucket at the fork
const WAIT_BLOCKS = 2000;

const read = (contract: string, fn: string, args: any[] = []) =>
  simnet.callReadOnlyFn(contract, fn, args, ANCHOR).result as any;
const readUint = (contract: string, fn: string, args: any[] = []): bigint => {
  const v = (read(contract, fn, args) as any).value;
  return (typeof v === "bigint" ? v : v.value) as bigint;
};
const readUintOk = (contract: string, fn: string, args: any[] = []): bigint =>
  ((read(contract, fn, args) as any).value as any).value as bigint;

// cvToJSON wraps responses and optionals one level deeper than a bare tuple.
const cvJson = (contract: string, fn: string, args: any[] = []) =>
  cvToJSON(read(contract, fn, args) as any) as any;
const fieldsOf = (j: any) => (j.value && j.value.type ? j.value.value : j.value);

const buckets = () => {
  const oi = fieldsOf(cvJson(`${ANCHOR}.state-v1`, "get-open-interest"));
  return {
    lp: BigInt(oi["lp-open-interest"].value),
    staked: BigInt(oi["staked-open-interest"].value),
    protocol: BigInt(oi["protocol-open-interest"].value),
  };
};
const openInterest = () => {
  const b = buckets();
  return b.lp + b.staked + b.protocol;
};
const totalBorrowed = () =>
  BigInt(fieldsOf(cvJson(`${ANCHOR}.state-v1`, "get-borrow-repay-params", [Cl.principal(VICTIM)]))["total-borrowed-amount"].value);
const accruedGap = () => openInterest() - totalBorrowed(); // OI - TB

const format = (v: bigint) => `${v} (${(Number(v) / 1e6).toFixed(6)} USDCx)`;

function priceUpdate(): Uint8Array {
  const now = simnet.getBlockTime();
  return buildEvmUpdate(
    buildLazerPayload({
      timestamp: now * 1_000_000n,
      channel: 1,
      feeds: [
        { id: 7, props: [[PROP.Price, USDCX_PRICE], [PROP.Exponent, -8n], [PROP.PublisherCount, 1n], [PROP.Confidence, 1n]] },
        { id: 1, props: [[PROP.Price, SBTC_PRICE], [PROP.Exponent, -8n], [PROP.PublisherCount, 1n], [PROP.Confidence, 1n]] },
      ],
    })
  );
}

const borrow = (user: string, amount: bigint) =>
  simnet.callPublicFn(`${MARKET}.borrower-v1`, "borrow", [Cl.buffer(priceUpdate()), Cl.uint(amount), Cl.none()], user);

function connectOracle() {
  simnet.callPublicFn(
    `${ORACLE}.pyth-lazer-oracle`,
    "set-trusted-signers",
    [Cl.list([Cl.tuple({ pubkey: Cl.buffer(TEST_PUBKEY), "expires-at": Cl.uint(100_000_000_000n) })])],
    ORACLE
  );
}

function fundCollateral(user: string) {
  simnet.executeCommand(`::mint_ft ${SBTC}.sbtc-token ${user} ${COLLATERAL}`);
  const r = simnet.callPublicFn(
    `${MARKET}.borrower-v1`,
    "add-collateral",
    [Cl.contractPrincipal(SBTC_ADDR, "sbtc-token"), Cl.uint(COLLATERAL), Cl.none()],
    user
  );
  expect(r.result).toBeOk(Cl.bool(true));
}

// Mirror of the deployed borrower-v1 split, one block ahead (the block the call will mine).
function splitForFullRepay(user: string) {
  const ap = fieldsOf(cvJson(`${ANCHOR}.state-v1`, "get-accrue-interest-params"));
  const pos = fieldsOf(cvJson(`${ANCHOR}.state-v1`, "get-user-position", [Cl.principal(user)]));
  const shares = BigInt(pos["debt-shares"].value);
  const borrowed = BigInt(pos["borrowed-amount"].value);
  const activeStaked = readUint(`${MARKET}.staking-v1`, "get-active-staked-lp-tokens");
  const rewardPct = readUint(`${ANCHOR}.staking-reward-v1`, "calculate-staking-reward-percentage", [Cl.uint(activeStaked)]);
  const acc = fieldsOf(cvJson(`${MARKET}.linear-kinked-ir-v1`, "accrue-interest", [
    Cl.uint(BigInt(ap["last-accrued-block-time"].value) + 600n),
    Cl.uint(BigInt(ap["lp-interest"].value)),
    Cl.uint(BigInt(ap["staked-interest"].value)),
    Cl.uint(rewardPct),
    Cl.uint(BigInt(ap["protocol-interest"].value)),
    Cl.uint(BigInt(ap["protocol-reserve-percentage"].value)),
    Cl.uint(BigInt(ap["total-assets"].value)),
  ]));
  const lp = BigInt(acc["lp-open-interest"].value);
  const staked = BigInt(acc["staked-open-interest"].value);
  const protocol = BigInt(acc["protocol-open-interest"].value);
  const oi = lp + staked + protocol;
  const tb = totalBorrowed();
  const tds = BigInt(fieldsOf(cvJson(`${ANCHOR}.state-v1`, "get-debt-params"))["total-debt-shares"].value);
  const currentDebt = (oi * shares + tds - 1n) / tds;
  const interestPart = currentDebt > borrowed ? currentDebt - borrowed : 0n;
  const oiwp = oi > tb ? oi - tb : 0n;
  const lpIwp = lp > tb ? lp - tb : 0n;
  const safeDiv = (a: bigint, b: bigint) => (b === 0n ? 0n : a / b);
  return {
    oi, tb, oiwp, tds, currentDebt, interestPart,
    lp, staked, protocol, lpIwp,
    lpPart: safeDiv(interestPart * lpIwp, oiwp),
    stakedPart: safeDiv(interestPart * staked, oiwp),
    protocolPart: safeDiv(interestPart * protocol, oiwp),
  };
}

const show = (o: Record<string, bigint>) =>
  JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

describe("Immunefi 97176 at live USDCx state", () => {
  it("the live pool carries an accrued-interest gap that bounds the split", () => {
    console.log("FORK", {
      block: simnet.blockHeight,
      openInterest: format(openInterest()),
      totalBorrowed: format(totalBorrowed()),
      gap: format(accruedGap()),
      buckets: show(buckets()),
    });
    expect(accruedGap()).toBeGreaterThan(0n);
  });

  it("the report's dust sequence does not move the gap and the full repay succeeds", () => {
    connectOracle();
    fundCollateral(VICTIM);
    fundCollateral(ATTACKER);

    const b = borrow(VICTIM, VICTIM_BORROW);
    console.log("VICTIM BORROW:", JSON.stringify(b.result));
    expect(b.result).toBeOk(Cl.bool(true));

    simnet.mineEmptyBlocks(WAIT_BLOCKS);
    console.log("AFTER WAIT", {
      block: simnet.blockHeight,
      gap: format(accruedGap()),
      position: JSON.stringify(read(`${ANCHOR}.state-v1`, "get-user-position", [Cl.principal(VICTIM)])),
    });

    // Attacker opens a dust position, then sends 12 one-unit repayments on the victim's behalf.
    simnet.executeCommand(`::mint_ft ${USDCX}.usdcx-token ${ATTACKER} 1000000`);
    const a = borrow(ATTACKER, 10_000_000n);
    expect(a.result).toBeOk(Cl.bool(true));

    const gapBefore = accruedGap();
    const dust = simnet.mineBlock(
      Array.from({ length: 12 }, () =>
        tx.callPublicFn(`${MARKET}.borrower-v1`, "repay", [Cl.uint(1n), Cl.some(Cl.principal(VICTIM))], ATTACKER)
      )
    );
    dust.forEach((r) => expect(r.result).toBeOk(Cl.bool(true)));
    const gapAfterDust = accruedGap();
    console.log("DUST 12x repay(1, victim)", {
      gapBefore: gapBefore.toString(),
      gapAfter: gapAfterDust.toString(),
      gapDelta: (gapAfterDust - gapBefore).toString(),
    });

    const split = splitForFullRepay(VICTIM);
    console.log("SPLIT AT FULL REPAY (one block ahead):", show(split));

    expect(split.interestPart).toBeLessThan(split.oiwp);
    expect(split.protocolPart).toBeLessThanOrEqual(split.protocol);
    expect(split.lpPart).toBeLessThanOrEqual(split.lpIwp);
    expect(split.stakedPart).toBeLessThanOrEqual(split.staked);

    simnet.executeCommand(`::mint_ft ${USDCX}.usdcx-token ${VICTIM} 1000000000000`);
    const repay = simnet.callPublicFn(
      `${MARKET}.borrower-v1`,
      "repay",
      [Cl.uint(split.currentDebt + 1_000_000n), Cl.none()],
      VICTIM
    );
    console.log("FULL REPAY:", JSON.stringify(repay.result), {
      gapAfterRepay: format(accruedGap()),
      positionAfter: JSON.stringify(read(`${ANCHOR}.state-v1`, "get-user-position", [Cl.principal(VICTIM)])),
      victimUsdcx: JSON.stringify(readUintOk(USDCX, "get-balance", [Cl.principal(VICTIM)])),
    });
    expect(repay.result).toBeOk(Cl.bool(true));
  });
});
