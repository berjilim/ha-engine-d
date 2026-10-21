# Engine D — HA Add-on

Automated dual-sided crypto trading bot (paper trading) for Home Assistant.

## What it does
Engine D trades 24 cryptocurrencies automatically:
- **Long side:** Buys coins in healthy markets, sells on strength, protects against crashes
- **Short side:** Shorts bounces in falling markets, takes profit on drops
- Runs 24/7, paper trading only (simulated money, real prices)

## Installation

1. Add this repository to Home Assistant:
   - Settings → Add-ons → Add-on Store → ⋮ → Repositories
   - Paste: `https://github.com/your-org/ha-engine-d`
2. Install "Engine D — Paper Trading Bot"
3. Configure your Binance API keys in the add-on options
4. Start the add-on

## Configuration

| Option | Description | Default |
|---|---|---|
| `binance_api_key` | Binance API key (reading + spot trading, withdrawals disabled) | (required) |
| `binance_secret` | Binance API secret | (required) |
| `binance_fut_api_key` | Binance Futures API key (optional) | (optional) |
| `binance_fut_secret` | Binance Futures API secret (optional) | (optional) |
| `c_start` | Starting equity (USDT) | 1140 |
| `c_poll` | Polling interval (seconds) | 60 |
| `c_slowlong_enabled` | Enable slow-long leg (0/1) | 0 |
| `c_long_guard_breadth` | Long entry breadth guard | 0.70 |
| `c_ml_bull_max_pos` | Max concurrent longs in BULL regime | 2 |
| `c_fs_cd_hours` | Short cooldown hours | 6 |

## State persistence
State is stored in `/data/pfD_state.json` (mapped to HA's persistent data directory). Survives container restarts.

## Logs
View logs via HA add-on log viewer, or check `/data/` for state files.

## Safety
- Paper trading only — no real orders, no real funds
- Binance API key must have withdrawals DISABLED
- The bot uses realistic costs (fees + slippage + funding) on every trade