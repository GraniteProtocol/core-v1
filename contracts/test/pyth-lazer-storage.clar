;; SPDX-License-Identifier: BUSL-1.1
;; Test double for Hiro's pyth-lazer-storage. Exposes the production READ interface
;; (get-price returning the real record shape) plus a public setter so tests seed
;; prices at runtime. Simnet only: mainnet references Hiro's deployed contract.

(define-constant ERR_PRICE_FEED_NOT_FOUND (err u3003))

(define-map prices uint {
  price: int,
  exponent: int,
  publisher-count: uint,
  confidence: (optional uint),
  best-bid: (optional int),
  best-ask: (optional int),
  ema-price: (optional int),
  ema-confidence: (optional uint),
  feed-update-timestamp: (optional uint),
  publish-time: uint,
  channel: uint,
})

(define-read-only (get-price (feed-id uint))
  (ok (unwrap! (map-get? prices feed-id) ERR_PRICE_FEED_NOT_FOUND)))

;; Seed a feed's price at runtime. The record fields the adapter does not read
;; default to none / u1.
(define-public (set-price (feed-id uint) (price int) (exponent int) (publish-time uint) (confidence (optional uint)))
  (begin
    (map-set prices feed-id {
      price: price,
      exponent: exponent,
      publisher-count: u1,
      confidence: confidence,
      best-bid: none,
      best-ask: none,
      ema-price: none,
      ema-confidence: none,
      feed-update-timestamp: none,
      publish-time: publish-time,
      channel: u1,
    })
    (ok true)))
