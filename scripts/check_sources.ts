import rpcPool from '../src/utils/rpcPool';
import fetch from 'node-fetch';
import { Connection } from '@solana/web3.js';

function maskUrl(u: string) {
  try {
    const url = new URL(u);
    // hide query params
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch (e) {
    return u.replace(/(.{10}).+(.{6})/, '$1...$2');
  }
}

async function testRpc(url: string) {
  const conn = rpcPool.getRpcConnection(url);
  const start = Date.now();
  try {
    const p = conn.getVersion();
    const res = await Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ]);
    return { ok: true, latencyMs: Date.now() - start, info: (res as any).solana_core ? (res as any) : res };
  } catch (e: any) {
    return { ok: false, latencyMs: Date.now() - start, error: e.message || String(e) };
  }
}

async function testJupiter() {
  const url = process.env.JUPITER_QUOTE_API || 'https://quote-api.jup.ag/v6/quote';
  const q = `${url}?inputMint=So11111111111111111111111111111111111111112&outputMint=So11111111111111111111111111111111111111112&amount=1000000000`;
  const start = Date.now();
  try {
    const r = await Promise.race([
      fetch(q, { method: 'GET' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ]) as any;
    return { ok: true, status: r.status, latencyMs: Date.now() - start };
  } catch (e: any) {
    return { ok: false, latencyMs: Date.now() - start, error: e.message || String(e) };
  }
}

async function testSolscan() {
  const url = process.env.SOLSCAN_API_URL || 'https://public-api.solscan.io';
  const start = Date.now();
  try {
    const r = await Promise.race([
      fetch(url, { method: 'GET' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ]) as any;
    return { ok: true, status: r.status, latencyMs: Date.now() - start };
  } catch (e: any) {
    return { ok: false, latencyMs: Date.now() - start, error: e.message || String(e) };
  }
}

async function main() {
  console.log('Checking RPC candidates from rpcPool...');
  const candidates = rpcPool.getRpcCandidates();
  for (const c of candidates) {
    const masked = maskUrl(c.toString());
    process.stdout.write(`- Testing ${masked} ... `);
    const res = await testRpc(c);
    if (res.ok) {
      console.log(`OK (${res.latencyMs} ms)`);
    } else {
      console.log(`FAIL (${res.latencyMs} ms) - ${res.error}`);
    }
  }

  console.log('\nChecking Jupiter quote endpoint...');
  const jres = await testJupiter();
  if (jres.ok) console.log(`Jupiter OK status=${jres.status} latency=${jres.latencyMs}ms`);
  else console.log(`Jupiter FAIL latency=${jres.latencyMs}ms error=${jres.error}`);

  console.log('\nChecking Solscan endpoint...');
  const sres = await testSolscan();
  if (sres.ok) console.log(`Solscan OK status=${sres.status} latency=${sres.latencyMs}ms`);
  else console.log(`Solscan FAIL latency=${sres.latencyMs}ms error=${sres.error}`);
}

main().catch(e => { console.error('check_sources error:', e); process.exit(1); });
