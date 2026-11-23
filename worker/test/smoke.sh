#!/usr/bin/env bash
# End-to-end smoke test against a running `wrangler dev` (default http://localhost:8787).
set -uo pipefail
API=${API:-http://localhost:8787}
TOK=${CHECKER_TOKEN:-dev-checker-token}
DEV="smoke-$(date +%s)-$RANDOM-aaaaaaaa"; OTHER="smoke-other-$(date +%s)-$RANDOM"   # device ids
D=(-H "X-Device-Id: $DEV"); O=(-H "X-Device-Id: $OTHER")
pass=0; fail=0
check() { # name expected_status actual_status [body]
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); echo "ok   $1"; else fail=$((fail+1)); echo "FAIL $1 (want $2 got $3) $4"; fi; }
req() { curl -s -o /tmp/sw_body -w '%{http_code}' "$@"; }

check "config"              200 "$(req $API/api/config)"
check "add w/o device id"   400 "$(req -X POST $API/api/watches -H 'Content-Type: application/json' -d '{"url":"met.hu"}')"
check "list w/o device id"  400 "$(req $API/api/watches)"
check "add private ip"      400 "$(req -X POST $API/api/watches "${D[@]}" -d '{"url":"http://192.168.1.1/"}')"
check "add bad mode"        400 "$(req -X POST $API/api/watches "${D[@]}" -d '{"url":"met.hu","mode":"x"}')"
check "add met.hu"          201 "$(req -X POST $API/api/watches "${D[@]}" -d '{"url":"met.hu"}')" "$(cat /tmp/sw_body)"
ID=$(python3 -c 'import json;print(json.load(open("/tmp/sw_body"))["id"])')
grep -q '"url":"https://met.hu/"' /tmp/sw_body && check "url normalized" 1 1 || check "url normalized" 1 0 "$(cat /tmp/sw_body)"
check "list"                200 "$(req $API/api/watches "${D[@]}")"
grep -q "$ID" /tmp/sw_body && check "list has own watch" 1 1 || check "list has own watch" 1 0
req $API/api/watches "${O[@]}" >/dev/null; grep -q "$ID" /tmp/sw_body && check "other device can't see it" 1 0 || check "other device can't see it" 1 1
check "other device get"    404 "$(req $API/api/watches/$ID "${O[@]}")"
check "other device patch"  404 "$(req -X PATCH $API/api/watches/$ID "${O[@]}" -d '{"name":"x"}')"
check "other device delete" 404 "$(req -X DELETE $API/api/watches/$ID "${O[@]}")"
check "patch selector"      200 "$(req -X PATCH $API/api/watches/$ID "${D[@]}" -d '{"selector":"#main","ignore":["\\d+:\\d+"]}')" "$(cat /tmp/sw_body)"
SUB='{"endpoint":"https://push.example/abc","keys":{"p256dh":"P","auth":"A"}}'
SUBREQ='{"watch_id":"'$ID'","subscription":'$SUB'}'
SUBBAD='{"watch_id":"'$ID'","subscription":{}}'
SUBUNK='{"watch_id":"nope","subscription":'$SUB'}'
REPORT='{"results":[{"id":"'$ID'","changed":true,"hash":"h","text":"t","diff":"+ new"}],"dead_endpoints":["https://push.example/abc"]}'
check "subscribe other dev" 404 "$(req -X POST $API/api/subscribe "${O[@]}" -d "$SUBREQ")"
check "subscribe"           200 "$(req -X POST $API/api/subscribe "${D[@]}" -d "$SUBREQ")" "$(cat /tmp/sw_body)"
check "subscribe bad"       400 "$(req -X POST $API/api/subscribe "${D[@]}" -d "$SUBBAD")"
check "subscribe unknown"   404 "$(req -X POST $API/api/subscribe "${D[@]}" -d "$SUBUNK")"
req -X POST $API/api/my-subscriptions -d '{"endpoint":"https://push.example/abc"}' >/dev/null
grep -q "$ID" /tmp/sw_body && check "my-subscriptions" 1 1 || check "my-subscriptions" 1 0 "$(cat /tmp/sw_body)"
check "jobs w/o token"      401 "$(req $API/api/internal/jobs)"
check "jobs"                200 "$(req $API/api/internal/jobs -H "Authorization: Bearer $TOK")"
grep -q 'push.example/abc' /tmp/sw_body && check "jobs include subs" 1 1 || check "jobs include subs" 1 0
check "report change"       200 "$(req -X POST $API/api/internal/report -H "Authorization: Bearer $TOK" -d "$REPORT")"
req $API/api/watches/$ID "${D[@]}" >/dev/null
grep -q '"last_diff":"+ new"' /tmp/sw_body && grep -q '"subscribers":0' /tmp/sw_body && check "report applied + dead sub removed" 1 1 || check "report applied" 1 0 "$(cat /tmp/sw_body)"
grep -q 'last_text' /tmp/sw_body && check "public hides last_text" 1 0 || check "public hides last_text" 1 1
check "delete"              200 "$(req -X DELETE $API/api/watches/$ID "${D[@]}")"
check "gone"                404 "$(req $API/api/watches/$ID "${D[@]}")"
# Per-device cap: 5 fit, the 6th is refused; then clean up.
IDS=(); for i in 1 2 3 4 5; do req -X POST $API/api/watches "${O[@]}" -d '{"url":"example.com"}' >/dev/null; IDS+=("$(python3 -c 'import json;print(json.load(open("/tmp/sw_body")).get("id",""))')"); done
check "5 per device ok"     5 "$(printf "%s\n" "${IDS[@]}" | grep -c .)"
check "6th refused"         429 "$(req -X POST $API/api/watches "${O[@]}" -d '{"url":"example.com"}')"
for i in "${IDS[@]}"; do req -X DELETE $API/api/watches/$i "${O[@]}" >/dev/null; done
check "cors preflight"      204 "$(req -X OPTIONS $API/api/watches -H 'Origin: http://localhost:8000')"
echo "passed $pass, failed $fail"; [[ $fail == 0 ]]
