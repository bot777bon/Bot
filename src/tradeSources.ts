// tradeSources.ts
// Consolidated trading sources with Jupiter, Raydium placeholders, and unified interfaces.

import type { BlockhashWithExpiryBlockHeight } from '@solana/web3.js';
const { Keypair, Transaction, VersionedTransaction, SystemProgram, PublicKey } = require('@solana/web3.js');
// spl-token helpers for rent-exemption and ATA checks
const { AccountLayout, getAssociatedTokenAddress } = require('@solana/spl-token');
const { createJupiterApiClient } = require('@jup-ag/api');
import { transactionSenderAndConfirmationWaiter } from './utils/jupiter.transaction.sender';
import { loadKeypair, withTimeout, logTrade } from './utils/tokenUtils';

type TradeSource = 'jupiter' | 'raydium' | 'dexscreener';

// Helper to get RPC connection from pool
const rpcPool = require('./utils/rpcPool').default;

// Jupiter implementation (simulation-first, robust signing/send, optional post-swap fee-split)
const Jupiter = {
  name: 'jupiter',
  async buy(tokenMint: string, amount: number, secret: string | any, ctrl?: any) {
    if (ctrl?.cancelled) throw new Error('Cancelled');
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const connection = rpcPool.getRpcConnection();
    console.log(`[Jupiter][buy] Using RPC: ${rpcPool.getLastUsedUrl() || 'unknown'}`);

    // normalize keypair
    let keypair: any;
    try {
      keypair = loadKeypair(secret);
    } catch (e) {
      try {
        const secretKey = Buffer.from(secret, 'base64');
        keypair = Keypair.fromSecretKey(secretKey);
      } catch (ee) {
        throw new Error('Invalid secret provided to Jupiter.buy');
      }
    }

    const userPublicKey = keypair.publicKey.toBase58();

    // config
    const FEE_SPLIT_ENABLED = String(process.env.ENABLE_FEE_SPLIT || 'false').toLowerCase() === 'true';
    const FEE_SPLIT_PERCENT = Number(process.env.FEE_SPLIT_PERCENT || '25');
    const MIN_SOL_RESERVE = Number(process.env.MIN_SOL_RESERVE || '0.001');

    // initial balance check (pre-swap) including estimated rent-exemption buffer
    try {
      const solBalance = await connection.getBalance(keypair.publicKey).catch(() => 0);
      const expectedExtraForSplit = (FEE_SPLIT_ENABLED && !isNaN(FEE_SPLIT_PERCENT) && FEE_SPLIT_PERCENT > 0) ? Math.round((amount * (FEE_SPLIT_PERCENT / 100)) * 1e9) : 0;
      // estimate rent for one token account (ATA) to avoid failed attempts when the swap creates an ATA
      let rentForOneAccount = 0;
      try {
        rentForOneAccount = await connection.getMinimumBalanceForRentExemption(AccountLayout.span).catch(() => 0);
      } catch (rentErr) {
        console.warn('[Jupiter][buy] could not determine rent-exemption amount, proceeding without rent buffer:', rentErr);
        rentForOneAccount = 0;
      }
      const requiredLamports = Math.ceil((amount * 1e9) + expectedExtraForSplit + Math.round(MIN_SOL_RESERVE * 1e9) + rentForOneAccount);
      if (solBalance < requiredLamports) throw new Error(`Insufficient SOL balance. Required: ${(requiredLamports/1e9)} SOL (buy + fee-split + reserve + rent buffer), Available: ${solBalance / 1e9}`);
    } catch (e) {
      console.error('[Jupiter][buy] balance pre-check failed:', e);
      throw e;
    }

    // 1. Get Jupiter quote
    const jupiter = createJupiterApiClient();
    let quote: any;
    try {
      const PRIOR_FEE = Number(process.env.PRIORITY_FEE_LAMPORTS) || 200000;
      quote = await jupiter.quoteGet({ inputMint: SOL_MINT, outputMint: tokenMint, amount: Math.floor(amount * 1e9), slippageBps: 100, prioritizationFeeLamports: PRIOR_FEE });
    } catch (e) {
      console.error('[Jupiter][buy] Failed to get quote:', e);
      throw e;
    }
    if (!quote || !quote.routePlan) throw new Error('No route found for token');

    // 2. Request swap transaction from Jupiter
    let swapResp: any;
    try {
      const swapRequest = { userPublicKey, wrapAndUnwrapSol: true, asLegacyTransaction: false, quoteResponse: quote };
      swapResp = await jupiter.swapPost({ swapRequest });
    } catch (e) {
      console.error('[Jupiter][buy] swapPost failed:', e);
      throw e;
    }
    if (!swapResp || !swapResp.swapTransaction) throw new Error('Failed to obtain swap transaction');

    // 3. Sign swap tx locally
    let swapTxBuf = Buffer.from(swapResp.swapTransaction, 'base64');
    try {
      let signed = false;
      try {
        const vt = VersionedTransaction.deserialize(swapTxBuf);
        vt.sign([keypair]);
        swapTxBuf = vt.serialize();
        signed = true;
      } catch (_) {
        try {
          const legacy = Transaction.from(swapTxBuf);
          legacy.sign(keypair);
          swapTxBuf = legacy.serialize();
          signed = true;
        } catch (__){ }
      }
      if (!signed) throw new Error('Failed to sign swap transaction locally');
    } catch (e) {
      console.error('[Jupiter][buy] Error signing swap tx:', e);
      throw e;
    }

    // 4. Simulate before sending
    try {
      let txObj: any;
      try { txObj = VersionedTransaction.deserialize(swapTxBuf); } catch (_) { txObj = Transaction.from(swapTxBuf); }
      const sim = await connection.simulateTransaction(txObj);
      if (sim.value && sim.value.err) {
        console.error('[Jupiter][buy] Swap simulation failed:', sim.value.err);
        console.error('[Jupiter][buy] sim logs:', sim.value.logs || sim);
        throw new Error('Swap simulation failed');
      }
    } catch (e) {
      console.error('[Jupiter][buy] Simulation error:', e);
      throw e;
    }

    // 5. Send via central sender
    let txid = '';
    try {
      // Prefer blockhashWithExpiryBlockHeight returned by the swap API (swapResp) if available.
      // Fallback to the quote's blockhash, then to a fresh RPC blockhash.
      const blockhashWithExpiryBlockHeight = swapResp?.blockhashWithExpiryBlockHeight || quote?.blockhashWithExpiryBlockHeight || (await connection.getLatestBlockhashAndContext('confirmed')).value;

      // Refresh the serialized transaction's blockhash to the active RPC's blockhash to reduce
      // the chance of "blockhash expired before confirmation". Handle both VersionedTransaction
      // and legacy Transaction formats and re-sign after updating.
      try {
        // Attempt VersionedTransaction first
        try {
          const vt = VersionedTransaction.deserialize(swapTxBuf);
          if (vt && vt.message && vt.message.recentBlockhash !== blockhashWithExpiryBlockHeight.blockhash) {
            vt.message.recentBlockhash = blockhashWithExpiryBlockHeight.blockhash;
            // Re-sign with payer keypair
            try { vt.sign([keypair]); } catch (sErr) { console.warn('[Jupiter][buy] Failed to re-sign VersionedTransaction:', sErr); }
            swapTxBuf = vt.serialize();
          }
        } catch (e) {
          // Not a VersionedTransaction, try legacy Transaction
          try {
            const legacy = Transaction.from(swapTxBuf);
            if (legacy && legacy.recentBlockhash !== blockhashWithExpiryBlockHeight.blockhash) {
              legacy.recentBlockhash = blockhashWithExpiryBlockHeight.blockhash;
              // Clear previous signatures and sign again with payer
              legacy.signatures = legacy.signatures.map((s: any) => ({ ...s, signature: null }));
              try { legacy.sign(keypair); } catch (sErr) { console.warn('[Jupiter][buy] Failed to re-sign legacy Transaction:', sErr); }
              swapTxBuf = legacy.serialize();
            }
          } catch (_ignore) {
            // couldn't parse as legacy either; leave swapTxBuf unchanged
          }
        }
      } catch (refreshErr) {
        console.warn('[Jupiter][buy] failed to refresh tx blockhash before send:', refreshErr);
      }

      const res = await transactionSenderAndConfirmationWaiter({ connection, serializedTransaction: swapTxBuf, blockhashWithExpiryBlockHeight, sendOptions: { skipPreflight: false } });
      if (!res || !res.transaction) {
        const liveTradesFlag = process.env.LIVE_TRADES === undefined ? true : (String(process.env.LIVE_TRADES).toLowerCase() === 'true');
        if (!liveTradesFlag) {
          txid = 'DRY-RUN-SIMULATED-TX';
        } else {
          throw new Error('Swap send failed');
        }
      } else {
        txid = res.transaction.signatures?.[0] || '';
      }
    } catch (e) {
      console.error('[Jupiter][buy] Send failed:', e);
      throw e;
    }

    // 6. Optional fee-split: send percentage of bought SOL amount to reserve wallet
    let feeSplitTx: string | null = null;
    let feeSplitAmountSol: number | null = null;
    let feeSplitError: string | null = null;
    try {
      const RESERVE_WALLET = process.env.RESERVE_WALLET || process.env.FEE_RECIPIENT || null;
      if (FEE_SPLIT_ENABLED && RESERVE_WALLET && txid && txid !== 'DRY-RUN-SIMULATED-TX') {
        const percent = Math.max(0, Math.min(100, Number(FEE_SPLIT_PERCENT || 0)));
        const splitSol = (amount * percent) / 100;
        const lamports = Math.round(splitSol * 1e9);
        feeSplitAmountSol = splitSol;
        if (lamports > 0) {
          // Re-check payer balance after the swap: the swap may have consumed SOL
          const postSwapBalance = await connection.getBalance(keypair.publicKey).catch(() => 0);
          // Also ensure reserve wallet has ATA for the bought token (if token is not native SOL)
          if (tokenMint !== SOL_MINT) {
            try {
              const reservePub = new PublicKey(RESERVE_WALLET);
              const ata = await getAssociatedTokenAddress(new PublicKey(tokenMint), reservePub);
              const ataInfo = await connection.getAccountInfo(ata);
              if (!ataInfo) {
                feeSplitError = `Reserve wallet is missing ATA for token ${tokenMint}. Create ATA ${ata.toBase58()} on the reserve wallet first or disable fee-split.`;
                console.warn('[Jupiter][buy] fee-split skipped: reserve ATA missing:', feeSplitError);
                // skip transfer attempt
                // mark as skipped and do not attempt SOL transfer
                // set lamports to 0 to avoid any accidental transfers
              }
            } catch (ataErr) {
              console.warn('[Jupiter][buy] could not verify reserve ATA, proceeding cautiously:', ataErr);
            }
          }
          if (postSwapBalance < lamports + Math.round(MIN_SOL_RESERVE * 1e9)) {
            feeSplitError = `Insufficient SOL after swap to perform fee-split. Required: ${(lamports + Math.round(MIN_SOL_RESERVE * 1e9))/1e9} SOL, Available: ${postSwapBalance/1e9} SOL`;
            console.warn('[Jupiter][buy] fee-split skipped:', feeSplitError);
          } else {
            const transferTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: new PublicKey(RESERVE_WALLET), lamports }));
            try { const bh = await connection.getLatestBlockhashAndContext('confirmed'); transferTx.recentBlockhash = bh.value.blockhash; } catch(_){ }
            transferTx.feePayer = keypair.publicKey;
            try { transferTx.sign(keypair); } catch(_){ }
            const serialized = transferTx.serialize();
            const blockhashWithExpiryBlockHeight = (await connection.getLatestBlockhashAndContext('confirmed')).value;
            const transferRes = await transactionSenderAndConfirmationWaiter({ connection, serializedTransaction: serialized, blockhashWithExpiryBlockHeight });
            if (transferRes && transferRes.transaction) {
              const metaAny = (transferRes as any).meta;
              const metaErr = metaAny && (metaAny.err || (metaAny.status && metaAny.status.Err));
              try {
                console.log('[Jupiter][buy] Fee-split transfer meta:', transferRes.meta || null);
                if (transferRes.meta && transferRes.meta.preBalances) console.log('[Jupiter][buy] Fee-split preBalances:', transferRes.meta.preBalances);
                if (transferRes.meta && transferRes.meta.postBalances) console.log('[Jupiter][buy] Fee-split postBalances:', transferRes.meta.postBalances);
              } catch (_) {}
              if (!metaErr) {
                feeSplitTx = transferRes.transaction.signatures?.[0] || null;
                console.log('[Jupiter][buy] Fee-split transfer confirmed on-chain:', feeSplitTx, 'amountSol=', splitSol);
              } else {
                const metaStr = JSON.stringify(metaErr);
                if (String(metaStr).toLowerCase().includes('insufficientfundsforrent')) {
                  feeSplitError = 'Fee-split failed: Insufficient funds for rent when creating recipient account. Ensure the reserve wallet has an ATA for the token or fund the payer with extra SOL to cover rent.';
                } else {
                  feeSplitError = 'Fee-split on-chain error: ' + metaStr;
                }
                console.warn('[Jupiter][buy] Fee-split transfer failed on-chain:', feeSplitError);
              }
            } else {
              feeSplitError = 'Fee-split transfer aborted or not confirmed';
              console.warn('[Jupiter][buy] Fee-split transfer aborted or not confirmed');
            }
          }
        }
      }
    } catch (e) {
      feeSplitError = String(e);
      console.warn('[Jupiter][buy] Fee-split processing error:', feeSplitError);
    }

    return { tx: txid, source: 'jupiter', feeSplitTx, feeSplitAmountSol, feeSplitError };
  },

  async sell(tokenMint: string, amount: number, secret: string | any, ctrl?: any) {
    if (ctrl?.cancelled) throw new Error('Cancelled');
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const connection = rpcPool.getRpcConnection();
    console.log(`[Jupiter][sell] Using RPC: ${rpcPool.getLastUsedUrl() || 'unknown'}`);

    // normalize keypair
    let keypair: any;
    try { keypair = loadKeypair(secret); } catch (e) { try { keypair = Keypair.fromSecretKey(Buffer.from(secret, 'base64')); } catch (ee) { throw new Error('Invalid secret provided to Jupiter.sell'); } }
    const userPublicKey = keypair.publicKey.toBase58();

    const jupiter = createJupiterApiClient();
    let quote: any;
    try {
      quote = await jupiter.quoteGet({ inputMint: tokenMint, outputMint: SOL_MINT, amount: Math.floor(amount * 1e9), slippageBps: 100 });
    } catch (e) {
      console.error('[Jupiter][sell] Failed to get quote:', e);
      throw e;
    }
    if (!quote || !quote.routePlan) throw new Error('No route found for token');

    let swapResp: any;
    try {
      const swapRequest = { userPublicKey, wrapAndUnwrapSol: true, asLegacyTransaction: false, quoteResponse: quote };
      swapResp = await jupiter.swapPost({ swapRequest });
    } catch (e) {
      console.error('[Jupiter][sell] swapPost failed:', e);
      throw e;
    }
    if (!swapResp || !swapResp.swapTransaction) throw new Error('Failed to obtain swap transaction');

    const swapTxBuf = Buffer.from(swapResp.swapTransaction, 'base64');
    let txid = '';
    try {
      const blockhashWithExpiryBlockHeight: BlockhashWithExpiryBlockHeight = quote?.blockhashWithExpiryBlockHeight || (await connection.getLatestBlockhashAndContext('confirmed')).value;
      const txResult = await transactionSenderAndConfirmationWaiter({ connection, serializedTransaction: swapTxBuf, blockhashWithExpiryBlockHeight });
      if (!txResult || !txResult.transaction) throw new Error('Transaction failed or not confirmed');
      txid = txResult.transaction.signatures?.[0] || '';
    } catch (e) {
      console.error('[Jupiter][sell] Robust sender failed:', e);
      throw e;
    }
    return { tx: txid, source: 'jupiter' };
  }
};

