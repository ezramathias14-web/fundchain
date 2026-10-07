#!/usr/bin/env bash
# Demo manual "spam verify → 429" terhadap API yang sedang jalan (lokal/staging).
#   API_URL=http://localhost:3000/api/v1 TOKEN=<token sesi admin> ./scripts/spam-verify.sh
# Token admin: login sebagai admin di web → DevTools → Application → Local Storage → token sesi.
set -euo pipefail
API_URL="${API_URL:-http://localhost:3000/api/v1}"
: "${TOKEN:?Isi TOKEN dengan token sesi admin}"
N="${N:-12}"
for i in $(seq 1 "$N"); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" "$API_URL/admin/integrity/verify-all")
  echo "request #$i → HTTP $code"
done
