#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

if ! command -v node >/dev/null 2>&1 && [[ -x "$HOME/.local/bin/node" ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

if ! command -v node >/dev/null 2>&1 && [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  # Non-interactive shells do not necessarily source the user's NVM setup.
  source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or later is required." >&2
  exit 1
fi

exec node "$root/scripts/install-local.mjs" "$@"
