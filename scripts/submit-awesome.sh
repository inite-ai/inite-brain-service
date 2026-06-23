#!/usr/bin/env bash
#
# Fork → branch → insert row → commit → push → draft PR for awesome-* lists.
#
# Usage:
#   scripts/submit-awesome.sh --list                    # show targets + status
#   scripts/submit-awesome.sh --only <id>               # run one target
#   scripts/submit-awesome.sh --all                     # run all PR-able targets
#   scripts/submit-awesome.sh --only <id> --apply       # actually push + open PR
#                                                       # (default = dry-run, shows diff only)
#
# Targets:
#   punkpeye        — punkpeye/awesome-mcp-servers (Knowledge & Memory section)
#   topoteretes     — topoteretes/awesome-ai-memory (Memory Tool table)
#   surrealdb       — surrealdb/awesome-surreal (Projects section)
#   webfuse         — webfuse-com/awesome-claude (Claude Code & MCP section)
#   appcypher       — appcypher/awesome-mcp-servers (closest fit section)
#
# Required: gh (authenticated), git, awk, sed.
# Workdir: tmp/awesome-submissions/<owner-repo>/

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Workdir is outside the project tree on purpose — macOS Privacy +
# Bash sandboxing can deny git writes inside ~/Documents/. /tmp is
# system-blessed and survives until reboot.
readonly WORK_DIR="${AWESOME_WORK_DIR:-/tmp/inite-awesome-submissions}"
readonly BRANCH_NAME="add-inite-brain-service"

# ── Row payloads ─────────────────────────────────────────────────────

# Keep the row text here as the single source of truth — same strings
# live in docs/distribution.md for human reference. Tweak both when
# brain's tool count, surface, or positioning changes.
readonly ROW_PUNKPEYE='- [inite-ai/inite-brain-service](https://github.com/inite-ai/inite-brain-service) 📇 ☁️ - "Open-source memory layer for LLM agents — bitemporal knowledge graph (SurrealDB) with facts, episodes, procedural tiers; hybrid vector + BM25 + multi-hop retrieval; GDPR-grade forget_entity; LoCoMo-benchmarked."'

readonly ROW_TOPOTERETES='| Inite Brain | Open-source memory layer for LLM agents — bitemporal knowledge graph with facts/episodes/procedural tiers, hybrid retrieval, multi-hop planner, GDPR forget. LoCoMo-benchmarked. | https://brain.inite.ai | Managed, Open source | https://github.com/inite-ai/inite-brain-service | Memory Tool | Graph, Vector |'

readonly ROW_SURREALDB='- [Inite Brain](https://github.com/inite-ai/inite-brain-service) - Open-source memory layer for LLM agents built on SurrealDB. Bitemporal knowledge graph with facts/episodes/procedural tiers, hybrid vector + BM25 + multi-hop retrieval, conflict resolution, GDPR forget. MCP server, Streamable HTTP, AGPL-3.0.'

readonly ROW_WEBFUSE='- [inite-brain-service](https://github.com/inite-ai/inite-brain-service) — open-source memory layer for Claude (and any other MCP client). Bitemporal knowledge graph, 18 tools, three memory tiers (facts/episodes/procedural), conflict resolution, GDPR forget. AGPL-3.0.'

readonly ROW_APPCYPHER='- [inite-ai/inite-brain-service](https://github.com/inite-ai/inite-brain-service) - Open-source bitemporal memory layer for LLM agents. MCP server (Streamable HTTP) with 18 tools across read/write/admin scopes. Knowledge graph (SurrealDB) with facts/episodes/procedural tiers, hybrid retrieval, conflict resolution, GDPR forget. AGPL-3.0.'

# Tier 3 row text — generic format, mostly identical across lists.
# Per-list adjustments are minor (some lists want a leading `*`, some
# bullet `-`; emoji conventions vary).
readonly ROW_KYROLABS='- [Inite Brain](https://github.com/inite-ai/inite-brain-service) - Open-source bitemporal memory layer for LLM agents. Knowledge graph (SurrealDB) with facts / episodes / procedural tiers, hybrid retrieval, conflict resolution, GDPR forget. MCP server, AGPL-3.0.'

readonly ROW_TENSORCHORD='| [Inite Brain](https://github.com/inite-ai/inite-brain-service)    | Open-source bitemporal memory layer for LLM agents. Hybrid vector + BM25 + multi-hop retrieval over a knowledge graph (SurrealDB). MCP server, AGPL-3.0.                       | ![GitHub Badge](https://img.shields.io/github/stars/inite-ai/inite-brain-service.svg?style=flat-square) |'

