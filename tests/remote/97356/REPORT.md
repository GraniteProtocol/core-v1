# Immunefi 97356 — Reproduction Status: Does Not Reproduce at Live State (Latent)

## Status
**Does not reproduce at live state; latent.** The deployed module is unfunded: active staked LP tokens = 0, total staked LP tokens = 0 (so wiped = 0), latch = false. The staking contract holds 0 LP tokens. There are no stakers to move into the queue, so the floor/ceil split and latch-persistence cannot be demonstrated without first funding the module and moving stakers in.

## Live State (remote_data fork at block 9,411,225)
| Reading | Value |
|---|---|
| `staking-v1.get-active-staked-lp-tokens` | 0 |
| `staking-v1.get-total-staked-lp-tokens` | 0 |
| `staking-v1.is-staking-wiped-out` | false |
| `state-v1.get-balance(staking-v1)` | 0 |

(`state-v1` has no `get-supply` read-only function; the LP token supply is not exposed under that name. The staking contract's LP token balance is 0.)

## Source Evidence
- The liquidation override `is-wiped ? u0 : (A+W)` is at `liquidator-v1` line 529 — once the latch is set, stakers are exempt from future slashing while liquidation is split over the recorded LP token supply.
- `state-v1.slash-staked-lp-tokens` at line 870 uses `effective-staked-lp-tokens` to compute the split.
- `staking-v1.stake` transfers LP tokens via `state-v1.transfer`; with 0 LP token supply in the staking contract and 0 stakers, there is nothing to exercise.

## What Differed From the Report
The reporter's PoC runs on a local simnet where stakers are seeded. The live deployment at the measured block has no stakers and no staked LP tokens (A = W = 0), so the defect is latent. It is a code-path issue in the liquidation split/latch, but it cannot be demonstrated against live state without first moving stakers into the queue.

## Harness
- `clarinet requirements` loaded the set and the `remote_data` fork initialized successfully; **not blocked**.
- Manifest: `tests/remote/97356/Clarinet.toml` (fork at 9,411,225).
- Probe: `tests/remote/97356/probe.mjs`.
