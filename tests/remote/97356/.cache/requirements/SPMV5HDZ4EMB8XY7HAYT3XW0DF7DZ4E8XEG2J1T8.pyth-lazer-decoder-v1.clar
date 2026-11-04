;; Title: pyth-lazer-decoder
;; Version: v1
;;
;; Description: Processes raw update messages from Pyth. Has two phases
;;   - Phase 1: Signature verification + trusted-signer check
;;   - Phase 2: Lazer payload/feed parser
;;
;; This contract is stateless, and unlike other Pyth contracts, can be easily updated
;;
;; Currently supports secp256k1/evm format only. ed25519/solana could be added in future update

;; Implements the swappable decoder interface the oracle dispatches.
(impl-trait .pyth-lazer-traits.decoder-trait)

;;;; Constants

;; -- EVM envelope --
;;   [0:4]   magic (uint32 BE)
;;   [4:36]  signature r
;;   [36:68] signature s
;;   [68]    recovery id (0/1; EVM adds 27 for Solidity, Clarity does not)
;;   [69:71] payload_len (uint16 BE)
;;   [71:]   payload (the signed bytes)
(define-constant EVM_FORMAT_MAGIC u706910618) ;; 0x2a22999a
(define-constant SIG_OFFSET u4)
(define-constant LEN_OFFSET u69)
(define-constant PAYLOAD_OFFSET u71)

;; -- Lazer payload header --
;;   [0:4]   magic (uint32 BE)
;;   [4:12]  timestamp (uint64 BE)
;;   [12]    channel (uint8)
;;   [13]    feeds_len (uint8)
;;   [14:]   feeds (the per-feed records)
(define-constant FORMAT_MAGIC u2479346549) ;; 0x93c7d375
(define-constant PAYLOAD_TIMESTAMP_OFFSET u4)
(define-constant PAYLOAD_CHANNEL_OFFSET u12)
(define-constant PAYLOAD_FEEDS_LEN_OFFSET u13)
(define-constant FEEDS_OFFSET u14)

;; Lazer Property Types
;; Types 0-5 and 9-11 are fixed-width
;; Types 6/7/8/12 are existence-flagged (see read-opt-*).
(define-constant PROP_PRICE u0) ;; int64
(define-constant PROP_BEST_BID u1) ;; int64
(define-constant PROP_BEST_ASK u2) ;; int64
(define-constant PROP_PUBLISHER_COUNT u3) ;; uint16
(define-constant PROP_EXPONENT u4) ;; int16
(define-constant PROP_CONFIDENCE u5) ;; uint64
(define-constant PROP_FUNDING_RATE u6) ;; int64, existence-flagged
(define-constant PROP_FUNDING_TIMESTAMP u7) ;; uint64, existence-flagged
(define-constant PROP_FUNDING_RATE_INTERVAL u8) ;; uint64, existence-flagged
(define-constant PROP_MARKET_SESSION u9) ;; int16, value 0-4
(define-constant PROP_EMA_PRICE u10) ;; int64
(define-constant PROP_EMA_CONFIDENCE u11) ;; uint64
(define-constant PROP_FEED_UPDATE_TIMESTAMP u12) ;; uint64, existence-flagged

;; Max feeds parsed per update. Must match size of `FEED_SLOTS`
(define-constant MAX_FEEDS u16)
(define-constant FEED_SLOTS (list u0 u1 u2 u3 u4 u5 u6 u7 u8 u9 u10 u11 u12 u13 u14 u15))
(define-constant PROPERTY_SLOTS (list u0 u1 u2 u3 u4 u5 u6 u7 u8 u9 u10 u11 u12))

;; Errors: EVM envelope / signature (Phase 1)
(define-constant ERR_INPUT_TOO_SHORT (err u2101))
(define-constant ERR_INVALID_EVM_MAGIC (err u2102))
(define-constant ERR_OVERLAY_PRESENT (err u2103))
(define-constant ERR_INVALID_SIGNATURE (err u2104))
(define-constant ERR_UNTRUSTED_SIGNER (err u2105))
(define-constant ERR_UNAUTHORIZED_CALLER (err u2106)) ;; verify-update is callable only by pyth-lazer-oracle

