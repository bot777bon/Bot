"""
trading.py
------------
Simple trading script (Python). Notes:

- Set EXCHANGE via an environment variable, for example:
    export EXCHANGE=binance

- The script tries to initialize a ccxt exchange class using common names
    (e.g. 'binance', 'binanceusdm', 'mexc'). If the exact name is not found
    it will search ccxt class names for a partial match and try the best
    candidate automatically. On failure it prints diagnostic output that
    lists ccxt class names (see [ccxt-init-debug] messages) to help you pick
    the correct EXCHANGE value for your installed ccxt version.

- API keys should be provided via environment variables:
    export API_KEY=...; export API_SECRET=...

Configuration is read from environment variables by default. The script
contains safe defaults (dry-run enabled) but review before enabling live orders.
"""

import ccxt
import inspect
import inspect
import pandas as pd
import ta
import time
import os
from datetime import datetime

# ---------------- إعداد المستخدم ----------------
CONFIG = {
    "exchange": os.environ.get("EXCHANGE", "binance"),        # binance أو mexc
    "apiKey": os.environ.get("API_KEY", "YOUR_API_KEY"),
    "secret": os.environ.get("API_SECRET", "YOUR_API_SECRET"),
    "symbol_filter": os.environ.get("SYMBOL_FILTER", "USDT"),      # نراقب فقط الأزواج المنتهية بـ USDT
    "timeframe": os.environ.get("TIMEFRAME", "15m"),           # الإطار الزمني
    "limit": int(os.environ.get("LIMIT", 200)),
    "trade_size_usdt": float(os.environ.get("TRADE_SIZE_USDT", 50)),        # حجم الصفقة بالدولار
    "tp_pct": float(os.environ.get("TP_PCT", 0.05)),               # الهدف: 5%
    "sl_pct": float(os.environ.get("SL_PCT", 0.03)),               # وقف الخسارة: 3%
    "dry_run": os.environ.get("DRY_RUN", "true").lower() in ("1", "true", "yes"),              # أولاً نجرب المحاكاة
    "poll_interval_s": int(os.environ.get("POLL_INTERVAL_S", 10)),
    "simulate_max_wait_s": int(os.environ.get("SIMULATE_MAX_WAIT_S", 60*30)),  # 30 دقيقة افتراضيًا
}
# -------------------------------------------------

def init_exchange():
    params = {"apiKey": CONFIG["apiKey"], "secret": CONFIG["secret"], "enableRateLimit": True}
    # allow several common aliases and try getattr on ccxt for flexibility
    name = str(CONFIG.get("exchange") or "").strip().lower()
    # common mapping: user-friendly names -> ccxt class attribute
    alias_map = {
        'binance': 'binance',
        'binanceusdm': 'binanceusdm',
        'binanceus': 'binanceus',
        'binancecoinm': 'binancecoinm',
        'mexc': 'mexc',
        'mxc': 'mexc',
        'bybit': 'bybit',
    }
    cls_name = alias_map.get(name, name)
    # If ccxt has the attribute, construct it
    try:
        if hasattr(ccxt, cls_name):
            ExchangeClass = getattr(ccxt, cls_name)
            return ExchangeClass(params)
        # sometimes exchanges are under ccxt.exchange({'options':...}) pattern - try direct constructor by name
        # final fallback: try lowercase name as attribute again
        for attr in dir(ccxt):
            if attr.lower() == cls_name.lower():
                ExchangeClass = getattr(ccxt, attr)
                return ExchangeClass(params)
        # no exact/ci match; try substring similarity and if a clear candidate exists, use it and add to alias_map
        classes = [n for n in dir(ccxt) if inspect.isclass(getattr(ccxt, n))]
        similar = [n for n in classes if cls_name.lower() in n.lower()]
        if similar:
            # choose best candidate (prefer exact token match order)
            candidate = similar[0]
            print(f"[ccxt-init] Using similar ccxt class '{candidate}' for EXCHANGE='{name}' and adding to alias_map")
            try:
                ExchangeClass = getattr(ccxt, candidate)
                # update alias_map so subsequent runs in this process are faster
                try:
                    alias_map[name] = candidate
                except Exception:
                    pass
                return ExchangeClass(params)
            except Exception:
                # fall through to diagnostic -> will raise below
                pass
    except Exception as e:
        # Diagnostic output for debugging ccxt compatibility
        try:
            classes = [n for n in dir(ccxt) if inspect.isclass(getattr(ccxt, n))]
            similar = [n for n in classes if cls_name.lower() in n.lower()]
            print("[ccxt-init-debug] Failed to initialize exchange:", CONFIG.get('exchange'))
            print("[ccxt-init-debug] Exception:", e)
            print("[ccxt-init-debug] ccxt classes (sample):", classes[:80])
            if similar:
                print("[ccxt-init-debug] Candidates matching your EXCHANGE name:", similar)
        except Exception:
            # best-effort diagnostic; ignore if introspection fails
            pass
        raise RuntimeError(f"Failed to initialize exchange '{CONFIG.get('exchange')}' via ccxt: {e}")
    raise ValueError(f"❌ Exchange غير مدعوم أو لم يتم العثور على موصِّف ccxt لَـ '{CONFIG.get('exchange')}'")

