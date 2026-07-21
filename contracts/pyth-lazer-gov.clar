;; SPDX-License-Identifier: BUSL-1.1

;; Governance shim for the Pyth Lazer oracle. Holds the oracle's ROLE_GOVERNANCE and
;; ROLE_PAUSE and gates every oracle setter behind the shared meta-governance-v1 multisig,
;; mirroring governance-v1's propose / approve / execute / timelock flow. One instance per
;; environment. meta-governance-v1 is untouched.

(use-trait decoder-trait .pyth-lazer-traits.decoder-trait)

;; ACTIONS
(define-constant ACTION_SET_TRUSTED_SIGNERS u0)
(define-constant ACTION_SET_DECODER u1)
(define-constant ACTION_SET_FEE u2)
(define-constant ACTION_SET_FEE_RECIPIENT u3)
(define-constant ACTION_SET_STALE_THRESHOLD u4)
(define-constant ACTION_SET_ROLE u5)
(define-constant ACTION_ADD_GUARDIAN u6)
(define-constant ACTION_REMOVE_GUARDIAN u7)

;; Oracle role ids (mirror pyth-lazer-oracle)
(define-constant ROLE_GOVERNANCE 0x00)
(define-constant ROLE_PAUSE 0x01)

;; Approve/deny threshold: 60% and above
(define-constant THRESHOLD u60)

;; ~24 hours assuming 4 second block time
(define-constant TIME_LOCKED_PERIOD u21600)

;; Time-locked proposals expire ~1 week after they become executable
(define-constant TIME_LOCK_EXECUTE_EXPIRATION_PERIOD u151200)

(define-constant SUCCESS (ok true))

;; ERRORS
(define-constant ERR-INVALID-ACTION (err u140000))
(define-constant ERR-NOT-GUARDIAN (err u140001))
(define-constant ERR-UNKNOWN-PROPOSAL (err u140002))
(define-constant ERR-SUBMITTED-VOTE (err u140003))
(define-constant ERR-PROPOSAL-CLOSED (err u140004))
(define-constant ERR-CONTRACT-ALREADY-INITIALIZED (err u140005))
(define-constant ERR-CONTRACT-NOT-INITIALIZED (err u140006))
(define-constant ERR-NOT-CONTRACT-DEPLOYER (err u140007))
(define-constant ERR-PROPOSAL-ALREADY-EXISTS (err u140009))
(define-constant ERR-FAILED-TO-GENERATE-PROPOSAL-ID (err u140010))
(define-constant ERR-PROPOSAL-VOTING-INCOMPLETE (err u140011))
(define-constant ERR-PROPOSAL-CANNOT-CLOSE (err u140012))
(define-constant ERR-PROPOSAL-EXPIRED (err u140013))
(define-constant ERR-PROPOSAL-ALREADY-EXECUTED (err u140016))
(define-constant ERR-PROPOSAL-TIME-LOCKED (err u140017))
(define-constant ERR-PROPOSAL-NOT-TIME-LOCKED (err u140018))
(define-constant ERR-CANNOT-VOTE (err u140019))
(define-constant ERR-ALREADY-GUARDIAN (err u140020))
(define-constant ERR-DECODER-MISMATCH (err u140021))
(define-constant ERR-MISSING-ORACLE-ROLE (err u140022))
(define-constant ERR-NO-GUARDIANS (err u140023))

;; DATA VARS / MAPS
(define-data-var next-proposal-nonce uint u0)

(define-map guardians principal bool)

(define-map governance-proposal (buff 32) {
  action: uint,
  approve-count: uint,
  deny-count: uint,
  closed: bool,
  expires-at: uint,
  executed: bool,
  execute-at: (optional uint),
  member-count: uint
})

(define-map proposal-approved-members { proposal-id: (buff 32), member: principal } bool)
(define-map proposal-denied-members { proposal-id: (buff 32), member: principal } bool)

;; time-locked actions
(define-map time-locked uint bool)

;; Per-action proposal data
(define-map trusted-signers-data (buff 32) (list 16 {
  pubkey: (buff 33),
  expires-at: uint,
}))
(define-map decoder-data (buff 32) principal)
(define-map fee-data (buff 32) uint)
(define-map fee-recipient-data (buff 32) principal)
(define-map stale-threshold-data (buff 32) uint)
(define-map role-data (buff 32) {
  who: principal,
  role: (buff 1),
  enabled: bool,
})
(define-map guardian-data (buff 32) principal)

