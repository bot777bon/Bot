// tradeSources.ts
// Unified trading source manager for Solana bot
// Language: English only


// --- Multi-Source Trading Logic (Promise.race, first-success-wins) ---
// Add your real source modules here. For now, placeholders are used.
// Example: import * as Jupiter from './sources/jupiter';
// Example: import * as Raydium from './sources/raydium';

type TradeSource = 'jupiter' | 'raydium' | 'dexscreener';


// --- Real Jupiter REST API integration ---
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
import type { BlockhashWithExpiryBlockHeight } from '@solana/web3.js';
const { createJupiterApiClient } = require('@jup-ag/api');
import { transactionSenderAndConfirmationWaiter, manualSendRawTransactionVerbose } from './utils/jupiter.transaction.sender';
import { loadKeypair, withTimeout, logTrade } from './utils/tokenUtils';

const Jupiter = {
  async buy(tokenMint: string, amount: number, secret: string, ctrl?: any) {
    if (ctrl?.cancelled) throw new Error('Cancelled');
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    // Use custom RPC if available
    const rpcUrl = process.env.HELIUS_RPC_URL || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new (require('@solana/web3.js').Connection)(rpcUrl, 'confirmed');
    console.log(`[Jupiter][buy] Using RPC: ${rpcUrl}`);
    let secretKey: Buffer;
    try {
      secretKey = Buffer.from(secret, 'base64');
    } catch (e) {
      console.error('[Jupiter][buy] Invalid base64 secret:', e);
      throw new Error('Invalid base64 secret');
    }
    const keypair = Keypair.fromSecretKey(secretKey);
    // Add delay before trade to avoid rate limit
    await new Promise(res => setTimeout(res, 5000));
    const userPublicKey = keypair.publicKey.toBase58();
    console.log('[Jupiter][buy] PublicKey:', userPublicKey);

    // Check SOL balance
    let solBalance = 0;
    try {
      solBalance = await connection.getBalance(keypair.publicKey);
      console.log(`[Jupiter][buy] SOL balance: ${solBalance / 1e9} SOL`);
    } catch (e) {
      console.error('[Jupiter][buy] Failed to fetch SOL balance:', e);
    }
    if (solBalance < amount * 1e9) {
      throw new Error(`Insufficient SOL balance. Required: ${amount}, Available: ${solBalance / 1e9}`);
    }

    // Validate mint address before any action
    if (tokenMint !== SOL_MINT) {
      try {
        const { PublicKey } = require('@solana/web3.js');
        const tokenMintPubkey = new PublicKey(tokenMint);
        // Mint validation: must exist and be owned by SPL Token program
        const mintInfo = await connection.getAccountInfo(tokenMintPubkey);
        if (!mintInfo || !mintInfo.owner || mintInfo.owner.toBase58() !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
          console.error(`[Jupiter][buy] Invalid mint: ${tokenMint}. Skipping swap.`);
          throw new Error(`Invalid SPL token mint: ${tokenMint}`);
        }
        // Token balance and ATA creation
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
          keypair.publicKey,
          { mint: tokenMintPubkey }
        );
        let tokenBalance = 0;
        if (tokenAccounts.value.length > 0) {
          tokenBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
        }
        console.log(`[Jupiter][buy] Token balance for ${tokenMint}: ${tokenBalance}`);
        // If no account, create associated token account before swap
        if (tokenAccounts.value.length === 0) {
          console.log(`[Jupiter][buy] Creating associated token account for mint: ${tokenMint}`);
          const { createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
          const ata = await (require('@solana/spl-token').getAssociatedTokenAddress)(tokenMintPubkey, keypair.publicKey);
          const ataIx = createAssociatedTokenAccountInstruction(
            keypair.publicKey,
            ata,
            keypair.publicKey,
            tokenMintPubkey
          );
          // Build transaction with explicit fee payer (required for compile/simulate)
          const { Transaction, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
          const tx = new Transaction({ feePayer: keypair.publicKey }).add(ataIx);

          // Check rent-exempt lamports for ATA (approx 165 bytes) and estimated fee
          let ataRent = 0;
          try {
            // associated token account size is the parsed account length for token accounts
            const rentExemption = await connection.getMinimumBalanceForRentExemption(165);
            ataRent = rentExemption;
          } catch (e) {
            console.warn('[Jupiter][buy] Failed to get rent exemption, proceeding conservatively');
            ataRent = Math.ceil(0.002 * LAMPORTS_PER_SOL); // fallback ~0.002 SOL
          }

          // Estimate a single-signature fee (conservative)
          const estimatedFee = Math.ceil(5000); // in lamports (very conservative placeholder)

          // Ensure payer has enough lamports for rent + fee before attempting ATA creation
          const payerBalance = await connection.getBalance(keypair.publicKey);
          if (payerBalance < ataRent + estimatedFee) {
            console.error(`[Jupiter][buy] Insufficient SOL for ATA creation. Required: ${(ataRent + estimatedFee) / LAMPORTS_PER_SOL} SOL, Available: ${payerBalance / LAMPORTS_PER_SOL} SOL`);
            throw new Error(`Insufficient SOL to create ATA for mint ${tokenMint}. Skipping trade to avoid fees.`);
          }

          // Set recent blockhash and sign transaction before simulating to provide fee payer signature
          try {
            const latest = await connection.getLatestBlockhash('finalized');
            tx.recentBlockhash = latest.blockhash;
          } catch (e) {
            // ignore and let simulateTransaction proceed; some RPCs don't require explicit blockhash
          }
          // Partially sign with payer so simulation sees a valid fee payer signature
          try {
            tx.sign(keypair);
          } catch (e) {
            // Transaction.sign may throw if the transaction has been compiled differently; ignore
          }

          // Preflight simulation for ATA creation
          let ataSim = await connection.simulateTransaction(tx);
          if (ataSim.value.err) {
            console.error(`[Jupiter][buy] ATA creation simulation failed for mint ${tokenMint}:`, ataSim.value.err);
            if (ataSim.value.logs) console.error('[Jupiter][buy] ATA simulation logs:\n', ataSim.value.logs.join('\n'));
            throw new Error(`ATA creation simulation failed for mint ${tokenMint}`);
          }
          // Send ATA creation transaction via centralized sender with limited retries so LIVE_TRADES is enforced there
          const ataSerialized = tx.serialize();
          let ataSent = false;
          let lastAtaErr: any = null;
          for (let attempt = 0; attempt < 2 && !ataSent; attempt++) {
            try {
              const blockhashWithExpiryBlockHeight = (await connection.getLatestBlockhashAndContext('confirmed')).value;
              const ataResult = await transactionSenderAndConfirmationWaiter({
                connection,
                serializedTransaction: ataSerialized,
                blockhashWithExpiryBlockHeight,
              });
              if (!ataResult) {
                const liveTradesFlag = process.env.LIVE_TRADES === undefined ? true : (String(process.env.LIVE_TRADES).toLowerCase() === 'true');
                if (!liveTradesFlag) {
                  console.log('[Jupiter][buy] DRY-RUN: central sender returned null for ATA creation; marking ATA as created for simulation purposes.');
                  ataSent = true;
                  break;
                }
                lastAtaErr = new Error('[Jupiter][buy] ATA creation aborted by central sender (dry-run or expired)');
                console.warn('[Jupiter][buy] ATA attempt', attempt, 'returned null result from sender');
                // wait a short moment before retry
                await new Promise(r => setTimeout(r, 1200));
                continue;
              }
              console.log(`[Jupiter][buy] ATA creation result:`, ataResult.transaction?.signatures?.[0] || 'confirmed');
              ataSent = true;
            } catch (e) {
              lastAtaErr = e;
              console.warn('[Jupiter][buy] ATA create attempt', attempt, 'failed:', (e as any)?.message ?? e);
              await new Promise(r => setTimeout(r, 1200));
            }
          }
          if (!ataSent) {
            console.error('[Jupiter][buy] All ATA creation attempts failed:', lastAtaErr);
            throw lastAtaErr;
          }
        }
        if (tokenBalance < 0) {
          throw new Error(`Insufficient token balance for mint ${tokenMint}`);
        }
      } catch (e) {
        console.error('[Jupiter][buy] Token mint validation or ATA creation failed:', e);
        throw e;
      }
    }

    // 1. Get Jupiter API client
    const jupiter = createJupiterApiClient();
    // 2. Get quote
    let quote;
    try {
      const PRIOR_FEE = Number(process.env.PRIORITY_FEE_LAMPORTS) || 200000;
      quote = await jupiter.quoteGet({
        inputMint: SOL_MINT,
        outputMint: tokenMint,
        amount: Math.floor(amount * 1e9),
        slippageBps: 100,
        prioritizationFeeLamports: PRIOR_FEE // raise priority fee (configurable)
      });
      console.log(`[Jupiter][buy] Using prioritizationFeeLamports: ${PRIOR_FEE}`);
      console.log('[Jupiter][buy] Quote:', quote);
    } catch (e) {
      console.error('[Jupiter][buy] Failed to get quote:', e);
      throw new Error('Failed to get quote: ' + (e instanceof Error ? e.message : String(e)));
    }
    if (!quote || !quote.routePlan || !quote.outAmount) {
      throw new Error('No route found for this token');
    }
    // 3. Get swap transaction
    const swapRequest = {
      userPublicKey,
      wrapAndUnwrapSol: true,
      asLegacyTransaction: false,
      quoteResponse: quote
    };
    console.log('[Jupiter][buy] swapRequest:', swapRequest);
    let swapResp;
    try {
      swapResp = await jupiter.swapPost({ swapRequest });
      console.log('[Jupiter][buy] swapResp:', swapResp);
    } catch (e) {
      console.error('[Jupiter][buy] Failed to get swap transaction:', e);
      throw new Error('Failed to get swap transaction: ' + (e instanceof Error ? e.message : String(e)));
    }
    if (!swapResp || !swapResp.swapTransaction) {
      throw new Error('Failed to get swap transaction from Jupiter');
    }
  // 4. Sign and send transaction using robust sender
  let swapTxBuf = Buffer.from(swapResp.swapTransaction, 'base64');
  let txid = '';
  let blockhashWithExpiryBlockHeight: BlockhashWithExpiryBlockHeight;
  try {
      // Try to get blockhash info from quote or connection
      blockhashWithExpiryBlockHeight = quote?.blockhashWithExpiryBlockHeight;
      if (!blockhashWithExpiryBlockHeight) {
        blockhashWithExpiryBlockHeight = (await connection.getLatestBlockhashAndContext('confirmed')).value;
      }
  // Preflight simulation for swap transaction
      const { VersionedTransaction, Transaction } = require('@solana/web3.js');
      let swapSimError = null;
      try {
        // Try parsing as a VersionedTransaction; if that fails, fallback to legacy Transaction
        let txObj;
        try {
          // Deserialize the versioned transaction from bytes
          txObj = VersionedTransaction.deserialize(swapTxBuf);
        } catch (parseErr) {
          try {
            txObj = Transaction.from(swapTxBuf);
          } catch (legacyErr) {
            throw parseErr; // rethrow original if both fail
          }
        }

        const txSim = await connection.simulateTransaction(txObj);
        if (txSim.value.err) {
          swapSimError = txSim.value.err;
          try {
            console.error(`[Jupiter][buy] Swap simulation failed for mint ${tokenMint}:`, JSON.stringify(txSim.value.err));
          } catch (e) {
            console.error(`[Jupiter][buy] Swap simulation failed for mint ${tokenMint}:`, txSim.value.err);
          }
          // Also print program logs to help diagnose InstructionError
          if (txSim.value.logs) {
            console.error(`[Jupiter][buy] Simulation logs for mint ${tokenMint}:\n`, txSim.value.logs.join('\n'));
          }
          // Log swapResp metadata if available
          try {
            console.error(`[Jupiter][buy] swapResp metadata: lastValidBlockHeight=${swapResp?.lastValidBlockHeight}, prioritizationFeeLamports=${swapResp?.prioritizationFeeLamports}`);
          } catch (e) {}
        }
      } catch (e) {
        swapSimError = e;
        console.error(`[Jupiter][buy] Swap simulation error for mint ${tokenMint}:`, e);
      }
      if (swapSimError) {
        throw new Error(`Swap simulation failed for mint ${tokenMint}`);
      }
      // Try sending swap via centralized sender; if it fails, retry by re-quoting and re-requesting swap
      let txResult = null;
      let swapSent = false;
      let lastSwapErr: any = null;
      const MAX_SWAP_ATTEMPTS = 3;
      for (let attempt = 0; attempt < MAX_SWAP_ATTEMPTS && !swapSent; attempt++) {
        try {
          console.log(`[Jupiter][buy] Re-simulating before sending attempt ${attempt + 1}/${MAX_SWAP_ATTEMPTS} for ${tokenMint}`);
          // Re-parse and re-simulate to ensure tx is still valid
          try {
            let txObj;
            try {
              txObj = VersionedTransaction.deserialize(swapTxBuf);
            } catch (parseErr) {
              txObj = Transaction.from(swapTxBuf);
            }
            const simBefore = await connection.simulateTransaction(txObj);
            if (simBefore.value.err) {
              console.error('[Jupiter][buy] Pre-send simulation failed, aborting send attempt:', simBefore.value.err);
              if (simBefore.value.logs) console.error(simBefore.value.logs.join('\n'));
              throw new Error('Pre-send simulation failed');
            }
          } catch (simErr) {
            throw simErr;
          }

          console.log(`[Jupiter][buy] Sending swap attempt ${attempt + 1}/${MAX_SWAP_ATTEMPTS} for ${tokenMint}`);
          // request server-side preflight (skipPreflight=false) to avoid wasting fees on bad txs
          txResult = await transactionSenderAndConfirmationWaiter({
            connection,
            serializedTransaction: swapTxBuf,
            blockhashWithExpiryBlockHeight,
            sendOptions: { skipPreflight: false },
          });
          if (!txResult) {
            const liveTradesFlag = process.env.LIVE_TRADES === undefined ? true : (String(process.env.LIVE_TRADES).toLowerCase() === 'true');
            if (!liveTradesFlag) {
              console.log('[Jupiter][buy] DRY-RUN: central sender returned null for swap send; marking swap as simulated success.');
              // In dry-run, mark as sent (no real txid)
              txid = 'DRY-RUN-SIMULATED-TX';
              swapSent = true;
              break;
            }
            throw new Error('Transaction failed or not confirmed');
          }
          if (!txResult.transaction) throw new Error('Transaction failed or not confirmed');
          txid = txResult.transaction.signatures?.[0] || '';
          console.log('[Jupiter][buy] Transaction sent:', txid);
          swapSent = true;
          break;
        } catch (e) {
          lastSwapErr = e;
          console.warn('[Jupiter][buy] swap send attempt', attempt + 1, 'failed:', (e as any)?.message ?? e);
          // small backoff
          await new Promise(r => setTimeout(r, 1500 + attempt * 500));
          // refresh quote and swap transaction to get fresh blockhash / prioritization fee
          try {
            console.log('[Jupiter][buy] refreshing quote and swap request to retry');
            const refreshedQuote = await jupiter.quoteGet({
              inputMint: SOL_MINT,
              outputMint: tokenMint,
              amount: Math.floor(amount * 1e9),
              slippageBps: 100,
              prioritizationFeeLamports: Number(process.env.PRIORITY_FEE_LAMPORTS) || 200000,
            });
            const refreshedSwapResp = await jupiter.swapPost({ swapRequest: { userPublicKey, wrapAndUnwrapSol: true, asLegacyTransaction: false, quoteResponse: refreshedQuote } });
            if (refreshedSwapResp && refreshedSwapResp.swapTransaction) {
              swapTxBuf = Buffer.from(refreshedSwapResp.swapTransaction, 'base64');
              blockhashWithExpiryBlockHeight = refreshedQuote?.blockhashWithExpiryBlockHeight || (await connection.getLatestBlockhashAndContext('confirmed')).value;
              console.log('[Jupiter][buy] refreshed swap transaction ready for next attempt');
            }
          } catch (innerErr) {
            console.warn('[Jupiter][buy] refreshing quote/swap failed:', (innerErr as any)?.message ?? innerErr);
          }
        }
      }
      if (!swapSent) {
        console.error('[Jupiter][buy] All swap send attempts failed:', lastSwapErr);
        // Fallback: attempt manual verbose send
        try {
          console.log('[Jupiter][buy] Falling back to manual verbose sendRawTransaction');
          // Manual verbose send with server-side preflight to ensure RPC rejects bad txs instead of burning fees
          const manual = await manualSendRawTransactionVerbose({ connection, serializedTransaction: swapTxBuf, sendOptions: { skipPreflight: false } });
          if (manual && manual.success) {
            txid = manual.txid || '';
            console.log('[Jupiter][buy] Manual send succeeded:', txid);
            swapSent = true;
          } else {
            console.error('[Jupiter][buy] Manual send failed or timed out:', manual);
            throw lastSwapErr;
          }
        } catch (manErr) {
          console.error('[Jupiter][buy] Manual verbose send failed as fallback:', manErr);
          throw lastSwapErr;
        }
      }
    } catch (e) {
      console.error('[Jupiter][buy] Robust sender failed:', e);
      if (typeof e === 'object' && e !== null && 'message' in e && typeof (e as any).message === 'string' && (e as any).message.includes('429')) {
        console.error('[Jupiter][buy] RPC rate limit (429 Too Many Requests). Use a private RPC or reduce trade frequency.');
      }
      // Print full error object for debugging
      console.error('[Jupiter][buy] Error details:', JSON.stringify(e, Object.getOwnPropertyNames(e), 2));
      throw new Error('Swap failed: ' + (e && typeof e === 'object' && 'message' in e ? (e as any).message : String(e)));
    }
    return { tx: txid, source: 'jupiter' };
  },
  async sell(tokenMint: string, amount: number, secret: string, ctrl?: any) {
    if (ctrl?.cancelled) throw new Error('Cancelled');
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    let secretKey: Buffer;
    try {
      secretKey = Buffer.from(secret, 'base64');
    } catch (e) {
      console.error('[Jupiter][sell] Invalid base64 secret:', e);
      throw new Error('Invalid base64 secret');
    }
    const keypair = Keypair.fromSecretKey(secretKey);
    const userPublicKey = keypair.publicKey.toBase58();
    // 1. Get Jupiter API client
    const jupiter = createJupiterApiClient();
    // 2. Get quote (token -> SOL)
    let quote;
    try {
      quote = await jupiter.quoteGet({
        inputMint: tokenMint,
        outputMint: SOL_MINT,
        amount: Math.floor(amount * 1e9),
        slippageBps: 100
      });
      console.log('[Jupiter][sell] Quote:', quote);
    } catch (e) {
      console.error('[Jupiter][sell] Failed to get quote:', e);
      throw new Error('Failed to get quote: ' + (e instanceof Error ? e.message : String(e)));
    }
    if (!quote || !quote.routePlan || !quote.outAmount) {
      throw new Error('No route found for this token');
    }
    // 3. Get swap transaction
    const swapRequest = {
      userPublicKey,
      wrapAndUnwrapSol: true,
      asLegacyTransaction: false,
      quoteResponse: quote
    };
    console.log('[Jupiter][sell] swapRequest:', swapRequest);
    let swapResp;
    try {
      swapResp = await jupiter.swapPost({ swapRequest });
      console.log('[Jupiter][sell] swapResp:', swapResp);
    } catch (e) {
      console.error('[Jupiter][sell] Failed to get swap transaction:', e);
      throw new Error('Failed to get swap transaction: ' + (e instanceof Error ? e.message : String(e)));
    }
    if (!swapResp || !swapResp.swapTransaction) {
      throw new Error('Failed to get swap transaction from Jupiter');
    }
    // 4. Sign and send transaction using robust sender
    const swapTxBuf = Buffer.from(swapResp.swapTransaction, 'base64');
    let txid = '';
    let blockhashWithExpiryBlockHeight: BlockhashWithExpiryBlockHeight;
    try {
      blockhashWithExpiryBlockHeight = quote?.blockhashWithExpiryBlockHeight;
      if (!blockhashWithExpiryBlockHeight) {
        blockhashWithExpiryBlockHeight = (await connection.getLatestBlockhashAndContext('confirmed')).value;
      }
      const txResult = await transactionSenderAndConfirmationWaiter({
        connection,
        serializedTransaction: swapTxBuf,
        blockhashWithExpiryBlockHeight,
      });
      if (!txResult || !txResult.transaction) throw new Error('Transaction failed or not confirmed');
      txid = txResult.transaction.signatures?.[0] || '';
      console.log('[Jupiter][sell] Transaction sent:', txid);
    } catch (e) {
      console.error('[Jupiter][sell] Robust sender failed:', e);
      throw new Error('Swap failed: ' + (e && typeof e === 'object' && 'message' in e ? (e as any).message : String(e)));
    }
    return { tx: txid, source: 'jupiter' };
  }
};

// Reduce parallel trades to 1 (sequential only)
const BUY_SOURCES = [Jupiter];
const SELL_SOURCES = [Jupiter];

// دالة جلب سعر Jupiter بالدولار وسولانا
async function getJupiterPrice(tokenMint: string, amount: number) {
  // جلب السعر بالدولار من birdeye أو أي مصدر مناسب
  const priceUsd = await require('./utils/index').getPrice(tokenMint);
  // جلب السعر بسولانا من خدمة Raydium
  const priceSol = await require('./raydium/raydium.service').getPriceInSOL(tokenMint);
  return {
    priceUsd,
    priceSol,
    source: 'jupiter',
    buy: async (tokenMint: string, amount: number, payerKeypair: any) => {
      // نفذ الشراء عبر Jupiter
      return await Jupiter.buy(tokenMint, amount, payerKeypair);
    }
  };
}

// دالة جلب سعر Raydium بالدولار وسولانا
async function getRaydiumPrice(tokenMint: string, amount: number) {
  const priceUsd = await require('./utils/index').getPrice(tokenMint);
  const priceSol = await require('./raydium/raydium.service').getPriceInSOL(tokenMint);
  return {
    priceUsd,
    priceSol,
    source: 'raydium',
    buy: async (tokenMint: string, amount: number, payerKeypair: any) => {
      try {
        // Raydium service expects a private key in base58 (pk) and token params
        const { RaydiumSwapService } = require('./raydium/raydium.service');
        const bs58 = require('bs58');
        // payerKeypair may be a Keypair object or base64 secret; normalize to base58 pk
        let pk: string;
        try {
          if (typeof payerKeypair === 'string') {
            // assume base64 secret
            const buf = Buffer.from(payerKeypair, 'base64');
            pk = bs58.encode(buf.slice(0, 32));
          } else if (payerKeypair && payerKeypair.secretKey) {
            pk = bs58.encode(Buffer.from(payerKeypair.secretKey));
          } else if (Array.isArray(payerKeypair)) {
            pk = bs58.encode(Buffer.from(payerKeypair));
          } else {
            // fallback: try JSON stringify -> parse
            pk = bs58.encode(Buffer.from(JSON.stringify(payerKeypair)));
          }
        } catch (e) {
          console.warn('[getRaydiumPrice][buy] Failed to normalize payerKeypair to bs58, attempting raw passthrough', e);
          pk = payerKeypair as any;
        }

        // Arbitrary defaults: assume token decimals 9, slippage 100 (1%), gas fee small
        const decimal = 9;
        const slippage = 100; // Percent class in Raydium expects basis-like; service uses it directly
        const gasFee = Number(process.env.RAYDIUM_GAS_FEE_SOL || '0.00001');
        const isFeeBurn = false;
        const username = process.env.RAYDIUM_USERNAME || 'bot';
        const isToken2022 = false;

        const svc = new RaydiumSwapService();
        const res = await svc.swapToken(pk, /*inputMint*/ 'So11111111111111111111111111111111111111112', /*outputMint*/ tokenMint, decimal, amount, slippage, gasFee, isFeeBurn, username, isToken2022);
        if (!res) throw new Error('Raydium swap returned null');
        return { tx: res.bundleId || res.signature || res.tx || null, price: priceUsd, signature: res.signature || res.bundleId };
      } catch (e) {
        console.error('[getRaydiumPrice][buy] Raydium buy failed:', e);
        throw e;
      }
    }
  };
}

// دالة جلب سعر DexScreener بالدولار وسولانا
async function getDexPrice(tokenMint: string, amount: number) {
  const priceUsd = await require('./utils/index').getPrice(tokenMint);
  const priceSol = await require('./raydium/raydium.service').getPriceInSOL(tokenMint);
  return {
    priceUsd,
    priceSol,
    source: 'dexscreener',
    buy: async (tokenMint: string, amount: number, payerKeypair: any) => {
      // نفذ الشراء عبر DexScreener (يجب أن تضيف منطق الشراء الفعلي)
      return { tx: 'dummy-dex-tx', price: priceUsd, signature: 'dummy-dex-sign' };
    }
  };
}


// Helper: run all sources in parallel, return first success, cancel others
async function raceSources(sources: any[], fnName: 'buy'|'sell', tokenMint: string, amount: number, secret: string): Promise<any> {
  let errors: string[] = [];
  const payerKeypair = loadKeypair(secret);
  for (let i = 0; i < sources.length; i++) {
    try {
      if (typeof sources[i][fnName] !== 'function') throw new Error(`${fnName} not implemented in source`);
      const start = Date.now();
      const promise = sources[i][fnName](tokenMint, amount, payerKeypair);
      const result = await withTimeout(promise, 5000, sources[i].name || 'Unknown');
      const end = Date.now();
      let tx = null, price = null, signature = null;
      if (typeof result === 'object' && result !== null) {
        tx = 'tx' in result ? (result as any).tx : null;
        price = 'price' in result ? (result as any).price : null;
        signature = 'signature' in result ? (result as any).signature : null;
      }
      logTrade({
        action: fnName,
        source: sources[i].name || sources[i].source || 'Unknown',
        token: tokenMint,
        amount,
        price: price,
        tx: tx || signature,
        latency: end - start,
        status: 'success'
      });
      return {
        source: sources[i].name || sources[i].source || 'Unknown',
        txSignature: tx || signature,
        price: price,
        amount,
        latency: end - start
      };
    } catch (e: any) {
      errors[i] = (typeof e === 'object' && e !== null && 'message' in e && typeof (e as any).message === 'string') ? (e as any).message : String(e);
      logTrade({
        action: fnName,
        source: sources[i].name || 'Unknown',
        token: tokenMint,
        amount,
        price: null,
        tx: null,
        latency: 0,
        status: 'fail'
      });
      console.error(`[raceSources][${fnName}] Error details:`, JSON.stringify(e, Object.getOwnPropertyNames(e), 2));
    }
  }
  throw new Error('All sources failed: ' + errors.filter(Boolean).join(' | '));
}

// unifiedBuy المعدلة
export async function unifiedBuy(tokenMint: string, amount: number, payerKeypair: any) {
  // جلب الأسعار من جميع المصادر
  const [jupiter, raydium, dex] = await Promise.all([
    getJupiterPrice(tokenMint, amount),
    getRaydiumPrice(tokenMint, amount),
    getDexPrice(tokenMint, amount)
  ]);

  // تجميع النتائج في مصفوفة
  const results = [jupiter, raydium, dex].filter(Boolean);

  // اختيار أفضل سعر بالدولار
  const best = results.reduce((prev, curr) =>
    curr.priceUsd < prev.priceUsd ? curr : prev
  );

  // تنفيذ الشراء من المصدر الأفضل
  const buyResult = await best.buy(tokenMint, amount, payerKeypair);

  // Normalize result shape for callers: always return { tx, source, success, raw, priceUsd, priceSol }
  const br: any = buyResult;
  const tx = br && (br.tx || br.txSignature || br.signature || (br.buyResult && (br.buyResult.tx || br.buyResult.signature))) || null;
  const normalized = {
    tx,
    source: best.source,
    success: !!tx,
    raw: buyResult,
    priceUsd: best.priceUsd,
    priceSol: best.priceSol
  };
  return normalized;
}

/**
 * @param {string} tokenMint
 * @param {number} amount
 * @param {string} secret
 * @returns {Promise<{tx: string, source: TradeSource}>}
 */
async function unifiedSell(tokenMint: string, amount: number, secret: string) {
  // raceSources returns an object with txSignature/tx etc. Normalize similarly to unifiedBuy
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

export { unifiedSell };