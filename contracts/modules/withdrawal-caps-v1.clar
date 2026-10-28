;; TITLE: withdrawal-caps
;; SPDX-License-Identifier: BUSL-1.1
;; VERSION: 1.0

(use-trait token-trait .trait-sip-010.sip-010-trait)

;; CONSTANTS
(define-constant LP-CONTRACT (as-contract .liquidity-provider-v1))
(define-constant BORROWER-CONTRACT (as-contract .borrower-v1))
(define-constant LIQUIDATOR-CONTRACT (as-contract .liquidator-v1))
(define-constant SUCCESS (ok true))
(define-constant SCALING-FACTOR u100000000)

;; ERRORS
(define-constant ERR-RESTRICTED (err u120000))
(define-constant ERR-FAILED-TO-GET-BALANCE (err u120001))
(define-constant ERR-WITHDRAWAL-LP-CAP-EXCEEDED (err u120002))
(define-constant ERR-WITHDRAWAL-DEBT-CAP-EXCEEDED (err u120003))
(define-constant ERR-WITHDRAWAL-COLLATERAL-CAP-EXCEEDED (err u120004))
(define-constant ERR-INVALID-CAP-FACTOR (err u120005))
(define-constant ERR-NOT-AUTHORIZED (err u120006))
(define-constant ERR-SYNC-FAILED (err u120007))
(define-constant ERR-BLOCK-INFO (err u120008))

;; VARIABLES

;; refill time window of 24 hrs
;; updatable through governance
(define-data-var refill-time-window uint u86400)

;; decay time window of 3 hrs
;; updatable through governance
(define-data-var decay-time-window uint u10800)

;; LP
(define-data-var lp-cap-factor uint u0)
(define-data-var last-lp-bucket-update uint u0)
(define-data-var lp-bucket uint u0) ;; credit used while no excess exists
(define-data-var lp-excess uint u0)
(define-data-var lp-excess-start uint u0)

;; Debt
(define-data-var debt-cap-factor uint u0)
(define-data-var last-debt-bucket-update uint u0)
(define-data-var debt-bucket uint u0) ;; credit used while no excess exists
(define-data-var debt-excess uint u0)
(define-data-var debt-excess-start uint u0)

;; Collateral
(define-map last-collateral-bucket-update principal uint)
(define-map collateral-bucket principal uint) ;; credit used while no excess exists
(define-map collateral-cap-factor principal uint)
(define-map collateral-excess principal uint)
(define-map collateral-excess-start principal uint)

;; A bucket above its max carries an excess above the max at the moment it was born.
;; *-excess-start is that block time; the effective value is max plus the excess decayed
;; by the remaining fraction of the window, so a moving max cannot corrupt the anchor.


(define-read-only (get-refill-time-window) (var-get refill-time-window))
(define-read-only (get-decay-time-window) (var-get decay-time-window))

(define-read-only (get-lp-cap-factor) (var-get lp-cap-factor))
(define-read-only (get-last-lp-bucket-update) (var-get last-lp-bucket-update))
(define-read-only (get-lp-bucket) (read-effective-lp-bucket))

(define-read-only (get-debt-cap-factor) (var-get debt-cap-factor))
(define-read-only (get-last-debt-bucket-update) (var-get last-debt-bucket-update))
(define-read-only (get-debt-bucket) (read-effective-debt-bucket))

(define-read-only (get-collateral-cap-factor (collateral principal)) (default-to u0 (map-get? collateral-cap-factor collateral)))
(define-read-only (get-last-collateral-bucket-update (collateral principal)) (default-to u0 (map-get? last-collateral-bucket-update collateral)))
(define-read-only (get-collateral-bucket (collateral principal) (total-liquidity uint)) (read-effective-collateral-bucket collateral total-liquidity))

(define-read-only (min (a uint) (b uint)) (if (> a b) b a ))

;; PRIVATE FUNCTIONS

(define-private (get-time-now)
  (ok (unwrap! (get-stacks-block-info? time (- stacks-block-height u1)) ERR-BLOCK-INFO))
)

