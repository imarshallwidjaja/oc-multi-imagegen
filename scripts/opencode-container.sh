#!/usr/bin/env bash
# Runs OpenCode 1 or 2 in a container with this checkout's packed plugin, for ad-hoc qualitative checks.
# Needs a source checkout, Linux with GNU coreutils (timeout, stat), git, tar, Docker, Bun, npm and Bash 4.4 or newer.
# Usage and expected results: docs/container-testing.md.
#
#   export OC_SANDBOX=$(scripts/opencode-container.sh init)     one new private sandbox per attempt
#   scripts/opencode-container.sh pack                          build, npm pack, extract, install runtime deps
#   scripts/opencode-container.sh prepare <host> [allow|tool-only|ask]
#   scripts/opencode-container.sh seed <host> [min-hours]       credential seed (v1, v2); v1-floor needs none
#   scripts/opencode-container.sh run <host> <name> -- <opencode args>
#   scripts/opencode-container.sh tools <host>                  tool ids (v1 and v1-floor only; no model)
#   scripts/opencode-container.sh skills <host>                 skills the host registered (no model)
#   scripts/opencode-container.sh lifecycle v2                  skill update and removal on a running server (no model)
#   OC_MODEL=... scripts/opencode-container.sh cases <host>     the four image cases, in order (v1, v2)
#   scripts/opencode-container.sh clean                         remove credentials and session state
#
# <host> is v1, v1-floor or v2. Each host gets its own HOME and XDG directories under $OC_SANDBOX.
# OC_TIMEOUT (a positive number of seconds, default 300) bounds each container. A container is stopped on
# timeout, on interrupt (Ctrl-C or SIGTERM) and on failure before the script returns; only the container it
# started (tracked by its --cidfile) is ever stopped. Exit status 124 means OC_TIMEOUT stopped a container.
# When Docker cannot confirm that the container is gone, the script prints its id, exits nonzero, runs no
# further container, and keeps the seed directory the container may still read.
set -euo pipefail
umask 077
exec 3>&2 # lifecycle warnings go here, so they reach the terminal even while a case's stderr is logged to a file

# Pinned by digest; the tag in each comment is what the digest resolved to when the runbook was validated.
V1_IMAGE=ghcr.io/anomalyco/opencode@sha256:6ebc13097f2381301220abe9d1b2a54f50cd1603a910dc1c66e93d8f2c4e8ebb      # 1.19.3
V1_FLOOR_IMAGE=ghcr.io/anomalyco/opencode@sha256:ecc3bf96ee55dad226d9cde50d79aaa8a1215c47860c0fcdc71570461bf438b8 # 1.18.29
V2_IMAGE=ghcr.io/anomalyco/opencode@sha256:02998f912cc8bf84ce20ff9d9faa33225406c52f9d13f8f86b376490f1e28813      # 2.0.32

MARKER=.oc-multi-imagegen-sandbox
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
timeout_s=${OC_TIMEOUT:-300}
case $timeout_s in '' | *[!0-9]*) echo "OC_TIMEOUT must be a positive whole number of seconds" >&2; exit 2 ;; esac
# GNU timeout treats 0 as "no limit", which would leave a hung container unbounded.
[ -n "${timeout_s//0/}" ] || { echo "OC_TIMEOUT must be a positive whole number of seconds" >&2; exit 2; }

die() { echo "$*" >&2; exit 2; }

image_of() {
  case $1 in
    v1) echo "$V1_IMAGE" ;;
    v1-floor) echo "$V1_FLOOR_IMAGE" ;;
    v2) echo "$V2_IMAGE" ;;
    *) die "Unknown host '$1'; use v1, v1-floor or v2" ;;
  esac
}