readonly ROW_DANIELSKRY='- [Inite Brain](https://github.com/inite-ai/inite-brain-service) - Open-source bitemporal memory layer for LLM agents. Hybrid retrieval (vector + BM25 + multi-hop planner) with claim-level verifier. MCP server, AGPL-3.0. LoCoMo-benchmarked.'

readonly ROW_JENQYANG='- [Inite Brain](https://github.com/inite-ai/inite-brain-service) - Open-source bitemporal memory layer for LLM agents. Knowledge graph with facts/episodes/procedural tiers, hybrid retrieval, conflict resolution. MCP server, AGPL-3.0.'

readonly ROW_KAUSHIKB11='- [Inite Brain](https://github.com/inite-ai/inite-brain-service) - Open-source memory layer (bitemporal knowledge graph) for LLM agents. MCP server over Streamable HTTP, 18 tools across read/write/admin scopes. AGPL-3.0.'

# ── PR copy ──────────────────────────────────────────────────────────

readonly PR_TITLE='Add inite-brain-service'
readonly PR_BODY='Adds inite-brain-service — open-source (AGPL-3.0) bitemporal memory layer for LLM agents. MCP server (Streamable HTTP) exposing 18 tools across read/write/admin scopes.

Distinct from existing memory entries: bitemporal (valid-time + transaction-time both modelled), conflict resolver with supersede/competing/revive semantics, three memory tiers (facts/episodes/procedural), GDPR-grade forget_entity. LoCoMo-benchmarked.

Repo: https://github.com/inite-ai/inite-brain-service
MCP Registry entry: io.github.inite-ai/inite-brain-service (in flight)'

# ── Logging ──────────────────────────────────────────────────────────

readonly C_DIM='\033[2m'
readonly C_BOLD='\033[1m'
readonly C_GREEN='\033[32m'
readonly C_YELLOW='\033[33m'
readonly C_RED='\033[31m'
readonly C_RESET='\033[0m'

log()  { printf '%b\n' "$*" >&2; }
info() { log "${C_DIM}[info]${C_RESET} $*"; }
ok()   { log "${C_GREEN}[ ok ]${C_RESET} $*"; }
warn() { log "${C_YELLOW}[warn]${C_RESET} $*"; }
err()  { log "${C_RED}[err ]${C_RESET} $*"; }

# ── Common driver ────────────────────────────────────────────────────

# fork_clone_branch UPSTREAM
#
# Forks UPSTREAM (owner/repo) under the authed user, clones the fork
# to WORK_DIR/<repo>, fetches upstream/main, creates BRANCH_NAME from
# upstream HEAD. Idempotent — re-runs are safe.
fork_clone_branch() {
  local upstream="$1"
  local repo
  repo="$(basename "$upstream")"
  # Namespace clone dirs by owner__repo — two upstream lists can have
  # the same repo name (punkpeye/awesome-mcp-servers vs appcypher/
  # awesome-mcp-servers) and we'd collide otherwise.
  local clone_dir="${WORK_DIR}/${upstream//\//__}"

  mkdir -p "$WORK_DIR"

  local viewer
  viewer="$(gh api user --jq .login)"
  # Fork name has to be unique under our user — two upstream repos
  # with the same basename (punkpeye/awesome-mcp-servers vs
  # appcypher/awesome-mcp-servers) would collide. Suffix with the
  # upstream owner.
  local fork_owner
  fork_owner="$(dirname "$upstream")"
  local fork_name="${repo}-from-${fork_owner}"
  local fork_full="${viewer}/${fork_name}"

  if [[ ! -d "$clone_dir/.git" ]]; then
    if ! gh repo view "$fork_full" >/dev/null 2>&1; then
      info "forking $upstream → $fork_full"
      gh repo fork "$upstream" --fork-name="$fork_name" --clone=false >/dev/null
      # Forks aren't instant — wait until GitHub has provisioned the
      # repo on our user before we try to clone it.
      local tries=0
      while ! gh repo view "$fork_full" >/dev/null 2>&1; do
        tries=$((tries + 1))
        if (( tries > 30 )); then
          err "fork didn't appear after 30s — aborting"
          return 1
        fi
        sleep 1
      done
    else
      info "fork ${fork_full} already exists"
    fi

    info "cloning ${fork_full} → ${clone_dir}"
    gh repo clone "$fork_full" "$clone_dir" >/dev/null

    git -C "$clone_dir" remote add upstream "https://github.com/${upstream}.git" 2>/dev/null || true
  else
    info "already cloned at ${clone_dir}"
  fi

  info "syncing with upstream/main"
  git -C "$clone_dir" fetch upstream --quiet
  local default_branch
  default_branch="$(git -C "$clone_dir" remote show upstream | awk '/HEAD branch/{print $NF}')"
  git -C "$clone_dir" checkout "$default_branch" --quiet 2>/dev/null \
    || git -C "$clone_dir" checkout -b "$default_branch" "upstream/${default_branch}" --quiet
  git -C "$clone_dir" reset --hard "upstream/${default_branch}" --quiet

  # Drop any prior attempt branch and start fresh.
  git -C "$clone_dir" branch -D "$BRANCH_NAME" --quiet 2>/dev/null || true
  git -C "$clone_dir" checkout -b "$BRANCH_NAME" --quiet

  echo "$clone_dir"
}

