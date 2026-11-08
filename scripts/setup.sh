#!/usr/bin/env bash
# Interactive first-time setup: creates .env with generated secrets, asks for your API keys,
# checks Docker, and optionally starts the stack. Safe to re-run; existing values are kept.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# Set KEY=VALUE in .env (value passed via the environment so no shell/sed escaping is needed).
set_var() {
  KEY="$1" VAL="$2" awk 'BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"]; done = 0 }
    index($0, k "=") == 1 { print k "=" v; done = 1; next } { print }
    END { if (!done) print k "=" v }' .env > .env.tmp && chmod 600 .env.tmp && mv .env.tmp .env
}
get_var() { grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }

say "1/4  Environment file"
if [ -f .env ]; then
  echo ".env already exists; only empty values will be filled."
else
  cp .env.example .env
  chmod 600 .env
  echo "Created .env from .env.example."
fi

for k in BETTER_AUTH_SECRET PAPERCLIP_TOOL_ACTION_SIGNING_SECRET AGENT_OS_WEBHOOK_SECRET CONFIRM_SECRET POSTGRES_PASSWORD; do
  if [ -z "$(get_var "$k")" ]; then
    set_var "$k" "$(openssl rand -hex 32)"
    echo "  generated $k"
  fi
done

say "2/4  API keys (input is hidden; press Enter to skip/keep)"
ask_key() {
  local k="$1" label="$2" cur v
  cur="$(get_var "$k")"
  if [ -n "$cur" ]; then
    printf '  %s is already set. Replace it? [y/N] ' "$label"
    read -r yn
    [[ "$yn" =~ ^[Yy]$ ]] || return 0
  fi
  printf '  %s: ' "$label"
  read -rs v
  echo
  [ -n "$v" ] && set_var "$k" "$v" && echo "  saved $k"
  return 0
}
echo "  (Pasting shows nothing on screen. That's expected: paste once, then press Enter.)"
ask_key ANTHROPIC_API_KEY "Anthropic API key (required, from console.anthropic.com → API Keys)"
for _ in 1 2; do
  [ -n "$(get_var ANTHROPIC_API_KEY)" ] && break
  echo "  ! The Anthropic key is required; nothing will start without it."
  ask_key ANTHROPIC_API_KEY "Anthropic API key"
done
if [ -z "$(get_var ANTHROPIC_API_KEY)" ]; then
  echo "  No Anthropic key entered. Re-run ./scripts/setup.sh when you have one (other values are kept)."
  exit 1
fi
ask_key COMPOSIO_API_KEY "Composio API key (optional; workers run without tools if empty)"
ask_key OPERATOR_TOKEN "Operator token protecting the command center (optional)"

say "3/4  Docker"
if ! command -v docker >/dev/null; then
  echo "Docker is not installed. Install Docker Engine + the compose plugin, then re-run this script."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but your user can't reach the daemon (permission denied)."
  echo "Fix it once with:   sudo usermod -aG docker \"$USER\"   then log out and back in."
  echo "Or run the stack with sudo:   sudo docker compose up --build"
  exit 1
fi
if ! docker compose config -q; then
  echo "docker-compose.yml can't be used with this .env (see the error above). Fix it, then re-run this script."
  exit 1
fi
echo "docker-compose.yml is valid with your .env."

say "4/4  Start"
fe_port="$(get_var FRONTEND_PORT)"; fe_port="${fe_port:-3000}"
pc_port="$(get_var PAPERCLIP_PORT)"; pc_port="${pc_port:-3100}"
port_busy() { command -v ss >/dev/null && ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }
for pair in "FRONTEND_PORT:$fe_port" "PAPERCLIP_PORT:$pc_port"; do
  if port_busy "${pair#*:}"; then
    hint=""; [ "${pair%%:*}" = FRONTEND_PORT ] && hint=" and CORS_ORIGIN=http://localhost:<port>"
    echo "  ! Port ${pair#*:} is already in use. Set ${pair%%:*}=<free port>$hint in .env, then re-run."
  fi
done
printf 'Build and start Paperclip, backend, frontend, Postgres and Redis now? [Y/n] '
read -r go
if [[ ! "$go" =~ ^[Nn]$ ]]; then
  echo "First build pulls Paperclip from GitHub and can take several minutes."
  echo "Command center: http://localhost:$fe_port   Paperclip: http://localhost:$pc_port"
  exec docker compose up --build
fi
echo "Start later with:  docker compose up --build"