;; Errors: Lazer payload / feeds (Phase 2)
(define-constant ERR_INVALID_PAYLOAD_MAGIC (err u2201))
(define-constant ERR_TOO_MANY_FEEDS (err u2202))
(define-constant ERR_INVALID_FEED_DATA (err u2203)) ;; Truncated / short read while parsing a feed
(define-constant ERR_PAYLOAD_OVERLAY (err u2204))
(define-constant ERR_UNKNOWN_PROPERTY (err u2205)) ;; Property type the v1 decoder does not handle
(define-constant ERR_TOO_MANY_PROPS (err u2206)) ;; Feed declares more properties than exist
(define-constant ERR_INVALID_MARKET_SESSION (err u2207)) ;; market-session value outside 0-4

;;;; Read-only functions

;; Parse EVM envelope and recover payload signer
(define-read-only (recover-signer (update (buff 8192)))
  (let ((update-len (len update)))
    ;; Must contain the fixed envelope header
    (asserts! (>= update-len PAYLOAD_OFFSET) ERR_INPUT_TOO_SHORT)
    ;; Check magic number
    (asserts!
      (is-eq (unwrap! (read-uint-be? update u0 u4) ERR_INPUT_TOO_SHORT)
        EVM_FORMAT_MAGIC
      )
      ERR_INVALID_EVM_MAGIC
    )
    (let (
        (signature-bytes (unwrap! (slice? update SIG_OFFSET LEN_OFFSET) ERR_INPUT_TOO_SHORT))
        (signature (unwrap! (as-max-len? signature-bytes u65) ERR_INVALID_SIGNATURE))
        (payload-len (unwrap! (read-uint-be? update LEN_OFFSET u2) ERR_INPUT_TOO_SHORT))
        (payload-end (+ PAYLOAD_OFFSET payload-len))
        (payload (unwrap! (slice? update PAYLOAD_OFFSET payload-end) ERR_INPUT_TOO_SHORT))
      )
      ;; Reject trailing bytes past the signed payload
      (asserts! (is-eq update-len payload-end) ERR_OVERLAY_PRESENT)
      ;; keccak256(payload) is the signed message hash
      (let ((signer (unwrap! (secp256k1-recover? (keccak256 payload) signature)
          ERR_INVALID_SIGNATURE
        )))
        (ok {
          signer: signer,
          payload: payload,
        })
      )
    )
  )
)

;; Recover signer and check against trusted signers
(define-read-only (verify-update (update (buff 8192)))
  (begin
    ;; Must use this contract with Pyth Oracle
    (asserts! (is-eq contract-caller .pyth-lazer-oracle) ERR_UNAUTHORIZED_CALLER)
    ;; Check if protocol paused
    (try! (contract-call? .pyth-lazer-oracle assert-active))
    (let ((recovered (try! (recover-signer update))))
      (asserts! (is-signer-trusted (get signer recovered)) ERR_UNTRUSTED_SIGNER)
      (ok recovered)
    )
  )
)

;; Verify signature and parse entire message
(define-read-only (decode-and-verify-price-feeds (update (buff 8192)))
  (let ((verified (try! (verify-update update))))
    (decode-lazer-payload (get payload verified))
  )
)

;; Parse Lazer payload
(define-read-only (decode-lazer-payload (payload (buff 8192)))
  (begin
    (asserts! (>= (len payload) FEEDS_OFFSET) ERR_INVALID_FEED_DATA)
    (asserts!
      (is-eq (unwrap! (read-uint-be? payload u0 u4) ERR_INVALID_PAYLOAD_MAGIC)
        FORMAT_MAGIC
      )
      ERR_INVALID_PAYLOAD_MAGIC
    )
    (let (
        (timestamp (unwrap! (read-uint-be? payload PAYLOAD_TIMESTAMP_OFFSET u8)
          ERR_INVALID_FEED_DATA
        ))
        (channel (unwrap! (read-uint-be? payload PAYLOAD_CHANNEL_OFFSET u1)
          ERR_INVALID_FEED_DATA
        ))
        (feeds-len (unwrap! (read-uint-be? payload PAYLOAD_FEEDS_LEN_OFFSET u1)
          ERR_INVALID_FEED_DATA
        ))
      )
      (asserts! (<= feeds-len MAX_FEEDS) ERR_TOO_MANY_FEEDS)
      (let ((state (try! (fold parse-feed-slot FEED_SLOTS
          (ok {
            bytes: payload,
            offset: FEEDS_OFFSET,
            remaining: feeds-len,
            feeds: (list),
          })
        ))))
        ;; Feeds must consume the payload exactly (no trailing overlay)
        (asserts! (is-eq (get offset state) (len payload)) ERR_PAYLOAD_OVERLAY)
        (ok {
          timestamp: timestamp,
          channel: channel,
          price-feeds: (get feeds state),
        })
      )
    )
  )
)

