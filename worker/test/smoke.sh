#!/usr/bin/env bash
# End-to-end smoke test against a running `wrangler dev` (default http://localhost:8787).
set -uo pipefail
API=${API:-http://localhost:8787}
TOK=${CHECKER_TOKEN:-dev-checker-token}
DEV="smoke-$(date +%s)-$RANDOM-aaaaaaaa"; OTHER="smoke-other-$(date +%s)-$RANDOM"   # device ids
D=(-H "X-Device-Id: $DEV"); O=(-H "X-Device-Id: $OTHER")
pass=0; fail=0
check() { # name expected_status actual_status [body]
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); echo "ok   $1"; else fail=$((fail+1)); echo "FAIL $1 (want $2 got $3) ${4:-}"; fi; }
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
check "jobs start=1"        200 "$(req "$API/api/internal/jobs?start=1" -H "Authorization: Bearer $TOK")"
req $API/api/check-status >/dev/null; grep -q '"state":"running"' /tmp/sw_body && check "status running" 1 1 || check "status running" 1 0 "$(cat /tmp/sw_body)"
check "fetch w/o token"     401 "$(req -X POST $API/api/internal/fetch -d '{"url":"example.com"}')"
check "fetch private ip"    400 "$(req -X POST $API/api/internal/fetch -H "Authorization: Bearer $TOK" -d '{"url":"http://127.0.0.1/"}')"
check "fetch example.com"   200 "$(req -X POST $API/api/internal/fetch -H "Authorization: Bearer $TOK" -d '{"url":"example.com"}')"
grep -q '"status":200' /tmp/sw_body && check "fetch body" 1 1 || check "fetch body" 1 0 "$(head -c 200 /tmp/sw_body)"
# Screenshots: history = first baseline + each change (newest SHOT_HISTORY kept), plus the latest check.
jpg() { printf '\xff\xd8\xff\xe0%s' "$1" | base64; }
TA="Authorization: Bearer $TOK"
rep() { req -X POST $API/api/internal/report -H "$TA" -d '{"results":[{"id":"'$ID'","changed":'$1',"hash":"h","text":"t","diff":"d'$2'","shot":"'$(jpg $2)'"}]}'; }
kinds() { req $API/api/watches/$ID/shots "${D[@]}" >/dev/null; python3 -c 'import json;print(" ".join(s["kind"] + ":" + (s["diff"] or "") for s in json.load(open("/tmp/sw_body"))))'; }
shotis() { # name index-in-list expected-payload
  local sid code; req $API/api/watches/$ID/shots "${D[@]}" >/dev/null
  sid=$(python3 -c 'import json,sys;print(json.load(open("/tmp/sw_body"))[int(sys.argv[1])]["id"])' "$2")
  code=$(curl -s -o /tmp/sw_shot -w '%{http_code}|%{content_type}' "$API/api/watches/$ID/shots/$sid" "${D[@]}")
  [[ "$code|$(base64 < /tmp/sw_shot)" == "200|image/jpeg|$(jpg $3)" ]] && check "$1" 1 1 || check "$1" 1 0 "$code"; }
