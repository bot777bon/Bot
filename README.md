# Telegram Solana Bot (Raydium, Jupiter, Pump.fun)

This repository contains a Telegram bot and supporting scripts for Solana/Raydium workflows.

## Features

- Telegram bot integrations
- Dex listener/sniper utilities
- Example trading script `trading.py` (optional)

## trading.py (optional)

This repository contains a small example trading script `trading.py`.

Usage notes:
- Provide credentials via environment variables: `API_KEY`, `API_SECRET`.
- Select exchange via `EXCHANGE` env var (e.g. `EXCHANGE=binance`). The script
  inspects your installed `ccxt` and will attempt to match common exchange
  class names. If initialization fails it prints diagnostic lines prefixed
  with `[ccxt-init-debug]` to help you choose the correct name.
- The script defaults to dry-run mode to avoid placing live orders. Review the
  `DRY_RUN` env var before enabling real trading.

Example:
```
export EXCHANGE=binance
export API_KEY=your_key
export API_SECRET=your_secret
python trading.py
```

Notes:
- `trading.py` is an example and not production-ready. Before enabling live
  orders, add proper risk controls, logging, retries, and run extensive tests.
# Telegram Solana Bot (Raydium, Jupiter, Pump.fun)
## Features