;; contract deployer. No permissions except to initialize the contract
(define-constant contract-deployer contract-caller)
(define-data-var initialized bool false)

;; PRIVATE FUNCTIONS
(define-read-only (is-governance-member (member principal))
  (contract-call? .meta-governance-v1 is-governance-member member)
)

(define-private (create-proposal (proposal-id (buff 32)) (action uint) (expires-in uint))
  (begin
    (try! (is-governance-member contract-caller))
    (asserts! (not (is-some (map-get? governance-proposal proposal-id))) ERR-PROPOSAL-ALREADY-EXISTS)
    (asserts! (var-get initialized) ERR-CONTRACT-NOT-INITIALIZED)
    (var-set next-proposal-nonce (+ (var-get next-proposal-nonce) u1))
    (map-set governance-proposal proposal-id {
      action: action,
      approve-count: u1,
      deny-count: u0,
      expires-at: (+ stacks-block-height expires-in),
      closed: false,
      executed: false,
      execute-at: none,
      member-count: (contract-call? .meta-governance-v1 governance-multisig-count),
    })
    (map-set proposal-approved-members { proposal-id: proposal-id, member: contract-caller } true)
    (print { action: "proposal-initiated", proposal-id: proposal-id })
    (print { action: "proposal-voted-approved", voter: contract-caller, proposal-id: proposal-id })
    (ok proposal-id)
))

(define-private (has-submitted-vote (proposal-id (buff 32)))
  (or
    (default-to false (map-get? proposal-approved-members { proposal-id: proposal-id, member: contract-caller }))
    (default-to false (map-get? proposal-denied-members { proposal-id: proposal-id, member: contract-caller }))
))

(define-private (approve-threshold-met (proposal-id (buff 32)))
  (let (
      (proposal (unwrap! (map-get? governance-proposal proposal-id) ERR-UNKNOWN-PROPOSAL))
      (percentage (/ (* (get approve-count proposal) u100) (get member-count proposal)))
    )
    (ok (>= percentage THRESHOLD))
))

(define-private (deny-threshold-met (proposal-id (buff 32)))
  (let (
      (proposal (unwrap! (map-get? governance-proposal proposal-id) ERR-UNKNOWN-PROPOSAL))
      (percentage (/ (* (get deny-count proposal) u100) (get member-count proposal)))
    )
    (ok (>= percentage THRESHOLD))
))

(define-private (execute-set-trusted-signers (proposal-id (buff 32)))
  (contract-call? .pyth-lazer-oracle set-trusted-signers (unwrap-panic (map-get? trusted-signers-data proposal-id)))
)

(define-private (execute-set-fee (proposal-id (buff 32)))
  (contract-call? .pyth-lazer-oracle set-fee (unwrap-panic (map-get? fee-data proposal-id)))
)

(define-private (execute-set-fee-recipient (proposal-id (buff 32)))
  (contract-call? .pyth-lazer-oracle set-fee-recipient (unwrap-panic (map-get? fee-recipient-data proposal-id)))
)

(define-private (execute-set-stale-threshold (proposal-id (buff 32)))
  (contract-call? .pyth-lazer-oracle set-stale-price-threshold (unwrap-panic (map-get? stale-threshold-data proposal-id)))
)

(define-private (execute-set-role (proposal-id (buff 32)))
  (let ((data (unwrap-panic (map-get? role-data proposal-id))))
    (contract-call? .pyth-lazer-oracle set-role (get who data) (get role data) (get enabled data))
))

;; Dispatch every non-trait action. set-decoder is handled by execute-set-decoder, which must
;; re-supply the decoder trait, so it is rejected here.
(define-private (execute-proposal (proposal-id (buff 32)) (action uint))
  (begin
    (asserts! (not (is-eq action ACTION_SET_TRUSTED_SIGNERS)) (execute-set-trusted-signers proposal-id))
    (asserts! (not (is-eq action ACTION_SET_FEE)) (execute-set-fee proposal-id))
    (asserts! (not (is-eq action ACTION_SET_FEE_RECIPIENT)) (execute-set-fee-recipient proposal-id))
    (asserts! (not (is-eq action ACTION_SET_STALE_THRESHOLD)) (execute-set-stale-threshold proposal-id))
    (asserts! (not (is-eq action ACTION_SET_ROLE)) (execute-set-role proposal-id))
    (asserts! (not (and (>= action ACTION_ADD_GUARDIAN) (<= action ACTION_REMOVE_GUARDIAN))) (execute-update-guardian proposal-id action))
    ERR-INVALID-ACTION
))

