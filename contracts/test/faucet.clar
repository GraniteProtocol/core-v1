;; SPDX-License-Identifier: BUSL-1.1

(define-constant SUCCESS (ok true))

(define-public (get-stx (amount uint) (to principal))
  (let
    (
      (balance (stx-get-balance (as-contract tx-sender)))
    )
    (asserts! (>= balance amount) (err "not enough STX in the faucet"))
    (unwrap! (as-contract (stx-transfer? amount tx-sender to)) (err "error sending STX"))
    SUCCESS
  )
)

(define-public (get-mock-usdc (amount uint))
  (let
    (
      (balance (stx-get-balance (as-contract tx-sender)))
      (user tx-sender)
    )
    (try! (contract-call? 'SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc mint amount user))
    SUCCESS
  )
)

(define-public (get-mock-btc (amount uint))
  (let
    (
      (balance (stx-get-balance (as-contract tx-sender)))
      (user tx-sender)
    )
    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token mint amount user))
    SUCCESS
  )
)

(define-public (get-mock-eth (amount uint))
  (let
    (
      (balance (stx-get-balance (as-contract tx-sender)))
      (user tx-sender)
    )
    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token mint amount user))
    SUCCESS
  )
)
