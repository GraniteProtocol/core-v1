;; Title: pyth-lazer-oracle
;; Version: FINAL (immutable)
;;
;; Description: The Pyth Lazer core contract -- immutable protocol state, access control,
;; and the public price-verification entry point (`verify-price-feeds`).
;;
;; Verify-only: `verify-price-feeds` verifies a signed update through the authorized
;; (swappable) decoder and returns the parsed feeds for in-transaction use. It is the sole
;; verification entry point -- the decoder gates `verify-update` to this contract.
;;
;; Role-based access control (similar to stx-labs/usdcx-token):
;;   - `governance`: manage signers / fee / decoder / stale-threshold / roles
;;   - `pause`: pause/resume price verification

;; Imported so set-decoder takes a <decoder-trait>, rejecting a non-decoder at the type level.
(use-trait decoder-trait .pyth-lazer-traits.decoder-trait)

;;;; Constants

;; Caller lacks the required role
(define-constant ERR_UNAUTHORIZED (err u4003))
;; Protocol is paused
(define-constant ERR_PAUSED (err u4004))
;; Cannot change your own governance role
(define-constant ERR_CANNOT_CHANGE_OWN_GOVERNANCE (err u4005))
;; Passed decoder is not the authorized one
(define-constant ERR_INVALID_DECODER (err u1001))
;; Update's publish-time is older than the staleness window
(define-constant ERR_STALE_PRICE (err u1002))

;; Lazer publish-time is microseconds; the staleness window is seconds
(define-constant MICROS_PER_SECOND u1000000)

;; Role IDs: Single-byte buffers (not bitflags)
(define-constant ROLE_GOVERNANCE 0x00) ;; manage signers/fee/decoder/threshold + roles
(define-constant ROLE_PAUSE 0x01) ;; pause / unpause

;;;; Data vars / maps

;; Authorized principals
;; Note that one principal can have multiple roles, and a role can be held by multiple principals
(define-map roles
  {
    who: principal,
    role: (buff 1),
  }
  bool
)

;; By default all roles granted to deployer
(map-set roles {
  who: tx-sender,
  role: ROLE_GOVERNANCE,
} true
)
(map-set roles {
  who: tx-sender,
  role: ROLE_PAUSE,
} true
)

;; Pauses protocol and most governance functions
;; `set-trusted-signers` stays callable so a compromised key can be rotated mid-incident
(define-data-var paused bool false)

;; Trusted Lazer signers
(define-data-var trusted-signers (list 16
  {
    pubkey: (buff 33), ;; Compressed secp256k1 pubkey
    expires-at: uint, ;; Unix timestamp (seconds)
  }
) (list))

;; Default staleness window (seconds) -- used when verify-price-feeds is passed `none` for max-age
(define-data-var stale-price-threshold uint (if is-in-mainnet
  u7200 ;;  2 hours
  u157680000 ;; ~5 years
))


;; The only decoder principal accepted for `<decoder>` trait param
(define-data-var decoder principal .pyth-lazer-decoder-v1)

;; Per-update fee in microSTX
;; Paid by the caller (tx-sender) of verify-price-feeds, sent to `fee-recipient`
(define-data-var fee uint u0)

;; Where the oracle sends collected fees
(define-data-var fee-recipient principal tx-sender)

;;;; Read-only getters

(define-read-only (get-trusted-signers)
  (var-get trusted-signers)
)

(define-read-only (get-stale-price-threshold)
  (var-get stale-price-threshold)
)

(define-read-only (get-decoder)
  (var-get decoder)
)

(define-read-only (get-fee)
  (var-get fee)
)

(define-read-only (get-fee-recipient)
  (var-get fee-recipient)
)

(define-read-only (has-role
    (who principal)
    (role (buff 1))
  )
  (default-to false (map-get? roles {
    who: who,
    role: role,
  })
  )
)

(define-read-only (is-paused)
  (var-get paused)
)

;;;; Guards
;;
;; Should be used with `contract-caller` instead of `tx-sender` to prevent phishing attacks

(define-read-only (assert-role
    (who principal)
    (role (buff 1))
  )
  (ok (asserts! (has-role who role) ERR_UNAUTHORIZED))
)

(define-read-only (assert-governance (who principal))
  (assert-role who ROLE_GOVERNANCE)
)

(define-read-only (assert-active)
  (ok (asserts! (not (var-get paused)) ERR_PAUSED))
)

;;;; Governance functions
;;
;; Only available to callers with `ROLE_GOVERNANCE`

