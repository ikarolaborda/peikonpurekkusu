#!/usr/bin/env bash
# Rotates the ES256 signing key WITHOUT invalidating outstanding tokens:
# the old public key is retired into secrets/retired-jwt-keys/<kid>.pem, where
# user-service keeps verifying it until you remove the file. Remove it once
# ACCESS_TOKEN_TTL (+ clock tolerance) has passed since the rotation.
set -euo pipefail

SECRETS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/secrets"
RETIRED_DIR="$SECRETS_DIR/retired-jwt-keys"
mkdir -p "$RETIRED_DIR"

OLD_KID=$(cat "$SECRETS_DIR/jwt-es256.kid")
cp "$SECRETS_DIR/jwt-es256-public.pem" "$RETIRED_DIR/$OLD_KID.pem"

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$SECRETS_DIR/jwt-es256-private.pem"
openssl pkey -in "$SECRETS_DIR/jwt-es256-private.pem" -pubout -out "$SECRETS_DIR/jwt-es256-public.pem"
chmod 600 "$SECRETS_DIR/jwt-es256-private.pem"
NEW_KID=$(openssl ec -in "$SECRETS_DIR/jwt-es256-private.pem" -pubout -outform DER 2>/dev/null | shasum -a 256 | cut -c1-16)
echo "$NEW_KID" > "$SECRETS_DIR/jwt-es256.kid"

echo "✓ rotated: $OLD_KID (retired, still verifying) → $NEW_KID (signing)"
echo "  restart user-service to load the ring, e.g.: docker compose restart user-service"
echo "  after the access-token TTL has passed: rm secrets/retired-jwt-keys/$OLD_KID.pem && restart again"
