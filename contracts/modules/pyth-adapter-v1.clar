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
(define-constant ERR-MISSING-FEED (err u80008))
(define-constant ERR-PRICE-LIST-OVERFLOW (err u80009))

(define-constant STACKS_BLOCK_TIME (contract-call? .constants-v1 get-stacks-block-time ))
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
(define-constant PRICE_DECIMALS (to-int (contract-call? .constants-v2 get-price-decimals)))
;; Lazer publish-time is microseconds; freshness is checked in seconds.
(define-constant MICROS_PER_SECOND u1000000)

;; Lazer numeric feed ids per token. See https://pyth.network/developers/price-feed-ids
(define-map price-feeds principal {
  feed-id: uint,
  max-confidence-ratio: uint
})
(define-data-var time-delta uint u1800)

;; admin-level maintenance functions
(define-public (update-price-feed-id (token principal) (new-feed-id uint) (max-confidence-ratio uint))
  (begin
    (asserts! (is-eq (contract-call? .state-v1 get-governance) contract-caller) ERR-NOT-AUTHORIZED)
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
    (asserts! (is-eq (contract-call? .state-v1 get-governance) contract-caller) ERR-NOT-AUTHORIZED)
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

;; Verify a signed Lazer update once and return the fixed-point price for each
;; requested token, in order. Reverts if any token is unsupported, its feed is
;; absent from the update, stale, low-confidence, or otherwise invalid.
(define-public (verify-and-get-prices (update (buff 8192)) (tokens (list 11 principal)))
  (let (
      (decoded (try! (contract-call? .pyth-lazer-oracle verify-price-feeds update .pyth-lazer-decoder-v1 none)))
      (timestamp (/ (get timestamp decoded) MICROS_PER_SECOND))
      (feeds (get price-feeds decoded))
      (result (try! (fold accumulate-token-price tokens (ok {
        timestamp: timestamp,
        feeds: feeds,
        prices: (list),
      }))))
    )
    (ok (get prices result))
  )
)

(define-private (accumulate-token-price
    (token principal)
    (acc (response {
      timestamp: uint,
      feeds: (list 16 {
        feed-id: uint,
        price: int,
        exponent: int,
        publisher-count: uint,
        confidence: (optional uint),
        best-bid: (optional int),
        best-ask: (optional int),
        funding-rate: (optional int),
        funding-timestamp: (optional uint),
        funding-rate-interval: (optional uint),
        market-session: (optional uint),
        ema-price: (optional int),
        ema-confidence: (optional uint),
        feed-update-timestamp: (optional uint),
      }),
      prices: (list 11 uint),
    } uint))
  )
  (let (
      (state (try! acc))
      (feed-data (unwrap! (map-get? price-feeds token) ERR-UNSUPPORTED-ASSET))
      (feed (unwrap! (find-feed (get feed-id feed-data) (get feeds state)) ERR-MISSING-FEED))
      (price (try! (validate-and-convert feed (get timestamp state) (get max-confidence-ratio feed-data))))
    )
    (ok (merge state {
      prices: (unwrap! (as-max-len? (append (get prices state) price) u11) ERR-PRICE-LIST-OVERFLOW),
    }))
  )
)

(define-private (find-feed
    (feed-id uint)
    (feeds (list 16 {
      feed-id: uint,
      price: int,
      exponent: int,
      publisher-count: uint,
      confidence: (optional uint),
      best-bid: (optional int),
      best-ask: (optional int),
      funding-rate: (optional int),
      funding-timestamp: (optional uint),
      funding-rate-interval: (optional uint),
      market-session: (optional uint),
      ema-price: (optional int),
      ema-confidence: (optional uint),
      feed-update-timestamp: (optional uint),
    }))
  )
  (get found (fold match-feed-id feeds { target: feed-id, found: none }))
)

(define-private (match-feed-id
    (feed {
      feed-id: uint,
      price: int,
      exponent: int,
      publisher-count: uint,
      confidence: (optional uint),
      best-bid: (optional int),
      best-ask: (optional int),
      funding-rate: (optional int),
      funding-timestamp: (optional uint),
      funding-rate-interval: (optional uint),
      market-session: (optional uint),
      ema-price: (optional int),
      ema-confidence: (optional uint),
      feed-update-timestamp: (optional uint),
    })
    (acc {
      target: uint,
      found: (optional {
        feed-id: uint,
        price: int,
        exponent: int,
        publisher-count: uint,
        confidence: (optional uint),
        best-bid: (optional int),
        best-ask: (optional int),
        funding-rate: (optional int),
        funding-timestamp: (optional uint),
        funding-rate-interval: (optional uint),
        market-session: (optional uint),
        ema-price: (optional int),
        ema-confidence: (optional uint),
        feed-update-timestamp: (optional uint),
      }),
    })
  )
  (if (and (is-none (get found acc)) (is-eq (get feed-id feed) (get target acc)))
    (merge acc { found: (some feed) })
    acc
  )
)

(define-private (validate-and-convert
    (feed {
      feed-id: uint,
      price: int,
      exponent: int,
      publisher-count: uint,
      confidence: (optional uint),
      best-bid: (optional int),
      best-ask: (optional int),
      funding-rate: (optional int),
      funding-timestamp: (optional uint),
      funding-rate-interval: (optional uint),
      market-session: (optional uint),
      ema-price: (optional int),
      ema-confidence: (optional uint),
      feed-update-timestamp: (optional uint),
    })
    (timestamp uint)
    (max-confidence-ratio uint)
  )
  (let (
      (price (get price feed))
      (expo (get exponent feed))
      ;; A signed Lazer feed may omit confidence; treat absent as zero (no bound to violate).
      (price-conf (default-to u0 (get confidence feed)))
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
  )
)

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
