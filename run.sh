#!/bin/sh
# Engine D — HA Add-on entrypoint
# Reads HA config from /data/options.json, runs pre-flight checks, then starts the engine.

set -e

# Set timezone
export TZ=Asia/Singapore

# Read HA config (if available)
CONFIG_FILE=/data/options.json

# Helper: read a value from options.json using node (no bashio dependency)
get_config() {
    local key="$1"
    local default="$2"
    if [ -f "$CONFIG_FILE" ]; then
        node -e "const c=require('$CONFIG_FILE'); console.log(c['$key'] !== undefined ? c['$key'] : '$default')" 2>/dev/null || echo "$default"
    else
        echo "$default"
    fi
}

# --- Pre-flight checks ---

# 1. Clock check (GMT+8)
GMT8_HOUR=$(TZ=Asia/Singapore date +%H)
echo "[PREFLIGHT] Clock (GMT+8 hour): $GMT8_HOUR"

# 2. Node version check
echo "[PREFLIGHT] Node version: $(node --version)"

# 3. DNS resolution check
if nslookup api.binance.com >/dev/null 2>&1; then
    echo "[PREFLIGHT] DNS resolution: OK (api.binance.com resolves)"
else
    echo "[PREFLIGHT] DNS resolution: FAIL (api.binance.com does not resolve)"
    echo "[PREFLIGHT] Engine will start but may fail to fetch prices."
fi

# 4. Network connectivity check
if curl -s --max-time 10 https://api.binance.com/api/v3/ping >/dev/null 2>&1; then
    echo "[PREFLIGHT] Binance API: OK (ping successful)"
else
    echo "[PREFLIGHT] Binance API: FAIL (cannot reach api.binance.com)"
    echo "[PREFLIGHT] Engine will start but may fail to fetch prices."
fi

# 5. State file write access check (actual write test, not just touch)
STATE_FILE=/data/pfD_state.json
PROBE_FILE=/data/.write_probe
if echo "probe" > "$PROBE_FILE" 2>/dev/null && [ -f "$PROBE_FILE" ]; then
    rm -f "$PROBE_FILE"
    echo "[PREFLIGHT] State file write access: OK ($STATE_FILE)"
else
    echo "[PREFLIGHT] State file write access: FAIL (cannot write to $STATE_FILE)"
    echo "[PREFLIGHT] Engine will fail to persist state. Check volume mapping."
    exit 1
fi

# 6. Generate .env from HA config (using printf for safe quoting)
API_KEY=$(get_config 'binance_api_key' '')
API_SECRET=$(get_config 'binance_secret' '')
FUT_KEY=$(get_config 'binance_fut_api_key' '')
FUT_SECRET=$(get_config 'binance_fut_secret' '')

printf 'BINANCE_API_KEY=%s\n' "$API_KEY" > /app/.env
printf 'BINANCE_SECRET=%s\n' "$API_SECRET" >> /app/.env
printf 'BINANCE_FUT_API_KEY=%s\n' "$FUT_KEY" >> /app/.env
printf 'BINANCE_FUT_SECRET=%s\n' "$FUT_SECRET" >> /app/.env

# Verify .env has 4 lines
ENV_LINES=$(wc -l < /app/.env)
echo "[PREFLIGHT] .env generated: $ENV_LINES lines"
if [ "$ENV_LINES" -ne 4 ]; then
    echo "[PREFLIGHT] WARNING: .env has $ENV_LINES lines (expected 4). Check API key configuration."
fi

# Set engine env vars from HA config (with defaults)
export C_START=$(get_config 'c_start' '1140')
export C_STATE=/data/pfD_state.json
export C_POLL=$(get_config 'c_poll' '60')
export C_SLOWLONG_ENABLED=$(get_config 'c_slowlong_enabled' '0')
export C_LONG_GUARD_BREADTH=$(get_config 'c_long_guard_breadth' '0.70')
export C_ML_BULL_MAX_POS=$(get_config 'c_ml_bull_max_pos' '2')
export C_FS_CD_HOURS=$(get_config 'c_fs_cd_hours' '6')
export TZ=Asia/Singapore

# Log startup
echo "[STARTUP] Engine D starting..."
echo "[STARTUP] State file: $C_STATE"
echo "[STARTUP] Poll interval: ${C_POLL}s"
echo "[STARTUP] Start equity: $C_START"
echo "[STARTUP] Long guard: $C_LONG_GUARD_BREADTH"
echo "[STARTUP] BULL cap: $C_ML_BULL_MAX_POS"
echo "[STARTUP] FS cooldown: ${C_FS_CD_HOURS}h"
echo "[STARTUP] Node: $(node --version)"

# Run the engine (node reads .env via dotenv)
# exec replaces shell process so SIGTERM goes to node directly
cd /app
exec node paper_D.js