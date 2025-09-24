import axios from 'axios';
import rpcPool from '../src/utils/rpcPool';

async function test() {
  const cands = rpcPool.getRpcCandidates();
  console.log('RPC candidates:', cands.length);
  for (const u of cands) {
    try {
      const start = Date.now();
      const res = await axios.post(u, { jsonrpc: '2.0', id: 1, method: 'getVersion', params: [] }, { timeout: 5000 });
      console.log(`OK    | ${Date.now() - start}ms | ${u} | status=${res.status}`);
    } catch (err: any) {
      const status = err && err.response && err.response.status ? err.response.status : 'N/A';
      const data = err && err.response && err.response.data ? JSON.stringify(err.response.data) : (err && err.message ? err.message : String(err));
      console.log(`ERROR | ${status}    | ${u} | ${data}`);
    }
  }
}

test().catch(e => { console.error('debug script failed', e); process.exit(1); });
