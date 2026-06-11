;; SPDX-License-Identifier: BUSL-1.1

(define-constant SUCCESS (ok true))
(define-constant ERR-NOT-AUTHORIZED (err u80000))
(define-constant ERR-UNSUPPORTED-ASSET (err u80001))
(define-constant ERR-PYTH-PRICE-STALE (err u80002))
(define-constant ERR-INVALID-MAX-CONFIDENCE-RATIO (err u80003))
(define-constant ERR-PRICE-CONFIDENCE-LOW (err u80004))
(define-constant ERR-INVALID-PRICE (err u80005))
(define-constant ERR-INVALID-EXPONENT (err u80006))
(define-constant ERR-INVALID-TIME-DELTA (err u80007))

(define-constant STACKS_BLOCK_TIME (contract-call? 'SP3Y6GFKWN50HPA8RKRXMY0EXAJR9VXPY899P88JN.constants-v1 get-stacks-block-time ))
;; Minimum time delta of 15 seconds (~2 Stacks blocks). Prevents
;; governance from setting time-delta to 0 (which would freeze
;; price-dependent operations) while still allowing tight freshness
;; during volatile market conditions.
(define-constant MINIMUM_TIME_DELTA u15)
;; Maximum time delta of 2 hours.
(define-constant MAXIMUM_TIME_DELTA u7200)
;; Maximum future timestamp tolerance of 60 seconds.
(define-constant FUTURE_TIMESTAMP_TOLERANCE u60)
;; Confidence ratio scaling factor  = 100% confidence
(define-constant CONFIDENCE_SCALING_FACTOR u10000)
;; Price scaling factor decimals
(define-constant PRICE_DECIMALS (to-int (contract-call? 'SP3Y6GFKWN50HPA8RKRXMY0EXAJR9VXPY899P88JN.constants-v2 get-price-decimals)))

;; price feeds can be found in https://pyth.network/developers/price-feed-ids
(define-map price-feeds principal {
  feed-id: (buff 32),
  max-confidence-ratio: uint
})
(define-data-var time-delta uint u300)
(map-set price-feeds 'SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc {feed-id: 0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a, max-confidence-ratio: u100})
(map-set price-feeds 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token {feed-id: 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43, max-confidence-ratio: u500})

;; admin-level maintenance functions
(define-public (update-price-feed-id (token principal) (new-feed-id (buff 32)) (max-confidence-ratio uint))
  (begin 
    (asserts! (is-eq (contract-call? 'SP3Y6GFKWN50HPA8RKRXMY0EXAJR9VXPY899P88JN.state-v1 get-governance) contract-caller) ERR-NOT-AUTHORIZED)
    (asserts! (<= max-confidence-ratio CONFIDENCE_SCALING_FACTOR) ERR-INVALID-MAX-CONFIDENCE-RATIO)
    (map-set price-feeds token {
      feed-id: new-feed-id,
      max-confidence-ratio: max-confidence-ratio
    })
    (print  {
      event-type: "update-price-feed-id",
      asset: token,
      user: contract-caller,
      feed-id: new-feed-id,
      max-confidence-ratio: max-confidence-ratio,
    })
    SUCCESS
))

(define-public (update-time-delta (delta uint))
  (begin 
    (asserts! (is-eq (contract-call? 'SP3Y6GFKWN50HPA8RKRXMY0EXAJR9VXPY899P88JN.state-v1 get-governance) contract-caller) ERR-NOT-AUTHORIZED)
    (asserts! (>= delta MINIMUM_TIME_DELTA) ERR-INVALID-TIME-DELTA)
    (asserts! (<= delta MAXIMUM_TIME_DELTA) ERR-INVALID-TIME-DELTA)
    (print  {
      event-type: "update-time-delta",
      old-val: (var-get time-delta),
      new-val: delta,
      user: contract-caller,
    })
    (var-set time-delta delta)
    SUCCESS
  )
)

(define-read-only (get-pyth-time-delta)
  (var-get time-delta)
)

(define-read-only (get-pyth-minimum-time-delta) MINIMUM_TIME_DELTA)

(define-read-only (read-price (token principal))
  (let 
    (
      (pyth-feed-data (unwrap! (map-get? price-feeds token) ERR-UNSUPPORTED-ASSET))
      (pyth-record 
          (try! (contract-call? 
            'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
            get-price
            (get feed-id pyth-feed-data)
          ))
        )
    )
    (decode-pyth pyth-record (get max-confidence-ratio pyth-feed-data))
  )
)

(define-public (update-pyth (maybe-vaa-buffer (optional (buff 8192))))
  (match maybe-vaa-buffer vaa-buffer
    (begin
      (try! 
        (contract-call? 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-oracle-v4 verify-and-update-price-feeds 
          vaa-buffer
          {
            pyth-storage-contract: 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4,
            pyth-decoder-contract: 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-pnau-decoder-v3,
            wormhole-core-contract: 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.wormhole-core-v4
          }) 
      )
      SUCCESS
    )
    SUCCESS
  )
)

(define-read-only (bulk-read-collateral-prices (collaterals (list 10 principal)))
  (fold check-collateral-price-exists collaterals (ok (list)))
)

(define-private (check-collateral-price-exists (collateral principal) (res (response (list 10 uint) uint)))
  (let (
    (price-list (try! res))
    (price (try! (read-price collateral)))
    (updated-price-list (unwrap-panic (as-max-len? (append price-list price) u10)))
  )
    (ok updated-price-list)
  )
)

(define-private (decode-pyth (pyth-record 
  {conf: uint, ema-conf: uint, ema-price: int, expo: int, prev-publish-time: uint, price: int, publish-time: uint}
) (max-confidence-ratio uint)) 
  (let 
    (
      (timestamp (get publish-time pyth-record))
      (expo (get expo pyth-record))
      (price (get price pyth-record))
      (price-conf (get conf pyth-record))
      
    )
    (asserts! (> price 0) ERR-INVALID-PRICE)
    ;; Upper bound 11 is the max safe value: pyth_max_int64 (~9.2e18)
    ;; * 10^(expo+PRICE_DECIMALS) must not exceed clarity_max_int128
    ;; (~1.7e38). With PRICE_DECIMALS = 8, expo <= 11 holds the product
    ;; below the overflow threshold for any valid Pyth price.
    (asserts! (and (>= expo -18) (<= expo 11)) ERR-INVALID-EXPONENT)
    (asserts! (is-valid timestamp) ERR-PYTH-PRICE-STALE)
    (try! (check-confidence (to-uint price) price-conf max-confidence-ratio))
    (ok (to-uint (convert-res price expo PRICE_DECIMALS)))
))

(define-private (check-confidence (price uint) (confidence uint) (max-confidence-ratio uint))
  (if (<= confidence (/ (* price max-confidence-ratio) CONFIDENCE_SCALING_FACTOR))
    (ok true)
    ERR-PRICE-CONFIDENCE-LOW
  )
)

(define-private (is-valid (timestamp uint))
  (let ((block-timestamp (+ (unwrap-panic (get-stacks-block-info? time (- stacks-block-height u1))) STACKS_BLOCK_TIME)))
    (if (>= timestamp block-timestamp)
      (<= timestamp (+ block-timestamp FUTURE_TIMESTAMP_TOLERANCE))
      (> timestamp (- block-timestamp (var-get time-delta))))
  )
)

(define-private (abs (val int))
  (if (> val 0) val (- 0 val))
)

(define-private (convert-res (price int) (expo int) (resolution-digits int))
  (if (>= expo 0)
    (* price (pow 10 (+ expo resolution-digits)))
    (let ((diff (- resolution-digits (abs expo))))
      (if (is-eq diff 0) 
        price 
        (if (> diff 0) (* price (pow 10 diff)) (/ price (pow 10 (abs diff))))
    ))
))
