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

*Residual, stated honestly:* capturing externally first opens a window where the
processor has the money and our books do not yet say so. That is strictly better
than the bug it replaces — it is non-terminal, visible, self-healing, and its
worst case is "our own database is down", not "we credited a merchant for money
that never arrived". A true settlement reconciliation against PSP reports is the
proper safety net on top; it is **not** built, because the mock PSP exposes no
settlement report to reconcile against, and inventing one would be theatre.

*Verified live* with an injected capture rejection, through the real payment flow:
**before** — `succeeded / captured`, customer debited 1577; **after** — `failed /
gateway_capture_failed`, balance restored to 0 delta. Smoke stayed 18/18.

### Still open, ranked

| # | Severity | Issue |
|---|---|---|
| B5 | Medium | **No runtime contract validation.** Consumers read payload fields by string key with `?? ""` / `?? 0` fallbacks. Producer drift writes a zero-amount row into an append-only table that cannot be corrected in place. Fix: validate against `contracts/events/*.schema.json` on consume. |
| B6 | Medium | **`kid` rotation is not implemented.** A single key is loaded and published; rotating it invalidates every outstanding token at once (fleet-wide logout) rather than overlapping old and new. |
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
