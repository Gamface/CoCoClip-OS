#!/usr/bin/env bash
# Connect Paperclip to Agent OS:
#   1. gets the backend a Paperclip board key (you approve it in your browser) and saves it as
#      PAPERCLIP_API_KEY in .env,
#   2. switches the agents you pick to Paperclip's HTTP adapter, pointed at the Agent OS backend.
# Paperclip's UI hides the HTTP adapter in this version, so this uses its API. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "No .env. Run ./scripts/setup.sh first."; exit 1; }
command -v curl >/dev/null || { echo "curl is required."; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required."; exit 1; }

get_var() { grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }
set_var() {
  KEY="$1" VAL="$2" awk 'BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"]; done = 0 }
    index($0, k "=") == 1 { print k "=" v; done = 1; next } { print }
    END { if (!done) print k "=" v }' .env > .env.tmp && chmod 600 .env.tmp && mv .env.tmp .env
}
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {'d': d}))" "$1"; }

port="$(get_var PAPERCLIP_PORT)"; port="${port:-3100}"
base="http://localhost:$port/api"
secret="$(get_var AGENT_OS_WEBHOOK_SECRET)"
[ -n "$secret" ] || { echo "AGENT_OS_WEBHOOK_SECRET is empty in .env. Run ./scripts/setup.sh first."; exit 1; }
curl -fsS "$base/health" >/dev/null || { echo "Paperclip isn't answering on $base. Start it with: docker compose up -d"; exit 1; }

# The paperclip service needs the private-endpoint allowlist from docker-compose.yml.
echo "Making sure Paperclip allows calls to the Agent OS backend..."
docker compose up -d paperclip >/dev/null
# Recreating the container (e.g. after the allowlist was added) restarts Paperclip; wait for it.
printf 'Waiting for Paperclip'
for _ in $(seq 1 90); do
  curl -fs -o /dev/null "$base/health" && break
  printf '.'; sleep 2
done
echo
curl -fs -o /dev/null "$base/health" || { echo "Paperclip didn't come back. Check: docker compose logs --tail=40 paperclip"; exit 1; }

key="$(get_var PAPERCLIP_API_KEY)"
board_ok() { [ -n "$1" ] && curl -fs -o /dev/null -H "Authorization: Bearer $1" "$base/companies"; }

if board_ok "$key"; then
  echo "PAPERCLIP_API_KEY already has board access."
else
  [ -n "$key" ] && echo "The current PAPERCLIP_API_KEY isn't a board key (it can't list companies). Getting a board key."
  ch="$(curl -fsS -X POST "$base/cli-auth/challenges" -H 'Content-Type: application/json' \
        -d '{"command":"agent-os connect-paperclip","clientName":"Agent OS backend"}')"
  id="$(printf '%s' "$ch" | json 'd["id"]')"
  tok="$(printf '%s' "$ch" | json 'd["token"]')"
  pending="$(printf '%s' "$ch" | json 'd["boardApiToken"]')"
  path="$(printf '%s' "$ch" | json 'd["approvalPath"]')"
  echo
  echo "Open this link in the browser where you're signed in to Paperclip, and click Approve:"
  echo "  http://localhost:$port$path"
  echo
  printf 'Waiting for approval'
  status=pending
  for _ in $(seq 1 300); do
    status="$(curl -fsS "$base/cli-auth/challenges/$id?token=$tok" | json 'd.get("status","pending")' || echo pending)"
    [ "$status" = pending ] || break
    printf '.'; sleep 2
  done
  echo
  [ "$status" = approved ] || { echo "Not approved ($status). Re-run this script to try again."; exit 1; }
  set_var PAPERCLIP_API_KEY "$pending"
  key="$pending"
  echo "Saved the board key to .env as PAPERCLIP_API_KEY."
fi

auth=(-H "Authorization: Bearer $key")
companies="$(curl -fsS "${auth[@]}" "$base/companies")"
mapfile -t cids < <(printf '%s' "$companies" | json '"\n".join(c["id"] for c in d)')
mapfile -t cnames < <(printf '%s' "$companies" | json '"\n".join(c["name"] for c in d)')
[ "${#cids[@]}" -gt 0 ] && [ -n "${cids[0]}" ] || { echo "No companies in Paperclip yet. Create one first."; exit 1; }
ci=0
if [ "${#cids[@]}" -gt 1 ]; then
  for i in "${!cids[@]}"; do echo "  $((i+1))) ${cnames[$i]}"; done
  read -rp "Which company? [1] " n; ci=$(( ${n:-1} - 1 ))
fi
cid="${cids[$ci]}"

agents="$(curl -fsS "${auth[@]}" "$base/companies/$cid/agents")"
mapfile -t aids < <(printf '%s' "$agents" | json '"\n".join(a["id"] for a in d)')
mapfile -t alabels < <(printf '%s' "$agents" | json '"\n".join("%s  (%s, now: %s)" % (a.get("name"), a.get("role") or "-", a.get("adapterType")) for a in d)')
[ "${#aids[@]}" -gt 0 ] && [ -n "${aids[0]}" ] || { echo "No agents in ${cnames[$ci]} yet. Hire one in Paperclip first."; exit 1; }
echo
echo "Agents in ${cnames[$ci]}:"
for i in "${!aids[@]}"; do echo "  $((i+1))) ${alabels[$i]}"; done
echo "Connected agents run as Agent OS workers (Claude + Composio tools) instead of their current harness."
read -rp "Which agents should Agent OS run? (numbers separated by spaces, or 'all') " picks
[ "$picks" = all ] && picks="$(seq -s ' ' 1 "${#aids[@]}")"

body="$(SECRET="$secret" python3 -c 'import json,os; print(json.dumps({"adapterType":"http","adapterConfig":{"url":"http://backend:8000/paperclip/heartbeat","method":"POST","headers":{"x-agent-os-secret":os.environ["SECRET"]}}}))')"
for n in $picks; do
  i=$((n-1)); [ "$i" -ge 0 ] && [ "$i" -lt "${#aids[@]}" ] || { echo "  skipped $n (no such agent)"; continue; }
  if curl -fsS -o /dev/null -X PATCH "${auth[@]}" -H 'Content-Type: application/json' -d "$body" "$base/agents/${aids[$i]}"; then
    echo "  connected ${alabels[$i]%%  (*}"
  else
    echo "  ! failed to update ${alabels[$i]%%  (*}"
  fi
done

echo
echo "Restarting the backend so it uses the key..."
docker compose up -d backend >/dev/null
echo "Done. Open the command center; your company and connected agents should appear."
echo "Paused agents still need to be resumed in Paperclip before they pick up tasks."
