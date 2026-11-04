# Immunefi 97176 - unclamped interest split underflows state-v1

Status: **does not reproduce at live state** (latent there). **Reproduces on a build of
current master** on all three legs, so the clamp still has to ship.

Two separate runs, clearly apart:

- `97176.test.ts` - live USDCx market, Clarinet remote_data fork, pinned block.
- `97176-master.test.ts` - repo contracts (`contracts/` at master `2d44a2d`, same bytes on
  the branch point) deployed into a local simnet, using the report's own fixture.

## How to run

Live fork:

```bash
npm ci
npx vitest run --config vitest.remote.config.js remote-tests/97176.test.ts -- --manifest Clarinet.remote.toml
```

Master build:

```bash
npx vitest run --config vitest.master.config.js
```

The remote manifest pins `initial_height = 9411000` (block time `1793797784`, 2026-11-04) and
requires `SP3M2BYF7RGF8WKW5FVDNJ6WR8D7AR9BHDXAKPXZE.state-v1` plus
`SPSX722NK9V3A8D3CVQT0CDY4EBQ3E9FSDDE61FT.borrower-v1`, `.liquidator-v1`,
`.liquidity-provider-v1`, `.withdrawal-caps-v1`. The resolver pulled the rest of the live graph
(adapter, IR module, staking, USDCx, sBTC, Lazer oracle/decoder) transitively. Contract code and
storage are the deployed values; no contract is modified or redeployed. No mnemonic is used; every
call is `simnet.callPublicFn` with an impersonated principal. The shared Lazer oracle's trusted
signer is rotated to a test key through `set-trusted-signers`, impersonating the principal that
holds `ROLE_GOVERNANCE` in the forked state, so `borrow` can carry a valid price update.

## Live state at the fork

The split's denominator is `open-interest-without-principal = open-interest - total-borrowed-amount`
(`state-v1`). At the fork:

| item | value (base units, 6 decimals) |
|---|---|
| open interest (lp + staked + protocol) | 1,184,345,492,182 |
| total borrowed amount | 1,176,501,918,416 |
| **gap (denominator)** | **7,843,573,766** |
| lp bucket | 1,182,384,598,892 |
| protocol bucket | 1,960,893,290 |
| staked bucket | 0 |

The gap is the pool's accrued-but-unpaid interest. It is the buffer a split has to exceed.

## Why the report's sequence does not arm it here

A borrower's `interest-part` on a full repayment is their own accrued interest, which is a part of
the pool's total accrued interest. With the gap positive, `interest-part <= total accrued interest <
gap + total accrued interest = denominator`. The report's arming step is 12 one-unit dust repayments
on the victim's behalf, which are supposed to shrink the denominator below the victim's interest.

Measured at the fork with the report's sequence:

1. Victim borrows `765,239,831,241` (the live debt bucket). Block 9,411,003.
2. 2,000 empty blocks. Block 9,413,004: gap `7,863,256,411`.
3. Attacker opens a position and borrows `10,000,000`, which accrues
   `1,525,880,332` of interest. Gap `9,389,136,743`.
4. One block with twelve `repay(1, some(victim))` calls, all accepted, each with
   `repaid-debt-shares: u0`. Gap after the block: `9,389,149,475`. The change is `+12,732`,
   which is exactly the block's own accrual; **the dust repayments moved the denominator by zero**.
   On the deployed code the three floor divisions of a one-unit interest part all round to zero, so
   the buckets are untouched.
5. The split that the victim's full repay will execute, computed one block ahead from the deployed
   formula:

| field | value |
|---|---|
| denominator | 9,389,149,475 |
| interest part | 598,928,577 |
| lp part | 449,196,442 (bucket slack 7,041,862,258) |
| protocol part | 149,732,134 (bucket 2,347,287,217) |
| staked part | 0 |

`interest-part` is 6.4% of the denominator. Every part is far inside its bucket.
6. The victim's full repayment succeeds: `765,838,764,815` repaid, `756,161,057,384` debt shares
   burned to zero, the position cleared. The gap falls by exactly the interest part
   (`598,928,577`) to `8,790,228,634`.

So the deployed contracts carry the unclamped split, but the live pool's state keeps the denominator
above any borrower's interest part. Closing the gap with the report's dust is not practical: a
one-unit repayment burns `floor(1 * total-debt-shares / open-interest)` shares, which is zero at the
live ratio, so the most a call can gain is the floor-division remainder of a single base unit (the
twelve measured calls gained zero), while the gap is `7,843,573,766` units. Reaching the report's
state first requires repaying roughly `7,843.57` USDCx of the pool's accrued interest (a derived
figure from the measured gap; a real cost that mostly returns to LPs).

## Master build - reproduces

`97176-master.test.ts` builds the report's fixture (100,000 USDC deposited, 25% protocol reserve,
one victim borrow of 0.10, 500 blocks of interest, an attacker borrow plus twelve
`repay(1, some(victim))` in one block) and then:

| test | outcome |
|---|---|
| control: full repayment without the dust repayments | `(ok true)` |
| leg 1: full repay | panics, `ArithmeticUnderflow` in `state-v1:update-repay-state` |
| leg 2: full liquidation | panics, `ArithmeticUnderflow` in `state-v1:update-liquidate-collateral-state` |
| leg 3: bad-debt socialization | panics, `ArithmeticUnderflow` in `state-v1:socialize-user-bad-debt` |

Buckets before the failing repay: lp `20,015,522`, protocol `7,142`, staked `5,892`. The fixture's
denominator is a few units, which is what the 12 dust repayments can cross.

## What this decides for the republish

- The live borrower-v1 and liquidator-v1 have no clamp of any kind: the three raw parts are floor
  divisions by the denominator and are passed straight to `state-v1`, whose subtractions are native
  unsigned arithmetic.
- On master, `conserve-interest-split` (#109) redistributes only the flooring remainder; it does not
  clamp a raw part that already exceeds its bucket. All three underflow legs still reproduce.
- Therefore the clamp is required in the held republish. The live exposure via this route is latent,
  not demonstrated: it needs the pool's accrued-interest gap driven to near zero first.
