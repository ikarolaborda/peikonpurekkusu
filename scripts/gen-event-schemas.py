#!/usr/bin/env python3
"""Generates contracts/events/*.schema.json from the event table below.

Every event is self-contained (no cross-subject $ref — Apicurio ccompat edge
cases) and shares the same envelope fields. Payload fields are per event.
Money is always {amount_minor_units: integer, currency_code: ISO-4217}.
Run: python3 scripts/gen-event-schemas.py
"""
import json
import pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "contracts" / "events"

MONEY = {
    "amount_minor_units": {"type": "integer"},
    "currency_code": {"type": "string", "pattern": "^[A-Z]{3}$"},
}

# event name -> (topic, payload properties, required payload fields)
EVENTS = {
    "payment-requested": (
        "payments.payment.requested.v1",
        {**MONEY, "payment_id": {"type": "string", "format": "uuid"},
         "user_id": {"type": "string", "format": "uuid"},
         "merchant_id": {"type": "string"},
         "payment_method": {"type": "string", "enum": ["card", "wallet", "bank"]},
         "fx_quote_id": {"type": ["string", "null"]}},
        ["payment_id", "user_id", "merchant_id", "amount_minor_units", "currency_code"],
    ),
    "payment-authorized": (
        "payments.payment.authorized.v1",
        {**MONEY, "payment_id": {"type": "string", "format": "uuid"},
         "hold_id": {"type": "string", "format": "uuid"},
         "psp_reference": {"type": "string"}},
        ["payment_id", "hold_id", "amount_minor_units", "currency_code"],
    ),
    "payment-captured": (
        "payments.payment.captured.v1",
        {**MONEY, "payment_id": {"type": "string", "format": "uuid"},
         "user_id": {"type": "string", "format": "uuid"},
         "account_id": {"type": "string", "format": "uuid"},
         "merchant_id": {"type": "string"},
         "hold_id": {"type": "string", "format": "uuid"},
         "ledger_transaction_id": {"type": "string", "format": "uuid"},
         "psp_reference": {"type": "string"},
         "fx_rate_used": {"type": ["string", "null"],
                          "description": "decimal string; null for same-currency"}},
        ["payment_id", "user_id", "account_id", "amount_minor_units",
         "currency_code", "ledger_transaction_id"],
    ),
    "payment-failed": (
        "payments.payment.failed.v1",
        {**MONEY, "payment_id": {"type": "string", "format": "uuid"},
         "user_id": {"type": "string", "format": "uuid"},
         "failure_code": {"type": "string",
                          "enum": ["fraud_denied", "insufficient_funds",
                                   "gateway_declined", "gateway_unavailable",
                                   "expired", "canceled"]},
         "failure_detail": {"type": "string"}},
        ["payment_id", "user_id", "failure_code"],
    ),
    "payment-reversed": (
        "payments.payment.reversed.v1",
        {**MONEY, "payment_id": {"type": "string", "format": "uuid"},
         "reversal_ledger_transaction_id": {"type": "string", "format": "uuid"},
         "reason": {"type": "string"}},
        ["payment_id", "reversal_ledger_transaction_id", "reason"],
    ),
    "funds-held": (
        "accounts.funds.held.v1",
        {**MONEY, "hold_id": {"type": "string", "format": "uuid"},
         "account_id": {"type": "string", "format": "uuid"},
         "payment_id": {"type": "string", "format": "uuid"},
         "expires_at": {"type": "string", "format": "date-time"}},
        ["hold_id", "account_id", "payment_id", "amount_minor_units", "currency_code"],
    ),
    "funds-captured": (
        "accounts.funds.captured.v1",
        {**MONEY, "hold_id": {"type": "string", "format": "uuid"},
         "account_id": {"type": "string", "format": "uuid"},
         "ledger_transaction_id": {"type": "string", "format": "uuid"}},
        ["hold_id", "account_id", "ledger_transaction_id",
         "amount_minor_units", "currency_code"],
    ),
    "funds-released": (
        "accounts.funds.released.v1",
        {**MONEY, "hold_id": {"type": "string", "format": "uuid"},
         "account_id": {"type": "string", "format": "uuid"},
         "reason": {"type": "string", "enum": ["compensation", "expiry", "partial_capture_remainder"]}},
        ["hold_id", "account_id", "amount_minor_units", "currency_code", "reason"],
    ),
    "transaction-recorded": (
        "transactions.transaction.recorded.v1",
        {**MONEY, "transaction_id": {"type": "string", "format": "uuid"},
         "payment_id": {"type": "string", "format": "uuid"},
         "account_id": {"type": "string", "format": "uuid"},
         "transaction_type": {"type": "string",
                              "enum": ["purchase", "refund", "hold", "capture",
                                       "release", "chargeback", "fx_conversion"]},
         "recorded_at": {"type": "string", "format": "date-time"}},
        ["transaction_id", "payment_id", "account_id", "transaction_type",
         "amount_minor_units", "currency_code"],
    ),
    "fraud-score-approved": (
        "fraud.score.approved.v1",
        {"fraud_log_id": {"type": "string", "format": "uuid"},
         "payment_id": {"type": "string", "format": "uuid"},
         "risk_score": {"type": "integer", "minimum": 0, "maximum": 100},
         "model_version": {"type": ["string", "null"]}},
        ["fraud_log_id", "payment_id", "risk_score"],
    ),
    "fraud-score-denied": (
        "fraud.score.denied.v1",
        {"fraud_log_id": {"type": "string", "format": "uuid"},
         "payment_id": {"type": "string", "format": "uuid"},
         "risk_score": {"type": "integer", "minimum": 0, "maximum": 100},
         "triggered_rules": {"type": "array", "items": {"type": "string"}}},
        ["fraud_log_id", "payment_id", "risk_score"],
    ),
    "fraud-score-flagged": (
        "fraud.score.flagged.v1",
        {"fraud_log_id": {"type": "string", "format": "uuid"},
         "payment_id": {"type": "string", "format": "uuid"},
         "user_id": {"type": "string", "format": "uuid"},
         "risk_score": {"type": "integer", "minimum": 0, "maximum": 100},
         "recommended_action": {"type": "string",
                                "enum": ["reverse", "step_up", "freeze_account", "review"]},
         "detail": {"type": "string"}},
        ["fraud_log_id", "payment_id", "user_id", "risk_score", "recommended_action"],
    ),
    "user-registered": (
        "identity.user.registered.v1",
        {"user_id": {"type": "string", "format": "uuid"},
         "kyc_status": {"type": "string", "enum": ["pending", "verified", "rejected"]},
         "registered_at": {"type": "string", "format": "date-time"}},
        ["user_id", "kyc_status"],
    ),
    "session-revoked": (
        "identity.user.session_revoked.v1",
        {"user_id": {"type": "string", "format": "uuid"},
         "session_id": {"type": "string"},
         "reason": {"type": "string",
                    "enum": ["logout", "refresh_reuse_detected", "admin_revoke",
                             "fraud_freeze", "password_change"]},
         "family_wide": {"type": "boolean"}},
        ["user_id", "session_id", "reason"],
    ),
    "notification-requested": (
        "notifications.notification.requested.v1",
        {"notification_id": {"type": "string", "format": "uuid"},
         "user_id": {"type": "string", "format": "uuid"},
         "template_id": {"type": "string"},
         "channel": {"type": "string", "enum": ["email", "sms", "push", "inapp"]},
         "params": {"type": "object",
                    "description": "template params — never raw PII beyond what the template needs"}},
        ["notification_id", "user_id", "template_id", "channel"],
    ),
    "notification-delivered": (
        "notifications.notification.delivered.v1",
        {"notification_id": {"type": "string", "format": "uuid"},
         "channel": {"type": "string", "enum": ["email", "sms", "push", "inapp"]},
         "delivered_at": {"type": "string", "format": "date-time"}},
        ["notification_id", "channel"],
    ),
    "notification-failed": (
        "notifications.notification.failed.v1",
        {"notification_id": {"type": "string", "format": "uuid"},
         "channel": {"type": "string", "enum": ["email", "sms", "push", "inapp"]},
         "attempts": {"type": "integer"},
         "last_error": {"type": "string"}},
        ["notification_id", "channel", "attempts"],
    ),
    "psp-completed": (
        "gateway.psp.completed.v1",
        {**MONEY, "psp_reference": {"type": "string"},
         "payment_id": {"type": "string", "format": "uuid"},
         "outcome": {"type": "string", "enum": ["approved", "declined", "error"]},
         "decline_code": {"type": ["string", "null"]}},
        ["psp_reference", "payment_id", "outcome"],
    ),
}