;; Fold step: Parse one feed slot and append to `acc`
;; Feed not appended to `acc` if required field(s) missing
;; On error, `acc` set to `(err ...)` and remaining feeds skipped
(define-private (parse-feed-slot
    (slot_ uint)
    (acc (response {
      bytes: (buff 8192),
      offset: uint,
      remaining: uint,
      feeds: (list 16
        {
          feed-id: uint,
          price: int,
          exponent: int,
          confidence: (optional uint),
          publisher-count: uint,
          best-bid: (optional int),
          best-ask: (optional int),
          funding-rate: (optional int),
          funding-timestamp: (optional uint),
          funding-rate-interval: (optional uint),
          market-session: (optional uint),
          ema-price: (optional int),
          ema-confidence: (optional uint),
          feed-update-timestamp: (optional uint),
        }
      ),
    }
      uint
    ))
  )
  (let (
      (state (try! acc))
      (remaining (get remaining state))
    )
    (if (is-eq remaining u0)
      acc
      (let (
          (parsed (try! (parse-one-feed (get bytes state) (get offset state))))
          (feed (get feed parsed))
          ;; Cursor advanced and this feed counted; returned unchanged when the feed
          ;; is missing a required field (parsed past, but not appended)
          (advanced (merge state {
            offset: (get offset parsed),
            remaining: (- remaining u1),
          }))
          (price (unwrap! (get price feed) (ok advanced)))
          (exponent (unwrap! (get exponent feed) (ok advanced)))
          (publisher-count (unwrap! (get publisher-count feed) (ok advanced)))
        )
        (ok (merge advanced {
          ;; NOTE: as-max-len? needs a LITERAL bound (u16), not the MAX_FEEDS constant
          feeds: (unwrap!
            (as-max-len?
              (append (get feeds advanced)
                (merge feed {
                  price: price,
                  exponent: exponent,
                  publisher-count: publisher-count,
                })
              )
              u16
            )
            ERR_TOO_MANY_FEEDS
          ),
        }))
      )
    )
  )
)

;; Parse one feed
;; Returns the feed plus the offset just past it
(define-private (parse-one-feed
    (bytes (buff 8192))
    (offset uint)
  )
  (let (
      (feed-id (unwrap! (read-uint-be? bytes offset u4) ERR_INVALID_FEED_DATA))
      (num-props (unwrap! (read-uint-be? bytes (+ offset u4) u1) ERR_INVALID_FEED_DATA))
      (parsed (try! (fold parse-property PROPERTY_SLOTS
        (ok {
          bytes: bytes,
          offset: (+ offset u5),
          remaining: num-props,
          price: none,
          exponent: none,
          confidence: none,
          publisher-count: none,
          best-bid: none,
          best-ask: none,
          funding-rate: none,
          funding-timestamp: none,
          funding-rate-interval: none,
          market-session: none,
          ema-price: none,
          ema-confidence: none,
          feed-update-timestamp: none,
        })
      )))
    )
    ;; Every declared property must have been consumed
    (asserts! (is-eq (get remaining parsed) u0) ERR_TOO_MANY_PROPS)
    (ok {
      feed: {
        feed-id: feed-id,
        price: (get price parsed),
        exponent: (get exponent parsed),
        confidence: (get confidence parsed),
        publisher-count: (get publisher-count parsed),
        best-bid: (get best-bid parsed),
        best-ask: (get best-ask parsed),
        funding-rate: (get funding-rate parsed),
        funding-timestamp: (get funding-timestamp parsed),
        funding-rate-interval: (get funding-rate-interval parsed),
        market-session: (get market-session parsed),
        ema-price: (get ema-price parsed),
        ema-confidence: (get ema-confidence parsed),
        feed-update-timestamp: (get feed-update-timestamp parsed),
      },
      offset: (get offset parsed),
    })
  )
)

