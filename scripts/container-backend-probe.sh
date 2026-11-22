#!/bin/sh
# Runs inside an OpenCode container, mounted by scripts/opencode-container.sh. It starts a private server and prints what
# the host registered, with no model and no credential. The image has busybox wget, sed and grep but no jq or Node, so
# this is POSIX sh.
#
#   container-backend-probe.sh v1 <codex|openai-api>   OpenCode 1: the sign-in method, any provider entry, the tools
#   container-backend-probe.sh v2 <codex|openai-api>   OpenCode 2: the integration, its methods and its connections
#   container-backend-probe.sh v1 tools                 OpenCode 1: its version and the tool ids it lists, whatever
#                                                       the backend (a plugin that failed to load leaves imagegen out)
#
# The container's OC_MULTI_IMAGEGEN_BACKEND selects the backend, so the arguments here are what the run expects it to
# have selected. openai-api must register the openai-images sign-in under that id and register no provider entry: on
# OpenCode 1 exactly one method, of type api; on OpenCode 2 exactly two, the key method and the env method for
# OC_MULTI_IMAGEGEN_OPENAI_API_KEY, and a connection for that variable once it is set (the probe sets a placeholder that is
# not a credential, and the plugin never reads it). codex must register no openai-images entry at all, whatever its
# methods, because its sign-in belongs to the host. On OpenCode 1 both register imagegen and imageedit, and only
# openai-api registers imagegen_models.
#
# Before it checks anything, the probe polls until the server shows the plugin loaded: on OpenCode 1 its imagegen tool
# (the plugin returns its tools and its sign-in method in one hooks object); on OpenCode 2 an active entry for
# /pluginpkg in the host's plugin list, which appears once the plugin's setup has returned, and then its skill.
# `tools` polls until the tool id list is not empty instead. Exit 0 means every printed fact matched. A plugin the
# host lists as failed, a state that does not arrive within 60 polls, a request that fails or a fact that does not
# match prints the reason and the server log to stderr and exits 1. The server is stopped however the probe ends.
# PROBE_TMP names the container's scratch directory; the unit tests point it at a temporary directory.

host=${1:-}
backend=${2:-}
case $host:$backend in
  v1:codex | v1:openai-api | v1:tools | v2:codex | v2:openai-api) ;;
  *) echo "usage: container-backend-probe.sh v1|v2 codex|openai-api, or container-backend-probe.sh v1 tools" >&2; exit 2 ;;
esac

tmp=${PROBE_TMP:-/tmp}
auth="Authorization: Basic $(printf opencode:probe | base64)"
url=http://127.0.0.1:4096

[ "$host$backend" != v2openai-api ] || export OC_MULTI_IMAGEGEN_OPENAI_API_KEY=NONSECRET-PROBE-PLACEHOLDER

if [ "$backend" = tools ]; then
  opencode --version || { echo "Probe failed: opencode --version exited $?" >&2; exit 1; }
fi
opencode serve --port 4096 --hostname 127.0.0.1 >"$tmp/serve.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Prints the reply to GET $1. OpenCode 2 needs the server password; OpenCode 1 has none.
get() {
  if [ "$host" = v2 ]; then
    wget -T 10 -qO- --header "$auth" "$url$1"
  else
    wget -T 10 -qO- "$url$1"
  fi
}

problem=''
fail() {
  {
    echo "Probe failed: $1"
    [ -z "$problem" ] || echo "Last poll: $problem"
    echo "Server log (last 30 lines):"
    tail -n 30 "$tmp/serve.log"
  } >&2
  exit 1
}

