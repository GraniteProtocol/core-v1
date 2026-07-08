(use-trait token-trait .trait-sip-010.sip-010-trait)

(define-public (borrow (amount uint))
    (contract-call? .borrower-v1 borrow amount (some tx-sender))
)

(define-public (add-collateral (collateral <token-trait>) (amount uint))
    (contract-call? .borrower-v1 add-collateral collateral amount (some tx-sender))
)

(define-public (remove-collateral (collateral <token-trait>) (amount uint))
    (contract-call? .borrower-v1 remove-collateral collateral amount (some tx-sender))
)