# show_diff_then_commit CLONE_DIR
#
# Prints the diff. In --apply mode, also commits/pushes/opens a draft
# PR. In dry-run, leaves the working tree dirty for the operator to
# inspect.
show_diff_then_commit() {
  local clone_dir="$1"
  local upstream="$2"

  log ""
  log "${C_BOLD}── diff ──${C_RESET}"
  git -C "$clone_dir" --no-pager diff
  log ""

  if [[ "${APPLY:-0}" != "1" ]]; then
    warn "dry-run — not committing. Re-run with --apply to push + open PR."
    info "(working tree left dirty at ${clone_dir})"
    return 0
  fi

  if git -C "$clone_dir" diff --quiet; then
    err "no changes — did the insertion target match? Aborting."
    return 1
  fi

  info "committing"
  git -C "$clone_dir" add -A
  git -C "$clone_dir" -c user.name='Mikhail Savchenko' \
    -c user.email='mikefluff@mikefluff.com' \
    commit -m "$PR_TITLE" --quiet

  info "pushing branch ${BRANCH_NAME}"
  git -C "$clone_dir" push -u origin "$BRANCH_NAME" --quiet --force-with-lease

  info "opening draft PR"
  ( cd "$clone_dir" && gh pr create \
      --repo "$upstream" \
      --draft \
      --title "$PR_TITLE" \
      --body "$PR_BODY" )
  ok "submitted to ${upstream}"
}

# ── Insertion helpers ────────────────────────────────────────────────

# insert_after_first_match FILE PATTERN ROW
#
# Inserts ROW immediately after the first line in FILE matching PATTERN
# (awk regex). Idempotent — bails if ROW is already present.
insert_after_first_match() {
  local file="$1" pattern="$2" row="$3"
  if grep -F -q "inite-brain-service" "$file"; then
    warn "$(basename "$file") already mentions inite-brain-service — skipping insertion"
    return 0
  fi
  awk -v pat="$pattern" -v row="$row" '
    { print }
    !inserted && $0 ~ pat {
      print ""
      print row
      inserted = 1
    }
  ' "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
}

# insert_alpha_in_section FILE SECTION_PATTERN KEY ROW
#
# Walks lines after the section heading; finds the first `- [owner/repo]`
# row whose owner/repo lexicographically > KEY (case-insensitive) and
# inserts ROW before it. Stops at the next `### ` or `## ` heading. If
# nothing > KEY, inserts at the section's end (just before next heading
# or EOF).
insert_alpha_in_section() {
  local file="$1" section_pattern="$2" key="$3" row="$4"
  if grep -F -q "inite-brain-service" "$file"; then
    warn "$(basename "$file") already mentions inite-brain-service — skipping insertion"
    return 0
  fi
  # BSD awk on macOS lacks gawk's 3-arg match(). Pull the key out with
  # POSIX match() + substr() instead — slower but portable.
  awk -v sec="$section_pattern" -v key="$(echo "$key" | tr '[:upper:]' '[:lower:]')" -v row="$row" '
    BEGIN { in_section = 0; inserted = 0 }
    {
      if (!inserted && in_section && $0 ~ /^#+ /) {
        print row
        inserted = 1
        in_section = 0
      } else if (!inserted && in_section && match($0, /^- \[[^]]+\]/)) {
        # Strip the leading "- [" (3 chars) and trailing "]" (1 char)
        # off the matched span to get the link label.
        row_key = tolower(substr($0, 4, RLENGTH - 4))
        if (row_key > key) {
          print row
          inserted = 1
        }
      }
      print
      if (!in_section && $0 ~ sec) in_section = 1
    }
    END {
      if (!inserted) print row
    }
  ' "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
}