exchange = init_exchange()

# --------- جلب البيانات ---------
def get_ohlcv(symbol):
    ohlcv = exchange.fetch_ohlcv(symbol, CONFIG["timeframe"], limit=CONFIG["limit"])
    df = pd.DataFrame(ohlcv, columns=["time","open","high","low","close","volume"])
    df["close"] = df["close"].astype(float)
    return df

# --------- حساب المؤشرات ---------
def add_indicators(df):
    if len(df) < 50:
        raise ValueError("Not enough bars to compute indicators")
    close = df["close"]
    df["EMA50"] = ta.trend.EMAIndicator(close, 50).ema_indicator()
    # ensure enough bars for EMA200
    if len(df) >= 200:
        df["EMA200"] = ta.trend.EMAIndicator(close, 200).ema_indicator()
    else:
        df["EMA200"] = pd.Series([None] * len(df))
    macd = ta.trend.MACD(close)
    df["MACD"] = macd.macd()
    df["MACD_signal"] = macd.macd_signal()
    stoch = ta.momentum.StochRSIIndicator(close).stochrsi()
    df["StochRSI"] = stoch
    return df

# --------- تحديد الإشارة ---------
def get_signal(df):
    # safety: ensure required columns
    if df is None or len(df) == 0:
        return "HOLD"
    try:
        ema50 = df["EMA50"].iloc[-1]
        ema200 = df["EMA200"].iloc[-1]
        macd = df["MACD"].iloc[-1]
        macd_signal = df["MACD_signal"].iloc[-1]
        stoch = df["StochRSI"].iloc[-1]
    except Exception:
        return "HOLD"

    ema_bull = (ema50 is not None and ema200 is not None and ema50 > ema200)
    ema_bear = (ema50 is not None and ema200 is not None and ema50 < ema200)
    macd_bull = (macd is not None and macd_signal is not None and macd > macd_signal)
    macd_bear = (macd is not None and macd_signal is not None and macd < macd_signal)
    # Correct StochRSI logic: oversold <0.2 -> bullish, overbought >0.8 -> bearish
    stoch_bull = (stoch is not None and stoch < 0.2)
    stoch_bear = (stoch is not None and stoch > 0.8)

    if ema_bull and macd_bull and stoch_bull:
        return "BUY"
    elif ema_bear and macd_bear and stoch_bear:
        return "SELL"
    else:
        return "HOLD"

# --------- تنفيذ محاكاة ---------
def simulate_trade(symbol, action, entry_price, max_wait_s=None):
    tp = entry_price * (1 + CONFIG["tp_pct"]) if action=="BUY" else entry_price * (1 - CONFIG["tp_pct"])
    sl = entry_price * (1 - CONFIG["sl_pct"]) if action=="BUY" else entry_price * (1 + CONFIG["sl_pct"])

    print(f"\n🔍 محاكاة {action} على {symbol} @ {entry_price:.8f} | TP={tp:.8f}, SL={sl:.8f}")

    start = time.time()
    max_wait_s = max_wait_s if max_wait_s is not None else CONFIG.get("simulate_max_wait_s")
    while True:
        try:
            ticker = exchange.fetch_ticker(symbol)
            price = float(ticker.get("last") or ticker.get("close") or 0)
        except Exception as e:
            print(f"⚠️ Failed to fetch ticker for {symbol}: {e}")
            price = None
        if price is not None:
            if action=="BUY":
                if price >= tp:
                    print(f"✅ الصفقة نجحت (TP Hit) {symbol} @ {price:.8f}")
                    return True
                elif price <= sl:
                    print(f"❌ الصفقة فشلت (SL Hit) {symbol} @ {price:.8f}")
                    return False
            else:  # SELL
                if price <= tp:
                    print(f"✅ الصفقة نجحت (TP Hit) {symbol} @ {price:.8f}")
                    return True
                elif price >= sl:
                    print(f"❌ الصفقة فشلت (SL Hit) {symbol} @ {price:.8f}")
                    return False
        if max_wait_s and (time.time() - start) > max_wait_s:
            print(f"⏱️ انتهاء المهلة لمحاكاة الصفقة على {symbol} بعد {max_wait_s} ثانية")
            return False
        time.sleep(CONFIG.get("poll_interval_s", 10))  # تحديث دوري