(define-private (get-proposal-execution-time (proposal-id (buff 32)))
  (let (
      (proposal (unwrap-panic (map-get? governance-proposal proposal-id)))
      (is-time-locked (default-to false (map-get? time-locked (get action proposal))))
      (current-execute-at (get execute-at proposal))
      (execute-at (if is-time-locked (+ stacks-block-height TIME_LOCKED_PERIOD) stacks-block-height))
    )
    (if (is-some current-execute-at) (unwrap-panic current-execute-at) execute-at)
))

;; Marks the proposal executable once the approve threshold is met. Runs it immediately when the
;; action is not time-locked and the trait-free dispatch can handle it; otherwise records execute-at.
(define-private (execute-if-approve-threshold-met (proposal-id (buff 32)))
  (let (
      (proposal (unwrap! (map-get? governance-proposal proposal-id) ERR-UNKNOWN-PROPOSAL))
      (threshold (try! (approve-threshold-met proposal-id)))
      (action (get action proposal))
      (execute-at (get-proposal-execution-time proposal-id))
    )
    (if threshold
      (if (and (<= execute-at stacks-block-height) (not (is-eq action ACTION_SET_DECODER)))
        (begin
          (try! (execute-proposal proposal-id action))
          (map-set governance-proposal proposal-id (merge proposal {
            closed: true,
            executed: true,
            execute-at: (some stacks-block-height),
          }))
          (print { action: "proposal-executed", proposal-id: proposal-id })
          SUCCESS
        )
        (begin
          (map-set governance-proposal proposal-id (merge proposal {
            expires-at: (+ TIME_LOCK_EXECUTE_EXPIRATION_PERIOD execute-at),
            closed: false,
            executed: false,
            execute-at: (some execute-at),
          }))
          (print { action: "proposal-execution-time-locked", proposal-id: proposal-id, execute-at: execute-at })
          SUCCESS
        )
      )
      SUCCESS
    )
))

(define-private (deny-proposal-if-deny-threshold-met (proposal-id (buff 32)))
  (let (
      (proposal (unwrap! (map-get? governance-proposal proposal-id) ERR-UNKNOWN-PROPOSAL))
      (threshold (try! (deny-threshold-met proposal-id)))
    )
    (if threshold
      (begin
        (map-set governance-proposal proposal-id (merge proposal { closed: true, executed: false, execute-at: none }))
        (print { action: "proposal-denied", proposal-id: proposal-id })
        SUCCESS
      )
      SUCCESS
    )
))

(define-private (is-already-guardian (account principal))
  (default-to false (map-get? guardians account))
)

(define-private (is-some-principal (account (optional principal)))
  (is-some account)
)

(define-private (add-guardian (guardian principal))
  (begin
    (asserts! (not (is-already-guardian guardian)) ERR-ALREADY-GUARDIAN)
    (map-set guardians guardian true)
    (print { action: "add-guardian", guardian: guardian })
    SUCCESS
))

(define-private (remove-guardian (guardian principal))
  (begin
    (asserts! (is-already-guardian guardian) ERR-NOT-GUARDIAN)
    (map-delete guardians guardian)
    (print { action: "remove-guardian", guardian: guardian })
    SUCCESS
))

(define-private (set-guardians (maybe-account (optional principal)) (res (response bool uint)))
  (if (is-err res)
    res
    (match maybe-account account (add-guardian account) res)
))

(define-private (execute-update-guardian (proposal-id (buff 32)) (action uint))
  (let ((guardian (unwrap-panic (map-get? guardian-data proposal-id))))
    (asserts! (not (is-eq action ACTION_ADD_GUARDIAN)) (add-guardian guardian))
    (asserts! (not (is-eq action ACTION_REMOVE_GUARDIAN)) (remove-guardian guardian))
    ERR-INVALID-ACTION
))

;; READ ONLY FUNCTIONS
(define-read-only (is-guardian (member principal))
  (begin
    (unwrap! (map-get? guardians member) ERR-NOT-GUARDIAN)
    SUCCESS
))

(define-read-only (get-proposal (proposal-id (buff 32)))
  (map-get? governance-proposal proposal-id)
)

