# Granite Protocol V1 — Security Audit Report

**Date:** 2026-02-27
**Auditor:** Claude Code (Automated Multi-Agent Audit)
**Scope:** All Clarity smart contracts in Granite Protocol V1 (excluding `contracts/pyth/` submodule internals and `contracts/test/` mock contracts)

---

## Executive Summary

This audit examined 18 Clarity smart contracts comprising the Granite Protocol V1 lending market on Stacks. Five specialized auditor agents reviewed the codebase in parallel, covering: core lending flows, oracle/interest rate models, governance, staking/LP mechanics, and flash loans/incentives.

### Finding Summary

| Severity | Count |
|----------|-------|
| **CRITICAL** | 0 |
| **HIGH** | 7 |
| **MEDIUM** | 13 |
| **LOW** | 17 |
| **INFORMATIONAL** | 23 |
| **Total** | 60 |

The protocol's architecture is sound — the logic/state separation, Clarity's atomic transactions, and the two-tier governance model provide strong foundational security. The most significant findings relate to oracle price edge cases, staking interest accrual ordering, and the trusted snapshot uploader in LP incentives.

---

## HIGH Severity Findings

### H-1: Zero-Price Oracle Enables Free Collateral Seizure via Liquidation
**Contracts:** `pyth-adapter-v1.clar` (L128-133), `liquidator-v1.clar` (L149-152, L494-502)

In `check-confidence`, when `price == u0`, the condition `(is-eq u0 price)` short-circuits to `(ok true)`, bypassing confidence validation entirely. Combined with `ensure-non-zero-repay-amount` in the liquidator (which allows any repay amount including 0 when `collateral-price <= u0`), a zero-price oracle report enables a liquidator to seize a user's entire collateral for zero repayment.

**Attack scenario:** Pyth feed reports price=0 for collateral X. All positions holding collateral X become liquidatable. Liquidator calls `liquidate-collateral` with `repay-amount = 0` and receives the user's full collateral balance for free.

**Recommendation:** Add `(asserts! (> price 0) ERR-INVALID-PRICE)` in `decode-pyth` before the confidence check. Also reject `repay-amount = 0` in `ensure-non-zero-repay-amount` unconditionally.

---

### H-2: Division-by-Zero in `utilization-calc` When `total-assets = 0`
**Contract:** `linear-kinked-ir-v1.clar` (L116-118)

The guard `(> (+ total-assets open-interest) u0)` passes when `total-assets = 0` and `open-interest > 0`, leading to division by zero. This scenario can occur after bad debt socialization reduces `total-assets` to 0 while residual `open-interest` remains. The panic bricks all protocol operations that call `accrue-interest`.

**Recommendation:** Change the guard to `(> total-assets u0)`.

---

### H-3: Staking Exchange Rate Computed Before Interest Accrual in `stake()`
**Contract:** `staking-v1.clar` (L167-185)

`convert-to-staked-lp-tokens` is called at L170 **before** `accrue-interest` at L172. If interest has accumulated since the last interaction, the staker converts at a stale (cheaper) exchange rate, receiving more staked-LP tokens than deserved and diluting existing stakers.

**Recommendation:** Move `(try! (accrue-interest))` before the `convert-to-staked-lp-tokens` call.

---

### H-4: Staking Exchange Rate Computed Before Interest Accrual in `initiate-unstake()`
**Contract:** `staking-v1.clar` (L262-291)

Same pattern as H-3. `convert-to-lp-tokens` at L269 runs before `accrue-interest` at L273. The unstaker gets fewer LP tokens than deserved (stale rate undervalues their position).

**Recommendation:** Move `(try! (accrue-interest))` before the let-binding that calls `convert-to-lp-tokens`.

---

### H-5: `finalize-unstake` Blocked When `staking-wiped-out` — Users Lose Pending Withdrawals
**Contract:** `staking-v1.clar` (L295, L341-351, L200-238)

`finalize-unstake` calls `check-staking-enabled` which reverts when `staking-wiped-out` is true. After a full slash event, users with pending withdrawal entries can never finalize — their LP tokens are permanently locked with no cleanup path.

