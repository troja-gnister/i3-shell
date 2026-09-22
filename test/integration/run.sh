#!/usr/bin/env bash
# Full private integration suite: builds TEST, runs every nested scenario, and
# always leaves dist/ holding a RELEASE bundle again — including on failure.
# The caller still performs the final `make install`.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
restore_release() {
  local result=$?
  trap - EXIT
  if ! npm run build; then
    printf '%s\n' 'release rebuild failed after integration' >&2
    result=1
  fi
  exit "$result"
}
trap restore_release EXIT
npm run build:test
bash test/integration/nested.sh -- bash test/integration/phase1-checks.sh
bash test/integration/nested.sh -- python3 test/integration/phase2-checks.py
bash test/integration/nested.sh --monitor 1920x1080 --monitor 1280x720 -- \
  python3 test/integration/phase2-checks.py --monitors
bash test/integration/nested.sh --disabled -- python3 test/integration/phase2-checks.py --settings
bash test/integration/nested.sh --disabled -- python3 test/integration/phase2-checks.py --name-conflict
