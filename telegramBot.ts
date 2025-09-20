// =================== Imports ===================
import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
import { loadUsers, saveUsers, walletKeyboard, getErrorMessage, limitHistory, hasWallet } from './src/bot/helpers';
import { helpMessages } from './src/helpMessages';
import { unifiedBuy, unifiedSell } from './src/tradeSources';
import { filterTokensByStrategy, registerBuyWithTarget, monitorAndAutoSellTrades } from './src/bot/strategy';
import { autoExecuteStrategyForUser } from './src/autoStrategyExecutor';
import { STRATEGY_FIELDS, buildTokenMessage, autoFilterTokens, notifyUsers, fetchDexScreenerTokens } from './src/utils/tokenUtils';
import { generateKeypair, exportSecretKey, parseKey } from './src/wallet';

console.log('--- Bot starting: Imports loaded ---');

dotenv.config();

console.log('--- dotenv loaded ---');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
console.log('TELEGRAM_BOT_TOKEN:', TELEGRAM_TOKEN);
if (!TELEGRAM_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not found in .env file. Please add TELEGRAM_BOT_TOKEN=YOUR_TOKEN to .env');
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_TOKEN as string);
console.log('--- Telegraf instance created ---');

function escapeHtml(str: string){
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
let users: Record<string, any> = loadUsers();
console.log('--- Users loaded ---');
// Optional: start sniper in-process and forward notifications to Telegram users.
if (String(process.env.START_SNIPER_IN_PROCESS || '').toLowerCase() === 'true') {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - dynamic require of JS module
  const sniperMod = require('./sniper.js');
    if (sniperMod) {
      try {
        // start the long-running listener in background
        if (typeof sniperMod.startSequentialListener === 'function') {
          (async () => {
            try { await sniperMod.startSequentialListener(); } catch (e) { console.error('[sniper] startSequentialListener failed', e); }
          })();
        }
        // subscribe to in-process notifier events
        if (sniperMod.notifier && typeof sniperMod.notifier.on === 'function') {
          sniperMod.notifier.on('notification', async (payload: any) => {
            try {
              // payload expected shape: { time, program, signature, user, matched, tokens, html, inlineKeyboard }
              const uid = payload && payload.user ? String(payload.user) : null;
              if (!uid) return;
              const chatId = Number(uid) || uid;
              let text = '';
              // If payload already contains a prebuilt HTML message, use it.
              if (payload && (payload as any).html) {
                try {
                  await bot.telegram.sendMessage(chatId, (payload as any).html, { parse_mode: 'HTML', reply_markup: (payload as any).inlineKeyboard || undefined } as any);
                  return;
                } catch (e: any) {
                  // fallthrough to other options
                }
              }
              // If the payload contains tokens array, format each token using buildTokenMessage
              try {
                const tokens = payload && payload.tokens && Array.isArray(payload.tokens) ? payload.tokens : null;
                if (tokens && tokens.length > 0) {
                  // reload users and respect per-user max trades preference
                  users = loadUsers();
                  const userObj = users && users[uid] ? users[uid] : null;
                  const defaultLimit = 3;
                  let userLimit = defaultLimit;
                  try {
                    const v = userObj && userObj.strategy && (userObj.strategy.maxTrades || userObj.strategy.listenerMaxCollect || userObj.strategy.maxCollect);
                    const n = Number(v);
                    if (!isNaN(n) && n > 0) userLimit = Math.max(1, Math.min(20, Math.floor(n)));
                  } catch (e) {}
                  const limit = Math.min(userLimit, tokens.length);
                  const botUsername = bot.botInfo?.username || process.env.BOT_USERNAME || 'YourBotUsername';

                  // Build a single combined HTML message by concatenating each token's built.msg
                  let combinedMsg = '';
                  const combinedKeyboard: any[] = [];
                  for (let i = 0; i < limit; i++) {
                    const t = tokens[i];
                    try {
                      const pairAddress = t.pairAddress || t.tokenAddress || t.address || t.mint || '';
                      const built = buildTokenMessage(t, botUsername, pairAddress, uid);
                      if (built && built.msg) {
                        if (combinedMsg) combinedMsg += '\n\n------------------------------\n\n';
                        combinedMsg += built.msg;
                        // Extract buy/sell callback rows (rows with callback_data) and append them
                        if (Array.isArray(built.inlineKeyboard)) {
                          for (const row of built.inlineKeyboard) {
                            try {
                              // if row contains callback_data, include it; otherwise skip to avoid URL-only rows
                              const hasCb = Array.isArray(row) && row.some((b: any) => b && b.callback_data);
                              if (hasCb) combinedKeyboard.push(row);
                            } catch (e) {}
                          }
                        }
                        continue;
                      }
                    } catch (e) { /* ignore token build errors */ }
                  }
                  // If we built something, send as single message
                  if (combinedMsg) {
                    try {
                      const replyMarkup: any = {};
                      if (combinedKeyboard.length) replyMarkup.inline_keyboard = combinedKeyboard;
                      await bot.telegram.sendMessage(chatId, combinedMsg, { parse_mode: 'HTML', reply_markup: replyMarkup } as any);
                      return;
                    } catch (e) {
                      // fallthrough to fallback
                    }
                  }
                }
              } catch (e) {}
              // build a simple fallback message
              const title = payload && payload.matched ? (Array.isArray(payload.matched) ? payload.matched.join(', ') : String(payload.matched)) : (payload && payload.tokens ? (Array.isArray(payload.tokens) ? payload.tokens.map((t:any)=>t.tokenAddress||t.address||t.mint).slice(0,5).join(', ') : String(payload.tokens)) : 'new token');
              const sig = (payload as any) && (payload as any).signature ? String((payload as any).signature) : null;
              text += `🚨 New token match for your strategy:\n${title}`;
              if (sig) text += `\nTx: https://solscan.io/tx/${sig}`;
              try { await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' } as any); } catch (e: any) { console.error('[sniper->telegram] sendMessage failed', e && e.message); }
            } catch (e: any) { console.error('[sniper->telegram] handler error', e && e.message); }
          });
        }
      } catch (e) { console.error('Failed to initialize in-process sniper module', e); }
    }
  } catch (e) { console.error('START_SNIPER_IN_PROCESS require error', e); }
}
let globalTokenCache: any[] = [];
let lastCacheUpdate = 0;
const CACHE_TTL = 1000 * 60 * 2;
let boughtTokens: Record<string, Set<string>> = {};
const restoreStates: Record<string, boolean> = {};

bot.command('auto_execute', async (ctx) => {
  const userId = String(ctx.from?.id);
  const user = users[userId];
  console.log(`[auto_execute] User: ${userId}`);
  if (!user || !user.strategy || !user.strategy.enabled) {
    await ctx.reply('You must set a strategy first using /strategy');
    return;
  }
  const now = Date.now();
  if (!globalTokenCache.length || now - lastCacheUpdate > CACHE_TTL) {
    globalTokenCache = await fetchDexScreenerTokens('solana');
    lastCacheUpdate = now;
  }
  await ctx.reply('Executing your strategy on matching tokens...');
  try {
    await autoExecuteStrategyForUser(user, globalTokenCache, 'buy');
    await ctx.reply('Strategy executed successfully!');
  } catch (e: any) {
    await ctx.reply('Error during auto execution: ' + getErrorMessage(e));
  }
});

const mainReplyKeyboard = Markup.keyboard([
  ['💼 Wallet', '⚙️ Strategy'],
  ['📊 Show Tokens', '🤝 Invite Friends'],
  ['سنايبر']
]).resize();

bot.start(async (ctx) => {
  await ctx.reply(
    '👋 Welcome to the Trading Bot!\nPlease choose an option:',
    mainReplyKeyboard
  );
});

bot.hears('💼 Wallet', async (ctx) => {
  const userId = String(ctx.from?.id);
  const user = users[userId];
  console.log(`[💼 Wallet] User: ${userId}`);
  if (user && hasWallet(user)) {
    const { getSolBalance } = await import('./src/getSolBalance');
    let balance = 0;
    try {
      balance = await getSolBalance(user.wallet);
    } catch {}
    await ctx.reply(
      `💼 Your Wallet:\nAddress: <code>${user.wallet}</code>\nBalance: <b>${balance}</b> SOL`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [ { text: '👁️ Show Private Key', callback_data: 'show_secret' } ]
          ]
        }
      }
    );
  } else {
    await ctx.reply('❌ No wallet found for this user.', walletKeyboard());
  }
});