(define-private (refill-bucket-amount (last-updated-at uint) (time-now uint) (max-bucket uint) (current-bucket uint) (inflow uint))
  (let (
      (refill-window (get-refill-time-window))
      (elapsed (if (is-eq last-updated-at u0) refill-window (if (> time-now last-updated-at) (- time-now last-updated-at) u0)))
      (refill-amount (if (>= elapsed refill-window) max-bucket (/ (* max-bucket elapsed) refill-window)))
      (new-bucket (min (+ current-bucket refill-amount) max-bucket))
  )
    (+ new-bucket inflow)
))

(define-private (excess-remaining (start uint) (time-now uint) (window uint))
  (let ((elapsed (if (> time-now start) (- time-now start) u0)))
    (if (>= elapsed window) u0 (- window elapsed))))

(define-private (effective-bucket-value (start uint) (excess uint) (stored-bucket uint) (max-bucket uint) (time-now uint) (window uint))
  (if (is-eq start u0)
    (min stored-bucket max-bucket)
    (+ max-bucket (/ (* excess (excess-remaining start time-now window)) window))))

;; A bucket move of `amount` changes the excess above max by amount * (1 - factor): the
;; cap moves with liquidity by factor * amount, so only the rest shows above it. Scaling by
;; window / remaining keeps the deadline, and using the same delta for inflows and uses is
;; what makes a quick deposit-then-withdraw balance out. Callers must not pass a zero remaining.
(define-private (excess-delta (amount uint) (factor uint) (window uint) (remaining uint))
  (/ (+ (* amount (- SCALING-FACTOR factor) window) (- (* SCALING-FACTOR remaining) u1))
     (* SCALING-FACTOR remaining)))

(define-private (sync-lp-bucket (inflow uint))
  (let
    (
      (time-now (try! (get-time-now)))
      (window (var-get decay-time-window))
      (total-liquidity (unwrap! (contract-call? .mock-usdc get-balance .state-v1) ERR-FAILED-TO-GET-BALANCE))
      (max-lp-bucket (/ (* total-liquidity (var-get lp-cap-factor)) SCALING-FACTOR))
      (start (var-get lp-excess-start))
      (excess (var-get lp-excess))
      (stored (var-get lp-bucket))
      (old-effective (effective-bucket-value start excess stored max-lp-bucket time-now window))
    )
    (if (or (is-eq start u0) (is-eq (excess-remaining start time-now window) u0))
      (let (
        (base (if (is-eq start u0) stored max-lp-bucket))
        (last-ts (if (is-eq start u0) (var-get last-lp-bucket-update) time-now))
        (refilled (refill-bucket-amount last-ts time-now max-lp-bucket (min base max-lp-bucket) inflow))
        (max-post (/ (* (+ total-liquidity inflow) (var-get lp-cap-factor)) SCALING-FACTOR))
      )
        (var-set lp-excess u0)
        (var-set lp-excess-start u0)
        (var-set lp-bucket (min refilled max-post))
        (var-set last-lp-bucket-update time-now)
        (if (> refilled max-post)
          (begin (var-set lp-excess (- refilled max-post)) (var-set lp-excess-start time-now)) true)
        (print {
          old-lp-bucket-value: old-effective,
          new-lp-bucket-value: (effective-bucket-value (var-get lp-excess-start) (var-get lp-excess) (var-get lp-bucket) max-lp-bucket time-now window),
          max-lp-bucket: max-lp-bucket,
          inflow: inflow,
          sender: contract-caller,
          action: "sync-lp-bucket"
        })
        SUCCESS
      )
      (begin
        (if (> inflow u0)
          (begin (var-set lp-excess (+ excess (excess-delta inflow (var-get lp-cap-factor) window (excess-remaining start time-now window)))) true)
          true)
        (print {
          old-lp-bucket-value: old-effective,
          new-lp-bucket-value: (effective-bucket-value start (var-get lp-excess) stored max-lp-bucket time-now window),
          max-lp-bucket: max-lp-bucket,
          inflow: inflow,
          sender: contract-caller,
          action: "sync-lp-bucket"
        })
        SUCCESS
      )
    )
  )
)