;; PUBLIC FUNCTIONS
(define-public (initiate-proposal-to-set-trusted-signers (signers (list 16 {
  pubkey: (buff 33),
  expires-at: uint,
})) (expires-in uint))
  (let (
      (proposal-id (keccak256 (unwrap! (to-consensus-buff? {
        sender: contract-caller,
        nonce: (var-get next-proposal-nonce),
        action: ACTION_SET_TRUSTED_SIGNERS,
        expires-in: expires-in,
        data: signers,
      }) ERR-FAILED-TO-GENERATE-PROPOSAL-ID)))
    )
    (try! (create-proposal proposal-id ACTION_SET_TRUSTED_SIGNERS expires-in))
    (map-set trusted-signers-data proposal-id signers)
    (try! (execute-if-approve-threshold-met proposal-id))
    (ok proposal-id)
))

(define-public (initiate-proposal-to-set-decoder (decoder <decoder-trait>) (expires-in uint))
  (let (
      (decoder-principal (contract-of decoder))
      (proposal-id (keccak256 (unwrap! (to-consensus-buff? {
        sender: contract-caller,
        nonce: (var-get next-proposal-nonce),
        action: ACTION_SET_DECODER,
        expires-in: expires-in,
        data: decoder-principal,
      }) ERR-FAILED-TO-GENERATE-PROPOSAL-ID)))
    )
    (try! (create-proposal proposal-id ACTION_SET_DECODER expires-in))
    (map-set decoder-data proposal-id decoder-principal)
    (try! (execute-if-approve-threshold-met proposal-id))
    (ok proposal-id)
))

(define-public (initiate-proposal-to-set-fee (fee uint) (expires-in uint))
  (let (
      (proposal-id (keccak256 (unwrap! (to-consensus-buff? {
        sender: contract-caller,
        nonce: (var-get next-proposal-nonce),
        action: ACTION_SET_FEE,
        expires-in: expires-in,
        data: fee,
      }) ERR-FAILED-TO-GENERATE-PROPOSAL-ID)))
    )
    (try! (create-proposal proposal-id ACTION_SET_FEE expires-in))
    (map-set fee-data proposal-id fee)
    (try! (execute-if-approve-threshold-met proposal-id))
    (ok proposal-id)
))

(define-public (initiate-proposal-to-set-fee-recipient (recipient principal) (expires-in uint))
  (let (
      (proposal-id (keccak256 (unwrap! (to-consensus-buff? {
        sender: contract-caller,
        nonce: (var-get next-proposal-nonce),
        action: ACTION_SET_FEE_RECIPIENT,
        expires-in: expires-in,
        data: recipient,
      }) ERR-FAILED-TO-GENERATE-PROPOSAL-ID)))
    )
    (try! (create-proposal proposal-id ACTION_SET_FEE_RECIPIENT expires-in))
    (map-set fee-recipient-data proposal-id recipient)
    (try! (execute-if-approve-threshold-met proposal-id))
    (ok proposal-id)
))

(define-public (initiate-proposal-to-set-stale-threshold (seconds uint) (expires-in uint))
  (let (
      (proposal-id (keccak256 (unwrap! (to-consensus-buff? {
        sender: contract-caller,
        nonce: (var-get next-proposal-nonce),
        action: ACTION_SET_STALE_THRESHOLD,
        expires-in: expires-in,
        data: seconds,
      }) ERR-FAILED-TO-GENERATE-PROPOSAL-ID)))
    )
    (try! (create-proposal proposal-id ACTION_SET_STALE_THRESHOLD expires-in))
    (map-set stale-threshold-data proposal-id seconds)
    (try! (execute-if-approve-threshold-met proposal-id))
    (ok proposal-id)
))

(define-public (initiate-proposal-to-set-role (who principal) (role (buff 1)) (enabled bool) (expires-in uint))
  (let (
      (proposal-id (keccak256 (unwrap! (to-consensus-buff? {
        sender: contract-caller,
        nonce: (var-get next-proposal-nonce),
        action: ACTION_SET_ROLE,
        expires-in: expires-in,
        data: { who: who, role: role, enabled: enabled },
      }) ERR-FAILED-TO-GENERATE-PROPOSAL-ID)))
    )
    (try! (create-proposal proposal-id ACTION_SET_ROLE expires-in))
    (map-set role-data proposal-id { who: who, role: role, enabled: enabled })
    (try! (execute-if-approve-threshold-met proposal-id))
    (ok proposal-id)
))

