;; SPDX-License-Identifier: BUSL-1.1

;; ERRORS
(define-constant ERR-INTEREST-PARAMS (err u10000))
(define-constant ERR-NOT-INITIALIZED (err u10001))
(define-constant ERR-NOT-AUTHORIZED (err u10002))
(define-constant ERR-ALREADY-INITIALIZED (err u10003))
(define-constant ERR-INPUT-ZERO (err u10004))

;; CONSTANTS
(define-constant SUCCESS (ok true))
(define-constant MINIMUM_INITIAL_DEPOSIT u1000) ;; 0.001 USDC (6 decimals) - dust burned to NULL_ADDRESS at initialize
;; principal-construct? on a hardcoded valid (version-byte, 20-byte-hash) pair
;; cannot fail at runtime; unwrap-panic surfaces only at deploy time if the
;; Clarity runtime ever tightens version-byte validation.
(define-constant NULL_ADDRESS
  (unwrap-panic (principal-construct? (if is-in-mainnet 0x16 0x1a)
                                       0x0000000000000000000000000000000000000000)))
;; Capture the deployer at contract-load time. initialize() is one-shot
;; (idempotence guard prevents re-entry), so binding to deployer is sufficient
;; and decouples init from state-v1.governance: flipping governance later
;; cannot brick or hijack the bootstrap.
(define-constant DEPLOYER contract-caller)

;; STATE
(define-data-var initialized bool false)

;; PUBLIC FUNCTIONS
(define-public (initialize)
  (begin
    (asserts! (is-eq contract-caller DEPLOYER) ERR-NOT-AUTHORIZED)
    (asserts! (not (var-get initialized)) ERR-ALREADY-INITIALIZED)
    (let (
        ;; state-v1.get-total-supply is structurally infallible: it returns
        ;; (ok (ft-get-supply lp-token)) unconditionally. unwrap-panic matches
        ;; that infallibility honestly rather than naming a recoverable error.
        (total-lp-supply (unwrap-panic (contract-call? .state-v1 get-total-supply)))
      )
      ;; The var-set must precede the inner deposit because deposit() asserts
      ;; on (var-get initialized). Clarity revert-on-error semantics roll this
      ;; assignment back atomically if the inner deposit propagates an error,
      ;; so initialized cannot end up true on a failed init.
      (var-set initialized true)
      (try! (if (is-eq total-lp-supply u0)
          (deposit MINIMUM_INITIAL_DEPOSIT NULL_ADDRESS)
          SUCCESS
      ))
      (print {
        action: "initialized",
        user: contract-caller,
        total-lp-supply-before: total-lp-supply,
        dust-burned: (is-eq total-lp-supply u0),
      })
      SUCCESS
)))

(define-public (deposit (assets uint) (recipient principal))
  (begin
    (asserts! (var-get initialized) ERR-NOT-INITIALIZED)
    (asserts! (> assets u0) ERR-INPUT-ZERO)
    (try! (accrue-interest))
    (let (
        (lp-params (contract-call? .state-v1 get-lp-params))
        (shares (contract-call? .math-v1 convert-to-shares lp-params assets false))
      )
      (try! (contract-call? .withdrawal-caps-v1 lp-deposit assets))
      (try! (contract-call? .state-v1 add-assets contract-caller recipient assets shares))
      (print {
        recipient: recipient,
        assets: assets,
        shares: shares,
        user: contract-caller,
        lp-params: (contract-call? .state-v1 get-lp-params),
        action: "deposit",
      }))
    SUCCESS
))

(define-public (withdraw (assets uint) (recipient principal))
  (begin
    (asserts! (var-get initialized) ERR-NOT-INITIALIZED)
    (asserts! (> assets u0) ERR-INPUT-ZERO)
    (try! (contract-call? .withdrawal-caps-v1 check-withdrawal-lp-cap assets))
    (try! (accrue-interest))
    (let ((shares (contract-call? .math-v1 convert-to-shares (contract-call? .state-v1 get-lp-params) assets true)))
      (try! (contract-call? .state-v1 remove-assets contract-caller recipient assets shares))
      (print {
        recipient: recipient,
        assets: assets,
        shares: shares,
        user: contract-caller,
        lp-params: (contract-call? .state-v1 get-lp-params),
        action: "withdraw"
      }))
    SUCCESS
))

(define-public (redeem (shares uint) (recipient principal))
  (begin
    (asserts! (var-get initialized) ERR-NOT-INITIALIZED)
    (asserts! (> shares u0) ERR-INPUT-ZERO)
    (try! (accrue-interest))
    (let
      (
        (asset-params (contract-call? .state-v1 get-lp-params))
        (assets (contract-call? .math-v1 convert-to-assets asset-params shares false))
      )
      (try! (contract-call? .withdrawal-caps-v1 check-withdrawal-lp-cap assets))
      (try! (contract-call? .state-v1 remove-assets contract-caller recipient assets shares))
      SUCCESS
    )
))

;; PRIVATE FUNCTIONS
(define-private (accrue-interest)
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
      )
    )
    (contract-call? .state-v1 set-accrued-interest accrued-interest)
))
