# Immunefi 97356 — Reproduction Status: Reproduces on simnet; latent at live state

## Status
**Reproduces on a local simnet build of current master with seeded stakers; latent at live state.**
The deployed module is unfunded — measured this run at the remote_data fork block
9,411,225, active staked LP tokens = 0 and total staked LP tokens = 0, so the latch
has never fired. The configuration the report needs (small active stake `A`, large
unbonding queue `W`) does not exist on the live deployment, so the defect cannot be
demonstrated at live state without first moving stakers into the queue. On simnet with
seeded stakers the floor/ceil split reproduces exactly as the report describes.

## Live state (remote_data fork at block 9,411,225)
| Reading | Value |
|---|---|
| `SP119QJ4...staking-v1.get-active-staked-lp-tokens` | 0 |
| `SP119QJ4...staking-v1.get-total-staked-lp-tokens` | 0 |
| `SP119QJ4...staking-v1.is-staking-wiped-out` | false |
| `SP35E2BB...state-v1.get-balance(staking-v1)` | 0 |

The staking contract's LP token balance is 0. `state-v1` has no `get-supply`
read-only function, so that probe errored; the balance read is the meaningful one.

Live addresses used:
- staking: `SP119QJ4NVE3RQP8RXJVW5EXAV3XD4CJZWRCEEAAR.staking-v1`
- state: `SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1`

## Simnet reproduction — measured numbers

Harness: `tests/poc-97356-staking-wipeout.test.ts`, run alongside the master suite with
`npx vitest run tests/poc-97356-staking-wipeout.test.ts`. The harness plays the role of
`liquidator-v1`: a wallet principal is registered as an allowed contract via
`state-v1.set-allowed-contract` (the same gate the real periphery passes), and drives
`slash-total-staked-lp-tokens` directly. Setup mirrors the reporter's PoC: default
initialization stakes `MINIMUM_INITIAL_STAKE = u1000` and sends the staked shares to
`NULL_ADDRESS`, so `A = 1000` dust is the only permanent active stake.

### Test 1 — premature wipeout and the three reverts
1. Initialization leaves `A = 1000` dust, total = 1000.
2. A staker stakes `1,000,000` LP and `initiate-unstake`s all of it:
   `A = 1000`, `W = 1,000,000`, total = `1,001,000`.
3. `slash-total-staked-lp-tokens(1)` is called 1,000 times. Every call has
   `floor(1 * W / (A+W)) = 0`, so each removes 1 from `A` and 0 from `W`.
   After the grind: `A = 0`, `W = 1,000,000`, total = `1,000,000`,
   `is-staking-wiped-out = true`. The latch fires on the 1,000th slash.
4. The three functions that call `check-staking-enabled` revert with
   `ERR-STAKING-WIPED-OUT (u60010)`:
   - `stake` → `(err u60010)`
   - `initiate-unstake` → `(err u60010)`
   - `reconcile-lp-token-balance` → `(err u60010)`
5. The unbonding staker still calls `finalize-unstake` (it deliberately omits the
   staking-enabled check) and receives the full `1,000,000` LP tokens, unslashed.

### Test 2 — control: active survives, no latch
Same setup, but only 999 slashes: `A = 1`, `W = 1,000,000`, total = `1,000,001`.
`is-staking-wiped-out = false`, and `stake` still succeeds. The latch is caused by
`A` reaching zero, not by the grind itself.

### Test 3 — socialization reads the queue as empty
After the latch (`A = 0`, `W = 1,000,000`, total = `1,000,000`), a bad-debt borrower
position is liquidated through `liquidator-v1.liquidate-collateral`. The liquidation
reaches `socialize-bad-debt`, which reads `staked-lp-tokens = get-total-staked-lp-tokens`
(1,000,000) but overrides it with `effective-staked-lp-tokens = u0` because
`is-wiped = true`. Measured in the `socialized-bad-debt` print event:
- `amount = u1408729177`
- `burned-staking-lp-tokens = u0`
- `get-total-staked-lp-tokens` remains `1,000,000` after socialization.

So the whole still-present queue is exempt from the slash; the loss flows to the
reserve and unstaked LPs instead of the stakers.

### Exact commands
```
npx vitest run tests/poc-97356-staking-wipeout.test.ts   # 3 tests, all pass
node tests/remote/97356/probe.mjs                        # live-state readings
```

## What differed from the report
The reporter's PoC and this simnet build agree on the split arithmetic, the premature
latch, the three reverts, and the socialization override. The only difference is the
live deployment: both in-scope staking modules are unfunded at the measured block, so
the defect is latent there. The report's own severity assessment acknowledges this.

## Harness notes
- `clarinet requirements` loaded the live contract set and the `remote_data` fork
  initialized successfully; **not blocked**.
- Manifest: `tests/remote/97356/Clarinet.toml` (fork at 9,411,225).
- Branch: `worktree-repro-oracle-staking`.