# --------- تنفيذ أمر حقيقي ---------
def place_real_order(symbol, action, usdt_size):
    if CONFIG["dry_run"]:
        print(f"[DRY RUN] 🚀 تنفيذ {action} حقيقي على {symbol} بمبلغ {usdt_size} USDT")
        return None
    try:
        ticker = exchange.fetch_ticker(symbol)
        price = float(ticker.get("last") or ticker.get("close") or 0)
        if price <= 0:
            raise ValueError("Invalid ticker price")
        amount = usdt_size / price
        # apply exchange precision if available
        market = exchange.markets.get(symbol) if hasattr(exchange, 'markets') else None
        if market and 'precision' in market and 'amount' in market['precision']:
            prec = market['precision']['amount']
            amount = float(round(amount, prec))
        if action == "BUY":
            order = exchange.create_market_buy_order(symbol, amount)
        else:
            order = exchange.create_market_sell_order(symbol, amount)
        print(f"🚀 تم تنفيذ {action} فعلي: {order}")
        return order
    except Exception as e:
        print(f"❌ Failed to place real order for {symbol}: {e}")
        return None

# --------- المراقبة الرئيسية ---------
def run_once():
    markets = exchange.load_markets()
    # markets may be dict symbol->meta
    symbols = [s for s in (list(markets.keys()) if isinstance(markets, dict) else markets) if str(s).endswith(CONFIG["symbol_filter"])]

    for symbol in symbols:
        try:
            df = get_ohlcv(symbol)
            df = add_indicators(df)
            signal = get_signal(df)
            if signal in ["BUY", "SELL"]:
                entry_price = float(df["close"].iloc[-1])
                success = simulate_trade(symbol, signal, entry_price)
                if success:
                    place_real_order(symbol, signal, CONFIG["trade_size_usdt"])
        except Exception as e:
            print(f"⚠️ خطأ في {symbol}: {e}")

if __name__ == "__main__":
    import sys
    # If '--analyze' is present, defer to the CLI analyze handler below instead of
    # running the full run_once (which may call private endpoints like load_markets).
    if len(sys.argv) > 1 and '--analyze' in sys.argv:
        # CLI analyze path will be handled later in the file
        pass
    else:
        print(f"Starting trading run: dry_run={CONFIG['dry_run']}, exchange={CONFIG['exchange']}")
        run_once()


