// Emit a test notification payload compatible with telegramBot's in-process handler
// Usage: TEST_USER_ID=<telegramChatId> node scripts/emit_notification.js

const path = require('path');
// try to require the sniper module (to access notifier) and tokenUtils for HTML preview
let sniper = null;
let tokenUtils = null;
try { sniper = require(path.join(__dirname, '..', 'sniper.js')); } catch (e) { /* ignore */ }
try { tokenUtils = require(path.join(__dirname, '..', 'src', 'utils', 'tokenUtils')); } catch (e) { /* ignore */ }

const userId = process.env.TEST_USER_ID || String(123456789);
const mintAddr = process.env.TEST_MINT || 'TestMintPubKey1234567890';
const program = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const sig = 'TESTSIG1234567890';

const tok = {
  tokenAddress: mintAddr,
  address: mintAddr,
  mint: mintAddr,
  pairAddress: '',
  firstBlockTime: null,
  _canonicalAgeSeconds: 1.23,
  sourceProgram: program,
  sourceSignature: sig,
  sampleLogs: [ 'Program log: Instruction: InitializeMint' ]
};
const freshMintsArr = [mintAddr];
const userCollectorEvent = {
  time: new Date().toISOString(),
  program: program,
  signature: sig,
  kind: 'initialize',
  freshMints: freshMintsArr,
  matched: freshMintsArr,
  user: userId,
  candidateTokens: [tok]
};

const payload = {
  freshMints: freshMintsArr,
  event: userCollectorEvent,
  tokens: [tok],
  user: userId,
  time: userCollectorEvent.time,
  program,
  signature: sig,
  matched: freshMintsArr
};

if(tokenUtils && typeof tokenUtils.buildTokenMessage === 'function'){
  try{
    const built = tokenUtils.buildTokenMessage(tok, process.env.BOT_USERNAME || 'YourBotUsername', tok.pairAddress || tok.tokenAddress, userId);
    if(built && built.msg){ payload.html = built.msg; payload.inlineKeyboard = built.inlineKeyboard || null; }
  }catch(e){}
}

console.log('--- Emitting test payload ---');
console.log(JSON.stringify(payload, null, 2));

if(sniper && sniper.notifier && typeof sniper.notifier.emit === 'function'){
  try{
    sniper.notifier.emit('notification', payload);
    console.error('Emitted on sniper.notifier (in-process). If telegram bot is running with START_SNIPER_IN_PROCESS=true it will receive this.');
  }catch(e){ console.error('Error emitting on notifier:', e && e.message); }
} else {
  console.error('sniper.notifier not found in this process — printed payload only. To route to Telegram, run the bot with START_SNIPER_IN_PROCESS=true in the same process.');
}