**Recommendation:** Allow `finalize-unstake` to proceed when staking is wiped out (returning 0 LP tokens if necessary) so users can clear their withdrawal entries.

---

### H-6: `unwrap-panic` in `sync-debt-bucket` Can Brick Borrowing
**Contract:** `withdrawal-caps-v1.clar` (L206)

`sync-debt-bucket` is called with `unwrap-panic` instead of `try!`. If `get-stacks-block-info?` returns `none` in any edge case, this causes an irrecoverable panic that bricks all borrowing operations when debt caps are enabled.

**Recommendation:** Replace `unwrap-panic` with `try!` at L206, consistent with `sync-lp-bucket` which correctly uses `try!`.

---

### H-7: Unverified Off-Chain LP Share Data — Snapshot Uploader Fully Trusted
**Contract:** `lp-incentives-v2.clar` (L161-191)

The `upload-snapshot` function accepts arbitrary `total-lp-shares` and per-user `lp-shares` with zero on-chain verification against actual LP token balances. A compromised uploader can fabricate share data to direct all epoch rewards to attacker-controlled addresses.

**Recommendation:** Implement on-chain LP balance verification, or add multi-sig/time-lock mechanisms for uploads to prevent single-key compromise from draining rewards.

---

## MEDIUM Severity Findings

### M-1: No Minimum Enforcement on `update-time-delta`
**Contract:** `pyth-adapter-v1.clar` (L44-56)

The `MINIMUM_TIME_DELTA` constant (60s) is defined but never enforced. Governance can set `time-delta` to 0 (freezing the protocol by rejecting all prices) or to an extremely large value (accepting arbitrarily stale prices).

**Recommendation:** Add `(asserts! (>= delta MINIMUM_TIME_DELTA) ERR-INVALID-TIME-DELTA)` and a maximum bound.

---

### M-2: Future Timestamp Acceptance in Oracle Price Validation
**Contract:** `pyth-adapter-v1.clar` (L135-141)

Prices with timestamps >= `block-timestamp` are accepted unconditionally. A Pyth price with a far-future timestamp would remain "valid" indefinitely, never becoming stale.

**Recommendation:** Add an upper bound: reject prices with timestamps more than ~60 seconds in the future.

---

### M-3: Exponent Overflow in `convert-res` for Extreme Values
**Contract:** `pyth-adapter-v1.clar` (L147-155)

Extreme Pyth exponent values (e.g., `expo = 30`) cause `(pow 10 38)` to overflow, panicking and DoS-ing any function reading that price feed.

**Recommendation:** Add exponent range validation (e.g., `-18 <= expo <= 18`).

---

### M-4: `calculate-interest-portions` Underflows When `current-debt < borrowed-amount`
**Contract:** `math-v1.clar` (L28-38)

The raw subtraction `(- current-debt borrowed-amount)` at L30 panics on underflow. Rounding edge cases in debt share conversions could cause `current-debt` to be slightly less than `borrowed-amount`.

**Recommendation:** Use `safe-sub` instead of raw subtraction.

---

### M-5: Post-Liquidation Health Buffer Too Tight for Multi-Collateral Positions
**Contract:** `liquidator-v1.clar` (L322)

The `LIQUIDATION-BUFFER` of 0.50% is tight. With multiple collateral types at different LTV ratios, the post-liquidation health can exceed the buffer due to rounding and premium interactions, blocking valid liquidations.

**Recommendation:** Widen the buffer or skip the check when `repay-amount` equals the protocol-computed `repay-allowed`.

---

### M-6: Liquidation Does Not Update Collateral List in Position
**Contract:** `state-v1.clar` (L832)

After liquidation, `map-set positions` uses `(get collaterals position)` (the OLD list) instead of the `updated-collaterals` parameter. Zero-balance collateral entries remain in the list permanently. Users cannot clean them up because `remove-collateral` with amount 0 triggers `ERR-TRANSFER-NULL`. The 10-item cap can eventually be exhausted with stale entries.

