#!/bin/bash
# Import all HSBC eStatement PDFs from R2 into the bank_statements system.
# Usage: ./scripts/import-bank-statements.sh

set -e

API_BASE="${API_BASE:-https://your-domain.com}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
WRANGLER="npx wrangler"
CFG="api/wrangler.toml"
BUCKET="opcc-crm-files"
R2_PREFIX="u-5dc14ca8/fs-"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PARSER="$SCRIPT_DIR/parse_hsbc.py"
TMPDIR="$(mktemp -d)"
trap "rm -rf $TMPDIR" EXIT

echo "=== OPCC CRM Bank Statement Import ==="
echo ""

# ?€?€ Step 1: Login to get JWT ?€?€
echo ">> Logging in as PnR..."
read -sp "Password for admin user: " PASSWORD
echo ""

LOGIN_RESP=$(curl -s -X POST "$API_BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PASSWORD\"}")

TOKEN=$(echo "$LOGIN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
USER_ID=$(echo "$LOGIN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user',{}).get('id',''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "ERROR: Login failed. Response: $LOGIN_RESP"
  exit 1
fi
echo "Logged in as user: $USER_ID"
echo ""

# ?€?€ Step 2: Get list of eStatement PDFs from R2 ?€?€
echo ">> Fetching eStatement list from D1..."
R2_KEYS=$($WRANGLER d1 execute opcc-crm-db --remote --config "$CFG" --json --command \
  "SELECT r2_key, filename FROM file_records WHERE user_id = '$USER_ID' AND filename LIKE 'eStatement%' ORDER BY filename" 2>/dev/null \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
for row in data[0]['results']:
    print(row['r2_key'])
")

if [ -z "$R2_KEYS" ]; then
  echo "ERROR: No eStatement files found for user $USER_ID"
  exit 1
fi

TOTAL=$(echo "$R2_KEYS" | wc -l | tr -d ' ')
echo "Found $TOTAL eStatement PDFs to import"
echo ""

# ?€?€ Step 3: Process each PDF ?€?€
SUCCESS=0
SKIPPED=0
FAILED=0

for R2_KEY in $R2_KEYS; do
  FILENAME=$(basename "$R2_KEY")
  echo -n "  [$FILENAME] "

  # Download from R2
  PDF_FILE="$TMPDIR/$(echo "$FILENAME" | tr ' ' '_')"
  if $WRANGLER r2 object get "$BUCKET/$R2_KEY" --file "$PDF_FILE" --config "$CFG" 2>/dev/null; then
    :
  else
    echo "FAILED (R2 download error)"
    FAILED=$((FAILED + 1))
    continue
  fi

  # Extract text with pdftotext
  TEXT_FILE="$PDF_FILE.txt"
  if pdftotext -layout "$PDF_FILE" "$TEXT_FILE" 2>/dev/null; then
    :
  else
    echo "FAILED (pdftotext error)"
    FAILED=$((FAILED + 1))
    continue
  fi

  # Parse
  PARSE_JSON=$($PYTHON3 "$PARSER" "$TEXT_FILE" "$R2_KEY" 2>/dev/null)
  if [ $? -ne 0 ]; then
    echo "FAILED (parser error)"
    FAILED=$((FAILED + 1))
    continue
  fi

  # Post to API
  IMPORT_RESP=$(curl -s -w "\n%{http_code}" -X POST "$API_BASE/api/bank-statements/import" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "$PARSE_JSON")

  HTTP_CODE=$(echo "$IMPORT_RESP" | tail -1)
  RESP_BODY=$(echo "$IMPORT_RESP" | sed '$d')

  if [ "$HTTP_CODE" = "201" ]; then
    TX_COUNT=$(echo "$RESP_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('transactions_count',0))" 2>/dev/null)
    echo "OK ($TX_COUNT txs)"
    SUCCESS=$((SUCCESS + 1))
  elif [ "$HTTP_CODE" = "409" ]; then
    echo "SKIPPED (already imported)"
    SKIPPED=$((SKIPPED + 1))
  else
    echo "FAILED (HTTP $HTTP_CODE: $(echo "$RESP_BODY" | head -c 100))"
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "=== Import Complete ==="
echo "  Success: $SUCCESS"
echo "  Skipped: $SKIPPED"
echo "  Failed:  $FAILED"
echo "  Total:   $TOTAL"
