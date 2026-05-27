#!/usr/bin/env bash

set -u

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ -z "${1:-}" ]; then
  cat <<'USAGE'
Usage: bash autofhir/scripts/watch-run-space.sh RUN_ID [INTERVAL_SECONDS]

Periodically logs run counts and disk usage, then runs the conservative
cleanup-run-space.ts --apply pass. The cleanup pass removes generated worktrees
and worker branches only for issues/chunks/seeds that are no longer running.
USAGE
  exit 0
fi

run_id="$1"
interval="${2:-120}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
root="$repo_root/autofhir/runs/$run_id"

count_files() {
  find "$1" -type f 2>/dev/null | wc -l | tr -d ' '
}

count_dirs() {
  find "$1" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' '
}

while true; do
  cd "$repo_root" || exit 1
  echo "watchdog_at=$(date -Is)"

  pending="$(count_files "$root/chunks/pending")"
  running="$(count_files "$root/chunks/running")"
  done_count="$(count_files "$root/chunks/done")"
  skipped="$(count_files "$root/chunks/skipped")"
  failed="$(count_files "$root/chunks/failed")"
  blocked="$(count_files "$root/chunks/blocked")"
  task_worktrees="$(count_dirs "$root/worktrees/tasks")"
  integration_worktrees="$(count_dirs "$root/worktrees/integration")"

  echo "counts pending=$pending running=$running done=$done_count skipped=$skipped failed=$failed blocked=$blocked"
  echo "worktrees task=$task_worktrees integration=$integration_worktrees"
  df -h "$repo_root" | tail -1

  bun autofhir/scripts/cleanup-run-space.ts --run-id "$run_id" --apply || true

  status=""
  if [ -f "$root/run.json" ]; then
    status="$(jq -r '.status // ""' "$root/run.json" 2>/dev/null || true)"
  fi
  if [ "$status" = "complete" ] && [ "$pending" = "0" ] && [ "$running" = "0" ]; then
    echo "watchdog_done=$(date -Is)"
    exit 0
  fi

  sleep "$interval"
done
