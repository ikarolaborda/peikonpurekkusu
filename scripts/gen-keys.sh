#!/usr/bin/env bash
# Generates the ES256 signing keypair for user-service (dev only).
# Production: keys live in Azure Key Vault; this script never runs there.
set -euo pipefail

SECRETS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/secrets"
mkdir -p "$SECRETS_DIR"

if [[ -f "$SECRETS_DIR/jwt-es256-private.pem" ]]; then
  echo "✓ signing keys already present in secrets/ — skipping"
  exit 0
fi

# PKCS#8 format (BEGIN PRIVATE KEY) — what jose.importPKCS8 expects
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$SECRETS_DIR/jwt-es256-private.pem"
openssl pkey -in "$SECRETS_DIR/jwt-es256-private.pem" -pubout -out "$SECRETS_DIR/jwt-es256-public.pem"
chmod 600 "$SECRETS_DIR/jwt-es256-private.pem"

# kid = first 16 hex chars of the public key's SHA-256 (stable per key)
KID=$(openssl ec -in "$SECRETS_DIR/jwt-es256-private.pem" -pubout -outform DER 2>/dev/null | \
      shasum -a 256 | cut -c1-16)
echo "$KID" > "$SECRETS_DIR/jwt-es256.kid"

echo "✓ generated ES256 keypair (kid=$KID) in secrets/"
