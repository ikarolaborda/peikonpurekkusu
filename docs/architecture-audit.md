# Architecture audit — 2026-07-11

A four-part adversarial sweep (Go money services, .NET services, NestJS + edge
security, infra/contracts/frontend) run against the *implementation*, not the
design docs. The money core held up: double-entry ledger, two-phase holds,
transactional outbox, Stripe-style idempotency, and per-service databases are all
implemented as documented, with no dual writes on any domain event and no
cross-service source imports.

Every defect found sits on a **failure edge** — the paths that only execute when
Kafka flaps, Redis blips, a process dies mid-saga, or a processor never answers.
That is why an 18/18 green smoke suite missed all of them: the happy path is correct.

---

## Fixed in this pass

### 1. Silent event loss when the DLQ write fails (all four consumer runtimes)
Every consumer advanced its offset even when the dead-letter publish had thrown.
A poison message arriving while the DLQ leader was momentarily unavailable was
therefore neither retried nor parked — it vanished.

Consumers now treat a record as *settled* only once it is processed **or**
durably in the DLQ; otherwise the offset is held and the record redelivers.
Handling is idempotent, so redelivery is always safe.

`payment-service/internal/consumer`, `account-service/internal/consumer`,
`transaction-service/…/PaymentFactsConsumer.cs`,
`fraud-service/…/DeepAnalysisConsumer.cs`,
`notification-service/src/consumers/notification.consumer.ts`

### 2. Transient DB faults misread as "already processed" (.NET)
Both .NET consumers caught *any* `DbUpdateException` on the `processed_events`
insert and returned success — treating a deadlock, statement timeout, or dropped
connection as a duplicate event. The row was never written, yet the offset advanced:
a captured payment could silently never reach the query side.

Only a genuine unique violation (Postgres SQLSTATE `23505`) is now swallowed.
Everything else bubbles to the retry/DLQ path.

### 3. Poison-path DLQ result discarded (.NET)
The unparseable-envelope branch called `DeadLetterAsync` and dropped its boolean
on the floor, defeating the very contract the retry path honored. Unparseable
events now raise `PoisonEventException`, which routes straight to the DLQ (no
wasted retries) and *propagates the DLQ result* to the offset decision.

### 4. Wallet payments could wedge with funds held (payment-service)
Two defects compounded:

- The wallet consumer committed `processed_events` in its **own** transaction
  *before* doing the business write, and `CompleteFromGateway` returned no error.
  A crash in between marked the event consumed forever while the capture never
  happened — hold stranded, money frozen.
- `WALLET_RESULT_TIMEOUT` was defined in config and **never referenced**. A wallet
  authorization the processor never answered sat in `submitted_to_gateway`
  indefinitely.

Now: the effect runs first and the idempotency mark second (`CompleteFromGateway`
is idempotent — it re-loads the payment and only acts on `submitted_to_gateway`),
errors propagate so the event redelivers, and an `ExpireStaleWallets` sweeper
compensates wallet payments past their timeout on the existing resume ticker.

### 5. Denylist could not fail closed (fraud-service)
The denylist rule shared the generic amount-tiered outage policy: when Redis was
unreadable it contributed **10** for amounts under the threshold — comfortably
inside approve territory. A known-denylisted user submitting a small payment
during a Redis blip was **approved**.

An unreadable denylist now forces step-up regardless of amount. It cannot clear a
user it cannot read. Step-up rather than hard deny, so a Redis outage degrades
payments instead of taking them fully offline. Covered by regression tests.

### 6. Ghost notifications (notification-service)
The SSE push ran *inside* the database transaction, so a failed commit still left
the subscriber holding a notification that was rolled back. The event is now
staged and published after commit.

### 7. Missing CSRF guard on `POST /auth/mfa/verify` (user-service)
The only state-mutating authenticated endpoint without `CsrfGuard`; every sibling
route chains it.

A note on (6): the SSE push is now best-effort *after* a durable commit. That is
the right trade — the notification row is committed to `notification-db` and the
client can always re-read it from `GET /notifications`, so a dropped live push is
recoverable, whereas a ghost notification for a rolled-back write is not.

### Verified vs not verified

Being precise about what the green checks actually prove:

**Verified.** `go build` + `go test` (both Go services); `dotnet test` — fraud
15/15 including 5 new denylist regressions, transaction 5/5; `tsc --noEmit` (both
Nest services). The full stack then built and came up **22/22 healthy from the
submodule layout**, and `make smoke` passed **18/18, exit 0** — including the
wallet async-completion path through the reworked consumer, the payment saga, the
idempotency replay, and the decline→hold-release compensation. So the fixes are
exercised end-to-end against a running system, and the repo split is proven not to
have broken the build or the topology.

**Not verified.** The failure paths these fixes govern are argued from code, not
yet exercised under fault injection. Specifically outstanding: a wallet-consumer
crash between the effect and the idempotency mark (does redelivery converge with
no duplicate ledger movement?); a forced DLQ-publish failure on each of the five
consumers (does the offset really hold, and does replay then settle exactly
once?); and the denylist step-up path against a genuinely unreachable Redis rather
than a stubbed one. These want fault-injection integration tests — the natural
next piece of work.

---

## Backlog

### Closed (2026-07-11)

**B1 — MFA is now enforced, not advisory.** Previously login minted full auth
cookies *before* the MFA challenge and `amr`/`auth_time` never left user-service,
so no downstream service *could* gate on them: a password alone moved money.

The naive fix — reject a half-authenticated session inside `verify()` — is wrong,
and testing it first is what saved the design: `/auth/*` bypasses ForwardAuth (it
*is* the authenticator), but `AuthGuard` calls the **same** `verify()`. Rejecting
there would also reject `/auth/mfa/verify`, locking the user out of the very step
that unlocks them.

So the check is split. A password-only session for an enrolled user is marked
`mfaPending`; the ForwardAuth `/verify` **endpoint** refuses it (no protected route
is reachable), while `verify()` itself stays permissive so MFA-verify and logout
still work. Refresh reuses the same session id, so token rotation cannot launder a
pending session — only proof of the second factor clears it. `/verify` now also
forwards `X-Auth-Amr` / `X-Auth-Time` (listed in Traefik's `authResponseHeaders`,
so Traefik overwrites them and a client cannot forge them), and payment-service
demands a *recent* second factor at or above `STEPUP_AMOUNT_LIMIT` — failing closed
when those headers are missing or junk. The SPA gained the MFA entry step it never
had; without it, enrolling a user would now lock them out.

**B2 — `requires_action` no longer wedges.** `POST /payments/{id}/resume` re-drives
a parked payment once the caller proves a fresh second factor, and
`ExpireStaleRequiresAction` fails it if the challenge is never completed.

**B4 — an open circuit no longer reads as a decline.** `gobreaker.ErrOpenState`
was not wrapped as `ErrUnavailable`, so it fell to the generic branch: while the
processor was *down*, the customer was told their card was *refused*. Unreachable
is now retryable (same idempotent gateway reference), bounded by
`ExpireStuckSubmissions`, and backs off instead of hot-looping.

**B9 — idempotency locks get a 2-minute lease** with an atomic compare-and-swap
reclaim, so a request that dies mid-flight no longer pins its key to 409 for 24 h.

*Verified:* unit tests for the step-up matrix; 22/22 healthy; smoke 18/18. Live
against the running stack: a large payment is refused `step_up_required` while an
ordinary one still succeeds; an MFA-enrolled user's password-only session gets 401
on `/users/me`, `/accounts` and `/transactions`, and after submitting the correct
code the same session gets 200.

**B3 — the ledger no longer records a capture the processor did not make.**
`stepCapture` moved user liability → merchant payable, *then* called the PSP, and
if that capture failed it only logged the error and still marked the payment
`succeeded`. The customer was told it worked and the merchant was credited for
money the card network never collected.

The instinctive fix — undo the ledger — is the wrong shape, and checking it first
is what redirected the design: there **is** no reversal path (the account gRPC is
`Hold`/`Capture`/`Release`/`GetBalance`, and the ledger is deliberately
append-only), so building one meant a proto change plus a new operation in the
money core. But the undo is only needed because we recorded the capture *before*
it happened. The ledger is the record of what happened to the money; posting a
capture the processor has not confirmed asserts a fact that has not occurred.

So the order is inverted: capture at the processor, checkpoint that durably as
`step='psp_captured'`, and only then post it to the ledger. Compensation becomes
trivial — if the processor refuses, no ledger movement has happened, so releasing
the still-active hold is the *entire* correction, using machinery that already
existed.