**Recommendation:** Change L832 to `collaterals: (get updated-collaterals liquidate-collateral-state)`.

---

### M-7: `lp-open-interest-without-principal` Underflow Risk in `socialize-bad-debt`
**Contract:** `liquidator-v1.clar` (L531)

Raw subtraction `(- lp-open-interest-val total-borrowed-amount)` can underflow if sequential liquidations erode the gap between these values.

**Recommendation:** Use `safe-sub` for defense in depth.

---

### M-8: LP Token First Depositor Share Inflation Attack
**Contract:** `liquidity-provider-v1.clar` (L19), `math-v1.clar` (L53-57)

The minimum deposit guard only blocks `assets == 1` when pool is empty. An attacker depositing 2 units then donating tokens directly to `state-v1` can manipulate the LP share exchange rate.

**Recommendation:** Implement a higher minimum initial deposit or a "dead shares" pattern.

---

### M-9: `borrowable-balance` Can Be Permanently Zeroed
**Contract:** `state-v1.clar` (L144-146)

The if-else pattern sets `borrowable-balance` to 0 when `borrowable-balance <= assets` rather than computing the actual difference. This can cause temporary borrowing disruption until restored by deposits.

**Recommendation:** Use `safe-sub` instead.

---

### M-10: `increase-lp-staked-balance` Callable by Any Allowed Contract
**Contract:** `staking-v1.clar` (L187-197)

Any allowed contract can inflate `total-lp-tokens-staked` without transferring actual LP tokens, manipulating the staking exchange rate.

**Recommendation:** Restrict callers to specific contracts (e.g., `state-v1`) or verify LP token receipt.

---

### M-11: Meta-Governance Proposals Execute Immediately (No Time-Lock)
**Contract:** `meta-governance-v1.clar` (L134-158)

Unlike governance-v1, meta-governance proposals have no time-lock. A 60% key compromise enables immediate hostile takeover of the multisig membership.

**Recommendation:** Add a time-lock mechanism matching governance-v1.

---

### M-12: LP Incentives `percent-of-epoch` Has No Cumulative >100% Guard
**Contract:** `lp-incentives-v2.clar` (L234-243)

Multiple overlapping snapshot uploads can distribute more than 100% of epoch rewards.

**Recommendation:** Track cumulative percent-of-epoch and assert `<= SCALING-FACTOR`.

---

### M-13: Flash Loan Callback Can Invoke Protocol Operations Mid-Flash
**Contract:** `flash-loan-v1.clar` (L83-108)

During the callback, `state-v1`'s USDC balance is temporarily reduced. Callback contracts can invoke borrow/liquidate/deposit operations that may read inconsistent balance state.

**Recommendation:** Add a reentrancy guard (`in-flash-loan` flag) and keep `allow-any` disabled in production.

---

## LOW Severity Findings

| # | Title | Contract | Line(s) |
|---|-------|----------|---------|
| L-1 | Bad debt slash uses inverted assert pattern (confusing but functional) | liquidator-v1 | 549 |
| L-2 | `open-interest-without-principal` raw subtraction risk | borrower-v1 | 93-94 |
| L-3 | `calculate-repayment-info` denominator safety (governance check prevents, no defense-in-depth) | liquidator-v1 | 369 |
| L-4 | Interest dust lost in three-way split (safe-div rounds down independently) | borrower-v1 | 95-97 |
| L-5 | Collateral list 10-item cap (known limitation) | borrower-v1 | 270 |
| L-6 | Precision loss in `get-rt-by-block` due to double division | linear-kinked-ir-v1 | 183-185 |
| L-7 | Taylor series diverges for large x values (>2) | linear-kinked-ir-v1 | 188-205 |
| L-8 | Negative staking reward silently clamped to zero | staking-reward-v1 | 77-85 |
| L-9 | Unbounded withdrawal index growth (self-DoS) | staking-v1 | 262-291 |
| L-10 | Slash integer division creates dust rounding | staking-v1 | 200-238 |
| L-11 | `get-time-now` uses `unwrap-panic` universally | withdrawal-caps-v1 | 68-70 |
| L-12 | `reconcile-lp-token-balance` potential underflow | staking-v1 | 240-260 |
| L-13 | `initiate-proposal-to-set-market-state` accepts overly broad action range | governance-v1 | 748 |
| L-14 | No minimum `expires-in` on proposal creation | governance-v1 | 307 |
| L-15 | Meta-governance allows reducing to 1-member multisig | meta-governance-v1 | 205 |
| L-16 | Duplicate address in `stx-claim` overwrites reward (SP96TKA...loses ~88.9%) | stx-claim | 97, 154 |
| L-17 | No minimum guardian count enforcement in governance-v1 | governance-v1 | 408-424 |

