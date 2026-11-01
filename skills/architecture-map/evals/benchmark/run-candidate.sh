#!/bin/sh
# run-candidate.sh - one cell of the release benchmark (see PROTOCOL.md beside this file).
#
# Runs one headless `claude -p` session of the plugin under test from <run-dir>/repo, with the variable <ENV_NAME>
# set to that directory and the prompt file's <ENV_NAME> placeholder replaced by the variable's name, and leaves the
# evidence in <run-dir>: stream.jsonl, stderr.log, exit-code, timing.json (started, finished and
# total_duration_seconds, epoch seconds) and command.txt (the command line, the prompt given by its file path).
#
# --plugin-dir <dir>   passes a plugin directory (a clone at the pinned commit) through to the session.
# --plugin <name@mkt>  installs the plugin from --marketplace into an isolated configuration directory,
#                      <run-dir>/config, so the caller's own plugins never load; the marketplace and the plugin are
#                      declared at project scope in <run-dir>/repo, the one setting source the session reads. The
#                      installed version goes to plugin-version.txt and the install output to install.log.
# --path-prepend <dir> puts <dir> first on PATH for the session only (a CLI installed under the workspace).
#
# Every location is an argument, and nothing is written outside <run-dir>. Exits 2 on a usage error, 1 when the
# install fails, otherwise with the session's own exit status.

USAGE='usage: run-candidate.sh <run-dir> <ENV_NAME> <prompt-file> (--plugin-dir <dir> | --plugin <name@marketplace> --marketplace <url-or-path>) [--model <model>] [--path-prepend <dir>] [-- <extra claude args>]'

usage() {
  if [ -n "$1" ]; then printf 'run-candidate.sh: %s\n' "$1" >&2; fi
  printf '%s\n' "$USAGE" >&2
  exit 2
}

# The absolute, symlink-free form of an existing directory.
absdir() { (cd "$1" 2>/dev/null && pwd -P); }

# One word quoted for a POSIX shell, as command.txt records it.
quote() {
  case $1 in
    '' | *[!A-Za-z0-9_./:=@,+-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}

[ $# -ge 3 ] || usage
RUN=$1
ENVNAME=$2
PROMPTFILE=$3
shift 3

PLUGIN_DIR=
PLUGIN=
MARKETPLACE=
MODEL=
PATH_PREPEND=
while [ $# -gt 0 ]; do
  case $1 in
    --plugin-dir | --plugin | --marketplace | --model | --path-prepend)
      [ $# -ge 2 ] && [ -n "$2" ] || usage "$1 needs a value"
      case $1 in
        --plugin-dir) PLUGIN_DIR=$2 ;;
        --plugin) PLUGIN=$2 ;;
        --marketplace) MARKETPLACE=$2 ;;
        --model) MODEL=$2 ;;
        --path-prepend) PATH_PREPEND=$2 ;;
      esac
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *) usage "unknown argument: $1" ;;
  esac
done
# What is left in "$@" are the extra claude arguments.

case $ENVNAME in
  '' | [0-9]* | *[!A-Za-z0-9_]*) usage "not a variable name: $ENVNAME" ;;
esac
RUN=$(absdir "$RUN") && [ -d "$RUN/repo" ] || usage "<run-dir>/repo is not a directory"
REPO=$RUN/repo
[ -f "$PROMPTFILE" ] && [ -r "$PROMPTFILE" ] || usage "cannot read the prompt file: $PROMPTFILE"
PROMPTFILE=$(absdir "$(dirname "$PROMPTFILE")")/$(basename "$PROMPTFILE")
if [ -n "$PLUGIN_DIR" ] && [ -n "$PLUGIN" ]; then usage 'give --plugin-dir or --plugin, not both'; fi
if [ -z "$PLUGIN_DIR" ] && [ -z "$PLUGIN" ]; then usage 'give --plugin-dir or --plugin'; fi
if [ -n "$PLUGIN" ] && [ -z "$MARKETPLACE" ]; then usage '--plugin needs --marketplace'; fi
if [ -n "$MARKETPLACE" ] && [ -z "$PLUGIN" ]; then usage '--marketplace goes with --plugin'; fi
if [ -n "$PLUGIN_DIR" ]; then PLUGIN_DIR=$(absdir "$PLUGIN_DIR") || usage "not a directory: --plugin-dir"; fi
if [ -n "$PATH_PREPEND" ]; then PATH_PREPEND=$(absdir "$PATH_PREPEND") || usage "not a directory: --path-prepend"; fi
if [ -n "$MARKETPLACE" ] && [ -d "$MARKETPLACE" ]; then MARKETPLACE=$(absdir "$MARKETPLACE"); fi