(define-private (sync-debt-bucket (inflow uint))
  (let
    (
      (time-now (try! (get-time-now)))
      (window (var-get decay-time-window))
      (total-liquidity (contract-call? .state-v1 get-borrowable-balance))
      (max-debt-bucket (/ (* total-liquidity (var-get debt-cap-factor)) SCALING-FACTOR))
      (start (var-get debt-excess-start))
      (excess (var-get debt-excess))
      (stored (var-get debt-bucket))
      (old-effective (effective-bucket-value start excess stored max-debt-bucket time-now window))
    )
    (if (or (is-eq start u0) (is-eq (excess-remaining start time-now window) u0))
      (let (
        (base (if (is-eq start u0) stored max-debt-bucket))
        (last-ts (if (is-eq start u0) (var-get last-debt-bucket-update) time-now))
        (refilled (refill-bucket-amount last-ts time-now max-debt-bucket (min base max-debt-bucket) inflow))
        (max-post (/ (* (+ total-liquidity inflow) (var-get debt-cap-factor)) SCALING-FACTOR))
      )
        (var-set debt-excess u0)
        (var-set debt-excess-start u0)
        (var-set debt-bucket (min refilled max-post))
        (var-set last-debt-bucket-update time-now)
        (if (> refilled max-post)
          (begin (var-set debt-excess (- refilled max-post)) (var-set debt-excess-start time-now)) true)
        (print {
          old-debt-bucket-value: old-effective,
          new-debt-bucket-value: (effective-bucket-value (var-get debt-excess-start) (var-get debt-excess) (var-get debt-bucket) max-debt-bucket time-now window),
          inflow: inflow,
          sender: contract-caller,
          action: "sync-debt-bucket"
        })
        SUCCESS
      )
      (begin
        (if (> inflow u0)
          (begin (var-set debt-excess (+ excess (excess-delta inflow (var-get debt-cap-factor) window (excess-remaining start time-now window)))) true)
          true)
        (print {
          old-debt-bucket-value: old-effective,
          new-debt-bucket-value: (effective-bucket-value start (var-get debt-excess) stored max-debt-bucket time-now window),
          inflow: inflow,
          sender: contract-caller,
          action: "sync-debt-bucket"
        })
        SUCCESS
      )
    )
  )
)

(define-private (sync-collateral-bucket (collateral <token-trait>) (inflow uint))
  (let
    (
      (time-now (try! (get-time-now)))
      (window (var-get decay-time-window))
      (collateral-token (contract-of collateral))
      (total-liquidity (unwrap! (contract-call? collateral get-balance .state-v1) ERR-FAILED-TO-GET-BALANCE))
      (max-collateral-bucket (/ (* total-liquidity (default-to u0 (map-get? collateral-cap-factor collateral-token))) SCALING-FACTOR))
      (start (default-to u0 (map-get? collateral-excess-start collateral-token)))
      (excess (default-to u0 (map-get? collateral-excess collateral-token)))
      (stored (default-to u0 (map-get? collateral-bucket collateral-token)))
      (old-effective (effective-bucket-value start excess stored max-collateral-bucket time-now window))
    )
    (if (or (is-eq start u0) (is-eq (excess-remaining start time-now window) u0))
      (let (
        (base (if (is-eq start u0) stored max-collateral-bucket))
        (last-ts (if (is-eq start u0) (default-to u0 (map-get? last-collateral-bucket-update collateral-token)) time-now))
        (refilled (refill-bucket-amount last-ts time-now max-collateral-bucket (min base max-collateral-bucket) inflow))
        (max-post (/ (* (+ total-liquidity inflow) (default-to u0 (map-get? collateral-cap-factor collateral-token))) SCALING-FACTOR))
      )
        (map-delete collateral-excess collateral-token)
        (map-delete collateral-excess-start collateral-token)
        (map-set collateral-bucket collateral-token (min refilled max-post))
        (map-set last-collateral-bucket-update collateral-token time-now)
        (if (> refilled max-post)
          (begin (map-set collateral-excess collateral-token (- refilled max-post)) (map-set collateral-excess-start collateral-token time-now)) true)
        (print {
          old-collateral-bucket-value: old-effective,
          new-collateral-bucket-value: (effective-bucket-value (default-to u0 (map-get? collateral-excess-start collateral-token)) (default-to u0 (map-get? collateral-excess collateral-token)) (default-to u0 (map-get? collateral-bucket collateral-token)) max-collateral-bucket time-now window),
          inflow: inflow,
          sender: contract-caller,
          action: "sync-collateral-bucket"
        })
        SUCCESS
      )
      (begin
        (if (> inflow u0)
          (begin (map-set collateral-excess collateral-token (+ excess (excess-delta inflow (default-to u0 (map-get? collateral-cap-factor collateral-token)) window (excess-remaining start time-now window)))) true)
          true)
        (print {
          old-collateral-bucket-value: old-effective,
          new-collateral-bucket-value: (effective-bucket-value start (default-to u0 (map-get? collateral-excess collateral-token)) stored max-collateral-bucket time-now window),
          inflow: inflow,
          sender: contract-caller,
          action: "sync-collateral-bucket"
        })
        SUCCESS
      )
    )
  )
)

