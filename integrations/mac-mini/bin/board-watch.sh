#!/usr/bin/env bash
# Hermes cron monitor script for the board routine (`--monitor-script`).
# Prints the Captain rows that need a move (captain), a person (needs-you) or a
# merge (ready, merged), sorted and without timestamps. Hermes hashes the output
# each tick and runs the bot only when it changed, so an idle board costs no
# tokens.
#
# A failing `captain status` exits non-zero, which Hermes reports: cmux down or
# a broken project should reach you, not be skipped silently.
set -euo pipefail

captain status --json | jq -c '
  [.rows[]
    | select(.group == "captain" or .group == "needs-you" or .group == "ready" or .group == "merged")
    | {id, title, group, why, next, pr: .pr.url, checks: .pr.checks}]
  | sort_by(.id)
  | if length == 0 then "Nothing on the board needs a move, a person or a merge."
    else {actionable: .} end'
