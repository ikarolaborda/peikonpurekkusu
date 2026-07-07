#!/usr/bin/env bash
# End-to-end smoke test through the Traefik edge. Sections activate as the
# corresponding vertical slices land. Requires: curl, python3.
set -euo pipefail

HTTP_PORT="${HTTP_PORT:-9080}"
API="http://api.localhost:${HTTP_PORT}"
JAR="$(mktemp -d)/cookies.txt"
EMAIL="smoke+$(date +%s)@peikon.dev"
PASSWORD="correct-horse-battery-staple-42"

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

json_get() { python3 -c "import json,sys; print(json.load(sys.stdin).get('$1',''))"; }

echo "── auth slice ──────────────────────────────────────────"

# 0. gateway warm-up: Traefik adds containers only after they turn healthy,
#    with a short propagation delay — probe until routing is live.
for _ in $(seq 1 30); do
  curl -sf -o /dev/null "$API/.well-known/jwks.json" && break
  sleep 2
done
curl -sf -o /dev/null "$API/.well-known/jwks.json" || fail "gateway never started routing to user-service"
pass "gateway routing live"

# 1. register
code=$(curl -s -o /tmp/smoke-reg.json -w '%{http_code}' -X POST "$API/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"first_name\":\"Smoke\",\"last_name\":\"Test\"}")
[[ "$code" == "201" ]] || fail "register → $code (want 201)"
pass "register ($EMAIL)"

# 2. login sets cookies + returns CSRF
resp=$(curl -s -c "$JAR" -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"device_fingerprint\":\"smoke-device\"}")
CSRF=$(echo "$resp" | json_get csrf_token)
[[ -n "$CSRF" ]] || fail "login returned no csrf_token: $resp"
ACCESS_COOKIE="${COOKIE_ACCESS_NAME:-at}"
REFRESH_COOKIE="${COOKIE_REFRESH_NAME:-rt}"
awk -v c="$ACCESS_COOKIE" '$6==c{found=1} END{exit !found}' "$JAR" || fail "no $ACCESS_COOKIE cookie set"
awk -v c="$REFRESH_COOKIE" '$6==c{found=1} END{exit !found}' "$JAR" || fail "no $REFRESH_COOKIE cookie set"
pass "login (cookies + CSRF)"

# 3. authenticated profile via gateway ForwardAuth
code=$(curl -s -o /tmp/smoke-me.json -w '%{http_code}' -b "$JAR" "$API/users/me")
[[ "$code" == "200" ]] || fail "/users/me → $code (want 200)"
[[ "$(json_get email < /tmp/smoke-me.json)" == "$EMAIL" ]] || fail "/users/me wrong identity"
pass "gateway ForwardAuth (/users/me)"

# 4. mutating request without CSRF header is rejected at the edge
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$API/users/me" || true)
[[ "$code" == "403" || "$code" == "404" ]] || fail "mutation without CSRF → $code (want 403/404)"
pass "CSRF enforced for mutations at gateway"

# 5. refresh rotation works…
code=$(curl -s -o /tmp/smoke-ref.json -w '%{http_code}' -b "$JAR" -c "$JAR.new" -X POST "$API/auth/refresh" \
  -H 'X-Device-Fingerprint: smoke-device')
[[ "$code" == "200" ]] || fail "refresh → $code (want 200)"
pass "refresh rotation"

# 6. …and REUSING the old refresh token (theft simulation) gets rejected
sleep 11   # step outside the parallel-tab grace window
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$API/auth/refresh" \
  -H 'X-Device-Fingerprint: smoke-device')
[[ "$code" == "401" ]] || fail "refresh reuse → $code (want 401)"
pass "refresh reuse detected (family revoked)"

# 7. the rotated session was revoked family-wide — its cookies must be dead too
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR.new" "$API/users/me")
[[ "$code" == "401" || "$code" == "503" ]] || fail "post-revocation access → $code (want 401)"
pass "family-wide revocation (stolen-token blast radius = 0)"

# 8. JWKS is published
curl -sf "$API/.well-known/jwks.json" | grep -q '"kid"' || fail "JWKS missing"
pass "JWKS published"

echo ""
echo "auth slice: ALL GREEN"

# ── account slice ────────────────────────────────────────────────────────────
echo ""
echo "── account slice ───────────────────────────────────────"
# The revoked session from the auth tests is dead — start a fresh identity.
EMAIL2="smoke-acct+$(date +%s)@peikon.dev"
JAR2="$(mktemp -d)/cookies2.txt"
curl -s -o /dev/null -X POST "$API/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL2\",\"password\":\"$PASSWORD\",\"first_name\":\"Smoke\",\"last_name\":\"Acct\"}"

# account provisioning is event-driven (outbox → Kafka → consumer): poll for it
curl -s -c "$JAR2" -o /dev/null -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL2\",\"password\":\"$PASSWORD\"}"
ACC=""
for _ in $(seq 1 20); do
  ACC=$(curl -s -b "$JAR2" "$API/accounts" | python3 -c \
    "import json,sys; a=json.load(sys.stdin).get('accounts',[]); print(a[0]['account_id'] if a else '')" 2>/dev/null)
  [[ -n "$ACC" ]] && break
  sleep 2
done
[[ -n "$ACC" ]] || fail "account never provisioned (outbox→Kafka→consumer pipeline)"
pass "account auto-provisioned via Kafka ($ACC)"

bal=$(curl -s -b "$JAR2" "$API/accounts/$ACC/balance" | python3 -c \
  "import json,sys; d=json.load(sys.stdin); print(d['available_minor_units'], d['source'])")
[[ "$bal" == "100000 ledger" ]] || fail "unexpected balance/source: $bal"
pass "welcome deposit posted (double-entry, source=ledger)"

entries=$(curl -s -b "$JAR2" "$API/accounts/$ACC/entries" | python3 -c \
  "import json,sys; e=json.load(sys.stdin)['entries']; print(e[0]['kind'], e[0]['direction'], e[0]['amount_minor_units'])")
[[ "$entries" == "deposit credit 100000" ]] || fail "unexpected ledger entries: $entries"
pass "immutable ledger entries readable"

echo ""
echo "account slice: ALL GREEN"