check "no shots yet"        200 "$(req $API/api/watches/$ID/shots "${D[@]}")"
grep -qx '\[\]' /tmp/sw_body && check "empty history" 1 1 || check "empty history" 1 0 "$(cat /tmp/sw_body)"
check "report baseline+shot" 200 "$(rep false A)"
check "history after baseline" "latest: baseline:" "$(kinds)"
shotis "baseline image" 1 A
req $API/api/watches "${D[@]}" >/dev/null
grep -q '"has_shots":true' /tmp/sw_body && check "list has_shots" 1 1 || check "list has_shots" 1 0 "$(head -c 300 /tmp/sw_body)"
check "report unchanged"    200 "$(rep false B)"
check "unchanged only moves latest" "latest: baseline:" "$(kinds)"
shotis "latest image" 0 B
for i in 1 2 3 4; do rep true C$i >/dev/null; done
check "changes kept"        "latest: change:dC4 change:dC3 change:dC2 change:dC1 baseline:" "$(kinds)"
rep true C5 >/dev/null
check "oldest dropped at 5" "latest: change:dC5 change:dC4 change:dC3 change:dC2 change:dC1" "$(kinds)"
shotis "change image" 1 C5
check "report not-jpeg shot" 200 "$(req -X POST $API/api/internal/report -H "$TA" -d '{"results":[{"id":"'$ID'","changed":false,"hash":"h","text":"t","shot":"aGVsbG8="}]}')"
shotis "not-jpeg ignored" 0 C5
check "report shot for deleted watch" 200 "$(req -X POST $API/api/internal/report -H "$TA" -d '{"results":[{"id":"gone1234","changed":true,"hash":"h","text":"t","shot":"'$(jpg X)'"}]}')"
check "shots other device"  404 "$(req $API/api/watches/$ID/shots "${O[@]}")"
check "shot other device"   404 "$(req $API/api/watches/$ID/shots/1 "${O[@]}")"
check "shots w/o device id" 400 "$(req $API/api/watches/$ID/shots)"
check "shot unknown id"     404 "$(req $API/api/watches/$ID/shots/999999 "${D[@]}")"
REPORT='{"results":[{"id":"'$ID'","changed":true,"hash":"h","text":"t","diff":"+ new","shot":"'$(jpg Z)'"}],"dead_endpoints":["https://push.example/abc"]}'
check "report change"       200 "$(req -X POST $API/api/internal/report -H "Authorization: Bearer $TOK" -d "$REPORT")"
req $API/api/check-status >/dev/null; grep -q '"state":"idle"' /tmp/sw_body && check "status idle after report" 1 1 || check "status idle after report" 1 0 "$(cat /tmp/sw_body)"
req $API/api/watches/$ID "${D[@]}" >/dev/null
grep -q '"last_diff":"+ new"' /tmp/sw_body && grep -q '"subscribers":0' /tmp/sw_body && check "report applied + dead sub removed" 1 1 || check "report applied" 1 0 "$(cat /tmp/sw_body)"
grep -q 'last_text' /tmp/sw_body && check "public hides last_text" 1 0 || check "public hides last_text" 1 1
check "history still 5"     "latest: change:+ new change:dC5 change:dC4 change:dC3 change:dC2" "$(kinds)"
check "text"                200 "$(req $API/api/watches/$ID/text "${D[@]}")"
grep -q '"text":"t"' /tmp/sw_body && check "text body" 1 1 || check "text body" 1 0 "$(cat /tmp/sw_body)"
check "text other device"   404 "$(req $API/api/watches/$ID/text "${O[@]}")"
# A blocked streak is remembered from its first blocked report until the next non-blocked one.
since() { req $API/api/watches/$ID "${D[@]}" >/dev/null; python3 -c 'import json;print(json.load(open("/tmp/sw_body")).get("blocked_since") or "")'; }
blk() { req -X POST $API/api/internal/report -H "$TA" -d '{"results":[{"id":"'$ID'","error":"'"$1"'"}]}' >/dev/null; }
blk "blocked (HTTP 403)"; S1=$(since)
[[ -n "$S1" ]] && check "blocked_since set" 1 1 || check "blocked_since set" 1 0
blk "blocked (HTTP 403)"
check "blocked_since keeps start" "$S1" "$(since)"
blk "HTTP 500"
check "other error clears it" "" "$(since)"
# Home checker: blocked watches go to ?home=1; once it reads one, the GitHub run skips it while that is fresh.
injobs() { req "$API/api/internal/jobs$1" -H "$TA" >/dev/null; python3 -c 'import json,sys;print(int(any(w["id"]==sys.argv[1] for w in json.load(open("/tmp/sw_body")))))' "$ID"; }
check "home: not blocked, not listed" 0 "$(injobs '?home=1')"
blk "blocked (HTTP 403)"
check "home: blocked is listed" 1 "$(injobs '?home=1')"
check "github still tries it" 1 "$(injobs '')"
check "home report" 200 "$(req -X POST $API/api/internal/report -H "$TA" -d '{"via":"home","results":[{"id":"'$ID'","changed":false,"hash":"h","text":"t"}]}')"
check "home keeps it" 1 "$(injobs '?home=1')"
check "github skips it" 0 "$(injobs '')"
check "home_ok in list" 1 "$(req $API/api/watches/$ID "${D[@]}" >/dev/null; python3 -c 'import json;print(int(bool(json.load(open("/tmp/sw_body")).get("home_ok"))))')"
check "blocked_since cleared" "" "$(since)"
check "patch filter"        200 "$(req -X PATCH $API/api/watches/$ID "${D[@]}" -d '{"contains":"x"}')"
check "re-baseline drops shots" "" "$(kinds)"
check "delete"              200 "$(req -X DELETE $API/api/watches/$ID "${D[@]}")"
check "gone"                404 "$(req $API/api/watches/$ID "${D[@]}")"
# Per-device cap: 5 fit, the 6th is refused; then clean up.
IDS=(); for i in 1 2 3 4 5; do req -X POST $API/api/watches "${O[@]}" -d '{"url":"example.com"}' >/dev/null; IDS+=("$(python3 -c 'import json;print(json.load(open("/tmp/sw_body")).get("id",""))')"); done
check "5 per device ok"     5 "$(printf "%s\n" "${IDS[@]}" | grep -c .)"
check "6th refused"         429 "$(req -X POST $API/api/watches "${O[@]}" -d '{"url":"example.com"}')"
for i in "${IDS[@]}"; do req -X DELETE $API/api/watches/$i "${O[@]}" >/dev/null; done
check "cors preflight"      204 "$(req -X OPTIONS $API/api/watches -H 'Origin: http://localhost:8000')"
echo "passed $pass, failed $fail"; [[ $fail == 0 ]]