The sweepers respect the asymmetry, which is the part that would bite if it were
got wrong: `ExpireStuckCaptures` only sees payments whose capture is **not yet
confirmed** (hold intact, safe to release). A payment past `psp_captured` is
**never** auto-compensated — releasing that hold would refund money the network
already took. It is retried instead (the ledger capture is idempotent on a
deterministic request id, so it converges), and `AlertStalledLedgerCaptures`
makes it loud rather than silent if it lingers.

*Residual, stated honestly.* Capturing externally first opens a window where the
processor has the money and our books do not yet say so. That is strictly better
than the bug it replaces — it is non-terminal, visible, self-healing, and its
worst case is "our own database is down", not "we credited a merchant for money
that never arrived". Two specific caveats rather than a reassuring summary:

- **Crash window.** If the process dies after the processor confirms the capture
  but before `psp_captured` is committed, the resumed worker sees
  `submitted_to_gateway` and captures again. That is safe *only because capturing
  the same authorization reference twice is idempotent* — trivially true of the
  mock, and the normal contract of real processors, but it is an assumption the
  design leans on rather than something this repo proves.
- **Liveness over money.** After `psp_captured`, nothing auto-compensates. Funds
  can sit collected-but-unbooked until the ledger retry lands (or a human looks).
  That is the deliberate trade: never refund money the network already took.

**Both residuals are now closed** (2026-07-11), and closing them exposed a defect
in the closure itself — see below.

*The crash window is no longer an assumption.* The mock PSP's capture handler
returned `200` unconditionally, so it neither enforced nor proved idempotency —
a double capture would have been invisible. It now records captures by reference:
a repeat returns the original result and settles nothing more, counting attempts
separately from settlements. Verified: three capture calls on one reference →
`attempts: 3, settled: 1`. The retry the saga performs on resume is provably free.
This makes the assumption explicit and testable against a stated contract; it is
**not** proof that every real processor is idempotent, and that distinction is
deliberate.

*Settlement reconciliation now exists.* The mock publishes `GET /settlement` (what
it actually collected, and the period the report covers), and payment-service
compares our books against it every minute, in **both** directions because they
mean opposite things:

| drift | meaning |
|---|---|
| settled but not booked | the crash-window/liveness residual actually materialising — the processor has money we never recorded |
| booked but not settled | the capture-ordering assumption is violated — no supported failure path should produce this, so it is an alarm, not a warning |

It is **detection only**. It never moves money: an automated "correction" to a
discrepancy in a payment ledger is exactly what should require a human.

*The defect the falsifier caught.* A reconciler that only ever prints "clean" is
worse than none — it manufactures assurance. So it was tested by injecting real
drift in each direction. The first run reported **55 violated invariants** on a
perfectly healthy stack: the settlement registry is in-memory, so restarting the
processor erased every prior capture while our books still held them. A settlement
report covers a *period*; "absent from the report" means "never collected" only for
payments the report actually claims to cover. The report now declares
`report_since`, payments outside it are counted as out-of-scope rather than
silently dropped, and the baseline is clean (0 false alarms, 55 correctly excluded).
Injected drift then fired in both directions and cleared when reverted — while the
genuinely orphaned capture kept being reported, because it is real.

*What the reconciler still cannot see, stated plainly.* The coverage window trades
false alarms for a blind spot: drift among captures booked **before** the report
begins is invisible to it. So an out-of-coverage count is not a footnote — it is its
own status (`coverage_gap`), and a run with one is never reported as "clean". The
result is exposed at `GET /health/reconciliation` (`clean` / `drift_detected` /
`coverage_gap` / `unavailable`) rather than living only in a log line nobody reads.

Precisely what is and is not proven: retry safety **against a processor that
honours idempotent capture-by-reference** (verified against that contract, not
against every real PSP); drift detection **only within the reported settlement
window**; no automated remediation, by choice.

An audit of every compensation path backs the central claim: success is published
in exactly one place (inside the post-ledger transaction), and no sweeper or
handler can mark a `psp_captured` payment failed — which is what would otherwise
emit `payment.failed.v1` and make account-service release a hold for money the
processor already collected.

*Verified live* with an injected capture rejection, through the real payment flow:
**before** — `succeeded / captured`, customer debited 1577; **after** — `failed /
gateway_capture_failed`, balance restored to 0 delta. Smoke stayed 18/18.

