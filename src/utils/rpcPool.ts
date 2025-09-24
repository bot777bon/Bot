import { Connection } from '@solana/web3.js';

// Simple in-memory RPC pool with round-robin selection and temporary backoff on failures.
// Parses environment variables and constructs endpoints from API keys when needed.
// Supported env vars (in priority order):
// - HELIUS_RPC_URLS (comma-separated full urls)
// - HELIUS_API_KEYS (comma-separated keys -> constructed as https://mainnet.helius-rpc.com/?api-key=KEY)
// - HELIUS_RPC_URL, HELIUS_RPC_URL_2, HELIUS_FAST_RPC_URL_2, HELIUS_RPC_URL_3
// - SOLANA_RPC_URL (full url)
// - SOLANA_API_KEY (construct mainnet endpoint if SOLANA_RPC_URL missing)
// - RPC_URL
// - MAINNET_RPC

const DEFAULT_MAINNET = 'https://api.mainnet-beta.solana.com';

function parseEnvUrls(): string[] {
  const env = process.env;
  const list: string[] = [];

  // If the process.env doesn't include the expected vars (scripts may not load .env),
  // attempt to read the repository .env file and parse missing keys.
  let fileEnv: Record<string,string>|null = null;
  try {
    if (!env.HELIUS_API_KEYS || !env.HELIUS_RPC_URLS) {
      const fs = require('fs');
      const path = require('path');
      const p = path.join(process.cwd(), '.env');
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed: Record<string,string> = {};
        raw.split(/\r?\n/).forEach((line: string) => {
          const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
          if (!m) return;
          let key = m[1];
          let val = m[2] || '';
          // strip surrounding quotes
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          parsed[key] = val;
        });
        fileEnv = parsed;
      }
    }
  } catch (e) {
    // ignore file read errors
    fileEnv = null;
  }

  // 1) Explicit Helius RPC URLs (comma-separated)
  const helUrls = env.HELIUS_RPC_URLS || env.HELIUS_RPC_URLS_RAW;
  if (helUrls) {
    helUrls.split(',').map(s => s.trim()).filter(Boolean).forEach(u => list.push(u));
  }

  // 2) Construct Helius URLs from HELIUS_API_KEYS if provided
  const helKeys = env.HELIUS_API_KEYS || env.HELIUS_API_KEY || (fileEnv && (fileEnv.HELIUS_API_KEYS || fileEnv.HELIUS_API_KEY));
  if (helKeys) {
    helKeys.toString().split(',').map(s => s.trim()).filter(Boolean).forEach(k => {
      const url = `https://mainnet.helius-rpc.com/?api-key=${k}`;
      if (!list.includes(url)) list.push(url);
    });
  }

  // 3) Add any explicit single Helius URL envs
  [env.HELIUS_RPC_URL, env.HELIUS_FAST_RPC_URL_2, env.HELIUS_RPC_URL_2, env.HELIUS_WEBSOCKET_URL, env.HELIUS_WEBSOCKET_URL_2, (fileEnv && fileEnv.HELIUS_RPC_URL), (fileEnv && fileEnv.HELIUS_FAST_RPC_URL_2), (fileEnv && fileEnv.HELIUS_RPC_URL_2)].forEach(u => {
    if (u && !list.includes(u)) list.push(u);
  });

  // 4) SOLANA_RPC_URL or construct from SOLANA_API_KEY
  const solRpc = env.SOLANA_RPC_URL || (fileEnv && fileEnv.SOLANA_RPC_URL);
  const solKey = env.SOLANA_API_KEY || (fileEnv && fileEnv.SOLANA_API_KEY);
  if (solRpc && !list.includes(solRpc)) list.push(solRpc);
  if (!solRpc && solKey) {
    const solUrl = `https://api.mainnet-beta.solana.com/?api-key=${solKey}`;
    if (!list.includes(solUrl)) list.push(solUrl);
  }

  // 5) Generic RPC_URL, MAINNET_RPC
  [env.RPC_URL, env.SOLANA_API_URL, env.MAINNET_RPC, (fileEnv && fileEnv.RPC_URL), (fileEnv && fileEnv.MAINNET_RPC)].forEach(u => {
    if (u && !list.includes(u)) list.push(u);
  });

  // Ensure at least the default mainnet RPC appears
  if (!list.includes(DEFAULT_MAINNET)) list.push(DEFAULT_MAINNET);

    const httpOnly = list.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u));
    const dropped = list.filter(u => typeof u === 'string' && !/^https?:\/\//i.test(u));
    if (dropped && dropped.length) {
      // do not throw; just log to console for diagnostics in dev runs
      try { console.warn('[rpcPool] dropping non-http(s) endpoints from candidates:', dropped); } catch (e) {}
    }

  // dedupe while preserving order
  return httpOnly.filter((v, i, a) => v && a.indexOf(v) === i) as string[];
}

