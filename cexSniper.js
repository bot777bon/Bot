#!/usr/bin/env node
// Lightweight CEX sniper helper (non-invasive)
// Exposes start/stop/history helpers that accept per-user decrypted keys.
const fs = require('fs');
const path = require('path');

const running = new Map();
const TRADE_DIR = path.join(process.cwd(), 'sent_tokens');
if (!fs.existsSync(TRADE_DIR)) {
  try { fs.mkdirSync(TRADE_DIR, { recursive: true }); } catch (e) {}
}

/**
 * @param {string} userId
 * @returns {string}
 */
function _historyPath(userId) {
  return path.join(TRADE_DIR, `cex_trades_${String(userId)}.json`);
}

/**
 * @param {string} userId
 * @param {{apiKey:string,apiSecret:string,platform?:string}} keys
 * @param {any} [opts]
 */
function startUserCexSniper(userId, keys, opts) {
  // keys: { apiKey, apiSecret, platform }
  if (!userId) return { ok: false, err: 'missing userId' };
  if (!keys || !keys.apiKey || !keys.apiSecret) return { ok: false, err: 'missing keys' };
  if (running.has(String(userId))) return { ok: false, err: 'already_running' };
  // Minimal start: mark running; if opts.live===true we'll flag live-mode but still keep safe by default
  /** @type {any} */
  const liveFlag = Boolean(opts && (opts).live);
  /** @type {any} */
  const meta = /** @type {any} */ ({ startedAt: Date.now(), keys: { ...keys }, opts: opts || {}, live: liveFlag });
  // If live requested, attempt to attach a ccxt client (if ccxt is installed)
  if (meta.live) {
    try {
      // lazy require so dependency is optional until used
      const ccxt = require('ccxt');
      const platformId = String((keys.platform || 'binance')).toLowerCase();
      // normalize some common names
      const map = { 'mexc': 'mexc', 'mexC': 'mexc', 'binance': 'binance', 'bybit': 'bybit' };
  let mapped;
  try { mapped = map[platformId]; } catch (e) { mapped = undefined; }
  const id = (mapped || platformId).toLowerCase();
      if (ccxt && ccxt[id]) {
        try {
          meta.client = new ccxt[id]({ apiKey: keys.apiKey, secret: keys.apiSecret, enableRateLimit: true });
        } catch (e) {
          meta.client = null;
          console.error('cexSniper: failed to init ccxt client for', id, e);
        }
      } else {
        meta.client = null;
      }
    } catch (e) {
      meta.client = null;
      // ccxt not installed or other error
    }
  }
  running.set(String(userId), meta);
  return { ok: true, msg: meta.live ? 'CEX sniper started in LIVE mode (orders disabled until fully implemented).' : 'CEX sniper started (simulation). This module currently runs in dry-run mode by default.' };
}

/**
 * @param {string} userId
 */
function stopUserCexSniper(userId) {
  if (!userId) return { ok: false, err: 'missing userId' };
  if (!running.has(String(userId))) return { ok: false, err: 'not_running' };
  running.delete(String(userId));
  return { ok: true, msg: 'CEX sniper stopped' };
}

/**
 * @param {string} userId
 */
function getUserCexSniperStatus(userId) {
  if (!userId) return { ok: false, err: 'missing userId' };
  const r = running.get(String(userId));
  if (!r) return { ok: true, running: false };
  return { ok: true, running: true, since: r.startedAt };
}

/**
 * @param {string} userId
 * @param {object} record
 */
function addTradeRecord(userId, record) {
  try {
    const p = _historyPath(userId);
    let arr = [];
    if (fs.existsSync(p)) {
      try { arr = JSON.parse(fs.readFileSync(p, 'utf8') || '[]'); } catch (e) { arr = []; }
    }
    arr.push(Object.assign({ ts: Date.now() }, record || {}));
    fs.writeFileSync(p, JSON.stringify(arr.slice(-500), null, 2));
    return { ok: true };
  } catch (e) { return { ok: false, err: String(e) }; }
}

/**
 * @param {string} userId
 */
function getUserTradeHistory(userId) {
  try {
    const p = _historyPath(userId);
    if (!fs.existsSync(p)) return { ok: true, trades: [] };
    const arr = JSON.parse(fs.readFileSync(p, 'utf8') || '[]');
    return { ok: true, trades: arr };
  } catch (e) { return { ok: false, err: String(e) }; }
}

// Analyze a symbol by invoking trading.py --analyze and returning parsed JSON
/**
 * Analyze a symbol by invoking trading.py --analyze and returning parsed JSON.
 * Accepts an optional opts object: { platform: 'mexc' } which will set EXCHANGE for the child python process.
 * Backwards compatible: analyzeSymbol(userId, symbol) still works.
 *
 * @param {string} userId
 * @param {string} symbol
 * @param {{platform?:string}} [opts]
 * @returns {Promise<any>}
 */