# insert_at_section_end FILE SECTION_PATTERN ROW
#
# Appends ROW at the END of the section matched by SECTION_PATTERN —
# right before the next `### ` or `## ` heading, or EOF.
insert_at_section_end() {
  local file="$1" section_pattern="$2" row="$3"
  if grep -F -q "inite-brain-service" "$file"; then
    warn "$(basename "$file") already mentions inite-brain-service — skipping insertion"
    return 0
  fi
  awk -v sec="$section_pattern" -v row="$row" '
    BEGIN { in_section = 0; inserted = 0 }
    {
      if (!inserted && in_section && /^#+ /) {
        print row
        inserted = 1
        in_section = 0
      }
      print
      if (!in_section && $0 ~ sec) in_section = 1
    }
    END { if (!inserted) print row }
  ' "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
}

# ── Targets ──────────────────────────────────────────────────────────

target_punkpeye() {
  local upstream='punkpeye/awesome-mcp-servers'
  local clone_dir
  clone_dir="$(fork_clone_branch "$upstream")"
  # Anchor on the H3 heading, not the table-of-contents link above it.
  insert_alpha_in_section \
    "${clone_dir}/README.md" \
    '^### .*Knowledge.*Memory' \
    'inite-ai/inite-brain-service' \
    "$ROW_PUNKPEYE"
  show_diff_then_commit "$clone_dir" "$upstream"
}

target_topoteretes() {
  local upstream='topoteretes/awesome-ai-memory'
  local clone_dir
  clone_dir="$(fork_clone_branch "$upstream")"
  # Table rows aren't strictly alphabetical — append at end of the
  # "Memory Tool" table. The table ends at the next blank line after
  # the header rule.
  insert_after_first_match \
    "${clone_dir}/README.md" \
    'Memory Tool.*Graph, Vector' \
    "$ROW_TOPOTERETES"
  show_diff_then_commit "$clone_dir" "$upstream"
}

target_surrealdb() {
  local upstream='surrealdb/awesome-surreal'
  local clone_dir
  clone_dir="$(fork_clone_branch "$upstream")"
  # Projects section, alphabetical by title. Title key is "Inite".
  insert_alpha_in_section \
    "${clone_dir}/README.md" \
    '^#+ .*Projects' \
    'Inite' \
    "$ROW_SURREALDB"
  show_diff_then_commit "$clone_dir" "$upstream"
}

target_webfuse() {
  local upstream='webfuse-com/awesome-claude'
  local clone_dir
  clone_dir="$(fork_clone_branch "$upstream")"
  insert_at_section_end \
    "${clone_dir}/README.md" \
    '^#+ .*Claude Code.*Model Context Protocol' \
    "$ROW_WEBFUSE"
  show_diff_then_commit "$clone_dir" "$upstream"
}

target_appcypher() {
  local upstream='appcypher/awesome-mcp-servers'
  local clone_dir
  clone_dir="$(fork_clone_branch "$upstream")"
  # No memory section; AI Services is the closest. Append at end.
  insert_at_section_end \
    "${clone_dir}/README.md" \
    '^#+ .*AI Services' \
    "$ROW_APPCYPHER"
  show_diff_then_commit "$clone_dir" "$upstream"
}

# ── Tier 3 targets ───────────────────────────────────────────────────

target_kyrolabs() {
  local upstream='kyrolabs/awesome-agents'
  local clone_dir
  clone_dir="$(fork_clone_branch "$upstream")"
  insert_at_section_end \
    "${clone_dir}/README.md" \
    '^#+ .*Knowledge Management' \
    "$ROW_KYROLABS"
  show_diff_then_commit "$clone_dir" "$upstream"
}

target_tensorchord() {
  local upstream='tensorchord/Awesome-LLMOps'
  local clone_dir
  clone_dir="$(fork_clone_branch "$upstream")"
  insert_at_section_end \
    "${clone_dir}/README.md" \
    '^#+ .*Hybrid search' \
    "$ROW_TENSORCHORD"
  show_diff_then_commit "$clone_dir" "$upstream"
}

