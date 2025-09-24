import rpcPool from '../src/utils/rpcPool';

async function main() {
  console.log('RPC candidates:', rpcPool.getRpcCandidates());
  const urls: string[] = [];
  // pick 5 selections
  for (let i = 0; i < 5; i++) {
    const url = rpcPool.getNextRpcUrl();
    urls.push(url);
  }
  console.log('Next 5 urls:', urls);
  const testUrl = urls[0];
  console.log('Marking failures on', testUrl);
  rpcPool.markFailure(testUrl);
  rpcPool.markFailure(testUrl);
  rpcPool.markFailure(testUrl);
  console.log('After failures, next url:', rpcPool.getNextRpcUrl());
  console.log('BlacklistUntil for testUrl should be set. LastUsed:', rpcPool.getLastUsedUrl());
  // mark success to clear
  rpcPool.markSuccess(testUrl);
  console.log('After markSuccess, next url:', rpcPool.getNextRpcUrl());
}

main().catch(e => { console.error(e); process.exit(1); });