**B5 — consumed payloads are now validated against the producer's schema
(transaction-service).** Previously `PaymentFactsConsumer` read every payload
field with `?? ""` / `?? 0` fallbacks, so a drifted producer wrote a permanent
zero-amount row into the immutable `transactions` table. Observed live before
fixing: a framed `payment.captured.v1` missing `amount_minor_units` produced an
`amount = 0` purchase row with no error anywhere.

The consumer now validates the payload against the **schema id embedded in the
frame**, fetched from Apicurio and cached compiled (ids are immutable). Validating
by the producer's id rather than a build-time schema copy matters because the
schemas use `additionalProperties: false`: an embedded copy would dead-letter
valid traffic the moment a producer legitimately adds a field, whereas the frame's
id always names the exact contract the producer wrote to.

Failure classes are deliberately split three ways: a **schema-invalid payload**
or an **authoritatively unknown schema id** is poison — parked in the existing
durable DLQ path with the failing keyword in `x-exception`; a **registry outage**
(network, timeout, 5xx) is transient — the consumer *seeks back* to the failed
offset and blocks. The seek is load-bearing: without it, the next record's stored
offset would commit past the held message and the unvalidated event would be
silently skipped. Liveness is traded for never writing an unvalidated money fact.
Formats (`uuid`, `date-time`) are not yet enforced — types, required fields and
shape are; format enforcement waits until producer traffic has been sampled.

Falsifying the design also surfaced a contract mismatch: the
`payment-reversed.v1` payload only carries `payment_id` /
`reversal_ledger_transaction_id` / `reason` (`additionalProperties: false`), so
the old "map reversed → refund row" path could only ever have produced a refund
with `amount = 0` and empty user/account **by contract**. Reversed events are now
parked to their DLQ with an explanatory reason until the refunds contract is
completed (nothing emits them today; the DLQ keeps them replayable).

*Verified live*: the identical pre-fix probe now dead-letters naming the missing
field, zero rows written; a valid probe lands with the right amount; with the
registry stopped and a cold cache, two events published mid-outage were held
(eight retry cycles, nothing dead-lettered) and both landed in order after
restart. Unit 14/14, smoke 18/18.

**B5b — the pattern now covers every business consumer.** What the pre-fix
probes showed on the others: fraud-service silently accepted the same drifted
capture events (`amount ?? 0` feeding the daily-volume control — the control
under-counts exactly when a producer drifts); notification-service rendered
**"Your payment of 0.00 EUR … was captured"** to the user from a drifted
payload, and silently *skipped and committed* an event missing `user_id` (no
DLQ, no log line — unfindable); account-service burned its retry budget and
dead-lettered (fail-closed but noisy and unnamed); payment-service's wallet
consumer read `outcome` with a `""` fallback, so a drifted `psp.completed`
would have been treated as a **decline** (Tier-1 code fact; staging an
in-flight wallet payment mid-cycle was not affordable, so the acceptance gate
is the post-fix probe showing such events dead-letter).

The hold mechanics are per-runtime, because the offset semantics differ:
.NET (Confluent client) seeks back to the failed offset; Go (franz-go, batch
commit) **blocks inside the handler** — the batch loop is synchronous, so a
blocked handler structurally prevents any later commit from skipping the held
record; Node (confluent kafka-javascript, librdkafka underneath) blocks inside
`eachMessage` with background heartbeats, bounded by `max.poll.interval.ms` —
an outage longer than that means eviction and uncommitted replay, which is
safe because every consumer is idempotent.

**B6 — signing-key rotation no longer disturbs live sessions.** First, an
honest correction: the backlog described rotation as a "fleet-wide logout",
and the live falsifier showed that was **overstated** — refresh tokens are
opaque Postgres rows and sessions live in Redis, so rotating the PEM 401'd
outstanding *access* tokens (≤10-min TTL) but `/auth/refresh` recovered the
same session without re-login. The true pre-fix impact: failing API calls
until the client refreshes — and the SPA only refreshes in its route guard,
so in-page calls failed until the next navigation.

The fix is a key ring in user-service (the platform's only JWT verifier —
downstream services trust ForwardAuth headers, never tokens): one current
signer (existing `JWT_PRIVATE_KEY_PATH`/`JWT_KID_PATH`, so single-key deploys
work unchanged) plus retired **public** keys in `JWT_RETIRED_KEYS_DIR/<kid>.pem`
— retired private keys are never kept. Verification selects by the token's
`kid` (cached local JWKS; the old per-verify key import went away with it);
a missing, unknown, or colliding `kid` fails closed, and boot refuses
duplicate kids, malformed kid stems, and non-P-256 keys. The JWKS endpoint
serves the whole ring. `scripts/rotate-keys.sh` is the runbook: retire the
old public pem, install the new pair, restart; **delete the retired file once
`ACCESS_TOKEN_TTL` has passed** — leaving it longer extends acceptance of
already-issued old tokens (never forgery), and removal requires the restart
to take effect.