const urls = parseEnvUrls();
let idx = 0;
const failureCounts = new Map<string, number>();
const blacklistUntil = new Map<string, number>();
let lastUsedUrl: string | null = null;
// health score: lower is better; maintains recency of successes/fails
const lastSuccess = new Map<string, number>();
const lastFailure = new Map<string, number>();
const lastFailureReason = new Map<string, string>();

function nowMs() { return Date.now(); }

export function getRpcCandidates(): string[] {
  return urls.slice();
}

export function getHealthyCandidates(): string[] {
  // sort by failureCounts, then lastSuccess recency
  return urls.slice().sort((a, b) => {
    const fa = failureCounts.get(a) || 0;
    const fb = failureCounts.get(b) || 0;
    if (fa !== fb) return fa - fb;
    const sa = lastSuccess.get(a) || 0;
    const sb = lastSuccess.get(b) || 0;
    return sb - sa; // prefer more recent success
  });
}

export function getNextRpcUrl(): string {
  const len = urls.length;
  if (len === 0) return DEFAULT_MAINNET;
  // prefer healthy candidates first
  const candidates = getHealthyCandidates();
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[(idx++) % candidates.length];
    const until = blacklistUntil.get(candidate) || 0;
    if (until > nowMs()) {
      // currently backoff, skip
      continue;
    }
    lastUsedUrl = candidate;
    return candidate;
  }
  // all blacklisted; return next anyway
  const candidate = urls[(idx++) % len];
  lastUsedUrl = candidate;
  return candidate;
}

export function getLastUsedUrl(): string | null {
  return lastUsedUrl;
}

export function markFailure(url: string) {
  if (!url) return;
  const prev = failureCounts.get(url) || 0;
  const next = prev + 1;
  failureCounts.set(url, next);
  lastFailure.set(url, nowMs());
  try { console.warn(`[rpcPool] markFailure ${url} count=${next}`); } catch (e) {}
  // Backoff threshold: 3 failures -> temporary blacklist for 60s
  if (next >= 3) {
    // increase backoff with further failures
    const extra = Math.min(5, next - 3);
    const base = 60_000; // 1 minute base
    const backoff = base * (1 + extra);
    blacklistUntil.set(url, nowMs() + backoff);
  }
}

export function markFailureWithReason(url: string, reason?: string) {
  if (!url) return;
  if (reason) {
    lastFailureReason.set(url, String(reason).slice(0, 1000));
  }
  markFailure(url);
  try { console.warn(`[rpcPool] markFailureWithReason ${url} reason=${String(reason)}`); } catch (e) {}
}

export function markSuccess(url: string) {
  if (!url) return;
  failureCounts.set(url, 0);
  blacklistUntil.delete(url);
  lastSuccess.set(url, nowMs());
  lastFailureReason.delete(url);
}

export function getLastFailureReason(url: string) {
  return lastFailureReason.get(url) || null;
}

export function getRpcConnection(preferUrl?: string): Connection {
  const url = preferUrl || getNextRpcUrl();
  lastUsedUrl = url;
  // Use confirmed by default but allow callers to pass different commitment via options later if needed
  return new Connection(url, { commitment: 'confirmed' } as any);
}

export default {
  getRpcCandidates,
  getNextRpcUrl,
  getLastUsedUrl,
  markFailure,
  markSuccess,
  getRpcConnection,
};

(module.exports as any).getHealthyCandidates = getHealthyCandidates;
(module.exports as any).markFailureWithReason = markFailureWithReason;
(module.exports as any).getLastFailureReason = getLastFailureReason;