(define-public (initiate-proposal-to-update-guardian (action uint) (guardian principal) (expires-in uint))
  (let (
      (proposal-id (keccak256 (unwrap! (to-consensus-buff? {
        sender: contract-caller,
        nonce: (var-get next-proposal-nonce),
        action: action,
        expires-in: expires-in,
        data: guardian,
      }) ERR-FAILED-TO-GENERATE-PROPOSAL-ID)))
    )
    (asserts! (or (is-eq action ACTION_ADD_GUARDIAN) (is-eq action ACTION_REMOVE_GUARDIAN)) ERR-INVALID-ACTION)
    (try! (create-proposal proposal-id action expires-in))
    (map-set guardian-data proposal-id guardian)
    (try! (execute-if-approve-threshold-met proposal-id))
    (ok proposal-id)
))

(define-public (approve (proposal-id (buff 32)))
  (let ((proposal (unwrap! (map-get? governance-proposal proposal-id) ERR-UNKNOWN-PROPOSAL)))
    (try! (is-governance-member contract-caller))
    (asserts! (not (get closed proposal)) ERR-PROPOSAL-CLOSED)
    (asserts! (< stacks-block-height (get expires-at proposal)) ERR-PROPOSAL-EXPIRED)
    (asserts! (not (has-submitted-vote proposal-id)) ERR-SUBMITTED-VOTE)
    (asserts! (is-none (get execute-at proposal)) ERR-CANNOT-VOTE)
    (map-set proposal-approved-members { proposal-id: proposal-id, member: contract-caller } true)
    (map-set governance-proposal proposal-id (merge proposal { approve-count: (+ (get approve-count proposal) u1) }))
    (print { action: "proposal-voted-approved", voter: contract-caller, proposal-id: proposal-id })
    (try! (execute-if-approve-threshold-met proposal-id))
    SUCCESS
))

(define-public (deny (proposal-id (buff 32)))
  (let ((proposal (unwrap! (map-get? governance-proposal proposal-id) ERR-UNKNOWN-PROPOSAL)))
    (try! (is-governance-member contract-caller))
    (asserts! (not (get closed proposal)) ERR-PROPOSAL-CLOSED)
    (asserts! (< stacks-block-height (get expires-at proposal)) ERR-PROPOSAL-EXPIRED)
    (asserts! (not (has-submitted-vote proposal-id)) ERR-SUBMITTED-VOTE)
    (asserts! (is-none (get execute-at proposal)) ERR-CANNOT-VOTE)
    (map-set proposal-denied-members { proposal-id: proposal-id, member: contract-caller } true)
    (map-set governance-proposal proposal-id (merge proposal { deny-count: (+ (get deny-count proposal) u1) }))
    (print { action: "proposal-voted-denied", voter: contract-caller, proposal-id: proposal-id })
    (try! (deny-proposal-if-deny-threshold-met proposal-id))
    SUCCESS
))

(define-public (close (proposal-id (buff 32)))
  (let (
      (proposal (unwrap! (map-get? governance-proposal proposal-id) ERR-UNKNOWN-PROPOSAL))
      (total-voted (+ (get approve-count proposal) (get deny-count proposal)))
      (current-count (contract-call? .meta-governance-v1 governance-multisig-count))
      (has-threshold-met (or (try! (deny-threshold-met proposal-id)) (try! (approve-threshold-met proposal-id))))
    )
    (try! (is-governance-member contract-caller))
    (asserts! (not (get closed proposal)) ERR-PROPOSAL-CLOSED)
    (if (>= stacks-block-height (get expires-at proposal))
      (begin (print { action: "proposal-expired", proposal-id: proposal-id }) true)
      (begin
        (asserts! (>= total-voted current-count) ERR-PROPOSAL-VOTING-INCOMPLETE)
        (asserts! (not has-threshold-met) ERR-PROPOSAL-CANNOT-CLOSE)
      )
    )
    (map-set governance-proposal proposal-id (merge proposal { closed: true, executed: false, execute-at: none }))
    (print { action: "proposal-closed", proposal-id: proposal-id })
    SUCCESS
))