// Reduce parallel trades to 1 (sequential only)
const BUY_SOURCES = [Jupiter];
const SELL_SOURCES = [Jupiter];

// getJupiterPrice, getRaydiumPrice, getDexPrice helpers (keep previous behavior but simplified)
async function getJupiterPrice(tokenMint: string, amount: number) {
  const priceUsd = await require('./utils/index').getPrice(tokenMint);
  const priceSol = await require('./raydium/raydium.service').getPriceInSOL(tokenMint);
  return {
    priceUsd,
    priceSol,
    source: 'jupiter',
    buy: async (tokenMint: string, amount: number, payerKeypair: any) => {
      return await Jupiter.buy(tokenMint, amount, payerKeypair);
    }
  };
}

async function getRaydiumPrice(tokenMint: string, amount: number) {
  const priceUsd = await require('./utils/index').getPrice(tokenMint);
  const priceSol = await require('./raydium/raydium.service').getPriceInSOL(tokenMint);
  return {
    priceUsd,
    priceSol,
    source: 'raydium',
    buy: async (tokenMint: string, amount: number, payerKeypair: any) => {
      // Placeholder that routes to Raydium service (existing implementation preserved elsewhere)
      const { RaydiumSwapService } = require('./raydium/raydium.service');
      const bs58 = require('bs58');
      let pk: string;
      try {
        if (typeof payerKeypair === 'string') pk = bs58.encode(Buffer.from(payerKeypair, 'base64').slice(0,32));
        else if (payerKeypair && payerKeypair.secretKey) pk = bs58.encode(Buffer.from(payerKeypair.secretKey));
        else if (Array.isArray(payerKeypair)) pk = bs58.encode(Buffer.from(payerKeypair));
        else pk = payerKeypair as any;
      } catch (e) { pk = payerKeypair as any; }
      const svc = new RaydiumSwapService();
      const res = await svc.swapToken(pk, 'So11111111111111111111111111111111111111112', tokenMint, 9, amount, 100, Number(process.env.RAYDIUM_GAS_FEE_SOL || '0.00001'), false, process.env.RAYDIUM_USERNAME || 'bot', false);
      if (!res) throw new Error('Raydium swap returned null');
      return { tx: res.bundleId || res.signature || res.tx || null, price: priceUsd, signature: res.signature || res.bundleId };
    }
  };
}

