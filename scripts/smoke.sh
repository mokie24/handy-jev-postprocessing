#!/bin/sh
# Smoke check: models + passthrough chat completions (no key needed for echo).
set -eu
BASE="${BASE:-http://127.0.0.1:11434}"
echo "== GET /v1/models =="
curl -sf "$BASE/v1/models"
echo
echo "== POST /v1/chat/completions =="
curl -sf "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"model":"jev-dictation","messages":[{"role":"user","content":"The meeting is Thursday, sorry, Friday at three."}]}'
echo
