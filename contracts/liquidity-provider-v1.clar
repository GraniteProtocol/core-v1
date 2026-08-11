;; SPDX-License-Identifier: BUSL-1.1

;; ERRORS
(define-constant ERR-INTEREST-PARAMS (err u10000))
(define-constant ERR-NOT-INITIALIZED (err u10001))
(define-constant ERR-POOL-INSOLVENT (err u10002))
(define-constant ERR-ALREADY-INITIALIZED (err u10003))
(define-constant ERR-INPUT-ZERO (err u10004))

;; CONSTANTS
(define-constant SUCCESS (ok true))
(define-constant MINIMUM_INITIAL_DEPOSIT u1000)
(define-constant NULL_ADDRESS
  (unwrap-panic (principal-construct? (if is-in-mainnet 0x16 0x1a)
                                       0x0000000000000000000000000000000000000000)))

;; STATE
(define-data-var initialized bool false)

;; PUBLIC FUNCTIONS
(define-public (initialize)
  (begin
    (asserts! (not (var-get initialized)) ERR-ALREADY-INITIALIZED)
    (let (
        (total-lp-supply (unwrap-panic (contract-call? 'SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1 get-total-supply)))
        (dust-burned (is-eq total-lp-supply u0))
      )
      (var-set initialized true)
      (try! (if dust-burned
          (deposit MINIMUM_INITIAL_DEPOSIT NULL_ADDRESS)
          SUCCESS
      ))
      (print {
        action: "initialized",
        user: contract-caller,
        total-lp-supply-before: total-lp-supply,
        dust-burned: dust-burned,
      })
      SUCCESS
)))

(define-public (deposit (assets uint) (recipient principal))
  (begin
    (asserts! (var-get initialized) ERR-NOT-INITIALIZED)
    (asserts! (> assets u0) ERR-INPUT-ZERO)
    (try! (accrue-interest))
    (let (
        (lp-params (contract-call? 'SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1 get-lp-params))
        (total-assets (get total-assets lp-params))
        (total-shares (get total-shares lp-params))
        (shares (contract-call? 'SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.math-v1 convert-to-shares lp-params assets false))
      )
      (asserts! (or (> total-assets u0) (is-eq total-shares u0)) ERR-POOL-INSOLVENT)
      (try! (contract-call? .withdrawal-caps-v1 lp-deposit assets))
      (try! (contract-call? 'SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1 add-assets contract-caller recipient assets shares))
      (print {
        recipient: recipient,
        assets: assets,
        shares: shares,
        user: contract-caller,
        lp-params: (contract-call? 'SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1 get-lp-params),
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
    (let ((shares (contract-call? 'SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.math-v1 convert-to-shares (contract-call? 'SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1 get-lp-params) assets true)))
      (try! (contract-call? 'SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1 remove-assets contract-caller recipient assets shares))
      (print {
        recipient: recipient,
        assets: assets,
        shares: shares,
        user: contract-caller,
        lp-params: (contract-call? 'SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1 get-lp-params),
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
        (asset-params (contract-call? 'SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1 get-lp-params))
        (assets (contract-call? 'SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.math-v1 convert-to-assets asset-params shares false))
      )
      (try! (contract-call? .withdrawal-caps-v1 check-withdrawal-lp-cap assets))
      (try! (contract-call? 'SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1 remove-assets contract-caller recipient assets shares))
      SUCCESS
    )
))

;; PRIVATE FUNCTIONS
(define-private (accrue-interest)
  (let (
      (accrue-interest-params (unwrap! (contract-call? 'SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1 get-accrue-interest-params) ERR-INTEREST-PARAMS))
      (accrued-interest (try! (contract-call? .linear-kinked-ir-v1 accrue-interest
        (get last-accrued-block-time accrue-interest-params)
        (get lp-interest accrue-interest-params)
        (get staked-interest accrue-interest-params)
        (try! (contract-call? 'SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.staking-reward-v1 calculate-staking-reward-percentage (contract-call? .staking-v1 get-active-staked-lp-tokens)))
        (get protocol-interest accrue-interest-params)
        (get protocol-reserve-percentage accrue-interest-params)
        (get total-assets accrue-interest-params)))
      )
    )
    (contract-call? 'SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1 set-accrued-interest accrued-interest)
))
