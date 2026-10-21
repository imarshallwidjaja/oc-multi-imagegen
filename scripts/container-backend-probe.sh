#!/bin/sh
# Runs inside an OpenCode container, mounted by scripts/opencode-container.sh. It starts a private server and prints what
# the host registered for the plugin's selected backend, with no model and no credential. The image has busybox wget, sed
# and grep but no jq or Node, so this is POSIX sh.
#
#   container-backend-probe.sh v1 <codex|openai-api>   OpenCode 1: the sign-in method, any provider entry, the tool
#   container-backend-probe.sh v2 <codex|openai-api>   OpenCode 2: the integration and its methods
#
# openai-api must register the openai-images sign-in under that id with exactly one method, the key-only one (type
# "api" on OpenCode 1, "key" on OpenCode 2), and register no provider entry; codex must register no openai-images
# entry at all, whatever its methods, because its sign-in belongs to the host. Exit 0 means every printed fact matched; a
# fact that does not match, or a request that fails, prints the server log to stderr and exits 1.
# PROBE_TMP names the container's scratch directory; the unit tests point it at a temporary directory.

host=${1:-}
backend=${2:-}
case $host in v1 | v2) ;; *) echo "usage: container-backend-probe.sh v1|v2 codex|openai-api" >&2; exit 2 ;; esac
case $backend in codex | openai-api) ;; *) echo "usage: container-backend-probe.sh v1|v2 codex|openai-api" >&2; exit 2 ;; esac

tmp=${PROBE_TMP:-/tmp}
auth="Authorization: Basic $(printf opencode:probe | base64)"
url=http://127.0.0.1:4096

opencode serve --port 4096 --hostname 127.0.0.1 >"$tmp/serve.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT

# Prints the reply to GET $1. OpenCode 2 needs the server password; OpenCode 1 has none.
get() {
  if [ "$host" = v2 ]; then
    wget -T 10 -qO- --header "$auth" "$url$1"
  else
    wget -T 10 -qO- "$url$1"
  fi
}

fail() {
  {
    echo "Probe failed: $1"
    echo "Server log (last 30 lines):"
    tail -n 30 "$tmp/serve.log"
  } >&2
  exit 1
}

# A request made before the location boots returns empty lists.
i=0
until get /api/location >/dev/null 2>&1 || get /path >/dev/null 2>&1 || [ $i -ge 60 ]; do i=$((i + 1)); sleep 1; done
sleep 2

# expect <what> <found text> <wanted: present|absent>
expect() {
  if [ "$3" = present ]; then
    [ -n "$2" ] || fail "$1 is missing or has the wrong shape"
    echo "$1: $2"
  else
    [ -z "$2" ] || fail "$1 is registered but should not be: $2"
    echo "$1: none"
  fi
}

wanted=absent
[ "$backend" = openai-api ] && wanted=present

if [ "$host" = v1 ]; then
  reply=$(get "/provider/auth?directory=/work") || fail "GET /provider/auth failed"
  found=$(printf '%s' "$reply" | grep -o '"openai-images":\[[^]]*\]')
  # Exactly one method, of type api: an empty list, another type or an extra method does not match.
  [ $wanted = absent ] || found=$(printf '%s' "$found" | grep -x '"openai-images":\[{"type":"api"[^{}]*}\]')
  expect "sign-in method" "$found" $wanted
  reply=$(get "/config?directory=/work") || fail "GET /config failed"
  # A provider or model entry would take part in the default chat model choice.
  expect "provider entry" "$(printf '%s' "$reply" | grep -o 'openai-images')" absent
  reply=$(get "/experimental/tool?directory=/work&provider=openai&model=gpt-5") || fail "GET /experimental/tool failed"
  # sed -n with p prints only a reply that has the imagegen entry, so an error body cannot pass as a description.
  expect "tool" "$(printf '%s' "$reply" | sed -n 's/.*{"id":"imagegen","description":"\([^"]\{1,110\}\).*/\1/p')" present
else
  reply=$(get /api/integration) || fail "GET /api/integration failed"
  found=$(printf '%s' "$reply" | sed 's/{"id":"/\n&/g' | grep '^{"id":"openai-images"')
  # Exactly one method, of type key: an empty list, another type or an extra method does not match.
  [ $wanted = absent ] || found=$(printf '%s' "$found" | grep '^{"id":"openai-images".*"methods":\[{"type":"key"[^{}]*}\]')
  expect "integration" "$(printf '%s' "$found" | cut -c1-200)" $wanted
fi
