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

## Backlog — known, unfixed, ranked

These are real and deliberately deferred: each is a feature, not a surgical fix,
and rushing them into a working stack trades one class of defect for another.

| # | Severity | Issue |
|---|---|---|
| B1 | **High** | **MFA/step-up is advisory.** Login sets valid auth cookies *before* the MFA challenge, and `amr`/`auth_time` are never forwarded by ForwardAuth — so no downstream service *can* gate on them. A password alone is currently sufficient to move money. Fix: withhold the access cookie until MFA completes, forward `X-Auth-Amr`/`X-Auth-Time`, gate high-risk operations on freshness. |
| B2 | **High** | **`requires_action` payments wedge permanently.** Fraud step-up parks the saga in a status no sweeper scans and no endpoint resumes. No funds are held at that point, so nothing is stranded — but the payment never resolves. Fix: a resume endpoint + expiry sweeper (pairs naturally with B1). |
| B3 | Medium | **Ledger capture precedes PSP capture.** If the PSP capture fails after the ledger already moved the money, the failure is only logged — ledger and PSP diverge with no automated compensation. Fix: reversing entries on PSP capture failure + a settlement reconciliation job. |
| B4 | Medium | **Breaker-open reads as a decline.** `ErrOpenState` maps to `gateway_declined`, so a brief PSP outage permanently *declines* the user's payment instead of retrying it. Fix: a retryable gateway-submission state. |
| B5 | Medium | **No runtime contract validation.** Consumers read payload fields by string key with `?? ""` / `?? 0` fallbacks. Producer drift writes a zero-amount row into an append-only table that cannot be corrected in place. Fix: validate against `contracts/events/*.schema.json` on consume. |
| B6 | Medium | **`kid` rotation is not implemented.** A single key is loaded and published; rotating it invalidates every outstanding token at once (fleet-wide logout) rather than overlapping old and new. |
| B7 | Medium | **Fraud deep-analysis reads a lossy store.** `fraud_logs` is a `DropOldest` bounded channel, and the daily-volume threshold sums it — so the control weakens precisely under the burst it exists to detect. |
| B8 | Low | **Header trust has no enforcement.** `X-User-Id` is unspoofable from outside (Traefik overwrites it), but any workload on the internal network can call a service directly and impersonate a user. Lateral-movement only. Fix: mTLS or a signed gateway assertion. |
| B9 | Low | Idempotency records have no `recovery_point` (documented but absent) and no staleness check on `locked_at` — a crash mid-request pins that key to 409 for its full 24 h TTL. |
| B10 | Low | Hygiene: `MOCK_PSP_DECLINE_RATE` is inert (declines are hard-coded deterministic); the topic list is maintained by hand in three places; `otel-collector` has no memory cap or healthcheck; DLQ topics are outside the versioned contract. |

## Docs corrected

- Fraud rules run **denylist → velocity → amount tier → geo → model**, not the
  order in `architecture.md` §9. The code's order is better (cheapest hard signal
  short-circuits first); the doc was stale.
- `device_fingerprint` is carried in the proto and never used — there is no device
  rule, only country. "geo/device" overstated it.
- The saga's `recorded`/`notified`/`compensating`/`refunded` states are declared in
  the schema but never entered; the saga terminates at `captured`/`done`.
