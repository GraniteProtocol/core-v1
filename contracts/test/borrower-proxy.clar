(use-trait token-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

(define-public (borrow (pyth-price-feed-data (optional (buff 8192))) (amount uint))
    (contract-call? .borrower-v1 borrow pyth-price-feed-data amount (some tx-sender))
)

(define-public (add-collateral (collateral <token-trait>) (amount uint))
    (contract-call? .borrower-v1 add-collateral collateral amount (some tx-sender))
)

(define-public (remove-collateral (pyth-price-feed-data (optional (buff 8192))) (collateral <token-trait>) (amount uint))
    (contract-call? .borrower-v1 remove-collateral pyth-price-feed-data collateral amount (some tx-sender))
)