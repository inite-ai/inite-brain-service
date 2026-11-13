#!/usr/bin/env bash
# Copy every database of one SurrealDB namespace from a single-node server
# (RocksDB) to the two-node cluster (TiKV, deploy/surreal-ha), then prove
# the copy: the same tables, the same definitions and the same row count
# in every table of every database.
#
#   SRC=http://old-host:8000 DST=http://new-host:8000 \
#     SURREAL_USER=root SURREAL_PASS=… scripts/surreal-ha-migrate.sh [out-dir]
#
# Brain must not write during the copy (stop the app, or put it behind
# the maintenance page): an export is a point-in-time read per database,
# not a snapshot of the whole namespace. The scoped user `brain_caller`
# is namespace-level and is not copied — Brain re-provisions it on the
# first tenant request (ensureScopedUser).
#
# The surreal CLI runs from the server image, so the host needs only
# docker, curl and jq. On Docker Desktop, reach a server published on the
# host as host.docker.internal.
set -euo pipefail

SRC=${SRC:?SRC endpoint, e.g. http://127.0.0.1:8000}
DST=${DST:?DST endpoint, e.g. http://127.0.0.1:8030}
NS=${NS:-brain}
SURREAL_USER=${SURREAL_USER:-root}
SURREAL_PASS=${SURREAL_PASS:?SURREAL_PASS}
IMAGE=${IMAGE:-surrealdb/surrealdb:v3.3.5}
OUT=${1:-$(mktemp -d -t surreal-ha-migrate)}
mkdir -p "$OUT"

sql() { # endpoint db statement → JSON result array
  curl -sf -u "$SURREAL_USER:$SURREAL_PASS" -H 'Accept: application/json' \
    -H "surreal-ns: $NS" ${2:+-H "surreal-db: $2"} -X POST "$1/sql" --data-binary "$3"
}
cli() { # surreal CLI from the image, endpoints rewritten for the container
  docker run --rm -i -v "$OUT:/out" "$IMAGE" "$@"
}
in_container() { sed -e 's#//127\.0\.0\.1#//host.docker.internal#' -e 's#//localhost#//host.docker.internal#' <<<"$1"; }

DBS=$(sql "$SRC" "" "INFO FOR NS;" | jq -r '.[0].result.databases | keys[]')
echo "namespace $NS: $(wc -w <<<"$DBS" | tr -d ' ') database(s) → $OUT"

sql "$DST" "" "DEFINE NAMESPACE IF NOT EXISTS $NS;" >/dev/null
failed=0
for db in $DBS; do
  cli export --endpoint "$(in_container "$SRC")" -u "$SURREAL_USER" -p "$SURREAL_PASS" \
    --namespace "$NS" --database "$db" "/out/$db.surql" 2>/dev/null
  # A computed view (DEFINE TABLE … AS SELECT, e.g. 0088's stats_*) is
  # exported with its rows, and the import rebuilds those rows from the
  # view's definition — inserting them again fails the import, which
  # stops at its first error and silently skips every table after it.
  awk '
    /^DEFINE TABLE [^ ]+ .* AS SELECT / { view[$3] = 1 }
    /^-- TABLE DATA: / { skip = ($4 in view) }
    /^-- TABLE: / { skip = 0 }
    !(skip && /^INSERT /)
  ' "$OUT/$db.surql" >"$OUT/$db.import.surql"
  sql "$DST" "" "DEFINE DATABASE IF NOT EXISTS \`$db\`;" >/dev/null
  if ! log=$(cli import --endpoint "$(in_container "$DST")" -u "$SURREAL_USER" -p "$SURREAL_PASS" \
    --namespace "$NS" --database "$db" "/out/$db.import.surql" 2>&1); then
    echo "✗ $db: import failed"
    grep ERROR <<<"$log" | tail -3
    failed=1
    continue
  fi

  # Proof: identical definitions (FLEXIBLE included — an exporter once
  # dropped it on option<object> fields) and identical counts per table.
  src_info=$(sql "$SRC" "$db" "INFO FOR DB;" | jq -S '.[0].result | del(.users, .accesses)')
  dst_info=$(sql "$DST" "$db" "INFO FOR DB;" | jq -S '.[0].result | del(.users, .accesses)')
  if [[ "$src_info" != "$dst_info" ]]; then
    echo "✗ $db: definitions differ"
    diff <(echo "$src_info") <(echo "$dst_info") | head -20 || true
    failed=1
    continue
  fi
  tables=$(jq -r '.tables | keys[]' <<<"$src_info")
  counts_differ=0
  rows=0
  for t in $tables; do
    q="SELECT count() AS n FROM \`$t\` GROUP ALL;"
    a=$(sql "$SRC" "$db" "$q" | jq '.[0].result[0].n // 0')
    b=$(sql "$DST" "$db" "$q" | jq '.[0].result[0].n // 0')
    rows=$((rows + a))
    if [[ "$a" != "$b" ]]; then
      echo "✗ $db.$t: $a rows at the source, $b at the destination"
      counts_differ=1
    fi
  done
  if [[ $counts_differ -eq 1 ]]; then failed=1; continue; fi
  echo "✓ $db: $(wc -w <<<"$tables" | tr -d ' ') tables, $rows rows, definitions identical"
done
exit $failed