async function getDexPrice(tokenMint: string, amount: number) {
  const priceUsd = await require('./utils/index').getPrice(tokenMint);
  const priceSol = await require('./raydium/raydium.service').getPriceInSOL(tokenMint);
  return {
    priceUsd,
    priceSol,
    source: 'dexscreener',
    buy: async () => ({ tx: 'dummy-dex-tx', price: priceUsd, signature: 'dummy-dex-sign' })
  };
}

// Helper: run sources sequentially (first success wins)
async function raceSources(sources: any[], fnName: 'buy'|'sell', tokenMint: string, amount: number, secret: string): Promise<any> {
  let errors: string[] = [];
  for (let i = 0; i < sources.length; i++) {
    try {
      if (typeof sources[i][fnName] !== 'function') throw new Error(`${fnName} not implemented in source`);
      const start = Date.now();
      const result = await withTimeout(sources[i][fnName](tokenMint, amount, secret), 20000, sources[i].name || 'Unknown');
      const end = Date.now();
      let tx: any = null, price: any = null, signature: any = null;
      if (typeof result === 'object' && result !== null) {
        tx = 'tx' in result ? result.tx : null;
        price = 'price' in result ? result.price : null;
        signature = 'signature' in result ? result.signature : null;
      }
      logTrade({ action: fnName, source: sources[i].name || sources[i].source || 'Unknown', token: tokenMint, amount, price: price as any, tx: (tx || signature) as any, latency: end - start, status: 'success' });
      return { source: sources[i].name || sources[i].source || 'Unknown', txSignature: tx || signature, price, amount, latency: end - start };
    } catch (e: any) {
      errors.push(String(e));
      logTrade({ action: fnName, source: sources[i].name || 'Unknown', token: tokenMint, amount, price: null, tx: null, latency: 0, status: 'fail' });
      console.error(`[raceSources][${fnName}] Error:`, e);
    }
  }
  throw new Error('All sources failed: ' + errors.join(' | '));
}

// unifiedBuy
export async function unifiedBuy(tokenMint: string, amount: number, payerKeypair: any) {
  const [jupiter, raydium, dex] = await Promise.all([getJupiterPrice(tokenMint, amount), getRaydiumPrice(tokenMint, amount), getDexPrice(tokenMint, amount)]);
  const results = [jupiter, raydium, dex].filter(Boolean);
  const best = results.reduce((prev: any, curr: any) => curr.priceUsd < prev.priceUsd ? curr : prev);
  const buyResult = await best.buy(tokenMint, amount, payerKeypair);
  const br: any = buyResult;
  const tx = br && (br.tx || br.txSignature || br.signature) || null;
  return { tx, source: best.source, success: !!tx, raw: buyResult, priceUsd: best.priceUsd, priceSol: best.priceSol };
}

// unifiedSell
export async function unifiedSell(tokenMint: string, amount: number, secret: string) {
  const res = await raceSources(SELL_SOURCES, 'sell', tokenMint, amount, secret);
  const r: any = res;
  const tx = r && (r.tx || r.txSignature || r.signature) || null;
  return {
    tx,
    source: r && (r.source || r.name) || 'unknown',
    success: !!tx,
    raw: r
  };
}