;; Inner fold step: Read the next property and advance cursor
;; Fail on unrecognized property types (> 12)
(define-private (parse-property
    (slot_ uint)
    (acc (response {
      bytes: (buff 8192),
      offset: uint,
      remaining: uint,
      price: (optional int),
      exponent: (optional int),
      confidence: (optional uint),
      publisher-count: (optional uint),
      best-bid: (optional int),
      best-ask: (optional int),
      funding-rate: (optional int),
      funding-timestamp: (optional uint),
      funding-rate-interval: (optional uint),
      market-session: (optional uint),
      ema-price: (optional int),
      ema-confidence: (optional uint),
      feed-update-timestamp: (optional uint),
    }
      uint
    ))
  )
  (let (
      (state (try! acc))
      (remaining (get remaining state))
    )
    (if (is-eq remaining u0)
      acc
      ;; bytes/off are bound only in the active branch, so no-op tail iterations stay cheap
      (let (
          (bytes (get bytes state))
          (off (get offset state))
          (ptype (unwrap! (read-uint-be? bytes off u1) ERR_INVALID_FEED_DATA))
          (stored (try! (set-property-field ptype bytes (+ off u1) state)))
        )
        (ok (merge stored { remaining: (- remaining u1) }))
      )
    )
  )
)

;; Lazer's evm encoding has no Option type: A missing optional is encoded as 0, so the
;; reference PythLazerLib treats a parsed 0 (price/bid/ask/confidence/publisher-count) as
;; missing. We mirror that -- collapse 0 to none. Exponent 0 is a real value, kept literally.
(define-private (some-if-nonzero-int (v int))
  (if (is-eq v 0)
    none
    (some v)
  )
)
(define-private (some-if-nonzero-uint (v uint))
  (if (is-eq v u0)
    none
    (some v)
  )
)