# await <what> <path> <predicate>: polls GET <path>, at most 60 attempts a second apart, until the predicate accepts
# the reply in $reply. A request made before the location boots answers with empty lists, which no predicate accepts.
await() {
  i=0
  while :; do
    if reply=$(get "$2" 2>"$tmp/wget.err"); then
      $3 && { problem=''; return 0; }
      problem=$(printf 'the reply did not show it: %.200s' "$reply")
    else
      problem="request failed: $(tr '\n' ' ' <"$tmp/wget.err")"
    fi
    i=$((i + 1))
    [ $i -lt 60 ] || fail "timed out waiting for $1"
    sleep 1
  done
}
tool_ids() { case $reply in '["'*'"]') ;; *) return 1 ;; esac; }
lists_imagegen() { case $reply in *'{"id":"imagegen"'*) ;; *) return 1 ;; esac; }
lists_own_skill() { case $reply in *'{"id":"oc-multi-imagegen"'*) ;; *) return 1 ;; esac; }

# OpenCode 2's plugin list (GET /api/plugin) holds one entry per configured plugin, and the host adds an entry only
# after that plugin's setup has returned: state active when setup succeeded, failed with the error when it did not
# (observed on the pinned v2.3.2). Registrations made during setup are readable at once. own_plugin prints the entry
# for the plugin this container configures, which the host lists by its configured directory, /pluginpkg. An entry
# may lack its id, as a failed one can, so entries are split where an id or a source opens one.
own_plugin() {
  printf '%s' "$reply" | sed -e 's/{"id":"/\n&/g' -e 's/{"source":/\n&/g' |
    grep '"source":{"type":"local","path":"/pluginpkg"}'
}
plugin_settled() {
  case $reply in '{'*'"data":['*']}') ;; *) return 1 ;; esac
  entry=$(own_plugin)
  [ "$(printf '%s\n' "$entry" | grep -c .)" = 1 ] || return 1
  case $entry in *'"state":{"status":"active"}'* | *'"state":{"status":"failed"'*) ;; *) return 1 ;; esac
}

if [ "$backend" = tools ]; then
  await "a tool id list" "/experimental/tool/ids?directory=/work" tool_ids
  printf '%s\n' "$reply"
  exit 0
elif [ "$host" = v1 ]; then
  await "the plugin's imagegen tool" "/experimental/tool?directory=/work&provider=openai&model=gpt-5" lists_imagegen
else
  await "the plugin's status" /api/plugin plugin_settled
  case $entry in *'"state":{"status":"active"}'*) ;; *) fail "the plugin did not load: $(printf '%.300s' "$entry")" ;; esac
  echo "plugin: active"
  # An active plugin whose setup registered nothing would pass the codex check as an absent integration.
  await "the plugin's skill" /api/skill lists_own_skill
fi

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
  expect "edit tool" "$(printf '%s' "$reply" | sed -n 's/.*{"id":"imageedit","description":"\([^"]\{1,110\}\).*/\1/p')" present
  # openai-api also registers its live model lookup; codex registers none.
  expect "models tool" "$(printf '%s' "$reply" | sed -n 's/.*{"id":"imagegen_models","description":"\([^"]\{1,110\}\).*/\1/p')" $wanted
else
  reply=$(get /api/integration) || fail "GET /api/integration failed"
  found=$(printf '%s' "$reply" | sed 's/{"id":"/\n&/g' | grep '^{"id":"openai-images"')
  # Exactly the key method and the env method: an empty list, another type or an extra method does not match.
  [ $wanted = absent ] || found=$(printf '%s' "$found" | grep '^{"id":"openai-images".*"methods":\[{"type":"key"[^{}]*},{"type":"env","names":\["OC_MULTI_IMAGEGEN_OPENAI_API_KEY"\]}\]')
  expect "integration" "$(printf '%s' "$found" | cut -c1-300)" $wanted
  # The host lists the variable as a connection of the integration once it is set.
  connections=
  [ $wanted = absent ] || connections=$(printf '%s' "$found" | sed -n 's/.*"connections":\(\[{"type":"env","name":"OC_MULTI_IMAGEGEN_OPENAI_API_KEY"[^]]*\]\).*/\1/p')
  expect "connections" "$connections" $wanted
fi