target_danielskry() {
  local upstream='Danielskry/Awesome-RAG'
  local clone_dir
  clone_dir="$(fork_clone_branch "$upstream")"
  insert_at_section_end \
    "${clone_dir}/README.md" \
    '^#+ .*Frameworks that Facilitate RAG' \
    "$ROW_DANIELSKRY"
  show_diff_then_commit "$clone_dir" "$upstream"
}

target_jenqyang() {
  local upstream='Jenqyang/Awesome-AI-Agents'
  local clone_dir
  clone_dir="$(fork_clone_branch "$upstream")"
  insert_at_section_end \
    "${clone_dir}/README.md" \
    '^#+ .*Advanced Components' \
    "$ROW_JENQYANG"
  show_diff_then_commit "$clone_dir" "$upstream"
}

target_kaushikb11() {
  local upstream='kaushikb11/awesome-llm-agents'
  local clone_dir
  clone_dir="$(fork_clone_branch "$upstream")"
  # H1 title contains "Frameworks" — anchor on the exact H2 heading
  # so we don't match the title and insert at top of file.
  insert_at_section_end \
    "${clone_dir}/README.md" \
    '^## Frameworks$' \
    "$ROW_KAUSHIKB11"
  show_diff_then_commit "$clone_dir" "$upstream"
}

# ── CLI ──────────────────────────────────────────────────────────────

list_targets() {
  cat <<'EOF'
Available targets:

Tier 1-2:
  punkpeye      punkpeye/awesome-mcp-servers       (Knowledge & Memory, alpha-sort)
  topoteretes   topoteretes/awesome-ai-memory      (Memory Tool table)
  surrealdb     surrealdb/awesome-surreal          (Projects, alpha-sort)
  webfuse       webfuse-com/awesome-claude         (Claude Code & MCP section)
  appcypher     appcypher/awesome-mcp-servers      (AI Services, append)

Tier 3:
  kyrolabs      kyrolabs/awesome-agents            (Knowledge Management, append)
  tensorchord   tensorchord/Awesome-LLMOps         (Search > Hybrid search, append)
  danielskry    Danielskry/Awesome-RAG             (Frameworks that Facilitate RAG, append)
  jenqyang      Jenqyang/Awesome-AI-Agents         (Advanced Components, append)
  kaushikb11    kaushikb11/awesome-llm-agents      (Frameworks, append)

Run one:
  scripts/submit-awesome.sh --only punkpeye
  scripts/submit-awesome.sh --only punkpeye --apply

Run all 10:
  scripts/submit-awesome.sh --all --apply

By default (without --apply) it's a dry run — clones into
/tmp/inite-awesome-submissions/, runs the insertion, prints the
diff, DOES NOT commit or open a PR. Re-run with --apply once the
diff looks right.
EOF
}

run_target() {
  local id="$1"
  log ""
  log "${C_BOLD}═══ target: ${id} ═══${C_RESET}"
  case "$id" in
    punkpeye)    target_punkpeye ;;
    topoteretes) target_topoteretes ;;
    surrealdb)   target_surrealdb ;;
    webfuse)     target_webfuse ;;
    appcypher)   target_appcypher ;;
    kyrolabs)    target_kyrolabs ;;
    tensorchord) target_tensorchord ;;
    danielskry)  target_danielskry ;;
    jenqyang)    target_jenqyang ;;
    kaushikb11)  target_kaushikb11 ;;
    *)
      err "unknown target: $id"
      list_targets
      return 1
      ;;
  esac
}

main() {
  local mode='list'
  local only=''
  APPLY=0

  while (( $# )); do
    case "$1" in
      --list)   mode='list' ;;
      --only)   mode='one'; only="$2"; shift ;;
      --all)    mode='all' ;;
      --apply)  APPLY=1 ;;
      -h|--help) list_targets; exit 0 ;;
      *) err "unknown arg: $1"; list_targets; exit 1 ;;
    esac
    shift
  done

  case "$mode" in
    list) list_targets ;;
    one)  run_target "$only" ;;
    all)
      for id in punkpeye topoteretes surrealdb webfuse appcypher \
                kyrolabs tensorchord danielskry jenqyang kaushikb11; do
        run_target "$id" || warn "target ${id} failed — continuing"
      done
      ;;
  esac
}

main "$@"
