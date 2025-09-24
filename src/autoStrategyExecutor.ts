import { filterTokensByStrategy } from './bot/strategy';
import { unifiedBuy, unifiedSell } from './tradeSources';
import { getSolBalance } from './getSolBalance';

/**
 * Executes auto-trading for a user based on their strategy.
 * @param user - User object containing strategy, wallet, and secret
 * @param tokens - Array of available tokens to filter and trade
 * @param mode - 'buy' or 'sell'
 */
export async function autoExecuteStrategyForUser(user: any, tokens: any[], mode: 'buy' | 'sell' = 'buy', options: { simulateOnly?: boolean, listenerBypass?: boolean } = {}) {
  // Return a list of results per-token so callers can inspect simulation outcomes
  const results: any[] = [];
  if (!user.strategy || !user.wallet || !user.secret || user.strategy.enabled === false) return results;

  // If caller indicates listenerBypass, skip strategy filtering (sniper button flow should not filter)
  const filteredTokens = options.listenerBypass ? (Array.isArray(tokens) ? tokens : []) : filterTokensByStrategy(tokens, user.strategy);
  if (filteredTokens.length === 0) {
    console.log(`[autoExecute] No tokens matched for user ${user.id || user.username}`);
    return results;
  }

  for (const token of filteredTokens) {
    try {
      // Execute auto buy/sell (transaction sending is controlled globally by LIVE_TRADES and the central sender)
      let result;
      if (mode === 'buy') {
        result = await unifiedBuy(token.mint, user.strategy.buyAmount || 0.1, user.secret);
      } else {
        result = await unifiedSell(token.mint, user.strategy.sellAmount || 0.1, user.secret);
      }
      console.log(`[autoExecute] ${mode} for user ${user.id || user.username} on token ${token.mint}:`, result);
      const wasSimulated = !!options.simulateOnly || process.env.LIVE_TRADES !== 'true';
      results.push({ token: token.mint, result, simulated: wasSimulated });

      // If caller wanted simulateOnly, but simulation was successful, optionally perform live buy immediately
      // This protects users from ATA or other one-time fees by following simulation with a real send.
      const AUTO_LIVE = String(process.env.AUTO_LIVE_ON_SIM_SUCCESS || 'true').toLowerCase() === 'true';
      if (options.simulateOnly && wasSimulated && AUTO_LIVE && mode === 'buy') {
        try {
          // basic safety: ensure user has at least the buy amount + reserve to cover fees
          const minReserve = Number(process.env.MIN_SOL_RESERVE || '0.001');
          let solBal = 0;
          try {
            solBal = await getSolBalance(user.wallet || user.secret || '');
          } catch (e) {
            console.warn('[autoExecute] Failed to read SOL balance for safety check, proceeding with caution');
          }
          const required = (user.strategy && user.strategy.buyAmount ? user.strategy.buyAmount : 0.1) + minReserve;
          if (solBal < required) {
            console.warn(`[autoExecute] Skipping immediate live buy for ${user.id || user.username} on ${token.mint}: insufficient SOL (have ${solBal} < required ${required})`);
          } else {
            console.log(`[autoExecute] Simulation succeeded for ${token.mint}, attempting immediate live buy for user ${user.id || user.username}`);
            // Toggle LIVE_TRADES temporarily to allow the central sender to perform live sends
            const prevLive = process.env.LIVE_TRADES;
              try {
              process.env.LIVE_TRADES = 'true';
              const liveRes = await unifiedBuy(token.mint, user.strategy.buyAmount || 0.1, user.secret);
              console.log(`[autoExecute] Immediate live buy result for ${token.mint}:`, liveRes);
              // replace the prior simulated result with live result in outputs and mark immediateLive
              results[results.length - 1] = { token: token.mint, result: liveRes, simulated: false, immediateLive: true };
            } catch (liveErr) {
              console.error('[autoExecute] Immediate live buy failed:', liveErr);
              // keep simulated result and attach the live error info
              results[results.length - 1].liveError = String(liveErr);
            } finally {
              // restore previous LIVE_TRADES value
              if (prevLive === undefined) delete process.env.LIVE_TRADES; else process.env.LIVE_TRADES = prevLive;
            }
          }
        } catch (e) {
          console.error('[autoExecute] Error during immediate live-buy follow-up:', e);
        }
        // continue to next token (do not fall through to other live-only code below)
        continue;
      }
      // Optionally: log, notify user, update history, etc. (left as-is for live runs)
    } catch (err) {
      console.error(`[autoExecute] Failed to ${mode} token ${token.mint} for user ${user.id || user.username}:`, err);
      results.push({ token: token.mint, error: err });
    }
  }
  return results;
}
