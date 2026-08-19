#!/usr/bin/env bash
# Source OPENAI_* from .env for PM2 (never `source .env` — unquoted values break bash).
set -euo pipefail

ENV_FILE="${1:-.env}"

read_env_val() {
  local key="$1"
  grep -m1 "^${key}=" "$ENV_FILE" | cut -d= -f2- | tr -d '\r' | sed 's/^["'"'"']//; s/["'"'"']$//'
}

export OPENAI_API_KEY="$(read_env_val OPENAI_API_KEY)"
export OPENAI_MODEL="$(read_env_val OPENAI_MODEL)"
export OPENAI_PROJECT_ID="$(read_env_val OPENAI_PROJECT_ID)"
export OPENAI_ORG_ID="$(read_env_val OPENAI_ORG_ID)"