(define-public (execute (proposal-id (buff 32)))
  (let ((proposal (unwrap! (map-get? governance-proposal proposal-id) ERR-UNKNOWN-PROPOSAL)))
    (try! (is-governance-member contract-caller))
    (asserts! (not (is-eq (get action proposal) ACTION_SET_DECODER)) ERR-INVALID-ACTION)
    (asserts! (not (get closed proposal)) ERR-PROPOSAL-CLOSED)
    (asserts! (not (get executed proposal)) ERR-PROPOSAL-ALREADY-EXECUTED)
    (asserts! (<= (unwrap! (get execute-at proposal) ERR-PROPOSAL-NOT-TIME-LOCKED) stacks-block-height) ERR-PROPOSAL-TIME-LOCKED)
    (asserts! (< stacks-block-height (get expires-at proposal)) ERR-PROPOSAL-EXPIRED)
    (try! (execute-if-approve-threshold-met proposal-id))
    SUCCESS
))

;; Dedicated executor for set-decoder: the caller re-supplies the decoder trait (which cannot be
;; stored), and it must match the principal captured when the proposal was created.
(define-public (execute-set-decoder (proposal-id (buff 32)) (decoder <decoder-trait>))
  (let ((proposal (unwrap! (map-get? governance-proposal proposal-id) ERR-UNKNOWN-PROPOSAL)))
    (try! (is-governance-member contract-caller))
    (asserts! (is-eq (get action proposal) ACTION_SET_DECODER) ERR-INVALID-ACTION)
    (asserts! (not (get closed proposal)) ERR-PROPOSAL-CLOSED)
    (asserts! (not (get executed proposal)) ERR-PROPOSAL-ALREADY-EXECUTED)
    (asserts! (try! (approve-threshold-met proposal-id)) ERR-PROPOSAL-VOTING-INCOMPLETE)
    (asserts! (<= (unwrap! (get execute-at proposal) ERR-PROPOSAL-NOT-TIME-LOCKED) stacks-block-height) ERR-PROPOSAL-TIME-LOCKED)
    (asserts! (< stacks-block-height (get expires-at proposal)) ERR-PROPOSAL-EXPIRED)
    (asserts! (is-eq (contract-of decoder) (unwrap-panic (map-get? decoder-data proposal-id))) ERR-DECODER-MISMATCH)
    (try! (contract-call? .pyth-lazer-oracle set-decoder decoder))
    (map-set governance-proposal proposal-id (merge proposal { closed: true, executed: true, execute-at: (some stacks-block-height) }))
    (print { action: "proposal-executed", proposal-id: proposal-id })
    SUCCESS
))

;; Requires the shim to already hold the oracle roles it will exercise, so a forgotten grant
;; fails here instead of silently at the first proposal execution. Deploy order is therefore:
;; deploy the stack, grant the shim ROLE_GOVERNANCE + ROLE_PAUSE, then initialize.
(define-public (initialize (guardians-addrs (list 5 (optional principal))))
  (begin
    (asserts! (not (var-get initialized)) ERR-CONTRACT-ALREADY-INITIALIZED)
    (asserts! (is-eq contract-caller contract-deployer) ERR-NOT-CONTRACT-DEPLOYER)
    (asserts! (contract-call? .pyth-lazer-oracle has-role (as-contract tx-sender) ROLE_GOVERNANCE) ERR-MISSING-ORACLE-ROLE)
    (asserts! (contract-call? .pyth-lazer-oracle has-role (as-contract tx-sender) ROLE_PAUSE) ERR-MISSING-ORACLE-ROLE)
    (asserts! (> (len (filter is-some-principal guardians-addrs)) u0) ERR-NO-GUARDIANS)
    (var-set initialized true)
    (try! (fold set-guardians guardians-addrs SUCCESS))
    (print { action: "initialize", meta-governance: .meta-governance-v1, guardians: guardians-addrs })
    SUCCESS
))

;; Guardian-held instant pause / unpause: no proposal, calls the oracle directly.
(define-public (guardian-pause)
  (begin
    (try! (is-guardian contract-caller))
    (try! (contract-call? .pyth-lazer-oracle pause))
    SUCCESS
))

(define-public (guardian-unpause)
  (begin
    (try! (is-guardian contract-caller))
    (try! (contract-call? .pyth-lazer-oracle unpause))
    SUCCESS
))

(map-set time-locked ACTION_SET_DECODER true)
(map-set time-locked ACTION_SET_STALE_THRESHOLD true)
(map-set time-locked ACTION_SET_ROLE true)
;; Adding a guardian is deliberate (time-locked); removing a compromised one is instant.
(map-set time-locked ACTION_ADD_GUARDIAN true)
