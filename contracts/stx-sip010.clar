;; SPDX-License-Identifier: BUSL-1.1

;; SIP-010 surface over the native STX asset. Holds no balance and mints nothing.

(impl-trait .trait-sip-010.sip-010-trait)

;; Movements are native STX, so callers need an STX post-condition; a fungible one naming this
;; contract can never match.
(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (begin
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

(define-read-only (get-total-supply) (ok stx-liquid-supply))

(define-read-only (get-token-uri) (ok none))