;; Read one property and advance cursor past it
;; Handles all types declared as `PROP_*` constants, errors on unsupported properties
;; Maps 0 -> `none` for some fields
(define-private (set-property-field
    (ptype uint)
    (bytes (buff 8192))
    (voffset uint)
    (state {
      bytes: (buff 8192),
      offset: uint,
      remaining: uint,
      price: (optional int),
      exponent: (optional int),
      confidence: (optional uint),
      publisher-count: (optional uint),
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
  )
  (if (is-eq ptype PROP_PRICE)
    (ok (merge state {
      price: (some-if-nonzero-int (unwrap! (read-int-be? bytes voffset u8) ERR_INVALID_FEED_DATA)),
      offset: (+ voffset u8),
    }))
    (if (is-eq ptype PROP_BEST_BID)
      (ok (merge state {
        best-bid: (some-if-nonzero-int (unwrap! (read-int-be? bytes voffset u8) ERR_INVALID_FEED_DATA)),
        offset: (+ voffset u8),
      }))
      (if (is-eq ptype PROP_BEST_ASK)
        (ok (merge state {
          best-ask: (some-if-nonzero-int (unwrap! (read-int-be? bytes voffset u8) ERR_INVALID_FEED_DATA)),
          offset: (+ voffset u8),
        }))
        (if (is-eq ptype PROP_PUBLISHER_COUNT)
          (ok (merge state {
            publisher-count: (some-if-nonzero-uint (unwrap! (read-uint-be? bytes voffset u2) ERR_INVALID_FEED_DATA)),
            offset: (+ voffset u2),
          }))
          (if (is-eq ptype PROP_EXPONENT)
            (ok (merge state {
              exponent: (some (unwrap! (read-int-be? bytes voffset u2) ERR_INVALID_FEED_DATA)),
              offset: (+ voffset u2),
            }))
            (if (is-eq ptype PROP_CONFIDENCE)
              (ok (merge state {
                confidence: (some-if-nonzero-uint (unwrap! (read-uint-be? bytes voffset u8) ERR_INVALID_FEED_DATA)),
                offset: (+ voffset u8),
              }))
              (if (is-eq ptype PROP_MARKET_SESSION)
                ;; 2-byte field bounded to 0-4; read unsigned so a negative int16 (> u4) also rejects
                (let ((session (unwrap! (read-uint-be? bytes voffset u2) ERR_INVALID_FEED_DATA)))
                  (asserts! (<= session u4) ERR_INVALID_MARKET_SESSION)
                  (ok (merge state {
                    market-session: (some session),
                    offset: (+ voffset u2),
                  }))
                )
                (if (is-eq ptype PROP_EMA_PRICE)
                  (ok (merge state {
                    ema-price: (some-if-nonzero-int (unwrap! (read-int-be? bytes voffset u8)
                      ERR_INVALID_FEED_DATA
                    )),
                    offset: (+ voffset u8),
                  }))
                  (if (is-eq ptype PROP_EMA_CONFIDENCE)
                    (ok (merge state {
                      ema-confidence: (some-if-nonzero-uint (unwrap! (read-uint-be? bytes voffset u8)
                        ERR_INVALID_FEED_DATA
                      )),
                      offset: (+ voffset u8),
                    }))
                    (if (is-eq ptype PROP_FUNDING_RATE)
                      (let ((r (try! (read-opt-int64 bytes voffset))))
                        (ok (merge state {
                          funding-rate: (get value r),
                          offset: (get next r),
                        }))
                      )
                      (if (is-eq ptype PROP_FUNDING_TIMESTAMP)
                        (let ((r (try! (read-opt-uint64 bytes voffset))))
                          (ok (merge state {
                            funding-timestamp: (get value r),
                            offset: (get next r),
                          }))
                        )
                        (if (is-eq ptype PROP_FUNDING_RATE_INTERVAL)
                          (let ((r (try! (read-opt-uint64 bytes voffset))))
                            (ok (merge state {
                              funding-rate-interval: (get value r),
                              offset: (get next r),
                            }))
                          )
                          (if (is-eq ptype PROP_FEED_UPDATE_TIMESTAMP)
                            (let ((r (try! (read-opt-uint64 bytes voffset))))
                              (ok (merge state {
                                feed-update-timestamp: (get value r),
                                offset: (get next r),
                              }))
                            )
                            ;; Unknown property type
                            ERR_UNKNOWN_PROPERTY
                          )
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        )
      )
    )
  )
)

;;;; Trusted-signer check (Phase 1)

;; True if `signer` matches a trusted signer that has not expired as of the current block time
(define-private (is-signer-trusted (signer (buff 33)))
  (get trusted
    (fold check-trusted-signer
      (contract-call? .pyth-lazer-oracle get-trusted-signers) {
      target: signer,
      now: stacks-block-time,
      trusted: false,
    })
  )
)

(define-private (check-trusted-signer
    (entry {
      pubkey: (buff 33),
      expires-at: uint,
    })
    (acc {
      target: (buff 33),
      now: uint,
      trusted: bool,
    })
  )
  (if (and
      (is-eq (get pubkey entry) (get target acc))
      (< (get now acc) (get expires-at entry))
    )
    (merge acc { trusted: true })
    acc
  )
)

;;;; Helper functions: Buffer reading

;; #[allow(case_fn)]
(define-private (read-uint-be?
    (bytes (buff 8192))
    (pos uint)
    (size uint)
  )
  (match (slice? bytes pos (+ pos size))
    b (some (buff-to-uint-be (unwrap! (as-max-len? b u16) none)))
    none
  )
)

;; #[allow(case_fn)]
(define-private (read-int-be?
    (bytes (buff 8192))
    (pos uint)
    (size uint)
  )
  (match (slice? bytes pos (+ pos size))
    b (let ((shift (* (- u16 size) u8)))
      ;; Sign-extend an N-byte two's-complement value: shift the sign bit to bit 127 and back.
      (some (bit-shift-right
        (bit-shift-left (buff-to-int-be (unwrap! (as-max-len? b u16) none)) shift)
        shift
      ))
    )
    none
  )
)

;; Read optional int64. If first byte is...
;;   - 0 => `none`, do not parse more bytes
;;   - non-zero => `(some next-8-bytes-as-int64)`
(define-private (read-opt-int64
    (bytes (buff 8192))
    (voffset uint)
  )
  (if (is-eq (unwrap! (read-uint-be? bytes voffset u1) ERR_INVALID_FEED_DATA) u0)
    (ok {
      value: none,
      next: (+ voffset u1),
    })
    (ok {
      value: (some (unwrap! (read-int-be? bytes (+ voffset u1) u8) ERR_INVALID_FEED_DATA)),
      next: (+ voffset u9),
    })
  )
)

;; Read optional uint64. If first byte is...
;;   - 0 => `none`, do not parse more bytes
;;   - non-zero => `(some next-8-bytes-as-uint64)`
(define-private (read-opt-uint64
    (bytes (buff 8192))
    (voffset uint)
  )
  (if (is-eq (unwrap! (read-uint-be? bytes voffset u1) ERR_INVALID_FEED_DATA) u0)
    (ok {
      value: none,
      next: (+ voffset u1),
    })
    (ok {
      value: (some (unwrap! (read-uint-be? bytes (+ voffset u1) u8) ERR_INVALID_FEED_DATA)),
      next: (+ voffset u9),
    })
  )
)
