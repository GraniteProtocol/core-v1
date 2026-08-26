;; SPDX-License-Identifier: BUSL-1.1

;; SIP-010 surface over the native STX asset. Holds no balance and mints nothing:
;; every transfer is a native `stx-transfer?`, so authorization is the runtime's
;; own tx-sender rule rather than an allowance ledger.

(impl-trait .trait-sip-010.sip-010-trait)

(define-constant ERR-NOT-TOKEN-OWNER (err u4))

(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (begin
    (asserts! (is-eq tx-sender sender) ERR-NOT-TOKEN-OWNER)
    (match memo
      m (stx-transfer-memo? amount sender recipient m)
      (stx-transfer? amount sender recipient)
    )
  )
)

(define-read-only (get-name) (ok "Stacks"))

(define-read-only (get-symbol) (ok "STX"))

(define-read-only (get-decimals) (ok u6))

(define-read-only (get-balance (who principal)) (ok (stx-get-balance who)))

;; Liquid, not total: stacked STX is excluded, which is the right bound here
;; since locked balances cannot move through transfer either.
(define-read-only (get-total-supply) (ok stx-liquid-supply))

(define-read-only (get-token-uri) (ok none))
