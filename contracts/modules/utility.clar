;; SPDX-License-Identifier: BUSL-1.1

;; constants
(define-constant SCALING-FACTOR u100000000)

;; errors
(define-constant ERR-INTEREST-PARAMS (err u120001))
(define-constant ERR-FAILED-TO-GET-BALANCE (err u120002))
(define-constant ERR-FAILED-TO-GET-DEBT-BUCKET (err u120003))


;; read-only functions
(define-read-only (get-accrue-interest)
  (let (
    (accrue-interest-params (unwrap! (contract-call? .state-v1 get-accrue-interest-params) ERR-INTEREST-PARAMS))
    (accrued-interest (try! (contract-call? .linear-kinked-ir-v1 accrue-interest
      (get last-accrued-block-time accrue-interest-params)
      (get lp-interest accrue-interest-params)
      (get staked-interest accrue-interest-params)
      (try! (contract-call? .staking-reward-v1 calculate-staking-reward-percentage (contract-call? .staking-v1 get-active-staked-lp-tokens)))
      (get protocol-interest accrue-interest-params)
      (get protocol-reserve-percentage accrue-interest-params)
      (get total-assets accrue-interest-params)))
    ))
    (ok accrued-interest)
))

(define-read-only (get-withdrawal-caps (inflow uint))
  (let (
      (lp (try! (get-lp-bucket inflow)))
      (debt (unwrap! (get-debt-bucket inflow) ERR-FAILED-TO-GET-DEBT-BUCKET))
      (collateral (try! (get-collateral-bucket inflow)))
    )
    (ok {lp: lp, debt: debt, collateral: collateral})
))



(define-private (min (a uint) (b uint)) (if (> a b) b a ))

(define-private (get-time-now) (unwrap-panic (get-stacks-block-info? time (- stacks-block-height u1))))

(define-private (refill-bucket-amount (last-updated-at uint) (time-now uint) (max-bucket uint) (current-bucket uint) (inflow uint))
  (let (
      (refill-window (contract-call? .withdrawal-caps-v1 get-refill-time-window))
      (elapsed (if (is-eq last-updated-at u0) refill-window (- time-now last-updated-at)))
      (refill-amount (if (>= elapsed refill-window) max-bucket (/ (* max-bucket elapsed) refill-window)))
      (new-bucket (min (+ current-bucket refill-amount) max-bucket))
  )
    (+ new-bucket inflow)
))

(define-private (decay-bucket-amount (last-updated-at uint) (time-now uint) (max-bucket uint) (current-bucket uint) (inflow uint))
  (let (
      (extra-bucket-amount (- current-bucket max-bucket))
      (decay-window (contract-call? .withdrawal-caps-v1 get-decay-time-window))
      (elapsed (if (is-eq last-updated-at u0) decay-window (- time-now last-updated-at)))
      (decayed-amount (if (>= elapsed decay-window) extra-bucket-amount (/ (* extra-bucket-amount elapsed) decay-window)))
      (new-bucket (- current-bucket decayed-amount))
  )
    (+ new-bucket inflow)
))

(define-private (get-lp-bucket (inflow uint))
  (let
    (
      (time-now (get-time-now))
      (last-ts (contract-call? .withdrawal-caps-v1 get-last-lp-bucket-update))
      (total-liquidity (unwrap! (contract-call? .mock-usdc get-balance .state-v1) ERR-FAILED-TO-GET-BALANCE))
      (lp-cap-factor (contract-call? .withdrawal-caps-v1 get-lp-cap-factor))
      (max-lp-bucket (/ (* total-liquidity lp-cap-factor) SCALING-FACTOR))
      (current-bucket (contract-call? .withdrawal-caps-v1 get-lp-bucket))
      (new-bucket-value (if (>= current-bucket max-lp-bucket) 
          (decay-bucket-amount last-ts time-now max-lp-bucket current-bucket inflow)
          (refill-bucket-amount last-ts time-now max-lp-bucket current-bucket inflow)))
    )
    (ok {
      cap-factor: lp-cap-factor,
      old-bucket: current-bucket,
      new-bucket: new-bucket-value,
      max-bucket: max-lp-bucket
    })
  )
)

(define-private (get-debt-bucket (inflow uint))
  (let
    (
      (time-now (get-time-now))
      (last-ts (contract-call? .withdrawal-caps-v1 get-last-debt-bucket-update))
      (total-liquidity (contract-call? .state-v1 get-borrowable-balance))
      (debt-cap-factor (contract-call? .withdrawal-caps-v1 get-debt-cap-factor))
      (max-debt-bucket (/ (* total-liquidity debt-cap-factor) SCALING-FACTOR))
      (current-bucket (contract-call? .withdrawal-caps-v1 get-debt-bucket))
      (new-bucket-value (if (>= current-bucket max-debt-bucket) 
          (decay-bucket-amount last-ts time-now max-debt-bucket current-bucket inflow)
          (refill-bucket-amount last-ts time-now max-debt-bucket current-bucket inflow)))
    )
    (ok {
      cap-factor: debt-cap-factor,
      old-bucket: current-bucket,
      new-bucket: new-bucket-value,
      max-bucket: max-debt-bucket
    })
  )
)

(define-private (get-collateral-bucket (inflow uint))
  (let
    (
      (time-now (get-time-now))
      (collateral-token .mock-btc)
      (last-ts (contract-call? .withdrawal-caps-v1 get-last-collateral-bucket-update collateral-token))
      (total-liquidity (unwrap! (contract-call? .mock-btc get-balance .state-v1) ERR-FAILED-TO-GET-BALANCE))
      (collateral-cap-factor (contract-call? .withdrawal-caps-v1 get-collateral-cap-factor collateral-token))
      (max-collateral-bucket (/ (* total-liquidity collateral-cap-factor) SCALING-FACTOR))
      (current-bucket (contract-call? .withdrawal-caps-v1 get-collateral-bucket collateral-token))
      (new-bucket-value (if (>= current-bucket max-collateral-bucket) 
          (decay-bucket-amount last-ts time-now max-collateral-bucket current-bucket inflow)
          (refill-bucket-amount last-ts time-now max-collateral-bucket current-bucket inflow)))
    )
    (ok {
      cap-factor: collateral-cap-factor,
      old-bucket: current-bucket,
      new-bucket: new-bucket-value,
      max-bucket: max-collateral-bucket
    })
  )
)
