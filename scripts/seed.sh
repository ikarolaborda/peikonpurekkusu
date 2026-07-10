#!/usr/bin/env bash
# Seeds demo users through the real API (so every event/side effect fires):
# each user gets an account with the $1,000 welcome deposit via the
# registration event, then a couple of demo payments build history.
set -euo pipefail

HTTP_PORT="${HTTP_PORT:-9080}"
API="http://api.localhost:${HTTP_PORT}"
PASSWORD="peikon-demo-passw0rd!"

seed_user() { # $1 email  $2 first  $3 last
  local email="$1" jar; jar="$(mktemp -d)/c.txt"
  curl -s -o /dev/null -X POST "$API/auth/register" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$PASSWORD\",\"first_name\":\"$2\",\"last_name\":\"$3\"}"
  local csrf
  csrf=$(curl -s -c "$jar" -X POST "$API/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$PASSWORD\"}" \
    | python3 -c "import json,sys;print(json.load(sys.stdin).get('csrf_token',''))")
  [[ -n "$csrf" ]] || { echo "  ! $email: login failed (already seeded?)"; return 0; }

  local acc=""
  for _ in $(seq 1 20); do
    acc=$(curl -s -b "$jar" "$API/accounts" | python3 -c \
      "import json,sys;a=json.load(sys.stdin).get('accounts',[]);print(a[0]['account_id'] if a else '')" 2>/dev/null || true)
    [[ -n "$acc" ]] && break
    sleep 2
  done
  [[ -n "$acc" ]] || { echo "  ! $email: account not provisioned in time"; return 0; }

  pay() { # $1 merchant  $2 amount  $3 instrument
    curl -s -o /dev/null -b "$jar" -X POST "$API/payments" \
      -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
      -H "Idempotency-Key: seed-$email-$1-$2" \
      -d "{\"account_id\":\"$acc\",\"merchant_id\":\"$1\",\"instrument_id\":\"$3\",\"amount\":{\"amount_minor_units\":$2,\"currency_code\":\"USD\"}}"
  }
  local CARD=00000000-0000-0000-0000-0000000ca4d1
  local WALLET=00000000-0000-0000-0000-0000000a11e7
  pay m-coffee 850 "$CARD"
  pay m-books 2399 "$CARD"
  pay m-games 4200 "$WALLET"
  echo "  ✓ $email (account $acc, 3 demo payments)"
}

echo "Seeding demo users (password: $PASSWORD)"
seed_user alice@peikon.dev Alice Doe
seed_user bob@peikon.dev Bob Smith
seed_user carol@peikon.dev Carol Johnson
echo "Done. Sign in at http://app.localhost:${HTTP_PORT}"