function analyzeSymbol(userId, symbol, opts) {
  return new Promise((resolve) => {
    try {
      const { spawn } = require('child_process');
      const script = path.join(process.cwd(), 'trading.py');
      const args = [script, '--analyze', String(symbol)];
      // Prepare env for child: allow overriding EXCHANGE per-call (platform), fallback to existing env
      const childEnv = Object.assign({}, process.env);
      try {
        const platform = opts && opts.platform ? String(opts.platform).trim() : (process.env.EXCHANGE || '');
        if (platform) childEnv.EXCHANGE = platform;
      } catch (e) {}
      const py = spawn('python3', args, { env: childEnv });
      let out = '';
      let err = '';
      py.stdout.on('data', (d) => { out += String(d || ''); });
      py.stderr.on('data', (d) => { err += String(d || ''); });
      py.on('close', (code) => {
        if (out) {
          try { const obj = JSON.parse(out.trim()); return resolve({ ok: true, data: obj }); } catch (e) { return resolve({ ok: false, parse_error: true, out, stderr: err }); }
        }
        return resolve({ ok: false, err: 'no_output', code, out, stderr: err });
      });
    } catch (e) { return resolve({ ok: false, err: String(e) }); }
  });
}

// Simple confirm flow for enabling live trading per-user
const pendingLiveConfirm = new Set();
/**
 * @param {string} userId
 */
function requestEnableLive(userId) {
  if (!userId) return { ok: false, err: 'missing userId' };
  // If already pending, confirm and enable
  if (pendingLiveConfirm.has(String(userId))) {
    pendingLiveConfirm.delete(String(userId));
    // mark running with live flag if keys available
    const ukeys = null; // caller should pass keys
    // we don't have keys here — caller will call startUserCexSniper with live true
    return { ok: true, msg: 'confirmed' };
  }
  pendingLiveConfirm.add(String(userId));
  return { ok: true, msg: 'confirm_needed' };
}

// Safety checks before any real execution
/**
 * @param {any} analysis
 * @param {any} opts
 */
function _passesFilters(analysis, opts) {
  try {
    const minVolume = Number(opts && opts.minVolume || process.env.CEX_MIN_VOLUME_USDT || 10000);
    const maxAtrPct = Number(opts && opts.maxAtrPct || process.env.CEX_MAX_ATR_PCT || 0.2);
    if (analysis.volume && analysis.close) {
      // approximate USD volume if symbol quote is USDT
      if (analysis.volume < minVolume) return { ok: false, reason: 'low_volume' };
    }
    if (analysis.atr && analysis.close) {
      const atrPct = Number(analysis.atr) / Number(analysis.close);
      if (!isNaN(atrPct) && atrPct > maxAtrPct) return { ok: false, reason: 'high_atr' };
    }
    return { ok: true };
  } catch (e) { return { ok: false, reason: 'filter_error', err: String(e) }; }
}

// Stubbed execute order: respects ENABLE_CEX_EXECUTION env var; for safety, default false
/**
 * @param {string} userId
 * @param {string} symbol
 * @param {string} side
 * @param {number} usdtSize
 * @param {any} keys
 * @param {any} opts
 */
async function executeOrder(userId, symbol, side, usdtSize, keys, opts) {
  try {
    const enabled = String(process.env.ENABLE_CEX_EXECUTION || '').toLowerCase() === 'true';
    // record attempt
    addTradeRecord(userId, { action: 'execute_attempt', symbol, side, usdtSize, enabled });
    if (!enabled) return { ok: false, simulated: true, msg: 'execution_disabled' };
    // If enabled, try to perform a real market order using user's client
    try {
      const meta = running.get(String(userId));
      const client = meta && meta.client;
      if (!client) {
        addTradeRecord(userId, { action: 'execute_failed', reason: 'no_client' });
        return { ok: false, err: 'no_client' };
      }
      // We need to determine amount in base currency. Many CEXs accept amount in base units.
      // Simplest approach: fetch ticker price and compute amount = usdtSize / price
      const ticker = await client.fetchTicker(symbol);
      const price = Number(ticker && (ticker.last || ticker.close || ticker.price));
      if (!price || isNaN(price) || price <= 0) {
        addTradeRecord(userId, { action: 'execute_failed', reason: 'bad_price', ticker });
        return { ok: false, err: 'bad_price' };
      }
      const amount = Number((Number(usdtSize) / price).toFixed(8));
      // place market order
      let order;
      if (typeof client.createMarketOrder === 'function') {
        order = await client.createMarketOrder(symbol, side, amount);
      } else if (typeof client.createOrder === 'function') {
        order = await client.createOrder(symbol, 'market', side, amount);
      } else {
        addTradeRecord(userId, { action: 'execute_failed', reason: 'no_order_method' });
        return { ok: false, err: 'no_order_method' };
      }
      addTradeRecord(userId, { action: 'execute_record', symbol, side, usdtSize, amount, order });
      return { ok: true, simulated: false, order };
    } catch (e) {
      addTradeRecord(userId, { action: 'execute_error', err: String(e) });
      return { ok: false, err: String(e) };
    }
  } catch (e) { return { ok: false, err: String(e) }; }
}

module.exports = { startUserCexSniper, stopUserCexSniper, getUserCexSniperStatus, getUserTradeHistory, addTradeRecord, analyzeSymbol, requestEnableLive, _passesFilters, executeOrder };