(define-public (set-trusted-signers (signers (list 16 {
  pubkey: (buff 33),
  expires-at: uint,
})))
  (begin
    ;; Intentionally NOT gated by `assert-active`: a compromised signer must be revocable
    ;; WHILE paused (pause halts verification; rotating the trusted set is the incident fix).
    (try! (assert-governance contract-caller))
    (var-set trusted-signers signers)
    (print {
      type: "trusted-signers",
      action: "updated",
      data: { signers: signers },
    })
    (ok true)
  )
)

(define-public (set-stale-price-threshold (seconds uint))
  (begin
    (try! (assert-active))
    (try! (assert-governance contract-caller))
    (var-set stale-price-threshold seconds)
    (print {
      type: "stale-price-threshold",
      action: "updated",
      data: { seconds: seconds },
    })
    (ok true)
  )
)

(define-public (set-decoder (new-decoder <decoder-trait>))
  (begin
    (try! (assert-active))
    (try! (assert-governance contract-caller))
    (let ((new-principal (contract-of new-decoder)))
      (var-set decoder new-principal)
      (print {
        type: "decoder",
        action: "updated",
        data: { new-decoder: new-principal },
      })
      (ok true)
    )
  )
)

(define-public (set-fee (new-fee uint))
  (begin
    (try! (assert-active))
    (try! (assert-governance contract-caller))
    (var-set fee new-fee)
    (print {
      type: "fee",
      action: "updated",
      data: { new-fee: new-fee },
    })
    (ok true)
  )
)

(define-public (set-fee-recipient (new-recipient principal))
  (begin
    (try! (assert-active))
    (try! (assert-governance contract-caller))
    (var-set fee-recipient new-recipient)
    (print {
      type: "fee-recipient",
      action: "updated",
      data: { new-recipient: new-recipient },
    })
    (ok true)
  )
)

(define-public (set-role
    (who principal)
    (role (buff 1))
    (enabled bool)
  )
  (begin
    (try! (assert-active))
    (try! (assert-governance contract-caller))
    ;; Refuse self-removal of governance, so the last admin can't lock everyone out
    (asserts!
      (not (and
        (is-eq role ROLE_GOVERNANCE)
        (is-eq who contract-caller)
      ))
      ERR_CANNOT_CHANGE_OWN_GOVERNANCE
    )
    (if enabled
      (map-set roles {
        who: who,
        role: role,
      } true
      )
      (map-delete roles {
        who: who,
        role: role,
      })
    )
    (print {
      type: "role",
      action: "updated",
      data: {
        who: who,
        role: role,
        enabled: enabled,
      },
    })
    (ok true)
  )
)

;;;; Pause functions
;;
;; Only available to callers with `ROLE_PAUSE`

(define-public (pause)
  (begin
    (try! (assert-role contract-caller ROLE_PAUSE))
    (var-set paused true)
    (print {
      type: "pause",
      action: "paused",
      data: { caller: contract-caller },
    })
    (ok true)
  )
)

(define-public (unpause)
  (begin
    (try! (assert-role contract-caller ROLE_PAUSE))
    (var-set paused false)
    (print {
      type: "pause",
      action: "unpaused",
      data: { caller: contract-caller },
    })
    (ok true)
  )
)

;;;; Price verification (public entry)

;; Verify a Lazer update through authorized decoder and return the parsed feeds
;; Public (not read-only) because it dispatches via a trait and may charge a fee
;; `max-age`: Staleness threshold in seconds. `none` => Governance default
(define-public (verify-price-feeds
    (update (buff 8192))
    (decoder-contract <decoder-trait>)
    (max-age (optional uint))
  )
  (begin
    ;; Only the authorized decoder is accepted
    (asserts! (is-eq (contract-of decoder-contract) (var-get decoder)) ERR_INVALID_DECODER)
    (let (
        ;; signature, trusted-signer, and pause checks all run inside the decoder
        (decoded (try! (contract-call? decoder-contract decode-and-verify-price-feeds update)))
        (publish-time-seconds (/ (get timestamp decoded) MICROS_PER_SECOND))
        (threshold (default-to (var-get stale-price-threshold) max-age))
      )
      ;; Reject stale updates. Written additively (publish + threshold >= now) so a Lazer
      ;; publish-time running ahead of the current block time can't underflow the uint.
      (asserts! (>= (+ publish-time-seconds threshold) stacks-block-time) ERR_STALE_PRICE)
      (try! (charge-fee))
      (ok decoded)
    )
  )
)

;; Charge the per-update fee (default u0) from tx-sender to the fee recipient.
;; `stx-transfer?` rejects a zero amount, so guard on it.
(define-private (charge-fee)
  (let ((fee-amount (var-get fee)))
    (if (> fee-amount u0)
      (stx-transfer? fee-amount tx-sender (var-get fee-recipient))
      (ok true)
    )
  )
)