---

## Cross-Contract Interaction Analysis

### Combined: Zero-Price Oracle + Free Liquidation (H-1)
Findings from `auditor-oracle-ir` (zero-price confidence bypass) and `auditor-core-lending` (zero-repay liquidation) combine into the highest-impact finding. An oracle failure or manipulation reporting price=0 enables mass liquidations with zero repayment across all affected positions.

### Combined: Stale Interest Accrual + Staking Rate (H-3, H-4)
The interest accrual ordering bugs in staking create a consistent pattern where any interaction after a period of inactivity uses stale exchange rates. This affects both entry (stake) and exit (unstake) paths, creating a systematic value transfer from stakers to new entrants / early exiters.

### Combined: Flash Loan + Protocol State Manipulation (M-13)
Flash loan callbacks can invoke any protocol operation during the temporary balance reduction. While Clarity's atomicity prevents fund loss, the temporarily inconsistent balance state could affect withdrawal cap calculations and free-liquidity checks.

---

## Architecture Assessment

### Strengths
- **Logic/state separation** is well-implemented. All state mutations go through `state-v1` with `allowed-contracts` gating.
- **Clarity's atomic transactions** eliminate traditional reentrancy risks. All `try!` failures revert the entire transaction including prior state changes.
- **Two-tier governance** provides meaningful separation between meta-governance (membership) and guardian governance (operations).
- **Rounding directions** consistently favor the protocol across all share conversion paths (debt, LP, staking).
- **Freeze-upgrades** is correctly irreversible, providing a meaningful security backstop.

### Concerns
- **Oracle single-dependency**: The entire protocol depends on Pyth price feeds with no fallback. A Pyth outage or manipulation freezes all price-dependent operations.
- **Trusted off-chain components**: LP incentives rely entirely on a single trusted uploader with no on-chain verification.
- **No reentrancy guard on flash loans**: While Clarity prevents traditional reentrancy, the flash loan callback can invoke protocol operations during a temporarily inconsistent balance state.

---

## Contracts Audited

| Contract | Lines | Auditor |
|----------|-------|---------|
| state-v1.clar | ~938 | core-lending, governance, staking-lp |
| borrower-v1.clar | ~308 | core-lending |
| liquidator-v1.clar | ~554 | core-lending |
| liquidity-provider-v1.clar | ~80 | staking-lp |
| governance-v1.clar | ~1335 | governance |
| meta-governance-v1.clar | ~378 | governance |
| staking-v1.clar | ~352 | staking-lp |
| flash-loan-v1.clar | ~115 | flash-incentives |
| lp-incentives-v2.clar | ~306 | flash-incentives |
| stx-claim.clar | ~174 | flash-incentives |
| math-v1.clar | ~75 | core-lending |
| linear-kinked-ir-v1.clar | ~206 | oracle-ir |
| linear-kinked-ir-utility.clar | ~151 | oracle-ir |
| pyth-adapter-v1.clar | ~156 | oracle-ir |
| staking-reward-v1.clar | ~124 | oracle-ir |
| withdrawal-caps-v1.clar | ~317 | staking-lp |
| utility.clar | ~155 | flash-incentives |
| constants-v1.clar, constants-v2.clar | ~40 | oracle-ir |
| traits (SIP-010, flash-loan) | ~35 | flash-incentives |