def analyze_symbol(symbol):
    """Compute indicators for a single symbol and return a dict summary."""
    try:
        # For CLI analysis use a public-only exchange instance to avoid private endpoints
        def init_public_exchange():
            params = { "enableRateLimit": True }
            name = str(CONFIG.get("exchange") or "").strip().lower()
            alias_map = {
                'binance': 'binance',
                'binanceusdm': 'binanceusdm',
                'binanceus': 'binanceus',
                'binancecoinm': 'binancecoinm',
                'mexc': 'mexc',
                'mxc': 'mexc',
                'bybit': 'bybit',
            }
            cls_name = alias_map.get(name, name)
            try:
                if hasattr(ccxt, cls_name):
                    ExchangeClass = getattr(ccxt, cls_name)
                    return ExchangeClass(params)
                for attr in dir(ccxt):
                    if attr.lower() == cls_name.lower():
                        ExchangeClass = getattr(ccxt, attr)
                        return ExchangeClass(params)
            except Exception:
                pass
            # fallback to generic constructor using name
            try:
                return getattr(ccxt, name)(params)
            except Exception:
                # final fallback: try first available exchange class
                classes = [n for n in dir(ccxt) if n.islower()]
                for c in classes:
                    try:
                        return getattr(ccxt, c)(params)
                    except Exception:
                        continue
                raise

        public_exchange = init_public_exchange()
        def get_ohlcv_public(symbol):
            ohlcv = public_exchange.fetch_ohlcv(symbol, CONFIG["timeframe"], limit=CONFIG["limit"])
            df = pd.DataFrame(ohlcv, columns=["time","open","high","low","close","volume"])
            df["close"] = df["close"].astype(float)
            return df

        # Resolve symbol against the exchange markets: try variants and fallbacks
        def resolve_symbol_on_exchange(exchange_obj, raw_symbol):
            try:
                # load markets once
                try:
                    markets = exchange_obj.load_markets()
                except Exception:
                    markets = getattr(exchange_obj, 'markets', {}) or {}
                # normalize
                rs = str(raw_symbol or '').strip()
                candidates = []
                s = rs
                candidates.append(s)
                # replacements
                candidates.append(s.replace('-', '/'))
                candidates.append(s.replace('_', '/'))
                # force uppercase variants
                candidates = candidates + [c.upper() for c in candidates]
                # if no slash, try common quote pairs
                if '/' not in s:
                    for q in ['USDT', 'USDC', 'BTC', 'ETH']:
                        candidates.append(f"{s}/{q}")
                        candidates.append(f"{s.upper()}/{q}")
                # dedupe preserving order
                seen = set(); uniq = []
                for c in candidates:
                    if not c: continue
                    if c in seen: continue
                    seen.add(c); uniq.append(c)
                # direct match against markets keys
                market_keys = list(markets.keys()) if isinstance(markets, dict) else []
                market_lc = {mk.lower(): mk for mk in market_keys}
                for cand in uniq:
                    if cand in market_keys: return cand
                    if cand.lower() in market_lc: return market_lc[cand.lower()]
                # fallback: search for market where base matches cand token name
                base_candidate = (s.split('/') or [s])[0].upper()
                preferred_quotes = ['USDT','USDC','BTC','ETH']
                for q in preferred_quotes:
                    key = f"{base_candidate}/{q}"
                    if key in market_keys: return key
                    if key.lower() in market_lc: return market_lc[key.lower()]
                # final fallback: find any market whose base equals base_candidate
                for mk in market_keys:
                    m = markets.get(mk) or {}
                    base = (m.get('base') or '').upper()
                    if base == base_candidate:
                        return mk
                # not found
                return None
            except Exception:
                return None

        resolved = resolve_symbol_on_exchange(public_exchange, symbol)
        if not resolved:
            # still attempt direct fetch which will give an informative error
            df = get_ohlcv_public(symbol)
        else:
            df = get_ohlcv_public(resolved)
            # replace symbol variable with resolved for outputs
            symbol = resolved
        df = add_indicators(df)
        # provide previous bar for change metrics when available
        last = df.iloc[-1]
        prev = df.iloc[-2] if len(df) >= 2 else last

        # compute ATR using ta if available
        try:
            atr_series = ta.volatility.AverageTrueRange(df['high'], df['low'], df['close']).average_true_range()
            atr = float(atr_series.iloc[-1]) if len(atr_series) > 0 else None
        except Exception:
            atr = None

        vol = float(last['volume'])
        prev_vol = float(prev['volume']) if prev is not None else None
        close = float(last['close'])
        prev_close = float(prev['close']) if prev is not None else None
        close_change = None
        try:
            if prev_close is not None and prev_close != 0:
                close_change = (close - prev_close) / abs(prev_close)
        except Exception:
            close_change = None

        vol_change = None
        try:
            if prev_vol is not None and prev_vol != 0:
                vol_change = (vol - prev_vol) / abs(prev_vol)
        except Exception:
            vol_change = None

        signal = get_signal(df)

        # Indicators snapshot
        try:
            ema50 = float(last.get('EMA50')) if last.get('EMA50') is not None else None
            ema200 = float(last.get('EMA200')) if last.get('EMA200') is not None else None
            macd = float(last.get('MACD')) if last.get('MACD') is not None else None
            macd_signal = float(last.get('MACD_signal')) if last.get('MACD_signal') is not None else None
            stoch = float(last.get('StochRSI')) if last.get('StochRSI') is not None else None
        except Exception:
            ema50 = ema200 = macd = macd_signal = stoch = None

        macd_hist = None
        try:
            if macd is not None and macd_signal is not None:
                macd_hist = macd - macd_signal
        except Exception:
            macd_hist = None

        # Build a confidence score 0..100 based on indicator agreement + volume/atr sanity
        score_components = []
        try:
            # EMA trend
            if ema50 is not None and ema200 is not None:
                score_components.append(1 if ema50 > ema200 else -1)
            # MACD
            if macd is not None and macd_signal is not None:
                score_components.append(1 if macd > macd_signal else -1)
            # StochRSI
            if stoch is not None:
                if stoch < 0.2:
                    score_components.append(1)
                elif stoch > 0.8:
                    score_components.append(-1)
            # volume (higher recent volume = positive)
            if vol_change is not None:
                score_components.append(1 if vol_change > 0 else -1)
            # ATR sanity: very large ATR% is negative
            if atr is not None and close:
                atr_pct = atr / close if close else 0
                score_components.append(-1 if atr_pct > 0.25 else 1)
        except Exception:
            pass

    # normalize to 0..100
        try:
            if len(score_components) == 0:
                score = 50.0
            else:
                s = sum(score_components) / (len(score_components) * 1.0)  # in [-1,1]
                score = float(round((s + 1) / 2 * 100, 2))  # map -1..1 to 0..100
        except Exception:
            score = 50.0

        # Compute additional professional metrics: RSI, EMA slope, MACD hist strength, volume vs MA
        try:
            # RSI using ta
            try:
                rsi_ser = ta.momentum.RSIIndicator(df['close'], window=14).rsi()
                rsi = float(rsi_ser.iloc[-1]) if len(rsi_ser) > 0 else None
            except Exception:
                rsi = None
            # EMA slope: relative change of EMA50 over last N bars
            ema_slope = None
            try:
                if 'EMA50' in df.columns and len(df['EMA50']) >= 3:
                    prev_ema = float(df['EMA50'].iloc[-3])
                    last_ema = float(df['EMA50'].iloc[-1])
                    ema_slope = (last_ema - prev_ema) / (prev_ema if prev_ema else 1)
            except Exception:
                ema_slope = None
            # MACD hist strength (abs normalized)
            macd_strength = None
            try:
                if macd_hist is not None and close:
                    macd_strength = abs(macd_hist) / (abs(close) if close else 1)
            except Exception:
                macd_strength = None
            # Volume vs short MA (20)
            vol_vs_ma = None
            try:
                if 'volume' in df.columns and len(df['volume']) >= 21:
                    ma_vol = df['volume'].rolling(window=20).mean().iloc[-1]
                    vol_vs_ma = (vol - ma_vol) / (ma_vol if ma_vol else 1)
            except Exception:
                vol_vs_ma = None
        except Exception:
            rsi = ema_slope = macd_strength = vol_vs_ma = None

        # Determine broad trend label and textual advice
        try:
            trend = 'MIXED'
            adv = []
            # simple trend logic: EMA trend + MACD sign
            if (ema50 is not None and ema200 is not None and ema50 > ema200) and (macd is not None and macd > macd_signal):
                trend = 'BULL'
            elif (ema50 is not None and ema200 is not None and ema50 < ema200) and (macd is not None and macd < macd_signal):
                trend = 'BEAR'
            else:
                trend = 'MIXED'

            # Advice bullets (emit as code + fallback text for translation friendly output)
            adv_objs = []
            def_adv = []
            if trend == 'BULL':
                adv_objs.append({'code': 'advice_trend_bull', 'text': 'Trend is bullish on the selected timeframe.'})
                def_adv.append('Trend is bullish on the selected timeframe.')
                if rsi is not None and rsi > 70:
                    adv_objs.append({'code': 'advice_rsi_high', 'text': 'RSI high -> consider risk of short-term pullback.'})
                    def_adv.append('RSI high -> consider risk of short-term pullback.')
                if atr is not None and close:
                    if (atr/close) > 0.1:
                        adv_objs.append({'code': 'advice_high_volatility', 'text': 'High volatility detected; prefer smaller position sizes.'})
                        def_adv.append('High volatility detected; prefer smaller position sizes.')
            elif trend == 'BEAR':
                adv_objs.append({'code': 'advice_trend_bear', 'text': 'Trend is bearish. Prefer wait-or-short strategies.'})
                def_adv.append('Trend is bearish. Prefer wait-or-short strategies.')
                if rsi is not None and rsi < 30:
                    adv_objs.append({'code': 'advice_rsi_oversold', 'text': 'RSI oversold -> short-term bounce possible.'})
                    def_adv.append('RSI oversold -> short-term bounce possible.')
            else:
                adv_objs.append({'code': 'advice_mixed', 'text': 'Market mixed: consider waiting for clearer confirmation or use reduced size.'})
                def_adv.append('Market mixed: consider waiting for clearer confirmation or use reduced size.')

            # Volume note
            if vol_vs_ma is not None and vol_vs_ma > 0.5:
                adv_objs.append({'code': 'advice_volume_high', 'text': 'Volume is above recent average — move has momentum.'})
                def_adv.append('Volume is above recent average — move has momentum.')
            elif vol_vs_ma is not None and vol_vs_ma < -0.5:
                adv_objs.append({'code': 'advice_volume_low', 'text': 'Volume is well below recent average — move lacks conviction.'})
                def_adv.append('Volume is well below recent average — move lacks conviction.')

            # Position sizing suggestion based on score and volatility
            pos = 'normal'
            try:
                if score >= 75 and (atr is None or (atr/close if close else 0) < 0.05): pos = 'aggressive'
                if score < 40 or (atr is not None and close and (atr/close) > 0.15): pos = 'light'
            except Exception:
                pos = 'normal'
        except Exception:
            trend = 'MIXED'; adv = ['No advice available']; pos = 'normal'

        # Suggested price levels based on ATR (conservative multipliers)
        try:
            suggested = None
            if atr is not None and close:
                # Use ATR multiples: SL distance = 1.5 * ATR, TP distance = 3 * ATR
                sl_dist = 1.5 * atr
                tp_dist = 3.0 * atr
                if trend == 'BULL' or signal == 'BUY':
                    entry = close
                    sl = max(0.0, entry - sl_dist)
                    tp = entry + tp_dist
                elif trend == 'BEAR' or signal == 'SELL':
                    entry = close
                    sl = entry + sl_dist
                    tp = max(0.0, entry - tp_dist)
                else:
                    entry = close
                    sl = max(0.0, entry - sl_dist)
                    tp = entry + tp_dist
                # position risk estimate: % of capital to risk per trade (very simple mapping)
                risk_pct = 1.0
                if score >= 80: risk_pct = 3.0
                elif score >= 60: risk_pct = 2.0
                elif score < 40: risk_pct = 0.5
                suggested = {
                    'entry': entry,
                    'sl': sl,
                    'tp': tp,
                    'sl_dist': sl_dist,
                    'tp_dist': tp_dist,
                    'risk_pct': risk_pct
                }
        except Exception:
            suggested = None

        # Build structured recommendation: action, entry zone, SL, multiple TPs, explanation
        try:
            recommendation = None
            # default: wait/no-action
            rec_action = 'wait'
            rec_entry = None
            rec_entry_zone = None
            rec_sl = None
            rec_tps = []
            rec_risk_pct = suggested['risk_pct'] if isinstance(suggested, dict) and 'risk_pct' in suggested else 1.0

            # Weighted confirmation: EMA=2, MACD=2, RSI=1, Volume=1
            try:
                w_ema = 2
                w_macd = 2
                w_rsi = 1
                w_vol = 1

                vote_ema = 1 if (ema50 is not None and ema200 is not None and ema50 > ema200) else 0
                vote_macd = 1 if (macd is not None and macd_signal is not None and macd > macd_signal and macd_strength and macd_strength > 0.00005) else 0
                vote_rsi = 1 if (rsi is not None and rsi > 50 and rsi < 80) else 0
                vote_vol = 1 if (vol_vs_ma is not None and vol_vs_ma > 0.05) else 0

                bull_weight = (vote_ema * w_ema) + (vote_macd * w_macd) + (vote_rsi * w_rsi) + (vote_vol * w_vol)

                vote_ema_b = 1 if (ema50 is not None and ema200 is not None and ema50 < ema200) else 0
                vote_macd_b = 1 if (macd is not None and macd_signal is not None and macd < macd_signal and macd_strength and macd_strength > 0.00005) else 0
                vote_rsi_b = 1 if (rsi is not None and rsi < 50 and rsi > 20) else 0
                vote_vol_b = 1 if (vol_vs_ma is not None and vol_vs_ma < -0.05) else 0
                bear_weight = (vote_ema_b * w_ema) + (vote_macd_b * w_macd) + (vote_rsi_b * w_rsi) + (vote_vol_b * w_vol)
            except Exception:
                bull_weight = bear_weight = 0

            # require HTF alignment (don't enter against a clear higher-timeframe bias)
            htf_allows_bull = True
            htf_allows_bear = True
            try:
                if isinstance(ht_bias, dict):
                    for v in ht_bias.values():
                        if v == 'BEAR': htf_allows_bull = False
                        if v == 'BULL': htf_allows_bear = False
            except Exception:
                pass

            # Weighted threshold: require >=3 points (EMA+anything else OR MACD+something)
            strong_bull = (bull_weight >= 3 and score >= 50 and htf_allows_bull)
            strong_bear = (bear_weight >= 3 and score >= 50 and htf_allows_bear)

            if strong_bull:
                rec_action = 'enter_long'
                # propose entry zone slightly below current price to avoid immediate weakness
                entry_center = close
                zone_down = max(0.0, entry_center - 0.5 * atr) if atr else entry_center
                zone_up = entry_center + (0.2 * atr) if atr else entry_center
                rec_entry_zone = [zone_down, zone_up]
                rec_entry = entry_center
                # SL and multi TP levels (conservative: TP1=1*atr, TP2=2*atr, TP3=3*atr)
                if atr:
                    rec_sl = max(0.0, entry_center - 1.5 * atr)
                    rec_tps = [entry_center + 1.0 * atr, entry_center + 2.0 * atr, entry_center + 3.0 * atr]
                else:
                    rec_sl = max(0.0, entry_center * (1 - CONFIG.get('sl_pct', 0.03)))
                    rec_tps = [entry_center * (1 + CONFIG.get('tp_pct', 0.05))]

            elif strong_bear:
                rec_action = 'enter_short'
                entry_center = close
                zone_up = entry_center + (0.5 * atr) if atr else entry_center
                zone_down = max(0.0, entry_center - (0.2 * atr)) if atr else entry_center
                rec_entry_zone = [zone_down, zone_up]
                rec_entry = entry_center
                if atr:
                    rec_sl = entry_center + 1.5 * atr
                    rec_tps = [entry_center - 1.0 * atr, entry_center - 2.0 * atr, entry_center - 3.0 * atr]
                else:
                    rec_sl = entry_center * (1 + CONFIG.get('sl_pct', 0.03))
                    rec_tps = [entry_center * (1 - CONFIG.get('tp_pct', 0.05))]

            else:
                # If mixed or low score but some entry possible, propose conservative approach
                if score >= 50 and atr is not None:
                    rec_action = 'consider_enter'
                    rec_entry = close
                    rec_entry_zone = [max(0.0, close - 0.5 * atr), close + 0.5 * atr]
                    rec_sl = max(0.0, close - 2.0 * atr)
                    rec_tps = [close + 1.0 * atr]
                else:
                    rec_action = 'wait'

            # human explanation lines (short) plus stable explain codes for translation
            rec_explain = []
            rec_explain_codes = []
            if rec_action in ('enter_long','enter_short','consider_enter'):
                # action code
                rec_explain_codes.append({'code': f're_ex_action_{rec_action}', 'text': f'Action: {rec_action}', 'vars': {'action': rec_action}})
                rec_explain.append(f"Action: {rec_action}")
                if rec_entry is not None:
                    rec_explain_codes.append({'code': 're_ex_entry', 'text': f'Entry: {round(rec_entry, 8)}', 'vars': {'val': round(rec_entry,8)}})
                    rec_explain.append(f"Entry: {round(rec_entry, 8)}")
                if rec_entry_zone is not None:
                    rec_explain_codes.append({'code': 're_ex_entry_zone', 'text': f'Entry zone: {round(rec_entry_zone[0],8)} - {round(rec_entry_zone[1],8)}', 'vars': {'low': round(rec_entry_zone[0],8), 'high': round(rec_entry_zone[1],8)}})
                    rec_explain.append(f"Entry zone: {round(rec_entry_zone[0],8)} - {round(rec_entry_zone[1],8)}")
                if rec_sl is not None:
                    rec_explain_codes.append({'code': 're_ex_sl', 'text': f'SL: {round(rec_sl,8)}', 'vars': {'val': round(rec_sl,8)}})
                    rec_explain.append(f"SL: {round(rec_sl,8)}")
                if rec_tps:
                    rec_explain_codes.append({'code': 're_ex_tps', 'text': 'TPs: ' + ", ".join([str(round(x,8)) for x in rec_tps]), 'vars': {'vals': ", ".join([str(round(x,8)) for x in rec_tps])}})
                    rec_explain.append("TPs: " + ", ".join([str(round(x,8)) for x in rec_tps]))
                rec_explain_codes.append({'code': 're_ex_risk', 'text': f'Position risk%: {rec_risk_pct}%', 'vars': {'pct': rec_risk_pct}})
                rec_explain.append(f"Position risk%: {rec_risk_pct}%")
            else:
                rec_explain_codes.append({'code': 're_ex_no_setup', 'text': 'No clear setup — consider waiting or reducing size', 'vars': {}})
                rec_explain.append('No clear setup — consider waiting or reducing size')

            recommendation = {
                'action': rec_action,
                'entry': rec_entry,
                'entry_zone': rec_entry_zone,
                'sl': rec_sl,
                'tps': rec_tps,
                'risk_pct': rec_risk_pct,
                'explain': rec_explain,
                'explain_codes': rec_explain_codes
            }
        except Exception:
            recommendation = None

        # Multi-timeframe bias (try 1h and 4h if possible)
        try:
            ht_bias = {}
            for tf in ['1h', '4h']:
                try:
                    ohl = public_exchange.fetch_ohlcv(symbol, tf, limit=200)
                    dfo = pd.DataFrame(ohl, columns=["time","open","high","low","close","volume"])
                    dfo['close'] = dfo['close'].astype(float)
                    if len(dfo) >= 50:
                        e50 = ta.trend.EMAIndicator(dfo['close'], 50).ema_indicator().iloc[-1]
                        e200 = ta.trend.EMAIndicator(dfo['close'], 200).ema_indicator().iloc[-1] if len(dfo) >= 200 else None
                        macdo = ta.trend.MACD(dfo['close'])
                        macd_val = macdo.macd().iloc[-1]
                        macd_sig = macdo.macd_signal().iloc[-1]
                        if e50 is not None and e200 is not None and e50 > e200 and macd_val is not None and macd_val > macd_sig:
                            ht_bias[tf] = 'BULL'
                        elif e50 is not None and e200 is not None and e50 < e200 and macd_val is not None and macd_val < macd_sig:
                            ht_bias[tf] = 'BEAR'
                        else:
                            ht_bias[tf] = 'MIXED'
                    else:
                        ht_bias[tf] = 'UNKNOWN'
                except Exception:
                    ht_bias[tf] = 'UNKNOWN'
        except Exception:
            ht_bias = {'1h':'UNKNOWN','4h':'UNKNOWN'}

        # small unicode sparkline for recent closes (no extra deps)
        try:
            def make_sparkline(series, length=30):
                chars = ['▁','▂','▃','▄','▅','▆','▇','█']
                s = list(series[-length:]) if len(series) >= 1 else list(series)
                if len(s) == 0:
                    return ''
                mn = min(s)
                mx = max(s)
                if mx == mn:
                    return ''.join([chars[0] for _ in s])
                out = []
                for v in s:
                    # normalize 0..1
                    t = (v - mn) / (mx - mn)
                    idx = int(round(t * (len(chars)-1)))
                    out.append(chars[max(0,min(len(chars)-1, idx))])
                return ''.join(out)
            spark = make_sparkline(list(df['close'].astype(float)), length=30)
        except Exception:
            spark = ''

        # short textual rationale
        rationale = []
        try:
            if ema50 is not None and ema200 is not None:
                rationale.append('EMA50>EMA200' if ema50 > ema200 else 'EMA50<EMA200')
            if macd is not None and macd_signal is not None:
                rationale.append('MACD>Signal' if macd > macd_signal else 'MACD<Signal')
            if stoch is not None:
                rationale.append(f'StochRSI={round(stoch,3)}')
            if atr is not None and close:
                rationale.append('ATR%=' + str(round((atr/close)*100,2)) + '%')
            if vol_change is not None:
                rationale.append('VolΔ=' + str(round(vol_change*100,2)) + '%')
        except Exception:
            pass

        # Prepare final advice text fallback
        final_advice_texts = def_adv if (('def_adv' in locals()) and def_adv) else (adv if ('adv' in locals()) else [])

        return {
            'symbol': symbol,
            'timeframe': CONFIG.get('timeframe'),
            'bars': len(df),
            'signal': signal,
            'score': score,
            'rationale': rationale,
            'indicators': {
                'EMA50': ema50,
                'EMA200': ema200,
                'EMA_diff': (ema50 - ema200) if (ema50 is not None and ema200 is not None) else None,
                'MACD': macd,
                'MACD_signal': macd_signal,
                'MACD_hist': macd_hist,
                'StochRSI': stoch
            },
            'atr': float(atr) if atr is not None else None,
            'atr_pct': (float(atr)/close) if (atr is not None and close) else None,
            'close': close,
            'prev_close': prev_close,
            'close_change': close_change,
            'volume': vol,
            'prev_volume': prev_vol,
            'volume_change': vol_change,
            'ts': int(df['time'].iloc[-1]) if 'time' in df.columns else None
            ,
            'rsi': rsi,
            'ema_slope': ema_slope,
            'macd_strength': macd_strength,
            'vol_vs_ma': vol_vs_ma,
            'trend': trend,
            'advice': final_advice_texts,
            'advice_codes': adv_objs if ('adv_objs' in locals()) else [],
            'position_sizing': pos,
            'suggested': suggested,
            'recommendation': recommendation
            ,
            'votes': {
                'vote_ema': int(vote_ema) if 'vote_ema' in locals() else None,
                'vote_macd': int(vote_macd) if 'vote_macd' in locals() else None,
                'vote_rsi': int(vote_rsi) if 'vote_rsi' in locals() else None,
                'vote_vol': int(vote_vol) if 'vote_vol' in locals() else None,
                'bull_weight': float(bull_weight) if 'bull_weight' in locals() else None,
                'bear_weight': float(bear_weight) if 'bear_weight' in locals() else None,
                'htf_allows_bull': bool(htf_allows_bull) if 'htf_allows_bull' in locals() else None,
                'htf_allows_bear': bool(htf_allows_bear) if 'htf_allows_bear' in locals() else None
            },
            'higher_timeframe_bias': ht_bias
        }
    except Exception as e:
        return { 'error': str(e), 'symbol': symbol }


def _cli_analyze():
    import argparse, json
    p = argparse.ArgumentParser()
    p.add_argument('--analyze', help='Symbol to analyze', required=True)
    args = p.parse_args()
    out = analyze_symbol(args.analyze)
    print(json.dumps(out))


if __name__ == '__main__':
    # preserve previous behavior when running without args
    import sys
    if len(sys.argv) > 1:
        # if --analyze used, run CLI analyze
        if '--analyze' in sys.argv:
            _cli_analyze()
            sys.exit(0)
