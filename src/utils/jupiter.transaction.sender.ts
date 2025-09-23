import {
  BlockhashWithExpiryBlockHeight,
  Connection,
  TransactionExpiredBlockheightExceededError,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import promiseRetry from "promise-retry";
import { wait } from "./wait";

function getRpcUrlCandidates(): string[] {
  const env = process.env;
  const urls = [
    // prefer explicit Helius endpoints first if present
    env.HELIUS_RPC_URL,
    env.HELIUS_FAST_RPC_URL_2,
    env.HELIUS_RPC_URL_2,
    // then configured RPC_URL / SOLANA_RPC_URL
    env.RPC_URL,
    env.SOLANA_RPC_URL,
    env.SOLANA_API_URL,
    env.MAINNET_RPC,
  ].filter(Boolean) as string[];
  // always include a default at the end
  urls.push('https://api.mainnet-beta.solana.com');
  // dedupe while preserving order
  return urls.filter((v, i) => urls.indexOf(v) === i);
}

type TransactionSenderAndConfirmationWaiterArgs = {
  connection: Connection;
  serializedTransaction: Buffer;
  blockhashWithExpiryBlockHeight: BlockhashWithExpiryBlockHeight;
  // optional send options to control preflight behavior
  sendOptions?: { skipPreflight?: boolean };
};

// default send options (preserve previous behavior)
const DEFAULT_SEND_OPTIONS = {
  skipPreflight: true,
};

export async function transactionSenderAndConfirmationWaiter({
  connection,
  serializedTransaction,
  blockhashWithExpiryBlockHeight,
  sendOptions,
}: TransactionSenderAndConfirmationWaiterArgs): Promise<VersionedTransactionResponse | null> {
  // Default to live trades enabled unless explicitly set to 'false'
  const liveTrades = process.env.LIVE_TRADES === undefined ? true : (String(process.env.LIVE_TRADES).toLowerCase() === 'true');
  if (!liveTrades) {
    console.warn('[transactionSenderAndConfirmationWaiter] DRY-RUN: LIVE_TRADES!=true. Skipping sendRawTransaction to avoid burning fees.');
    return null;
  }
  const options = sendOptions || DEFAULT_SEND_OPTIONS;
  let txid: string | undefined;
  try {
    txid = await connection.sendRawTransaction(
      serializedTransaction,
      options
    );
  } catch (firstErr: any) {
    // Print diagnostics for first error
    try {
      if (firstErr && typeof firstErr === 'object') {
        if ('getLogs' in firstErr && typeof firstErr.getLogs === 'function') {
          try {
            const logs = await firstErr.getLogs();
            console.error('[transactionSenderAndConfirmationWaiter] SendTransactionError getLogs():', logs);
          } catch (glErr) {
            console.error('[transactionSenderAndConfirmationWaiter] getLogs() threw:', glErr);
          }
        }
        if ('transactionLogs' in firstErr && firstErr.transactionLogs) {
          console.error('[transactionSenderAndConfirmationWaiter] error.transactionLogs:', firstErr.transactionLogs);
        }
        if ('message' in firstErr) console.error('[transactionSenderAndConfirmationWaiter] sendRawTransaction error message:', firstErr.message);
        console.error('[transactionSenderAndConfirmationWaiter] first sendRawTransaction error object:', JSON.stringify(firstErr, Object.getOwnPropertyNames(firstErr), 2));
      }
    } catch (diagErr) {
      console.error('[transactionSenderAndConfirmationWaiter] error while printing diagnostics for firstErr:', diagErr);
    }

    // Try fallback RPC URLs in order
    const candidates = getRpcUrlCandidates();
    console.warn('[transactionSenderAndConfirmationWaiter] Attempting fallback RPCs, candidates:', candidates);
    for (const url of candidates) {
      try {
        if (!url) continue;
        console.log(`[transactionSenderAndConfirmationWaiter] trying RPC: ${url}`);
        const altConn = new (require('@solana/web3.js').Connection)(url, 'confirmed');
        txid = await altConn.sendRawTransaction(serializedTransaction, options);
        // if succeeded, replace connection reference for subsequent confirmation steps
        connection = altConn;
        console.log('[transactionSenderAndConfirmationWaiter] sendRawTransaction succeeded via fallback RPC:', url, 'txid=', txid);
        break;
      } catch (e: any) {
        console.warn(`[transactionSenderAndConfirmationWaiter] sendRawTransaction failed on ${url}:`, (e && e.message) || e);
        // try next
        try {
          if (e && typeof e === 'object') {
            if ('getLogs' in e && typeof e.getLogs === 'function') {
              try { const logs = await e.getLogs(); console.error('[transactionSenderAndConfirmationWaiter] fallback getLogs():', logs); } catch(_){}
            }
            if ('transactionLogs' in e && e.transactionLogs) console.error('[transactionSenderAndConfirmationWaiter] fallback error.transactionLogs:', e.transactionLogs);
          }
        } catch (_) {}
      }
    }

    if (!txid) {
      // no fallback succeeded, rethrow original
      throw firstErr;
    }
  }

  const controller = new AbortController();
  const abortSignal = controller.signal;

  const abortableResender = async () => {
    while (true) {
      await wait(2_000);
      if (abortSignal.aborted) return;
      try {
        await connection.sendRawTransaction(
          serializedTransaction,
          options
        );
      } catch (e) {
        console.warn(`Failed to resend transaction: ${e}`);
      }
    }
  };

  try {
    abortableResender();
    const lastValidBlockHeight =
      blockhashWithExpiryBlockHeight.lastValidBlockHeight - 150;

    // this would throw TransactionExpiredBlockheightExceededError
    await Promise.race([
      connection.confirmTransaction(
        {
          ...blockhashWithExpiryBlockHeight,
          lastValidBlockHeight,
          signature: txid,
          abortSignal,
        },
        "confirmed"
      ),
      new Promise(async (resolve) => {
        // in case ws socket died
        while (!abortSignal.aborted) {
          await wait(2_000);
          const tx = await connection.getSignatureStatus(txid, {
            searchTransactionHistory: false,
          });
          if (tx?.value?.confirmationStatus === "confirmed") {
            resolve(tx);
          }
        }
      }),
    ]);
  } catch (e) {
    if (e instanceof TransactionExpiredBlockheightExceededError) {
      // we consume this error and getTransaction would return null
      return null;
    } else {
      // invalid state from web3.js
      throw e;
    }
  } finally {
    controller.abort();
  }

  // in case rpc is not synced yet, we add some retries
  const response = promiseRetry(
    async (retry: any) => {
      const response = await connection.getTransaction(txid, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!response) {
        retry(response);
      }
      return response;
    },
    {
      retries: 5,
      minTimeout: 1e3,
    }
  );

  return response;
}

// Manual verbose sender: broadcast raw tx and poll signature status with detailed logs
export async function manualSendRawTransactionVerbose({ connection, serializedTransaction, sendOptions }: { connection: Connection; serializedTransaction: Buffer; sendOptions?: { skipPreflight?: boolean }; }) {
  const liveTrades = process.env.LIVE_TRADES === undefined ? true : (String(process.env.LIVE_TRADES).toLowerCase() === 'true');
  if (!liveTrades) {
    console.warn('[manualSendRawTransactionVerbose] DRY-RUN: LIVE_TRADES!=true. Skipping manual send.');
    return { success: false, reason: 'dry-run' };
  }
  try {
    const options = sendOptions || { skipPreflight: true };
    console.log('[manualSendRawTransactionVerbose] broadcasting raw transaction with options:', options);
    const txid = await connection.sendRawTransaction(serializedTransaction, options);
    console.log('[manualSendRawTransactionVerbose] sendRawTransaction returned signature:', txid);
    // Poll status a few times
    for (let i = 0; i < 12; i++) {
      try {
        const status = await connection.getSignatureStatuses([txid], { searchTransactionHistory: true });
        console.log(`[manualSendRawTransactionVerbose] poll #${i+1} status:`, JSON.stringify(status && status.value ? status.value[0] : null));
        const s = status && status.value && status.value[0];
        if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
          console.log('[manualSendRawTransactionVerbose] Transaction confirmed:', txid);
          return { success: true, txid };
        }
        if (s && s.err) {
          console.warn('[manualSendRawTransactionVerbose] Transaction returned error in status:', s.err);
          return { success: false, reason: s.err, txid };
        }
      } catch (e) {
        console.warn('[manualSendRawTransactionVerbose] poll error:', (e as any)?.message ?? e);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    console.warn('[manualSendRawTransactionVerbose] polling timed out without confirmation');
    return { success: false, reason: 'timeout', txid };
  } catch (e) {
    console.error('[manualSendRawTransactionVerbose] sendRawTransaction failed:', (e as any)?.message ?? e);
    return { success: false, reason: (e as any)?.message ?? e };
  }
}