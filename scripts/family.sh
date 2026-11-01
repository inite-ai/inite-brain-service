#!/bin/sh
# The INITE family's shared tooling, at the head of inite-shared's main.
# Every family repo carries this file as scripts/family.sh, byte for byte:
# `inite-standards check` fails when it differs from
# inite-shared/devops/standards/family/family.sh. Change it there.
#
#   sh scripts/family.sh gate [ref]     the checks: lint, typecheck, test, standards
#   sh scripts/family.sh lint           eslint, errors held to .inite/lint-baseline.json
#   sh scripts/family.sh release [...]  a CalVer GitHub release, which is what deploys
#   sh scripts/family.sh standards ...  the conformance CLI (inite-standards)
#
# The tools come from inite-shared at the head of its main, fetched with the
# gh CLI into ~/.cache/inite-family/<sha>; offline, the newest cached copy is
# used. INITE_FAMILY_DIR points at a checkout of devops/standards instead
# (CI sets it to the copy the runner downloaded with the shared workflow).
set -e
tool="${1:-}"
[ $# -gt 0 ] && shift
dir="${INITE_FAMILY_DIR:-}"
if [ -z "$dir" ]; then
  cache="${XDG_CACHE_HOME:-$HOME/.cache}/inite-family"
  mkdir -p "$cache"
  newest=$(ls -t "$cache" 2>/dev/null | grep -v '\.tmp$' | head -1 || true)
  fresh=""
  # Ask for main's head at most every ten minutes.
  if [ -n "$newest" ] && [ -f "$cache/$newest/.complete" ] && [ -n "$(find "$cache/$newest/.complete" -mmin -10 2>/dev/null)" ]; then
    fresh="$newest"
  fi
  if [ -z "$fresh" ]; then
    sha=$(gh api repos/inite-ai/inite-shared/commits/main -H 'Accept: application/vnd.github.sha' 2>/dev/null || true)
    if [ -n "$sha" ] && [ ! -f "$cache/$sha/.complete" ]; then
      tmp="$cache/$sha.tmp"
      rm -rf "$tmp" && mkdir -p "$tmp"
      ok=1
      files=$(gh api -H 'Accept: application/vnd.github.raw' "repos/inite-ai/inite-shared/contents/devops/standards/MANIFEST?ref=$sha" 2>/dev/null) || ok=0
      for f in $files; do
        mkdir -p "$tmp/$(dirname "$f")"
        gh api -H 'Accept: application/vnd.github.raw' "repos/inite-ai/inite-shared/contents/devops/standards/$f?ref=$sha" >"$tmp/$f" 2>/dev/null || { ok=0; break; }
      done
      if [ "$ok" = 1 ] && [ -n "$files" ]; then
        rm -rf "$cache/$sha" && mv "$tmp" "$cache/$sha" && : >"$cache/$sha/.complete"
      else
        rm -rf "$tmp"
      fi
    fi
    if [ -n "$sha" ] && [ -f "$cache/$sha/.complete" ]; then
      touch "$cache/$sha/.complete"
      fresh="$sha"
    elif [ -n "$newest" ] && [ -f "$cache/$newest/.complete" ]; then
      echo "family: could not reach inite-shared; using the cached tools from ${newest%"${newest#???????}"}" >&2
      fresh="$newest"
    else
      echo "family: cannot fetch inite-shared/devops/standards (gh auth login, or set INITE_FAMILY_DIR)." >&2
      exit 2
    fi
  fi
  dir="$cache/$fresh"
fi
export INITE_FAMILY_DIR="$dir"
case "$tool" in
  gate) exec sh "$dir/family/gate.sh" "$@" ;;
  release) exec bash "$dir/family/release.sh" "$@" ;;
  lint) exec node "$dir/bin/inite-standards.mjs" lint "$@" ;;
  standards) exec node "$dir/bin/inite-standards.mjs" "$@" ;;
  *) echo "usage: sh scripts/family.sh gate|lint|release|standards [args]" >&2; exit 2 ;;
esac