cd "$REPO" || exit 2
PROMPT=$(sed "s/<ENV_NAME>/$ENVNAME/g" "$PROMPTFILE") || usage "cannot read the prompt file: $PROMPTFILE"
export "$ENVNAME=$REPO"
ASSIGN="$ENVNAME=$(quote "$REPO")"

if [ -n "$PLUGIN" ]; then
  CLAUDE_CONFIG_DIR=$RUN/config
  export CLAUDE_CONFIG_DIR
  mkdir -p "$CLAUDE_CONFIG_DIR" || exit 1
  printf 'run-candidate.sh: warning: %s is a fresh Claude Code configuration directory; it must be logged in once (CLAUDE_CONFIG_DIR=%s claude /login) before a session can run\n' "$CLAUDE_CONFIG_DIR" "$CLAUDE_CONFIG_DIR" >&2
  env -u CLAUDECODE claude plugin marketplace add "$MARKETPLACE" --scope project >>"$RUN/install.log" 2>&1 ||
    { printf 'run-candidate.sh: adding the marketplace failed, see %s/install.log\n' "$RUN" >&2; exit 1; }
  env -u CLAUDECODE claude plugin install "$PLUGIN" --scope project >>"$RUN/install.log" 2>&1 ||
    { printf 'run-candidate.sh: installing %s failed, see %s/install.log\n' "$PLUGIN" "$RUN" >&2; exit 1; }
  env -u CLAUDECODE claude plugin list --json 2>>"$RUN/install.log" |
    node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let v = "unknown";
      try { const p = JSON.parse(s).find((e) => e.id === process.argv[1]); if (p && p.version) v = p.version; } catch {}
      console.log(v);
    });' "$PLUGIN" >"$RUN/plugin-version.txt" 2>>"$RUN/install.log" ||
    printf 'unknown\n' >"$RUN/plugin-version.txt"
  ASSIGN="$ASSIGN CLAUDE_CONFIG_DIR=$(quote "$CLAUDE_CONFIG_DIR")"
fi

# The session's arguments, built back to front onto the extra arguments.
set -- --output-format stream-json --verbose --setting-sources project \
  --permission-mode auto --permission-prompts none "$@"
if [ -n "$MODEL" ]; then set -- --model "$MODEL" "$@"; fi
if [ -n "$PLUGIN_DIR" ]; then set -- --plugin-dir "$PLUGIN_DIR" "$@"; fi

if [ -n "$PATH_PREPEND" ]; then
  ASSIGN="$ASSIGN PATH=$(quote "$PATH_PREPEND"):\"\$PATH\""
  PATH=$PATH_PREPEND:$PATH
  export PATH
fi

{
  printf 'cd %s && %s env -u CLAUDECODE claude -p "$(sed %s %s)"' "$(quote "$REPO")" "$ASSIGN" \
    "$(quote "s/<ENV_NAME>/$ENVNAME/g")" "$(quote "$PROMPTFILE")"
  for a in "$@"; do printf ' %s' "$(quote "$a")"; done
  printf '\n'
} >"$RUN/command.txt"

STARTED=$(date +%s)
env -u CLAUDECODE claude -p "$PROMPT" "$@" >"$RUN/stream.jsonl" 2>"$RUN/stderr.log"
STATUS=$?
FINISHED=$(date +%s)
printf '%s\n' "$STATUS" >"$RUN/exit-code"
printf '{"started": %s, "finished": %s, "total_duration_seconds": %s}\n' \
  "$STARTED" "$FINISHED" "$((FINISHED - STARTED))" >"$RUN/timing.json"
exit "$STATUS"
