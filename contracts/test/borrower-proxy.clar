(use-trait token-trait .trait-sip-010.sip-010-trait)

(define-public (borrow (pyth-price-feed-data (optional (buff 8192))) (amount uint))
    (contract-call? .borrower-v1 borrow pyth-price-feed-data amount (some tx-sender))
)