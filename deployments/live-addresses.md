# Live addresses

Measured on chain 2026-11-05. Re-verify before use.

## Staging USDCx

Anchor and stay-old contracts: `SP2N615VZET7VD3DK3SCGPRXFSA9XSJW89KRC2Y30`

- state-v1, math-v1, constants-v1, constants-v2, linear-kinked-ir-v1, pyth-adapter-v1,
  staking-reward-v1, flash-loan-v1, trait-flash-loan-v1

Live contracts since the 2026-11-05 upgrade: `SP2E4S1CVTQG3CMGRJW1B9ECNBZKJEVF424JKDTVJ`

- Allowed market contracts: staking-v1, withdrawal-caps-v1, borrower-v1, liquidator-v1,
  liquidity-provider-v1
- Governance pair: governance-v1, meta-governance-v1
- Read-only utilities, not in the allow-set: utility, linear-kinked-ir-utility

Governance: `SP2E4S1CVTQG3CMGRJW1B9ECNBZKJEVF424JKDTVJ.governance-v1`

Market token: `SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx`

Collateral: `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token`

Lazer oracle: `SPMV5HDZ4EMB8XY7HAYT3XW0DF7DZ4E8XEG2J1T8`, feeds USDCx 7 and sBTC 1

## Deployment record

The deployed source is branch `staging-upgrade/sp2n615-fixes` at `5ef5dc6` (PR #117). The plans
below point at master's generic source and cannot reproduce the run without it.

Applied in this order:

1. `plan-v2` published the five fixed contracts. Its trailing `liquidity-provider-v1` initialize did
   not broadcast, so `init-only` applied that call instead.
2. `governance-pair` published and initialised the new governance pair. `governance-init` is the same
   initialisation, duplicated inside `governance-pair`; it was not applied separately.
3. `gov-wave-initiate` and `gov-wave-execute` ran the five `u14` authorisations and the governance
   handover under the old governance.
4. `validate` ran the live deposit and add-collateral between the governance wave and staking init.
5. `staking-init`'s batch moved the 1,000 LP and its initialize aborted on the same-block race: the
   transfer landed at tx index 1 in block 9417300, after the initialize at index 0, so the stake saw
   a zero balance and the call returned `(err u1)`. `staking-init-retry` then applied the initialize
   at block 9417312 and staked the floor. `staking-init` is use-once and not replayable: re-applying
   moves another 1,000 LP from `SP2M1DGAD8ZAPD5X3D919GK0RPKTAE851W5Y584YE` to the deployer before
   failing.
6. `utility-pair` published the two read-only utilities.
7. `caps-debt-set`, `caps-debt-execute`, `deposit-proof`, `borrow-proof`, `repay-proof`,
   `caps-reset-initiate` and `caps-reset-execute` ran the cap and borrow validation, ending with
   every cap factor at zero.
8. `retire-old-initiate` and `retire-old-execute` removed the four old mutators below.

## Old SP2N615 mutators

`SP2N615VZET7VD3DK3SCGPRXFSA9XSJW89KRC2Y30.borrower-v1`, `.liquidator-v1`,
`.liquidity-provider-v1` and `.staking-v1` were authorised from the 2026-10-28 deployment and stayed
authorised through the 2026-11-05 upgrade until the retirement wave. The old
`SP2N615...withdrawal-caps-v1` has both cap factors at `u0`, so `check-withdrawal-debt-cap` returns
SUCCESS unconditionally; while the old borrower was allowed, that was an uncapped borrow entrance on
the same `state-v1`. The retirement set `is-allowed-contract` to `(err u107)` for all four.
`SP2N615...flash-loan-v1` remains allowed.
