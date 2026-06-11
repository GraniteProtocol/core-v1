;; SPDX-License-Identifier: BUSL-1.1

;; TRAITS
(use-trait callback-trait 'SP3Y6GFKWN50HPA8RKRXMY0EXAJR9VXPY899P88JN.trait-flash-loan-v1.flash-loan)

;; CONSTANTS
(define-constant SUCCESS (ok true))
;; Maximum fee percentage
(define-constant max-fee u100000000)


;; Errors
(define-constant ERR-CONTRACT-NOT-ALLOWED (err u110000))
(define-constant ERR-NOT-AUTHORIZED (err u110001))
(define-constant ERR-INVALID-FEE (err u110002))


;; Data vars
;; List of allowed contracts that are called back during the flash loan
(define-map allowed-contracts principal bool)
;; Flag to allow any contract to use flash loan
(define-data-var allow-any bool true)
;; Fee of 0.01% for processing flash loan scaled to 10^8
(define-data-var fee uint u10)

;; Read only functions

(define-read-only (get-fee) (var-get fee))

(define-read-only (is-contract-allowed (contract principal))
  (if (var-get allow-any) true (default-to false (map-get? allowed-contracts contract)))
)

;; Public functions

(define-public (set-allowed-contract (contract principal))
  (begin
    (asserts! (is-governance) ERR-NOT-AUTHORIZED)
    (map-set allowed-contracts contract true)
    (print {
      action: "set-allowed-contract",
      contract: contract
    })
    SUCCESS
))

(define-public (remove-allowed-contract (contract principal))
  (begin
    (asserts! (is-governance) ERR-NOT-AUTHORIZED)
    (map-delete allowed-contracts contract)
    (print {
      action: "remove-allowed-contract",
      contract: contract
    })
    SUCCESS
))

(define-public (update-fee (new-fee uint))
  (begin
    (asserts! (is-governance) ERR-NOT-AUTHORIZED)
    (asserts! (<= new-fee max-fee) ERR-INVALID-FEE)
    (print {
      action: "update-fee",
      old-value: (var-get fee),
      new-value: new-fee,
    })
    (var-set fee new-fee)
    SUCCESS
))

(define-public (update-allow-any-contract (value bool))
  (begin
    (asserts! (is-governance) ERR-NOT-AUTHORIZED)
    (print {
      action: "update-allow-any-contract",
      old-value: (var-get allow-any),
      new-value: value,
    })
    (var-set allow-any value)
    SUCCESS
))

(define-public (flash-loan (amount uint) (callback <callback-trait>) (data (optional (buff 20480))))
  (let (
      (flash-loan-fee (contract-call? 'SP3Y6GFKWN50HPA8RKRXMY0EXAJR9VXPY899P88JN.math-v1 divide-round-up (* amount (var-get fee)) max-fee))
      (caller contract-caller)
      (callback-contract (contract-of callback))
    )
    (asserts! (is-contract-allowed callback-contract) ERR-CONTRACT-NOT-ALLOWED)
    ;; transfer funds to user
    (try! (contract-call? 'SP3Y6GFKWN50HPA8RKRXMY0EXAJR9VXPY899P88JN.state-v1 transfer-to 'SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc caller amount))
    (try! (contract-call? callback on-granite-flash-loan amount flash-loan-fee data))
    (try! (contract-call? 'SP3Y6GFKWN50HPA8RKRXMY0EXAJR9VXPY899P88JN.state-v1 transfer-from 'SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc caller amount))
    (try! (if (> flash-loan-fee u0)
      (contract-call? 'SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc transfer flash-loan-fee caller (contract-call? 'SP3Y6GFKWN50HPA8RKRXMY0EXAJR9VXPY899P88JN.state-v1 get-governance) none)
      SUCCESS
    ))

    (print {
      action: "flash-loan",
      amount: amount,
      fee: flash-loan-fee,
      caller: caller,
      contract: callback-contract
    })
    SUCCESS
  )
)

;; private functions


(define-private (is-governance)
  (is-eq (contract-call? 'SP3Y6GFKWN50HPA8RKRXMY0EXAJR9VXPY899P88JN.state-v1 get-governance) contract-caller)
)