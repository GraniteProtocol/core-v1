;; SPDX-License-Identifier: BUSL-1.1

(define-constant SUCCESS (ok true))
(define-constant ERR-TOKEN-ALREADY-ADDED (err u240))
(define-constant ERR-TOKEN-NOT-ADDED (err u250))
(define-constant ERR-NOT-AUTHORIZED (err u260))
(define-constant ERR-INVALID-BUFFER (err u270))

(define-map price-feeds principal uint)

(define-public
  (update-price-feed-id
    (token principal)
    (new-feed-id (buff 32))
  )
  (begin
    (asserts! (is-eq (contract-call? .state-v1 get-governance) contract-caller) ERR-NOT-AUTHORIZED)
    SUCCESS
  )
)

(define-read-only (read-price (ticker principal))
  (let
    (
      (price (unwrap! (map-get? price-feeds ticker) ERR-TOKEN-NOT-ADDED))
    )
    (ok price)
  )
)

(define-public (add-ticker (ticker principal) (initial-price uint))
  (begin 
    ;; if insert returns false, that means this function call was invalid
    (asserts! (map-insert price-feeds ticker initial-price) ERR-TOKEN-ALREADY-ADDED)
    SUCCESS
  )
)

(define-public (set-price (ticker principal) (new-price uint))
  (begin 
    (unwrap! (map-get? price-feeds ticker) ERR-TOKEN-NOT-ADDED)
    (map-set price-feeds ticker new-price)
    SUCCESS
  )
)

(define-public (update-pyth (maybe-vaa-buffer (optional (buff 8192))))
  ;; testing oracle with no price verification
  (match maybe-vaa-buffer vaa-buffer (if (< u1 (len vaa-buffer)) ERR-INVALID-BUFFER SUCCESS) SUCCESS)
)