;; EFFECTIVE READS AND DEBITS

(define-read-only (get-time-now-uint)
  (unwrap-panic (get-stacks-block-info? time (- stacks-block-height u1))))

(define-read-only (read-effective-lp-bucket)
  (let (
      (total-liquidity (unwrap-panic (contract-call? .mock-usdc get-balance .state-v1)))
      (max-bucket (/ (* total-liquidity (var-get lp-cap-factor)) SCALING-FACTOR))
    )
    (effective-bucket-value (var-get lp-excess-start) (var-get lp-excess) (var-get lp-bucket) max-bucket (get-time-now-uint) (var-get decay-time-window))
  )
)

(define-read-only (read-effective-debt-bucket)
  (let (
      (total-liquidity (contract-call? .state-v1 get-borrowable-balance))
      (max-bucket (/ (* total-liquidity (var-get debt-cap-factor)) SCALING-FACTOR))
    )
    (effective-bucket-value (var-get debt-excess-start) (var-get debt-excess) (var-get debt-bucket) max-bucket (get-time-now-uint) (var-get decay-time-window))
  )
)

(define-read-only (read-effective-collateral-bucket (collateral principal) (total-liquidity uint))
  (let (
      (max-bucket (/ (* total-liquidity (default-to u0 (map-get? collateral-cap-factor collateral))) SCALING-FACTOR))
    )
    (effective-bucket-value
      (default-to u0 (map-get? collateral-excess-start collateral))
      (default-to u0 (map-get? collateral-excess collateral))
      (default-to u0 (map-get? collateral-bucket collateral))
      max-bucket
      (get-time-now-uint)
      (var-get decay-time-window))
  )
)

(define-private (debit-lp-bucket (amount uint) (effective uint) (max-bucket uint))
  (let (
      (time-now (try! (get-time-now)))
      (window (var-get decay-time-window))
      (start (var-get lp-excess-start))
      (excess (var-get lp-excess))
      (stored (var-get lp-bucket))
    )
    (if (is-eq start u0)
      (begin
        (var-set lp-bucket (- (min stored max-bucket) amount))
        SUCCESS
      )
      (let ((remaining (excess-remaining start time-now window)))
        (if (is-eq remaining u0)
          (begin
            (var-set lp-excess u0)
            (var-set lp-excess-start u0)
            (var-set lp-bucket (- max-bucket amount))
            (var-set last-lp-bucket-update time-now)
            SUCCESS
          )
          (let ((grossed (excess-delta amount (var-get lp-cap-factor) window remaining)))
            (if (>= grossed excess)
              (begin
                (var-set lp-excess u0)
                (var-set lp-excess-start u0)
                (var-set lp-bucket (- effective amount))
                (var-set last-lp-bucket-update time-now)
                SUCCESS
              )
              (begin
                (var-set lp-excess (- excess grossed))
                SUCCESS
              )
            )
          )
        )
      )
    )
  )
)

(define-private (debit-debt-bucket (amount uint) (effective uint) (max-bucket uint))
  (let (
      (time-now (try! (get-time-now)))
      (window (var-get decay-time-window))
      (start (var-get debt-excess-start))
      (excess (var-get debt-excess))
      (stored (var-get debt-bucket))
    )
    (if (is-eq start u0)
      (begin
        (var-set debt-bucket (- (min stored max-bucket) amount))
        SUCCESS
      )
      (let ((remaining (excess-remaining start time-now window)))
        (if (is-eq remaining u0)
          (begin
            (var-set debt-excess u0)
            (var-set debt-excess-start u0)
            (var-set debt-bucket (- max-bucket amount))
            (var-set last-debt-bucket-update time-now)
            SUCCESS
          )
          (let ((grossed (excess-delta amount (var-get debt-cap-factor) window remaining)))
            (if (>= grossed excess)
              (begin
                (var-set debt-excess u0)
                (var-set debt-excess-start u0)
                (var-set debt-bucket (- effective amount))
                (var-set last-debt-bucket-update time-now)
                SUCCESS
              )
              (begin
                (var-set debt-excess (- excess grossed))
                SUCCESS
              )
            )
          )
        )
      )
    )
  )
)

