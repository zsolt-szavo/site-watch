#!/usr/bin/env bash
# End-to-end smoke test against a running `wrangler dev` (default http://localhost:8787).
set -uo pipefail
API=${API:-http://localhost:8787}
INV=${INVITE_CODE:-letmein}; TOK=${CHECKER_TOKEN:-dev-checker-token}
pass=0; fail=0
check() { # name expected_status actual_status [body]
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); echo "ok   $1"; else fail=$((fail+1)); echo "FAIL $1 (want $2 got $3) $4"; fi; }
req() { curl -s -o /tmp/sw_body -w '%{http_code}' "$@"; }

check "config"              200 "$(req $API/api/config)"
check "add w/o invite"      403 "$(req -X POST $API/api/watches -H 'Content-Type: application/json' -d '{"url":"met.hu"}')"
check "add private ip"      400 "$(req -X POST $API/api/watches -H "X-Invite-Code: $INV" -d '{"url":"http://192.168.1.1/"}')"
check "add bad mode"        400 "$(req -X POST $API/api/watches -H "X-Invite-Code: $INV" -d '{"url":"met.hu","mode":"x"}')"
check "add met.hu"          201 "$(req -X POST $API/api/watches -H "X-Invite-Code: $INV" -d '{"url":"met.hu"}')" "$(cat /tmp/sw_body)"
ID=$(python3 -c 'import json;print(json.load(open("/tmp/sw_body"))["id"])')
grep -q '"url":"https://met.hu/"' /tmp/sw_body && check "url normalized" 1 1 || check "url normalized" 1 0 "$(cat /tmp/sw_body)"
check "list"                200 "$(req $API/api/watches)"
check "patch selector"      200 "$(req -X PATCH $API/api/watches/$ID -H "X-Invite-Code: $INV" -d '{"selector":"#main","ignore":["\\d+:\\d+"]}')" "$(cat /tmp/sw_body)"
SUB='{"endpoint":"https://push.example/abc","keys":{"p256dh":"P","auth":"A"}}'
SUBREQ='{"watch_id":"'$ID'","subscription":'$SUB'}'
SUBBAD='{"watch_id":"'$ID'","subscription":{}}'
SUBUNK='{"watch_id":"nope","subscription":'$SUB'}'
REPORT='{"results":[{"id":"'$ID'","changed":true,"hash":"h","text":"t","diff":"+ new"}],"dead_endpoints":["https://push.example/abc"]}'
check "subscribe"           200 "$(req -X POST $API/api/subscribe -d "$SUBREQ")" "$(cat /tmp/sw_body)"
check "subscribe bad"       400 "$(req -X POST $API/api/subscribe -d "$SUBBAD")"
check "subscribe unknown"   404 "$(req -X POST $API/api/subscribe -d "$SUBUNK")"
req -X POST $API/api/my-subscriptions -d '{"endpoint":"https://push.example/abc"}' >/dev/null
grep -q "$ID" /tmp/sw_body && check "my-subscriptions" 1 1 || check "my-subscriptions" 1 0 "$(cat /tmp/sw_body)"
check "jobs w/o token"      401 "$(req $API/api/internal/jobs)"
check "jobs"                200 "$(req $API/api/internal/jobs -H "Authorization: Bearer $TOK")"
grep -q 'push.example/abc' /tmp/sw_body && check "jobs include subs" 1 1 || check "jobs include subs" 1 0
check "report change"       200 "$(req -X POST $API/api/internal/report -H "Authorization: Bearer $TOK" -d "$REPORT")"
req $API/api/watches/$ID >/dev/null
grep -q '"last_diff":"+ new"' /tmp/sw_body && grep -q '"subscribers":0' /tmp/sw_body && check "report applied + dead sub removed" 1 1 || check "report applied" 1 0 "$(cat /tmp/sw_body)"
grep -q 'last_text' /tmp/sw_body && check "public hides last_text" 1 0 || check "public hides last_text" 1 1
check "delete"              200 "$(req -X DELETE $API/api/watches/$ID -H "X-Invite-Code: $INV")"
check "gone"                404 "$(req $API/api/watches/$ID)"
check "cors preflight"      204 "$(req -X OPTIONS $API/api/watches -H 'Origin: http://localhost:8000')"
echo "passed $pass, failed $fail"; [[ $fail == 0 ]]