ENVELOPE_PROPS = {
    "event_id": {"type": "string", "format": "uuid",
                 "description": "uuidv7 — consumer dedup key"},
    "event_type": {"type": "string"},
    "schema_version": {"type": "integer", "minimum": 1},
    "occurred_at": {"type": "string", "format": "date-time"},
    "tenant_id": {"type": "string", "default": "peikon"},
    "correlation_id": {"type": "string",
                       "description": "W3C trace-id of the originating request"},
    "causation_id": {"type": ["string", "null"],
                     "description": "event_id of the event that caused this one"},
    "idempotency_key": {"type": ["string", "null"],
                        "description": "client idempotency key when user-initiated"},
}
ENVELOPE_REQUIRED = ["event_id", "event_type", "schema_version", "occurred_at",
                     "correlation_id", "payload"]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (topic, payload_props, payload_required) in EVENTS.items():
        schema = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": f"https://peikonpurekkusu.dev/events/{name}.schema.json",
            "title": topic,
            "type": "object",
            "additionalProperties": False,
            "properties": {
                **ENVELOPE_PROPS,
                "event_type": {"type": "string", "const": topic},
                "payload": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": payload_props,
                    "required": payload_required,
                },
            },
            "required": ENVELOPE_REQUIRED,
        }
        path = OUT / f"{name}.schema.json"
        path.write_text(json.dumps(schema, indent=2) + "\n")
        print(f"✓ {path.relative_to(OUT.parent.parent)}")
    # topic → schema-file map used by register-schemas.sh
    mapping = {topic: f"{name}.schema.json" for name, (topic, _, _) in EVENTS.items()}
    (OUT / "topics.json").write_text(json.dumps(mapping, indent=2, sort_keys=True) + "\n")
    print(f"✓ contracts/events/topics.json ({len(mapping)} topics)")


if __name__ == "__main__":
    main()