(define-private (debit-collateral-bucket (collateral <token-trait>) (amount uint) (effective uint) (max-bucket uint))
  (let (
      (time-now (try! (get-time-now)))
      (window (var-get decay-time-window))
      (collateral-token (contract-of collateral))
      (start (default-to u0 (map-get? collateral-excess-start collateral-token)))
      (excess (default-to u0 (map-get? collateral-excess collateral-token)))
      (stored (default-to u0 (map-get? collateral-bucket collateral-token)))
    )
    (if (is-eq start u0)
      (begin
        (map-set collateral-bucket collateral-token (- (min stored max-bucket) amount))
        SUCCESS
      )
      (let ((remaining (excess-remaining start time-now window)))
        (if (is-eq remaining u0)
          (begin
            (map-delete collateral-excess collateral-token)
            (map-delete collateral-excess-start collateral-token)
            (map-set collateral-bucket collateral-token (- max-bucket amount))
            (map-set last-collateral-bucket-update collateral-token time-now)
            SUCCESS
          )
          (let ((grossed (excess-delta amount (default-to u0 (map-get? collateral-cap-factor collateral-token)) window remaining)))
            (if (>= grossed excess)
              (begin
                (map-delete collateral-excess collateral-token)
                (map-delete collateral-excess-start collateral-token)
                (map-set collateral-bucket collateral-token (- effective amount))
                (map-set last-collateral-bucket-update collateral-token time-now)
                SUCCESS
              )
              (begin
                (map-set collateral-excess collateral-token (- excess grossed))
                SUCCESS
              )
            )
          )
        )
      )
    )
  )
)

(define-private (is-governance)
  (is-eq (contract-call? .state-v1 get-governance) contract-caller)
)

;; PUBLIC FUNCTIONS
(define-public (check-withdrawal-lp-cap (amount uint))
  (begin
    (asserts! (is-eq contract-caller LP-CONTRACT) ERR-RESTRICTED)
    (if (is-eq (var-get lp-cap-factor) u0)
      SUCCESS
      (begin
        (try! (sync-lp-bucket u0))
        (let (
            (total-liquidity (unwrap! (contract-call? .mock-usdc get-balance .state-v1) ERR-FAILED-TO-GET-BALANCE))
            (max-bucket (/ (* total-liquidity (var-get lp-cap-factor)) SCALING-FACTOR))
            (effective (effective-bucket-value (var-get lp-excess-start) (var-get lp-excess) (var-get lp-bucket) max-bucket (get-time-now-uint) (var-get decay-time-window)))
          )
          (asserts! (<= amount effective) ERR-WITHDRAWAL-LP-CAP-EXCEEDED)
          (try! (debit-lp-bucket amount effective max-bucket))
          SUCCESS
        )
      )
    )
  )
)

(define-public (lp-deposit (amount uint))
  (begin 
    (asserts! (is-eq contract-caller LP-CONTRACT) ERR-RESTRICTED)
    (if (is-eq (var-get lp-cap-factor) u0)
      SUCCESS
      (sync-lp-bucket amount)
    )
  )
)

(define-public (check-withdrawal-debt-cap (amount uint))
  (begin
    (asserts! (is-eq contract-caller BORROWER-CONTRACT) ERR-RESTRICTED)
    (if (is-eq (var-get debt-cap-factor) u0)
      SUCCESS
      (begin
        (unwrap! (sync-debt-bucket u0) ERR-SYNC-FAILED)
        (let (
            (total-liquidity (contract-call? .state-v1 get-borrowable-balance))
            (max-bucket (/ (* total-liquidity (var-get debt-cap-factor)) SCALING-FACTOR))
            (effective (effective-bucket-value (var-get debt-excess-start) (var-get debt-excess) (var-get debt-bucket) max-bucket (get-time-now-uint) (var-get decay-time-window)))
          )
          (asserts! (<= amount effective) ERR-WITHDRAWAL-DEBT-CAP-EXCEEDED)
          (try! (debit-debt-bucket amount effective max-bucket))
          SUCCESS
        )
      )
    )
  )
)