bot.action('show_secret', async (ctx) => {
  console.log(`[show_secret] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  const user = users[userId];
  if (user && hasWallet(user)) {
    await ctx.reply('🔑 Your private key:\n<code>' + user.secret + '</code>', { parse_mode: 'HTML' });
  } else {
    await ctx.reply('❌ No wallet found for this user.');
  }
});

bot.hears('⚙️ Strategy', async (ctx) => {
  console.log(`[⚙️ Strategy] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  userStrategyStates[userId] = { step: 0, values: {} };
  await ctx.reply('🚦 Strategy Setup:\nPlease enter the required value for each field. Send "skip" to skip any optional field.');
  const field = STRATEGY_FIELDS[0];
  await ctx.reply(`📝 ${field.label}${field.optional ? ' (optional)' : ''}`);
});

bot.hears('📊 Show Tokens', async (ctx) => {
  console.log(`[📊 Show Tokens] User: ${String(ctx.from?.id)}`);
  ctx.reply('To view tokens matching your strategy, use the /show_token command.');
});

bot.hears('🤝 Invite Friends', async (ctx) => {
  console.log(`[🤝 Invite Friends] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  const inviteLink = `https://t.me/${ctx.me}?start=${userId}`;
  await ctx.reply(`🤝 Share this link to invite your friends:\n${inviteLink}`);
});

bot.hears('سنايبر', async (ctx) => {
  console.log(`[سنايبر] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  const user = users[userId] = users[userId] || {};
  const maxCollect = Number(user.listenerMaxCollect || user.strategy && user.strategy.listenerMaxCollect || 3) || 3;
  const timeoutMs = Number(process.env.RUNNER_TIMEOUT_MS || 60000);
  await ctx.reply(`🔎 جاري جلب أحدث ${maxCollect} منت${maxCollect>1? 'ات' : 'ة'} صريحة (قد يستغرق بعض الثواني)...`);
  try{
    // require sniper module and call collector
  const sniperMod = require('./sniper.js');
    if(!sniperMod || typeof sniperMod.collectFreshMints !== 'function'){
      await ctx.reply('⚠️ خطأ داخلي: دالة collectFreshMints غير متوفرة على الخادم.');
      return;
    }
    console.error(`[سنايبر] request user=${userId} maxCollect=${maxCollect} timeoutMs=${timeoutMs}`);
    let res = await sniperMod.collectFreshMints({ maxCollect, timeoutMs });
    console.error(`[سنايبر] initial resultCount=${(res && Array.isArray(res)) ? res.length : 'err'}`);
    // If empty, try one retry with longer timeout (to reduce false negatives)
    if(!res || !Array.isArray(res) || res.length===0){
      const retryTimeout = Math.min(Number(process.env.RUNNER_TIMEOUT_MS || 60000) * 2, 120000);
      console.error(`[سنايبر] initial empty - retrying with timeoutMs=${retryTimeout} for user=${userId}`);
      try{
        await ctx.reply('ℹ️ لم يتم العثور على مِنتات فورية — سأحاول مرة ثانية بمهلة أطول (قد يستغرق ذلك).');
      }catch(_){}
      res = await sniperMod.collectFreshMints({ maxCollect, timeoutMs: retryTimeout });
      console.error(`[سنايبر] retry resultCount=${(res && Array.isArray(res)) ? res.length : 'err'}`);
      if(!res || !Array.isArray(res) || res.length===0){
        await ctx.reply('ℹ️ لم يتم العثور على منتات صريحة خلال المحاولتين. قد تكون الشبكة هادئة أو هناك قيود RPC. جرّب مرة أخرى لاحقًا أو زد المهلة عبر RUNNER_TIMEOUT_MS.');
        return;
      }
    }
    // Send each collected token as a payload-style message (array line then detailed JSON)
    for(const tok of res){
      try{
        const mint = (tok as any).tokenAddress || (tok as any).address || (tok as any).mint || String(tok);
        const collectorPayload: any = {
          time: new Date().toISOString(),
          program: (tok as any).sourceProgram || null,
          signature: (tok as any).sourceSignature || null,
          kind: (tok as any).kind || 'initialize',
          freshMints: [mint],
          ageSeconds: (tok as any)._canonicalAgeSeconds || null,
          firstBlock: (tok as any).firstBlockTime ? Math.floor((tok as any).firstBlockTime/1000) : null,
          txBlock: (tok as any).txBlock || null,
          sampleLogs: (tok as any).sampleLogs || [],
        };
        // Prefer the same HTML + inline keyboard used by Show Token (buildTokenMessage)
        try{
          const botUsername = process.env.BOT_USERNAME || 'YourBotUsername';
          const pairAddress = (tok as any).pairAddress || (tok as any).tokenAddress || (tok as any).address || (tok as any).mint || '';
          // buildTokenMessage is imported at top; use it when available
          if(typeof buildTokenMessage === 'function'){
            try{
              const built = buildTokenMessage(tok, botUsername, pairAddress, userId);
              if(built && built.msg){
                // send the rich HTML message with inline keyboard if available
                await bot.telegram.sendMessage(Number(userId) || userId, built.msg, { parse_mode: 'HTML', reply_markup: built.inlineKeyboard || undefined } as any);
                continue;
              }
            }catch(e){ /* fallthrough to preformatted JSON */ }
          }
          // fallback: send array line then detailed JSON in <pre>
          await ctx.replyWithHTML(`<pre>${escapeHtml(JSON.stringify([mint]))}</pre>`, { disable_web_page_preview: true } as any);
          await ctx.replyWithHTML(`<pre>${escapeHtml(JSON.stringify(collectorPayload, null, 2))}</pre>`, { disable_web_page_preview: true } as any);
        }catch(e){
          // fallback: simple text
          await ctx.reply(`Mint: ${mint}`);
        }
      }catch(e){ console.error('[سنايبر->send] token send failed', e); }
    }
  }catch(e){
    console.error('سنايبر collector error', (e as any) && (e as any).message || e);
    try{ await ctx.reply('❌ حدث خطأ أثناء جلب المِنتات. تفقد سجلات الخادم.'); }catch(_){ }
  }
});

// Allow users to set preferred number of mints returned by the button
bot.command('set_mints', async (ctx) => {
  const userId = String(ctx.from?.id);
  const parts = ctx.message.text.split(' ').map(s=>s.trim()).filter(Boolean);
  if(parts.length < 2){
    await ctx.reply('استعمل: /set_mints <N> — ضع عدد المِنتات التي تريدها عند الضغط على سنايبر (مثال: /set_mints 3)');
    return;
  }
  const n = Number(parts[1]);
  if(isNaN(n) || n <= 0 || n > 20){
    await ctx.reply('الرجاء إدخال رقم صالح بين 1 و 20.');
    return;
  }
  users[userId] = users[userId] || {};
  users[userId].listenerMaxCollect = n;
  saveUsers(users);
  await ctx.reply(`✅ تم ضبط عدد المِنتات على ${n}. عند الضغط على سنايبر سيظهر لك أحدث ${n} مِنتات صريحة.`);
});

bot.command('notify_tokens', async (ctx) => {
  console.log(`[notify_tokens] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  const user = users[userId];
  if (!user || !user.strategy || !user.strategy.enabled) {
    await ctx.reply('❌ You must set a strategy first using /strategy');
    return;
  }
  const now = Date.now();
  if (!globalTokenCache.length || now - lastCacheUpdate > CACHE_TTL) {
    globalTokenCache = await fetchDexScreenerTokens('solana');
    lastCacheUpdate = now;
  }
  const filteredTokens = filterTokensByStrategy(globalTokenCache, user.strategy);
  if (!filteredTokens.length) {
    await ctx.reply('No tokens currently match your strategy.');
    return;
  }
  await notifyUsers(ctx.telegram, { [userId]: user }, filteredTokens);
  await ctx.reply('✅ Notification sent for tokens matching your strategy.');
});



bot.action(/buy_(.+)/, async (ctx: any) => {
  const userId = String(ctx.from?.id);
  const user = users[userId];
  const tokenAddress = ctx.match[1];
  console.log(`[buy] User: ${userId}, Token: ${tokenAddress}`);
  if (!user || !hasWallet(user) || !user.strategy || !user.strategy.enabled) {
    await ctx.reply('❌ No active strategy or wallet found.');
    return;
  }
  try {
    const amount = Number(user.strategy && user.strategy.buyAmount);
    if (!amount || isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Your strategy does not have a valid buy amount configured. Please set `buyAmount` in your strategy or use the Settings to configure the buy amount before using the Buy button.', { parse_mode: 'Markdown' });
      return;
    }
    await ctx.reply(`🛒 Buying token: <code>${tokenAddress}</code> with amount: <b>${amount}</b> SOL ...`, { parse_mode: 'HTML' });
    const result = await unifiedBuy(tokenAddress, amount, user.secret);
    if (result && result.tx) {
      if (!boughtTokens[userId]) boughtTokens[userId] = new Set();
      boughtTokens[userId].add(tokenAddress);
      const entry = `ManualBuy: ${tokenAddress} | Amount: ${amount} SOL | Source: unifiedBuy | Tx: ${result.tx}`;
      user.history = user.history || [];
      user.history.push(entry);
      limitHistory(user);
      saveUsers(users);
      registerBuyWithTarget(user, { address: tokenAddress }, result, user.strategy.targetPercent || 10);
      await ctx.reply(`Token bought successfully!\nAuto-sell order placed for profit target ${(user.strategy.targetPercent || 10)}%.\nCheck your orders with /pending_sells`);
    } else {
      await ctx.reply('Buy failed: Transaction was not completed.');
    }
  } catch (e) {
    await ctx.reply('❌ Error during buy: ' + getErrorMessage(e));
    console.error('buy error:', e);
  }
});



async function getUserTokenBalance(user: any, tokenAddress: string): Promise<number> {
  if (user && user.balances && typeof user.balances[tokenAddress] === 'number') {
    return user.balances[tokenAddress];
  }
  return user.strategy.buyAmount || 0.01;
}


bot.action(/sell_(.+)/, async (ctx: any) => {
  const userId = String(ctx.from?.id);
  const user = users[userId];
  const tokenAddress = ctx.match[1];
  console.log(`[sell] User: ${userId}, Token: ${tokenAddress}`);
  if (!user || !hasWallet(user) || !user.strategy || !user.strategy.enabled) {
    await ctx.reply('❌ No active strategy or wallet found.');
    return;
  }
  try {
    const sellPercent = user.strategy.sellPercent1 || 100;
    const balance = await getUserTokenBalance(user, tokenAddress);
    const amount = (balance * sellPercent) / 100;
    await ctx.reply(`🔻 Selling token: <code>${tokenAddress}</code> with <b>${sellPercent}%</b> of your balance (${balance}) ...`, { parse_mode: 'HTML' });
    const result = await unifiedSell(tokenAddress, amount, user.secret);
    if (result?.tx) {
      const entry = `ManualSell: ${tokenAddress} | Amount: ${amount} | Source: unifiedSell | Tx: ${result.tx}`;
      user.history = user.history || [];
      user.history.push(entry);
      limitHistory(user);
      saveUsers(users);
      await ctx.reply('Token sold successfully!');
    } else {
      await ctx.reply('Sell failed: Transaction was not completed.');
    }
  } catch (e: any) {
    await ctx.reply(`❌ Error during sell: ${getErrorMessage(e)}`);
    console.error('sell error:', e);
  }
});


bot.command('wallet', async (ctx) => {
  console.log(`[wallet] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  const user = users[userId];
  if (user && hasWallet(user)) {
    await ctx.reply('🔑 Your wallet private key:\n' + user.secret);
  } else {
    await ctx.reply('❌ No wallet found for this user.', walletKeyboard());
  }
});


bot.command(['create_wallet', 'restore_wallet'], async (ctx) => {
  console.log(`[${ctx.message.text.startsWith('/restore_wallet') ? 'restore_wallet' : 'create_wallet'}] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  let user = users[userId];
  if (!user) {
    user = {};
    users[userId] = user;
  }
  let keypair, secret;
  if (ctx.message.text.startsWith('/restore_wallet')) {
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) {
      await ctx.reply('❗ Please provide the private key after the command. Example: /restore_wallet <secret>');
      return;
    }
    try {
      keypair = parseKey(parts[1]);
      secret = exportSecretKey(keypair);
    } catch (e) {
      await ctx.reply('❌ Failed to restore wallet. Invalid key.');
      return;
    }
  } else {
    keypair = generateKeypair();
    secret = exportSecretKey(keypair);
  }
  user.secret = secret;
  user.wallet = keypair.publicKey?.toBase58?.() || keypair.publicKey;
  saveUsers(users);
  await ctx.reply('✅ Wallet ' + (ctx.message.text.startsWith('/restore_wallet') ? 'restored' : 'created') + ' successfully!\nAddress: <code>' + user.wallet + '</code>\nPrivate key (keep it safe): <code>' + user.secret + '</code>', { parse_mode: 'HTML' });
});


async function notifyAutoSell(user: any, sellOrder: any) {
  console.log(`[notifyAutoSell] User: ${user?.id || user?.userId || user?.telegramId}, Token: ${sellOrder.token}, Amount: ${sellOrder.amount}, Status: ${sellOrder.status}`);
  try {
    const chatId = user.id || user.userId || user.telegramId;
    let msg = `✅ Auto-sell order executed:\n`;
    msg += `Token: ${sellOrder.token}\nAmount: ${sellOrder.amount}\nTarget price: ${sellOrder.targetPrice}\n`;
    msg += sellOrder.tx ? `Transaction: ${sellOrder.tx}\n` : '';
    msg += sellOrder.status === 'success' ? 'Executed successfully.' : 'Execution failed.';
    await bot.telegram.sendMessage(chatId, msg);
  } catch {}
}

setInterval(async () => {
  console.log(`[monitorAndAutoSellTrades] Interval triggered`);
  if (!globalTokenCache || !Array.isArray(globalTokenCache)) return;
  if (!users || typeof users !== 'object') return;
  const tokens = globalTokenCache;
  for (const userId in users) {
    if (!userId || userId === 'undefined') {
      console.warn('[monitorAndAutoSellTrades] Invalid userId, skipping.');
      continue;
    }
    const user = users[userId];
    await monitorAndAutoSellTrades(user, tokens);
    const sentTokensDir = process.cwd() + '/sent_tokens';
    const userFile = `${sentTokensDir}/${userId}.json`;
    if (!require('fs').existsSync(userFile)) continue;
    let userTrades = [];
    try { userTrades = JSON.parse(require('fs').readFileSync(userFile, 'utf8')); } catch {}
    const executed = userTrades.filter((t: any) => t.mode === 'sell' && t.status === 'success' && t.auto && !t.notified);
    for (const sellOrder of executed) {
      await notifyAutoSell(user, sellOrder);
      (sellOrder as any).notified = true;
    }
    require('fs').writeFileSync(userFile, JSON.stringify(userTrades, null, 2));
  }
}, 5 * 60 * 1000);


// ========== Interactive wallet buttons ==========
bot.action('create_wallet', async (ctx) => {
  console.log(`[create_wallet] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  let user = users[userId];
  if (!user) {
    user = {};
    users[userId] = user;
  }
    // Prevent creating a wallet if one already exists
    if (user.secret && user.wallet) {
      await ctx.reply('You already have a wallet! You can view it from the menu.');
      return;
  }
  const keypair = generateKeypair();
  const secret = exportSecretKey(keypair);
  user.secret = secret;
  user.wallet = keypair.publicKey?.toBase58?.() || keypair.publicKey;
  saveUsers(users);
  await ctx.reply(`✅ Wallet created successfully!\nAddress: <code>${user.wallet}</code>\nPrivate key (keep it safe): <code>${user.secret}</code>`, { parse_mode: 'HTML' });
});

bot.action('restore_wallet', async (ctx) => {
  console.log(`[restore_wallet] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  restoreStates[userId] = true;
  await ctx.reply('🔑 Please send your wallet private key in a private message now:');
});

bot.on('text', async (ctx, next) => {
  console.log(`[text] User: ${String(ctx.from?.id)}, Message: ${ctx.message.text}`);
  const userId = String(ctx.from?.id);
  if (restoreStates[userId]) {
    const secret = ctx.message.text.trim();
    try {
      const keypair = parseKey(secret);
      let user = users[userId] || {};
      user.secret = exportSecretKey(keypair);
      user.wallet = keypair.publicKey?.toBase58?.() || keypair.publicKey;
      users[userId] = user;
      saveUsers(users);
      delete restoreStates[userId];

      await ctx.reply(`✅ Wallet restored successfully!\nAddress: <code>${user.wallet}</code>\nPrivate key (keep it safe): <code>${user.secret}</code>`, { parse_mode: 'HTML' });
          } catch {
            await ctx.reply('❌ Failed to restore wallet. Invalid key. Try again or create a new wallet.');
          }
          return;
        }
        if (typeof next === 'function') return next();
      });

      const userStrategyStates: Record<string, { step: number, values: Record<string, any>, phase?: string, tradeSettings?: Record<string, any> }> = {};

      bot.hears('⚙️ Strategy', async (ctx) => {
        const userId = String(ctx.from?.id);
        userStrategyStates[userId] = { step: 0, values: {} };
        await ctx.reply('🚦 Strategy Setup:\nPlease enter the required value for each field. Send "skip" to skip any optional field.');
        const field = STRATEGY_FIELDS[0];
        await ctx.reply(`📝 ${field.label}${field.optional ? ' (optional)' : ''}`);
      });

      bot.on('text', async (ctx, next) => {
        const userId = String(ctx.from?.id);
        if (userStrategyStates[userId]) {
          const state = userStrategyStates[userId];
          if (state.phase === 'tradeSettings') {
            const tradeFields = [
              { key: 'buyAmount', label: 'Buy amount per trade (SOL)', type: 'number' },
              { key: 'sellPercent1', label: 'Sell percent for first target (%)', type: 'number' },
              { key: 'target1', label: 'Profit target 1 (%)', type: 'number' },
              { key: 'sellPercent2', label: 'Sell percent for second target (%)', type: 'number' },
              { key: 'target2', label: 'Profit target 2 (%)', type: 'number' },
              { key: 'stopLoss', label: 'Stop loss (%)', type: 'number' },
              { key: 'maxTrades', label: 'Max concurrent trades', type: 'number' }
            ];
            if (state.step >= tradeFields.length) {
              delete userStrategyStates[userId];
              return;
            }
            const current = tradeFields[state.step];
            let value: any = ctx.message.text.trim();
            const numValue = Number(value);
            if (isNaN(numValue)) {
              await ctx.reply('❗ Please enter a valid number.');
              return;
            }
            value = numValue;
            if (!state.tradeSettings) state.tradeSettings = {};
            state.tradeSettings[current.key] = value;
            state.step++;
            if (state.step < tradeFields.length) {
              await ctx.reply(`📝 ${tradeFields[state.step].label}`);
            } else {
              if (!users[userId]) users[userId] = {};
              users[userId].strategy = { ...state.values, ...state.tradeSettings, enabled: true };
              saveUsers(users);
              delete userStrategyStates[userId];
              await ctx.reply('✅ Strategy and trade settings saved successfully! You can now press "📊 Show Tokens" to see matching tokens and trades.');
            }
            return;
          }
          if (state.step >= STRATEGY_FIELDS.length) {
            delete userStrategyStates[userId];
            return;
          }
          const field = STRATEGY_FIELDS[state.step];
          let value: any = ctx.message.text.trim();
          if (value === 'skip' && field.optional) {
            value = undefined;
          } else if (field.type === 'number') {
            const numValue = Number(value);
            if (isNaN(numValue)) {
              await ctx.reply('❗ Please enter a valid number.');
              return;
            }
            value = numValue;
          }
          state.values[field.key] = value;
          state.step++;
          if (state.step < STRATEGY_FIELDS.length) {
            const nextField = STRATEGY_FIELDS[state.step];
            await ctx.reply(`📝 ${nextField.label}${nextField.optional ? ' (optional)' : ''}`);
          } else {
            state.step = 0;
            state.phase = 'tradeSettings';
            state.tradeSettings = {};
            await ctx.reply('⚙️ Trade settings:\nPlease enter the buy amount per trade (SOL):');
          }
          return;
        }
        if (typeof next === 'function') return next();
      });

      bot.command('show_token', async (ctx) => {
  console.log(`[show_token] User: ${String(ctx.from?.id)}`);
        const userId = String(ctx.from?.id);
        const user = users[userId];
        if (!user || !user.strategy || !user.strategy.enabled) {
          await ctx.reply('❌ You must set a strategy first using /strategy');
          return;
        }
        const now = Date.now();
        if (!globalTokenCache.length || now - lastCacheUpdate > CACHE_TTL) {
          globalTokenCache = await fetchDexScreenerTokens('solana');
          lastCacheUpdate = now;
        }
        const filteredTokens = filterTokensByStrategy(globalTokenCache, user.strategy);
        const maxTrades = user.strategy.maxTrades && user.strategy.maxTrades > 0 ? user.strategy.maxTrades : 5;
        const tokensToTrade = filteredTokens.slice(0, maxTrades);
        if (!tokensToTrade.length) {
          await ctx.reply('No tokens currently match your strategy.');
          return;
        }
        await ctx.reply(`🔎 Found <b>${tokensToTrade.length}</b> tokens matching your strategy${filteredTokens.length > maxTrades ? ` (showing first ${maxTrades})` : ''}.\nExecuting auto-buy and auto-sell setup...`, { parse_mode: 'HTML' });

        let buyResults: string[] = [];
        let successCount = 0, failCount = 0;
        for (const token of tokensToTrade) {
          const tokenAddress = token.tokenAddress || token.address || token.mint || token.pairAddress;
          const buyAmount = user.strategy.buyAmount || 0.01;
          const name = token.name || token.symbol || tokenAddress;
          const price = token.priceUsd || token.price || '-';
          const dexUrl = token.url || (token.pairAddress ? `https://dexscreener.com/solana/${token.pairAddress}` : '');
          console.log(`[show_token] Attempting buy: User: ${userId}, Token: ${tokenAddress}, Amount: ${buyAmount}`);
          try {
            const buyResult = await unifiedBuy(tokenAddress, buyAmount, user.secret);
            console.log(`[show_token] Buy result:`, buyResult);
            if (buyResult && buyResult.tx) {
              successCount++;
              // سجل العملية في التاريخ
              const entry = `AutoShowTokenBuy: ${tokenAddress} | Amount: ${buyAmount} SOL | Source: unifiedBuy | Tx: ${buyResult.tx}`;
              user.history = user.history || [];
              user.history.push(entry);
              limitHistory(user);
              saveUsers(users);
              // سجل أمر بيع تلقائي
              const targetPercent = user.strategy.targetPercent || 10;
              registerBuyWithTarget(user, { address: tokenAddress, price }, buyResult, targetPercent);
              buyResults.push(`🟢 <b>${name}</b> (<code>${tokenAddress}</code>)\nPrice: <b>${price}</b> USD\nAmount: <b>${buyAmount}</b> SOL\nTx: <a href='https://solscan.io/tx/${buyResult.tx}'>${buyResult.tx}</a>\n<a href='${dexUrl}'>DexScreener</a> | <a href='https://solscan.io/token/${tokenAddress}'>Solscan</a>\n------------------------------`);
            } else {
              failCount++;
              console.log(`[show_token] Buy failed for token: ${tokenAddress}`);
              buyResults.push(`🔴 <b>${name}</b> (<code>${tokenAddress}</code>)\n❌ Failed to buy.`);
            }
          } catch (e) {
            failCount++;
            console.log(`[show_token] Error during buy for token: ${tokenAddress}`, e);
            buyResults.push(`🔴 <b>${name}</b> (<code>${tokenAddress}</code>)\n❌ Error: ${getErrorMessage(e)}`);
          }
        }
        let summary = `<b>Auto Buy Summary</b>\n------------------------------\n✅ Success: <b>${successCount}</b>\n❌ Failed: <b>${failCount}</b>\n------------------------------`;
  await ctx.reply(summary + '\n' + buyResults.join('\n'), { parse_mode: 'HTML' });
// Handle Buy/Sell actions from show_token
bot.action(/showtoken_buy_(.+)/, async (ctx) => {
  const userId = String(ctx.from?.id);
  // reload users from disk to pick up any runtime changes to strategy/wallet
  users = loadUsers();
  const user = users[userId];
  const tokenAddress = ctx.match[1];
  console.log(`[showtoken_buy] User: ${userId}, Token: ${tokenAddress}`);
  if (!user || !hasWallet(user) || !user.strategy || !user.strategy.enabled) {
    await ctx.reply('❌ No active strategy or wallet found.');
    return;
  }
  try {
    const amount = user.strategy.buyAmount || 0.01;
    await ctx.reply(`🛒 Buying token: <code>${tokenAddress}</code> with amount: <b>${amount}</b> SOL ...`, { parse_mode: 'HTML' });
    const result = await unifiedBuy(tokenAddress, amount, user.secret);
    if (result && result.tx) {
      const entry = `ShowTokenBuy: ${tokenAddress} | Amount: ${amount} SOL | Source: unifiedBuy | Tx: ${result.tx}`;
      user.history = user.history || [];
      user.history.push(entry);
      limitHistory(user);
      saveUsers(users);
      await ctx.reply(`Token bought successfully! Tx: ${result.tx}`);
    } else {
      await ctx.reply('Buy failed: Transaction was not completed.');
    }
  } catch (e) {
    await ctx.reply('❌ Error during buy: ' + getErrorMessage(e));
    console.error('showtoken buy error:', e);
  }
});

bot.action(/showtoken_sell_(.+)/, async (ctx) => {
  const userId = String(ctx.from?.id);
  // reload users from disk to pick up any runtime changes to strategy/wallet
  users = loadUsers();
  const user = users[userId];
  const tokenAddress = ctx.match[1];
  console.log(`[showtoken_sell] User: ${userId}, Token: ${tokenAddress}`);
  if (!user || !hasWallet(user) || !user.strategy || !user.strategy.enabled) {
    await ctx.reply('❌ No active strategy or wallet found.');
    return;
  }
  try {
    const sellPercent = Number(user.strategy && (user.strategy.sellPercent1 ?? user.strategy.sellPercent ?? 100));
    const buyAmount = Number(user.strategy && user.strategy.buyAmount);
    if (!buyAmount || isNaN(buyAmount) || buyAmount <= 0) {
      await ctx.reply('❌ Cannot determine amount to sell because your strategy does not have a valid `buyAmount` configured. Set a buy amount in your strategy or use the sell command with an explicit amount.', { parse_mode: 'Markdown' });
      return;
    }
    // Use buyAmount as an estimated holding to compute sell amount when exact balance is unknown
    const balance = buyAmount;
    const amount = (balance * sellPercent) / 100;
    await ctx.reply(`🔻 Selling token: <code>${tokenAddress}</code> with <b>${sellPercent}%</b> of your balance (${balance}) ...`, { parse_mode: 'HTML' });
    const result = await unifiedSell(tokenAddress, amount, user.secret);
    if (result && result.tx) {
      const entry = `ShowTokenSell: ${tokenAddress} | Amount: ${amount} | Source: unifiedSell | Tx: ${result.tx}`;
      user.history = user.history || [];
      user.history.push(entry);
      limitHistory(user);
      saveUsers(users);
      await ctx.reply(`Token sold successfully! Tx: ${result.tx}`);
    } else {
      await ctx.reply('Sell failed: Transaction was not completed.');
    }
  } catch (e) {
    await ctx.reply('❌ Error during sell: ' + getErrorMessage(e));
    console.error('showtoken sell error:', e);
  }
});
      });


// =================== Bot Launch ===================
console.log('--- About to launch bot ---');
(async () => {
  try {
    await bot.launch();
    console.log('✅ Bot launched successfully (polling)');
  } catch (err: any) {
    if (err?.response?.error_code === 409) {
      console.error('❌ Bot launch failed: Conflict 409. Make sure the bot is not running elsewhere or stop all other sessions.');
      process.exit(1);
    } else {
      console.error('❌ Bot launch failed:', err);
      process.exit(1);
    }
  }
})();
console.log('--- End of file reached ---');

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});