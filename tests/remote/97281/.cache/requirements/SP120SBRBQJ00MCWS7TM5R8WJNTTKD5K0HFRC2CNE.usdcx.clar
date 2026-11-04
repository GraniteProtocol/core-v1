;; USDCx token
;;
;; This contract implements the SIP-010 trait for fungible contracts.
;;
;; This contract utilizes a role-based access control system to manage protocol permissions.
;; There are three roles:
;;
;; - `governance`: Allowed to update the protocol contracts and add/remove roles
;; - `mint`: Allowed to mint and burn tokens
;; - `pause`: Allowed to pause and unpause the protocol
;;

(impl-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

;; `tx-sender` or `contract-caller` tried to move a token it does not own.
(define-constant ERR_NOT_OWNER (err u4))
;; `contract-caller` tried to use a function it is not authorized to use.
(define-constant ERR_UNAUTHORIZED (err u400))
;; Protocol is paused.
(define-constant ERR_PAUSED (err u401))

(define-fungible-token usdcx-token)

(define-data-var token-name (string-ascii 32) "USDCx")
(define-data-var token-symbol (string-ascii 10) "USDCx")
;; The SIP-16 URI for token metadata
(define-data-var token-uri (optional (string-utf8 256)) (some u"https://ipfs.io/ipfs/bafkreifkhq47bgrlq2z2qgtps65eawgp6xsqkwldz57y2bjpefgo5zvza4"))
(define-constant token-decimals u6)

;; Allowed to update the protocol contracts
(define-constant governance-role 0x00)
;; Allowed to mint and burn tokens
(define-constant mint-role 0x01)
;; Allowed to pause and unpause the protocol
(define-constant pause-role 0x02)

;; Allow protocol to be paused
(define-data-var paused bool false)

;; Mapping of active protocol contracts (by role)
(define-map active-protocol-contracts
  {
    caller: principal,
    role: (buff 1),
  }
  bool
)

;; The contract .usdcx-v1 automatically has the `mint` role
(map-set active-protocol-contracts {
  caller: .usdcx-v1,
  role: mint-role,
}
  true
)
;; Default the contract deployer as having the `governance` role
(map-set active-protocol-contracts {
  caller: tx-sender,
  role: governance-role,
}
  true
)

;; SIP-010 functions

(define-public (transfer
    (amount uint)
    (sender principal)
    (recipient principal)
    (memo (optional (buff 34)))
  )
  (begin
    (asserts! (or (is-eq tx-sender sender) (is-eq contract-caller sender))
      ERR_NOT_OWNER
    )
    (try! (ft-transfer? usdcx-token amount sender recipient))
    (match memo
      to-print (print to-print)
      0x
    )
    (ok true)
  )
)

(define-read-only (get-name)
  (ok (var-get token-name))
)

(define-read-only (get-symbol)
  (ok (var-get token-symbol))
)

(define-read-only (get-decimals)
  (ok token-decimals)
)

(define-read-only (get-balance (who principal))
  (ok (ft-get-balance usdcx-token who))
)

(define-read-only (get-balance-available (who principal))
  (ok (ft-get-balance usdcx-token who))
)

(define-read-only (get-balance-locked (who principal))
  (ok (ft-get-balance usdcx-token who))
)

(define-read-only (get-total-supply)
  (ok (ft-get-supply usdcx-token))
)

(define-read-only (get-token-uri)
  (ok (var-get token-uri))
)

;; Protocol caller validation

;; Checks whether the contract-caller is a protocol contract
(define-read-only (is-protocol-caller
    (contract-flag (buff 1))
    (contract principal)
  )
  (validate-protocol-caller contract-flag contract)
)

;; Validate that a given principal is a protocol contract
(define-read-only (validate-protocol-caller
    (contract-flag (buff 1))
    (contract principal)
  )
  (begin
    ;; Check that the caller has the required role
    (asserts!
      (default-to false
        (map-get? active-protocol-contracts {
          caller: contract,
          role: contract-flag,
        })
      )
      ERR_UNAUTHORIZED
    )
    (ok true)
  )
)

;; Protocol pausing

(define-read-only (is-protocol-paused)
  (var-get paused)
)

;; Validate that protocol is not paused
(define-read-only (validate-protocol-active)
  (ok (asserts! (not (is-protocol-paused)) ERR_PAUSED))
)

;; --- Protocol functions

;; Transfer tokens from one account to another.
;; Only the `mint` role is allowed to call this function.
(define-public (protocol-transfer
    (amount uint)
    (sender principal)
    (recipient principal)
  )
  (begin
    ;; #[filter(amount, sender, recipient)]
    (try! (validate-protocol-active))
    (try! (validate-protocol-caller mint-role contract-caller))
    (ft-transfer? usdcx-token amount sender recipient)
  )
)

;; Mint tokens to an account.
;; Only the `mint` role is allowed to call this function.
(define-public (protocol-mint
    (amount uint)
    (recipient principal)
  )
  (begin
    ;; #[filter(amount, recipient)]
    (try! (validate-protocol-active))
    (try! (validate-protocol-caller mint-role contract-caller))
    (ft-mint? usdcx-token amount recipient)
  )
)

;; Burn tokens from an account.
;; Only the `mint` role is allowed to call this function.
(define-public (protocol-burn
    (amount uint)
    (owner principal)
  )
  (begin
    ;; #[filter(amount, owner)]
    (try! (validate-protocol-active))
    (try! (validate-protocol-caller mint-role contract-caller))
    (ft-burn? usdcx-token amount owner)
  )
)

;; Set the name of the token.
;; Only the `governance` role is allowed to call this function.
(define-public (protocol-set-name (new-name (string-ascii 32)))
  (begin
    ;; #[filter(new-name)]
    (try! (validate-protocol-active))
    (try! (validate-protocol-caller governance-role contract-caller))
    (ok (var-set token-name new-name))
  )
)

;; Set the symbol of the token.
;; Only the `governance` role is allowed to call this function.
(define-public (protocol-set-symbol (new-symbol (string-ascii 10)))
  (begin
    ;; #[filter(new-symbol)]
    (try! (validate-protocol-active))
    (try! (validate-protocol-caller governance-role contract-caller))
    (ok (var-set token-symbol new-symbol))
  )
)

;; Set the SIP-16 URI for token metadata.
;; Only the `governance` role is allowed to call this function.
(define-public (protocol-set-token-uri (new-uri (optional (string-utf8 256))))
  (begin
    ;; #[filter(new-uri)]
    (try! (validate-protocol-active))
    (try! (validate-protocol-caller governance-role contract-caller))
    (ok (var-set token-uri new-uri))
  )
)

;; Helper function to mint tokens to multiple recipients.
;; Only the `mint` role is allowed to call this function.
(define-private (protocol-mint-many-iter (item {
  amount: uint,
  recipient: principal,
}))
  ;; #[allow(unchecked_data)]
  (ft-mint? usdcx-token (get amount item) (get recipient item))
)

;; Mint tokens to multiple recipients.
;; Only the `mint` role is allowed to call this function.
(define-public (protocol-mint-many (recipients (list 200 {
  amount: uint,
  recipient: principal,
})))
  (begin
    ;; #[filter(recipients)]
    (try! (validate-protocol-active))
    (try! (validate-protocol-caller mint-role contract-caller))
    (ok (map protocol-mint-many-iter recipients))
  )
)

;; Set an active protocol caller.
;; Only the `governance` role is allowed to call this function.
(define-public (set-active-protocol-caller
    (caller principal)
    (role (buff 1))
    (enabled bool)
  )
  (begin
    ;; #[filter(caller, role, enabled)]
    (try! (validate-protocol-active))
    (try! (validate-protocol-caller governance-role contract-caller))
    (map-set active-protocol-contracts {
      caller: caller,
      role: role,
    }
      enabled
    )
    (ok true)
  )
)

;; Pause the protocol.
;; Only the `pause` role is allowed to call this function.
(define-public (pause)
  (begin
    (try! (validate-protocol-caller pause-role contract-caller))
    (print {
      topic: "pause",
      paused: true,
      caller: contract-caller,
    })
    (ok (var-set paused true))
  )
)

;; Unpause the protocol.
;; Only the `pause` role is allowed to call this function.
(define-public (unpause)
  (begin
    (try! (validate-protocol-caller pause-role contract-caller))
    (print {
      topic: "pause",
      paused: false,
      caller: contract-caller,
    })
    (ok (var-set paused false))
  )
)