(define-public (repay (amount uint))
  (begin 
    (asserts! (or (is-eq contract-caller BORROWER-CONTRACT) (is-eq contract-caller LIQUIDATOR-CONTRACT)) ERR-RESTRICTED)
    (if (is-eq (var-get debt-cap-factor) u0)
      SUCCESS
      (sync-debt-bucket amount)
    )
  )
)

(define-public (check-withdrawal-collateral-cap (collateral <token-trait>) (amount uint))
  (let ((collateral-token (contract-of collateral)))
    (asserts! (is-eq contract-caller BORROWER-CONTRACT) ERR-RESTRICTED)
    (if (is-eq (default-to u0 (map-get? collateral-cap-factor collateral-token)) u0)
      SUCCESS
      (begin
        (try! (sync-collateral-bucket collateral u0))
        (let (
            (total-liquidity (unwrap! (contract-call? collateral get-balance .state-v1) ERR-FAILED-TO-GET-BALANCE))
            (max-bucket (/ (* total-liquidity (default-to u0 (map-get? collateral-cap-factor collateral-token))) SCALING-FACTOR))
            (effective (effective-bucket-value (default-to u0 (map-get? collateral-excess-start collateral-token)) (default-to u0 (map-get? collateral-excess collateral-token)) (default-to u0 (map-get? collateral-bucket collateral-token)) max-bucket (get-time-now-uint) (var-get decay-time-window)))
          )
          (asserts! (<= amount effective) ERR-WITHDRAWAL-COLLATERAL-CAP-EXCEEDED)
          (try! (debit-collateral-bucket collateral amount effective max-bucket))
          SUCCESS
        )
      )
    )
  )
)

(define-public (collateral-deposit (collateral <token-trait>) (amount uint))
  (let ((collateral-token (contract-of collateral)))
    (asserts! (is-eq contract-caller BORROWER-CONTRACT) ERR-RESTRICTED)
    (if (is-eq (default-to u0 (map-get? collateral-cap-factor collateral-token)) u0) 
      SUCCESS
      (sync-collateral-bucket collateral amount)
    )
  )
)

(define-public (set-lp-cap (new-cap uint))
  (begin
    (asserts! (is-governance) ERR-NOT-AUTHORIZED)
    (asserts! (<= new-cap SCALING-FACTOR) ERR-INVALID-CAP-FACTOR)
    (print {
      action: "set-lp-cap",
      old-value: (var-get lp-cap-factor),
      new-value: new-cap
    })
    (var-set lp-cap-factor new-cap)
    SUCCESS
  )
)

(define-public (set-debt-cap (new-cap uint))
  (begin
    (asserts! (is-governance) ERR-NOT-AUTHORIZED)
    (asserts! (<= new-cap SCALING-FACTOR) ERR-INVALID-CAP-FACTOR)
    (print {
      action: "set-debt-cap",
      old-value: (var-get debt-cap-factor),
      new-value: new-cap
    })
    (var-set debt-cap-factor new-cap)
    SUCCESS
  )
)

(define-public (set-collateral-cap (collateral principal) (new-cap uint))
  (begin
    (asserts! (is-governance) ERR-NOT-AUTHORIZED)
    (asserts! (<= new-cap SCALING-FACTOR) ERR-INVALID-CAP-FACTOR)
    (print {
      action: "set-collateral-cap",
      collateral: collateral,
      old-value: (default-to u0 (map-get? collateral-cap-factor collateral)),
      new-value: new-cap
    })
    (map-set collateral-cap-factor collateral new-cap)
    SUCCESS
  )
)

(define-public (set-refill-time-window (new-window uint))
  (begin
    (asserts! (is-governance) ERR-NOT-AUTHORIZED)
    (print {
      action: "set-refill-time-window",
      old-value: (var-get refill-time-window),
      new-value: new-window
    })
    (var-set refill-time-window new-window)
    SUCCESS
  )
)

(define-public (set-decay-time-window (new-window uint))
  (begin
    (asserts! (is-governance) ERR-NOT-AUTHORIZED)
    (print {
      action: "set-decay-time-window",
      old-value: (var-get decay-time-window),
      new-value: new-window
    })
    (var-set decay-time-window new-window)
    SUCCESS
  )
)
