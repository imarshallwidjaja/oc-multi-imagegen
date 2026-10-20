#!/bin/sh
# Runs inside the OpenCode 2 container, mounted by scripts/opencode-container.sh. It starts a private server and
# reads the skills it lists. The image has busybox wget, sed and grep but no jq or Node, so this is POSIX sh.
#
#   container-skill-probe.sh skills      print the skill list once oc-multi-imagegen appears in it exactly once
#   container-skill-probe.sh lifecycle   append a marker to the package's SKILL.md and a comment to server.js, then
#                                        remove the plugin from the config, and wait for the list to follow each change
#
# Exit 0 means every state it reports was read from one successful skill-list reply and showed the expected
# oc-multi-imagegen entry. A failed request, a reply that is not a complete skill list, a wrong entry count, or a state
# that does not arrive within 30 polls prints what it last saw and the server log to stderr and exits 1. Each poll is
# one request bounded to 5 seconds plus a 1-second sleep, so the wait is at most 30 attempts, not 30 seconds of wall
# time. Only the oc-multi-imagegen entry is inspected, so a marker in another skill does not count.
# PROBE_PKG, PROBE_CONFIG and PROBE_TMP name the container's package, config file and scratch directory; the unit
# tests point them at a temporary directory.

pkg=${PROBE_PKG:-/pluginpkg}
config=${PROBE_CONFIG:-/xdg/config/opencode/opencode.json}
tmp=${PROBE_TMP:-/tmp}
auth="Authorization: Basic $(printf opencode:probe | base64)"
url=http://127.0.0.1:4096
body='' problem='' entries='' marked=''

opencode serve --port 4096 --hostname 127.0.0.1 >"$tmp/serve.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT

# Reads /api/skill into $body. Succeeds only for a completed request whose reply is a skill list; otherwise
# $problem says which. The reply is {"location":{...},"data":[...]}, so a reply cut off after a complete entry, which
# ends in } but not ]}, is not a skill list.
fetch() {
  body=$(wget -T 5 -qO- --header "$auth" "$url/api/skill" 2>"$tmp/wget.err") || {
    problem="request failed: $(tr '\n' ' ' <"$tmp/wget.err")"
    return 1
  }
  case $body in
    '{'*'"data":['*']}') ;;
    *) problem="reply is not a skill list"; return 1 ;;
  esac
}

# Prints the oc-multi-imagegen entry of $body. Quotes inside a skill's content are escaped, so an unescaped
# {"id":" always starts an entry.
own() { printf '%s' "$body" | sed 's/{"id":"/\n&/g' | grep '^{"id":"oc-multi-imagegen"'; }

fail() {
  {
    echo "Probe failed: $1 ($problem)"
    printf 'Last reply (first 400 characters): %.400s\n' "$body"
    echo "Server log (last 30 lines):"
    tail -n 30 "$tmp/serve.log"
  } >&2
  exit 1
}

# await <what> <entries> <marker>: polls, at most 30 attempts, until one successful reply shows exactly that many
# oc-multi-imagegen entries and that many LIFECYCLE-MARKER lines in them; a marker of "any" accepts either.
await() {
  i=0
  while :; do
    if fetch; then
      entries=$(own | grep -c .)
      marked=$(own | grep -c LIFECYCLE-MARKER)
      problem="saw entries=$entries marker=$marked, wanted entries=$2 marker=$3"
      [ "$entries" = "$2" ] && { [ "$3" = any ] || [ "$marked" = "$3" ]; } && return 0
    fi
    i=$((i + 1))
    [ $i -lt 30 ] || fail "timed out waiting for $1"
    sleep 1
  done
}

# A request made before the location boots returns empty lists; the polls above would also cover this wait.
i=0
until wget -T 2 -qO- --header "$auth" "$url/api/location" >/dev/null 2>&1 || [ $i -ge 60 ]; do i=$((i + 1)); sleep 1; done

case ${1:-} in
  skills)
    await "oc-multi-imagegen to be listed once" 1 any
    printf '%s\n' "$body"
    ;;
  lifecycle)
    await "oc-multi-imagegen to be listed once" 1 0
    echo "loaded: entries=$entries marker=$marked"
    printf '\nLIFECYCLE-MARKER\n' >>"$pkg/skills/oc-multi-imagegen/SKILL.md"
    echo "// reload" >>"$pkg/server.js"
    await "the appended marker in the oc-multi-imagegen skill" 1 1
    echo "updated: entries=$entries marker=$marked"
    edited=$(sed 's#"plugins": \["/pluginpkg"\]#"plugins": []#' "$config") && printf '%s\n' "$edited" >"$config"
    await "oc-multi-imagegen to leave the list" 0 0
    echo "removed: entries=$entries"
    ;;
  *)
    echo "usage: container-skill-probe.sh skills|lifecycle" >&2
    exit 2
    ;;
esac
