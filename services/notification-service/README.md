# notification-service

Fans payment/identity/fraud facts into user-facing notifications across
channels, and pushes them live to the SPA. NestJS 11 · Node 24 · MikroORM 7.

## Behavior

- Consumes `identity.user.registered.v1` (welcome), `payments.payment.captured.v1`
  (success), `payments.payment.failed.v1` (failure), `fraud.score.flagged.v1`
  (security alert). A `ROUTES` map picks the template + channels per event.
- Idempotent via `processed_events` in the same transaction as the write;
  3 attempts → `notification-service.<topic>.dlq`.
- Templates carry only `{{param}}` placeholders — payloads pass minimal params;
  money is formatted from minor units at render (JPY/KRW/VND zero-decimal aware).
- Channel **Strategy**: `inapp` (the persisted notification row is the
  delivery) + mock `email`/`sms`/`push` transports that write to a
  dev-visible `dev_inbox`; every attempt logged in `delivery_attempts`.
- REST (ForwardAuth `X-User-Id`): `GET /notifications` inbox,
  `POST /notifications/{id}/read`, `GET /notifications/stream` (SSE live feed,
  25 s heartbeat). Health `/health/live` + `/health/ready` (DB + consumer).

## Patterns map

- **Strategy** — `ChannelStrategy` (inapp / email / sms / push)
- **Factory / Registry** — `TemplateRegistry` renders by template id
- **Mediator-ish routing** — `ROUTES` maps each event type to template+channels
- Confluent wire-format parsing shared with the Go/.NET services (`wire.ts`)

## Notes

MikroORM 7 decorator-free entities; migrations run at boot. Unit tests
(template interpolation, wire-format parse/reject) stub the ESM-only
packages and pass in the build.
