(use-trait token-trait .trait-sip-010.sip-010-trait)

(define-public (borrow (update (buff 8192)) (amount uint))
    (contract-call? .borrower-v1 borrow update amount (some tx-sender))
)

(define-public (add-collateral (collateral <token-trait>) (amount uint))
    (contract-call? .borrower-v1 add-collateral collateral amount (some tx-sender))
)

(define-public (remove-collateral (update (buff 8192)) (collateral <token-trait>) (amount uint))
    (contract-call? .borrower-v1 remove-collateral update collateral amount (some tx-sender))
)
