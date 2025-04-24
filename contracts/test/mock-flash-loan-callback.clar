;; SPDX-License-Identifier: BUSL-1.1

(impl-trait .trait-flash-loan-v1.flash-loan)

(define-data-var result (response bool uint) (ok true))

(define-public (on-granite-flash-loan (amount uint) (fee uint) (data (optional (buff 10240))))
  (let (
      (caller tx-sender)
      (user-balance (contract-call? .mock-usdc get-balance caller))
    ) 
    (print {
      action: "flash-loan-callback",
      amount: amount,
      fee: fee,
      data: data,
      caller: caller,
      user-balance: user-balance
    })

    (var-get result)
  )
)

(define-public (set-result (res (response bool uint)))
  (begin
    (var-set result res)
    (ok true)
  )
)