*Verified live*: the identical rotation that 401'd a pre-rotation session on
the old build kept it at 200 on the new one, with both kids in the JWKS; a
fresh login signed with the new kid; deleting the retired pem then correctly
rejected the old-kid token and shrank the JWKS. Unit 14/14 (real ES256
signatures — the jest jose stub was an empty object and would have made these
tests fake; jest now transforms the real library). Smoke 18/18.

Deferred follow-up: an SPA one-shot 401→refresh→retry interceptor would close
the "fails until next navigation" gap for ordinary token expiry too.

**audit-service is deliberately excluded.** It is the system of record for
what actually flowed on the wire — including the drifted traffic the business
consumers dead-letter. Validating there would erase the evidence; its DLQ'd
siblings are diagnosed *from* the audit rows. The exclusion is a policy, not
an omission: audit-service must never be read as a statement of contract
correctness.

### Still open, ranked

| # | Severity | Issue |
|---|---|---|
| B5b | Medium | **Contract validation covers only transaction-service.** The other four consumers (payment-service ×2 Go, fraud-service .NET, notification-service Nest) still read payload fields with fallbacks. Transplant the B5 pattern: validate by the frame's schema id, poison/transient split, seek-back hold. |
| B7 | Medium | **Fraud deep-analysis reads a lossy store.** `fraud_logs` is a `DropOldest` bounded channel, and the daily-volume threshold sums it — so the control weakens precisely under the burst it exists to detect. |
| B8 | Low | **Header trust has no enforcement.** `X-User-Id` is unspoofable from outside (Traefik overwrites it), but any workload on the internal network can call a service directly and impersonate a user. Lateral-movement only. Fix: mTLS or a signed gateway assertion. |
| B10 | Low | Hygiene: the topic list is maintained by hand in three places (`contracts/events/topics.json`, `infra/kafka/create-topics.sh`, audit-service's `AllTopics`) — a drift trap; DLQ topics are outside the versioned contract. |

MFA enrollment itself has no self-service UI yet (the flag is set directly in the
database). The enforcement, challenge delivery and verification all work; what is
missing is the "turn on MFA" screen.

## Build coupling — resolved

The sweep flagged that three services could not be built without the aggregator
checked out around them: account-service and payment-service reached out through a
`replace github.com/peikonpurekkusu/contracts/gen/go => ../../contracts/gen/go`
(pointing at a module path whose GitHub org does not even exist — it *only* ever
resolved through the relative path), and fraud-service spliced in C# source with a
`Compile Include="../../../contracts/gen/csharp/Fraud.cs"`.

Contracts are now consumed **by version**:

- **Go** — `gen/go` is published as a real module at the path that matches its
  repository, released with the directory-prefixed tag `gen/go/v1.0.0` (Go's
  convention for a module in a subdirectory). Both services now
  `require .../peikonpurekkusu-contracts/gen/go v1.0.0` with **no `replace`**.
  Go's publishing model is decentralized, so this needs no registry at all.
- **.NET** — the stubs are a `Peikon.Contracts` class library. fraud-service carries
  `contracts` as its own submodule and takes a `ProjectReference`. The project is
  package-shaped, so publishing to nuget.org later turns this into a one-line
  `PackageReference`. GitHub Packages was rejected: its NuGet feed demands
  authentication even to restore a *public* package, which would break clean builds.

Every Docker build context is now the component's own directory. Verified by cloning
payment-service, account-service and fraud-service **standalone, with no aggregator
present**, and building each (fraud-service's image builds and runs its tests inside).

## Docs corrected

- Fraud rules run **denylist → velocity → amount tier → geo → model**, not the
  order in `architecture.md` §9. The code's order is better (cheapest hard signal
  short-circuits first); the doc was stale.
- `device_fingerprint` is carried in the proto and never used — there is no device
  rule, only country. "geo/device" overstated it.
- The saga's `recorded`/`notified`/`compensating`/`refunded` states are declared in
  the schema but never entered; the saga terminates at `captured`/`done`.
