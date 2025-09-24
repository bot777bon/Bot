#!/usr/bin/env ts-node
require('dotenv').config();

/**
 * Continuous preflight -> live runner
 * - Collect fresh mints one-by-one
 * - Run simulate-only preflight for each mint
 * - If simulation passes, perform live buy immediately
 * - Skip failed sims quickly and continue until TARGET_BUYS achieved
 */
async function main(){
  try{
    const sniperMod = require('../sniper');
    if(!sniperMod || typeof sniperMod.collectFreshMints !== 'function'){
      console.error('sniper.collectFreshMints not available'); process.exit(1);
    }
    const users = require('../users.json');
    const uid = Object.keys(users)[0];
    const user = users[uid];
    if(!user){ console.error('No user found'); process.exit(2); }

  const TARGET_BUYS = Number(process.env.TARGET_BUYS || 1);
  const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 50);
  const MAX_SEND_ATTEMPTS = Number(process.env.MAX_SEND_ATTEMPTS || 3);
  let DRY_RUN_MODE = (String(process.env.DRY_RUN_MODE || 'true').toLowerCase() === 'true');
  // Safety: require explicit confirmation to enable live broadcasts
  const CONFIRM_LIVE = String(process.env.CONFIRM_LIVE || 'false').toLowerCase() === 'true';
  if (!DRY_RUN_MODE && !CONFIRM_LIVE) {
    console.warn('[safety] LIVE trades requested but CONFIRM_LIVE!=true — forcing DRY_RUN_MODE to avoid accidental fees');
    DRY_RUN_MODE = true;
  }
    const perCollectTimeoutMs = Number(process.env.COLLECT_TIMEOUT_MS || 20000);

    console.log('Starting continuous preflight->live for user', uid, 'target buys=', TARGET_BUYS);

    const { autoExecuteStrategyForUser } = await import('../src/autoStrategyExecutor');
    const rpcPool = require('../src/utils/rpcPool').default;
    const conn = rpcPool.getRpcConnection();

  let buysDone = 0;
    let attempts = 0;
  // track processed mints and per-mint attempt counters to avoid repeated wasted work
  const processedMints = new Set<string>();
  const perMintAttempts: Map<string, { simAttempts: number; liveAttempts: number }> = new Map();

  const MAX_SIM_ATTEMPTS_PER_MINT = Number(process.env.MAX_SIM_ATTEMPTS_PER_MINT || 3);

    while(buysDone < TARGET_BUYS && attempts < MAX_ATTEMPTS){
      attempts++;
      console.log('\n[loop] attempt', attempts, 'buysDone', buysDone, '/', TARGET_BUYS);
      // Collect a single fresh mint (blocks up to timeout)
      let collected: any[] = [];
      try{
        collected = await sniperMod.collectFreshMints({ maxCollect: 1, timeoutMs: perCollectTimeoutMs });
      }catch(e){ console.warn('[loop] collectFreshMints failed:', String(e)); }
      if(!collected || collected.length===0){ console.log('[loop] no mints collected this cycle, continuing'); continue; }
      const tok = collected[0];
      const mint = tok.mint || tok.tokenAddress || tok.address || tok;
      if(processedMints.has(mint)){
        console.log('[loop] mint already processed, skipping:', mint); continue;
      }
      const counters = perMintAttempts.get(mint) || { simAttempts: 0, liveAttempts: 0 };
      perMintAttempts.set(mint, counters);
      console.log('[loop] collected mint=', mint);

      // Build token object
      const tokenObj = {
        mint,
        createdAt: tok.firstBlockTime || tok.firstBlock || null,
        ageMinutes: tok._canonicalAgeSeconds ? (tok._canonicalAgeSeconds/60) : null,
        __listenerCollected: true,
      };

    // 1) Simulation (dry-run)
  process.env.LIVE_TRADES = 'false';
  console.log('[loop] running initial simulation for', mint, 'simAttempts=', counters.simAttempts);
    let simRes: any[] = [];
      // Simulation with lightweight 429/backoff handling
      try{
        simRes = await autoExecuteStrategyForUser(user, [tokenObj], 'buy', { simulateOnly: true, listenerBypass: true });
      }catch(e){
        const es = String(e || '');
        console.warn('[loop] simulation error for', mint, es);
        // exponential backoff for 429s
        if(es.includes('429') || es.toLowerCase().includes('too many requests')){
          counters.simAttempts = (counters.simAttempts || 0) + 1;
          perMintAttempts.set(mint, counters);
          const back = Math.min(60000, 500 * Math.pow(2, Math.min(counters.simAttempts, 6)));
          console.warn('[loop] detected 429 rate-limit during simulation — backing off for', back, 'ms');
          await new Promise(r=>setTimeout(r, back));
          continue;
        }
        // non-retryable simulation error, mark as processed to avoid repeated failures
        console.warn('[loop] non-rate-limit simulation error — marking mint processed to avoid loops');
        processedMints.add(mint);
        continue;
      }
      console.log('[loop] simulation result:', JSON.stringify(simRes));

      const passed = Array.isArray(simRes) && simRes.length>0 && simRes[0] && simRes[0].result && (simRes[0].result.success === true || (simRes[0].result.tx && String(simRes[0].result.tx).startsWith('DRY-RUN')));
      if(!passed){
        console.log('[loop] initial simulation failed or no route for', mint, '- skipping quickly');
        // count a simulation attempt and possibly mark processed if too many sims
        counters.simAttempts = (counters.simAttempts || 0) + 1;
        perMintAttempts.set(mint, counters);
        if(counters.simAttempts >= MAX_SIM_ATTEMPTS_PER_MINT){
          console.log('[loop] reached max sim attempts for', mint, '- marking processed');
          processedMints.add(mint);
        }
        continue;
      }

      // Double-check: re-run a quick simulation immediately before live send to avoid stale quotes
      console.log('[loop] re-running quick simulation to confirm stability for', mint);
      let confirmSim: any[] = [];
      try{
        confirmSim = await autoExecuteStrategyForUser(user, [tokenObj], 'buy', { simulateOnly: true, listenerBypass: true });
      }catch(e){
        const es = String(e || '');
        console.warn('[loop] confirm simulation error for', mint, es);
        if(es.includes('429') || es.toLowerCase().includes('too many requests')){
          counters.simAttempts = (counters.simAttempts || 0) + 1;
          perMintAttempts.set(mint, counters);
          const back = Math.min(60000, 500 * Math.pow(2, Math.min(counters.simAttempts, 6)));
          console.warn('[loop] detected 429 during confirm simulation — backing off for', back, 'ms');
          await new Promise(r=>setTimeout(r, back));
          continue;
        }
        console.warn('[loop] confirm simulation non-rate-limit error — marking mint processed');
        processedMints.add(mint);
        continue;
      }
      const confirmPassed = Array.isArray(confirmSim) && confirmSim.length>0 && confirmSim[0] && confirmSim[0].result && (confirmSim[0].result.success === true || (confirmSim[0].result.tx && String(confirmSim[0].result.tx).startsWith('DRY-RUN')));
      if(!confirmPassed){
        console.log('[loop] confirm simulation failed for', mint, '- skipping');
        counters.simAttempts = (counters.simAttempts || 0) + 1;
        perMintAttempts.set(mint, counters);
        if(counters.simAttempts >= MAX_SIM_ATTEMPTS_PER_MINT){ processedMints.add(mint); }
        continue;
      }

      // 2) If passed, perform live buy (skip if already bought during immediate follow-up)
      // 2) If passed, perform live buy
      let liveRes: any[] = [];
      const wasImmediate = Array.isArray(confirmSim) && confirmSim.some((s:any)=>s && s.immediateLive && s.token === mint);
      if(wasImmediate){
        console.log('[loop] token was already bought during immediate live follow-up in simulation step — marking processed and skipping live send');
        processedMints.add(mint);
        continue;
      }
      if(DRY_RUN_MODE){
        console.log('[loop] DRY_RUN_MODE=true — skipping actual broadcast, will run simulated execution as final check');
        try{ liveRes = await autoExecuteStrategyForUser(user, [tokenObj], 'buy', { simulateOnly: true, listenerBypass: true }); }catch(e){ console.error('[loop] dry-run final simulate error', String(e)); }
        // do not mark mint processed just because DRY_RUN succeeded; allow later live attempts
        counters.simAttempts = (counters.simAttempts || 0) + 1;
        perMintAttempts.set(mint, counters);
        if(counters.simAttempts >= MAX_SIM_ATTEMPTS_PER_MINT){
          console.log('[loop] DRY_RUN: reached max sim attempts for', mint, '- marking processed');
          processedMints.add(mint);
        }
      } else {
        if(!CONFIRM_LIVE){
          console.warn('[safety] CONFIRM_LIVE!=true — not performing live buy despite DRY_RUN_MODE=false');
          liveRes = [{ token: mint, result: { tx: null } }];
        } else {
          process.env.LIVE_TRADES = 'true';
          console.log('[loop] simulation confirmed — performing LIVE buy for', mint);
          // attempt limited number of send attempts per mint with 429/backoff handling
          let sendAttempts = 0;
          while(sendAttempts < MAX_SEND_ATTEMPTS){
            sendAttempts++;
            try{
              liveRes = await autoExecuteStrategyForUser(user, [tokenObj], 'buy', { simulateOnly: false, listenerBypass: true });
              if(Array.isArray(liveRes) && liveRes.length>0 && liveRes[0] && liveRes[0].result && liveRes[0].result.tx){ break; }
            }catch(e){
              const es = String(e || '');
              console.error('[loop] live execute error attempt', sendAttempts, 'for', mint, es);
              if(es.includes('429') || es.toLowerCase().includes('too many requests')){
                counters.liveAttempts = (counters.liveAttempts || 0) + 1;
                perMintAttempts.set(mint, counters);
                const back = Math.min(120000, 500 * Math.pow(2, Math.min(counters.liveAttempts, 8)));
                console.warn('[loop] rate limit detected during live send — backing off for', back, 'ms');
                await new Promise(r=>setTimeout(r, back));
                continue;
              }
            }
            console.log('[loop] live send attempt', sendAttempts, 'failed or returned no tx, retrying after short delay');
            await new Promise(r => setTimeout(r, 1000 + sendAttempts * 500));
          }
        }
      }
      console.log('[loop] live execution returned:', JSON.stringify(liveRes, null, 2));

      // If txid present, fetch on-chain details
      try{
        if(Array.isArray(liveRes) && liveRes.length>0){
          const r = liveRes[0];
          const txid = r && r.result && r.result.tx ? r.result.tx : null;
          if(txid && !String(txid).startsWith('DRY-RUN')){
            console.log('[loop] live txid returned:', txid);
            try{
              const tx = await conn.getTransaction(txid, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 } as any);
              if(tx){
                const err = tx.meta && tx.meta.err ? tx.meta.err : null;
                const fee = tx.meta && typeof tx.meta.fee === 'number' ? tx.meta.fee : null;
                console.log('[loop] on-chain fee (lamports):', fee, 'SOL:', fee ? fee/1e9 : 'n/a');
                if(tx.meta && tx.meta.logMessages) console.log('[loop] logs (first 20):\n', tx.meta.logMessages.slice(0,20).join('\n'));
                if(!err){
                  console.log('[loop] transaction confirmed with no error — counting as buy success for', mint);
                  buysDone++;
                } else {
                  console.warn('[loop] transaction confirmed but returned error in meta for', mint, 'err=', err);
                }
              } else {
                console.log('[loop] transaction details not yet available for', txid, '- will mark mint processed to avoid reattempts');
              }
            }catch(e){
              const es = String(e || '');
              console.warn('[loop] error fetching tx details for', txid, es);
              if(es.includes('429') || es.toLowerCase().includes('too many requests')){
                console.warn('[loop] RPC rate-limit when fetching tx details — sleeping briefly');
                await new Promise(r=>setTimeout(r,3000));
              }
            } finally {
              // Mark as processed either way to avoid reprocessing the same mint
              processedMints.add(mint);
            }
          } else {
            console.log('[loop] live execution did not return on-chain tx (DRY-RUN or failure) — marking mint processed to avoid loops');
            processedMints.add(mint);
          }
        }
      }catch(e){ console.warn('[loop] failed to fetch tx details:', String(e)); processedMints.add(mint); }

      // small delay to avoid tight loop
  await new Promise(r => setTimeout(r, 800));
  // early exit if reached target
  if(buysDone >= TARGET_BUYS){ console.log('[loop] target reached, exiting main loop'); break; }
    }

    console.log('\nFinished: buysDone=', buysDone, 'attempts=', attempts);
    process.exit(0);
  }catch(e){ console.error('Script failed:', String(e)); process.exit(11); }
}

main();