# Succeeds when the canonical path $1 is neither inside nor above this checkout or the repository it belongs to
# (a worktree sits inside its main repository).
outside_repo() {
  local dir=${1%/} root common roots=("$repo")
  common=$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  [ -z "$common" ] || roots+=("$(cd "$common/.." && pwd -P)")
  for root in "${roots[@]}"; do
    root=${root%/}
    case $dir/ in "$root"/*) return 1 ;; esac
    case $root/ in "$dir"/*) return 1 ;; esac
  done
}

# Accepts only a sandbox that `init` made and that is still yours and private, before anything is written to it.
use_sandbox() {
  sandbox=${OC_SANDBOX:?Set OC_SANDBOX to the path printed by '$0 init'}
  case $sandbox in /*) ;; *) die "OC_SANDBOX must be an absolute path" ;; esac
  [ -d "$sandbox" ] || die "OC_SANDBOX is not a directory; make one with '$0 init'"
  [ "$(cd "$sandbox" && pwd -P)" = "$sandbox" ] || die "OC_SANDBOX must be a canonical path (no symlinks, '..' or trailing '/')"
  outside_repo "$sandbox" || die "OC_SANDBOX must be outside the repository and its worktrees"
  if [ ! -f "$sandbox/$MARKER" ] || [ -L "$sandbox/$MARKER" ] || [ "$(stat -c '%u %a' "$sandbox")" != "$(id -u) 700" ]; then
    die "$sandbox is not a private sandbox made by '$0 init'; refusing to use it"
  fi
}

# Container lifecycle. The helper owns one container at a time, identified by the id docker writes to
# --cidfile after it creates it. A name collision therefore leaves nothing to stop, and another container is
# never touched. `unsettled` holds the id of a container that could not be confirmed gone: every later
# container_run then fails, and the seed directory is kept because that container may still read it.
child='' cidfile='' cname='' seeddir='' unsettled=''
stop_owned() {
  [ -n "$cidfile" ] && [ -s "$cidfile" ] || return 0
  local id ids i
  id=$(<"$cidfile")
  docker stop --time 5 "$id" >/dev/null 2>&1 || docker kill "$id" >/dev/null 2>&1 || true
  # --rm removes the container once it stops. Only a listing that succeeds and names no such container proves
  # it is gone; a failed listing (the daemon is unreachable) or a container still listed proves nothing.
  for i in $(seq 1 20); do
    ids=$(docker ps -aq --filter "id=$id" 2>/dev/null) || break
    [ -n "$ids" ] || return 0
    sleep 0.5
  done
  unsettled=$id
  echo "Could not confirm that container $id is gone. It may still be running: check 'docker ps -a --filter id=$id' and stop it by id before using this sandbox again." >&3
  return 1
}
cleanup() {
  trap - EXIT
  if [ -n "$child" ]; then
    stop_owned || true # the failure is recorded in $unsettled
    kill "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true # docker has settled before anything below runs
  fi
  [ -n "$seeddir" ] || return 0
  if [ -n "$unsettled" ]; then
    echo "Kept $seeddir because container $unsettled may still read it; delete it yourself once that container is gone." >&3
  else
    rm -rf "$seeddir"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Runs `docker "${ARGS[@]}"` for at most $timeout_s seconds, then stops the container it started and returns
# docker's status, or 124 after a timeout. If it cannot confirm the container is gone it fails too (status 1
# when docker itself succeeded). Callers read the status explicitly: `set -e` does not reach into `||` and `if`.
container_run() {
  local rc=0 started=$SECONDS
  timeout --kill-after=2 "$timeout_s" docker "${ARGS[@]}" &
  child=$!
  wait "$child" 2>/dev/null || rc=$? # 2>/dev/null: bash would otherwise print "Killed" for a timed-out docker
  stop_owned || true
  child=''
  if [ "$rc" -ge 124 ] && [ $((SECONDS - started)) -ge "$timeout_s" ]; then
    echo "Stopped $cname after the ${timeout_s}s OC_TIMEOUT." >&2
    rc=124
  fi
  [ -z "$unsettled" ] || [ "$rc" -ne 0 ] || rc=1
  return "$rc"
}

# Everything the container sees: its own home and XDG directories, the plugin package read-only, and an
# explicit environment. The host's HOME, credentials and environment never reach it.
base_args() {
  local host=$1 name=$2
  case $name in '' | *[!A-Za-z0-9_-]*) die "Run names use letters, digits, '_' and '-'" ;; esac
  # Docker creates a missing bind-mount source as root, which this user could not then clean up.
  for dir in "$host"/{home,config,data,state,cache,work} pkg/package; do
    [ -d "$sandbox/$dir" ] || die "$sandbox/$dir is missing; run 'pack' and 'prepare $host' first"
  done
  cname=ocimg-$host-$name-$$-$RANDOM
  cidfile=$sandbox/cid/$cname
  ARGS=(run --rm --name "$cname" --cidfile "$cidfile" --label "ocimg.sandbox=$sandbox"
    --user "$(id -u):$(id -g)" --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory 3g
    -e HOME=/home/oc -e XDG_CONFIG_HOME=/xdg/config -e XDG_DATA_HOME=/xdg/data
    -e XDG_STATE_HOME=/xdg/state -e XDG_CACHE_HOME=/xdg/cache)
  if [ "$host" = v2 ]; then
    # OpenCode 2 must take the credential from its own connection store. A non-secret decoy shows the plugin
    # does not read OPENCODE_AUTH_CONTENT, the OpenCode 1 source; the generation calls still succeed.
    ARGS+=(-e 'OPENCODE_AUTH_CONTENT={"openai":{"type":"oauth","access":"NONSECRET-DECOY","refresh":"NONSECRET-DECOY","expires":4102444800000}}')
  fi
  ARGS+=(-v "$sandbox/$host/home:/home/oc" -v "$sandbox/$host/config:/xdg/config" -v "$sandbox/$host/data:/xdg/data"
    -v "$sandbox/$host/state:/xdg/state" -v "$sandbox/$host/cache:/xdg/cache" -v "$sandbox/$host/work:/work"
    -v "$sandbox/pkg/package:/pluginpkg:ro" -w /work)
}

# Generic requests: they name neither the tool nor the skill, so a run shows whether the agent finds both itself.
case_prompt() {
  local style="hand-drawn 90s Japanese animation style"
  case $1 in
    A) echo "Create a wide illustration of a lighthouse on a rocky coast at dusk, in a $style. Save it as lighthouse.png in the project folder." ;;
    B) echo "Make a sticker of a red paper lantern in a $style, with a transparent background so it can be placed on other designs. Save it as lantern-sticker.png in the project folder." ;;
    C) echo "Change lighthouse.png so the sky is stormy with heavy dark clouds and the lighthouse lamp is lit. Keep the rest of the scene as it is. Save the result as lighthouse-storm.png." ;;
    D) echo "Design two portrait screens of a meal-planning mobile app: a weekly plan screen and a shopping list screen. They must look like the same app, with the same colours, type and style. Save them as plan-screen.png and shopping-screen.png in the project folder." ;;
  esac
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case $cmd in
  init)
    # A new private directory per attempt keeps credentials, work files and logs from one attempt out of the next.
    base=${TMPDIR:-/tmp}
    base=$(cd "$base" && pwd -P) || die "TMPDIR is not a directory"
    outside_repo "$base/oc-multi-imagegen.sandbox" || die "TMPDIR must be outside the repository and its worktrees"
    sandbox=$(mktemp -d "$base/oc-multi-imagegen.XXXXXX")
    mkdir "$sandbox/cid" "$sandbox/logs" "$sandbox/pack"
    : >"$sandbox/$MARKER"
    echo "$sandbox"
    ;;

  pack)
    use_sandbox
    [ ! -e "$sandbox/pkg" ] && [ -z "$(ls -A "$sandbox/pack")" ] || die "This sandbox already holds a package; make a new one with '$0 init'"
    # A stale dist/ would pack old code, so the build is part of packing.
    (cd "$repo" && bun run build)
    (cd "$repo" && npm pack --pack-destination "$sandbox/pack")
    tarballs=("$sandbox"/pack/*.tgz)
    [ "${#tarballs[@]}" -eq 1 ] || die "Expected one tarball in $sandbox/pack"
    mkdir "$sandbox/pkg"
    tar -xzf "${tarballs[0]}" -C "$sandbox/pkg"
    # Installs the runtime dependencies only, so the container sees what a consumer of the package would.
    (cd "$sandbox/pkg/package" && npm install --omit=dev --ignore-scripts --no-audit --no-fund)
    {
      echo "commit: $(git -C "$repo" rev-parse HEAD)"
      echo "uncommitted paths: $(git -C "$repo" status --porcelain | wc -l)"
      sha256sum "$repo/dist/index.js" "${tarballs[0]}"
    } >"$sandbox/identity.txt"
    cat "$sandbox/identity.txt"
    ;;

  prepare)
    # allow: imagegen, the plugin's skill and reading PNG files (to look at results) are permitted.
    # tool-only: imagegen alone, so the skill is denied. ask: imagegen asks and nothing else is permitted.
    # Everything else is denied, so the agent has no shell and cannot read the credential.
    host=${1:?host}; perm=${2:-allow}
    image_of "$host" >/dev/null
    case $perm in allow | tool-only | ask) ;; *) die "Permission must be allow, tool-only or ask" ;; esac
    use_sandbox
    mkdir -p "$sandbox/$host"/{home,config/opencode,data/opencode,state,cache,work}
    tool_effect=$perm
    [ "$perm" != tool-only ] || tool_effect=allow
    extra=''
    if [ "$host" = v2 ]; then
      if [ "$perm" = allow ]; then
        extra=',
    { "action": "skill", "resource": "oc-multi-imagegen", "effect": "allow" },
    { "action": "read", "resource": "*.png", "effect": "allow" }'
      fi
      # update and share are OpenCode 2's own settings; the run needs neither the updater nor sharing.
      cat >"$sandbox/$host/config/opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": ["/pluginpkg"],
  "permissions": [
    { "action": "*", "resource": "*", "effect": "deny" },
    { "action": "imagegen", "resource": "*", "effect": "$tool_effect" }$extra
  ],
  "update": "disable",
  "share": "disabled"
}
EOF
    else
      if [ "$perm" = allow ]; then
        extra=', "skill": { "*": "deny", "oc-multi-imagegen": "allow" }, "read": { "*": "deny", "*.png": "allow" }'
      fi
      cat >"$sandbox/$host/config/opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///pluginpkg"],
  "permission": { "*": "deny", "imagegen": "$tool_effect"$extra },
  "autoupdate": false,
  "share": "disabled"
}
EOF
    fi
    ;;

  seed)
    host=${1:?host}
    image_of "$host" >/dev/null
    use_sandbox
    hours=()
    [ -z "${2:-}" ] || hours=(--min-hours "$2")
    if [ "$host" = v2 ]; then
      # A new private directory per invocation, so cleanup() removes only what this run made. It exists only
      # while the import runs; cleanup() removes it however this command ends, unless the container may still read it.
      seeddir=$(mktemp -d "$sandbox/seed.XXXXXX")
      (cd "$repo" && bun scripts/seed-container-auth.ts --host v2 --out "$seeddir/import.json" ${hours[@]+"${hours[@]}"})
      base_args v2 seed-import
      ARGS+=(-v "$seeddir:/seed:ro" "$V2_IMAGE" auth import --standalone /seed/import.json)
      rc=0
      container_run || rc=$?
      if [ "$rc" -ne 0 ]; then
        echo "The credential import failed (status $rc)." >&2
        exit "$rc"
      fi
    else
      # OpenCode 1 reads this file as its auth.json until `clean` removes it.
      (cd "$repo" && bun scripts/seed-container-auth.ts --host v1 --out "$sandbox/$host/data/opencode/auth.json" ${hours[@]+"${hours[@]}"})
    fi
    ;;

  run)
    host=${1:?host}; name=${2:?name}; shift 2
    [ "${1:-}" != -- ] || shift
    use_sandbox
    base_args "$host" "$name"
    ARGS+=("$(image_of "$host")" "$@")
    container_run
    ;;

  tools)
    # Lists the tool ids a v1 server registers: a load check that needs no model and no credential.
    host=${1:?host}
    [ "$host" != v2 ] || die "OpenCode 2 has no tool listing; check its load log line instead (docs/container-testing.md)"
    use_sandbox
    base_args "$host" tools
    ARGS+=(--entrypoint sh "$(image_of "$host")" -c '
      opencode --version
      opencode serve --port 4096 --hostname 127.0.0.1 >/tmp/serve.log 2>&1 &
      i=0; until wget -T 2 -qO- http://127.0.0.1:4096/path >/dev/null 2>&1 || [ $i -ge 60 ]; do i=$((i+1)); sleep 1; done
      wget -T 60 -qO- "http://127.0.0.1:4096/experimental/tool/ids?directory=/work"; echo
      kill %1')
    container_run
    ;;

  skills)
    # Lists the skills a host registered: a load check that needs no model and no credential. OpenCode 1 has
    # `debug skill`. OpenCode 2 has no such command, so scripts/container-skill-probe.sh starts a private server in
    # the container and prints its skill list once oc-multi-imagegen is in it; it fails, with the server log, if
    # that never happens. The server's password is a throwaway for this one container, not a credential.
    host=${1:?host}
    image_of "$host" >/dev/null
    use_sandbox
    base_args "$host" skills
    if [ "$host" = v2 ]; then
      ARGS+=(-e OPENCODE_SERVER_PASSWORD=probe -v "$repo/scripts/container-skill-probe.sh:/probe.sh:ro" --entrypoint sh "$V2_IMAGE" /probe.sh skills)
    else
      ARGS+=("$(image_of "$host")" debug skill)
    fi
    container_run
    ;;

  lifecycle)
    # Edits the sandbox's package and config while an OpenCode 2 server runs, and prints what its skill list does:
    # registered, updated after the package changes, removed after the plugin leaves the config. Each state must
    # show in a successful reply, or the command fails (scripts/container-skill-probe.sh). It changes the sandbox
    # package, so use a sandbox that is not also used for a model run. No model, no credential.
    host=${1:?host}
    [ "$host" = v2 ] || die "lifecycle runs on v2, which reloads plugins while running; for v1, edit the sandbox package or config and run 'skills v1' again"
    use_sandbox
    base_args v2 lifecycle
    for i in "${!ARGS[@]}"; do
      case ${ARGS[i]} in *:/pluginpkg:ro) ARGS[i]=${ARGS[i]%:ro} ;; esac
    done
    ARGS+=(-e OPENCODE_SERVER_PASSWORD=probe -v "$repo/scripts/container-skill-probe.sh:/probe.sh:ro" --entrypoint sh "$V2_IMAGE" /probe.sh lifecycle)
    container_run
    ;;

  cases)
    # The paid scenario: four model-driven image calls per host, in order, stopping at the first failure.
    # Later cases build on earlier outputs, so it only starts from an empty work directory and no earlier logs.
    host=${1:?host}
    model=${OC_MODEL:?Set OC_MODEL to the agent model, for example openai/gpt-6.1-sol-fast}
    case $host in v1) opts=(run --format json --dir /work --model "$model") ;; v2) opts=(run --standalone --format json --model "$model") ;; *) die "cases runs on v1 or v2" ;; esac
    use_sandbox
    [ -d "$sandbox/$host/work" ] || die "Run '$0 prepare $host' first"
    [ -z "$(ls -A "$sandbox/$host/work")" ] || die "$sandbox/$host/work is not empty; start a new attempt with '$0 init'"
    for log in "$sandbox/logs/$host-case-"*; do
      [ ! -e "$log" ] || die "$log exists from an earlier attempt; start a new attempt with '$0 init'"
    done
    for c in A B C D; do
      echo "Case $c on $host" >&2
      base_args "$host" "case-$c"
      ARGS+=("$(image_of "$host")" "${opts[@]}" "$(case_prompt "$c")")
      rc=0
      container_run >"$sandbox/logs/$host-case-$c.out" 2>"$sandbox/logs/$host-case-$c.err" || rc=$?
      if [ "$rc" -ne 0 ]; then
        echo "Case $c failed (status $rc); the remaining cases were not run. See $sandbox/logs/$host-case-$c.err" >&2
        exit "$rc"
      fi
    done
    ;;

  clean)
    # Removes credential-bearing state. The work directories (images), logs and package stay for review.
    use_sandbox
    running=$(docker ps -q --filter "label=ocimg.sandbox=$sandbox") || die "Could not list this sandbox's containers; nothing was removed"
    [ -z "$running" ] || die "A container from this sandbox is still running ($running); stop it with 'docker stop' first"
    rm -rf "$sandbox"/{v1,v1-floor,v2}/{data,state,home,cache} "$sandbox/seed" "$sandbox"/seed.*
    ;;

  *)
    sed -n '2,21p' "${BASH_SOURCE[0]}" >&2
    exit 2
    ;;
esac
