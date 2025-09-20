import path from 'path';
/**
 * تحقق هل المستخدم اشترى العملة مسبقًا ولم يبعها بعد
 */
export function hasPendingBuy(userId: string, tokenAddress: string): boolean {
  if (!userId || userId === 'undefined') {
    console.warn('[hasPendingBuy] Invalid userId, skipping check.');
    return false;
  }
  const sentTokensDir = path.join(process.cwd(), 'sent_tokens');
  const userFile = path.join(sentTokensDir, `${userId}.json`);
  if (!fs.existsSync(userFile)) return false;
  try {
    const userTrades = JSON.parse(fs.readFileSync(userFile, 'utf8'));
    return userTrades.some((t: any) => t.mode === 'buy' && t.token === tokenAddress && t.status === 'success' &&
      !userTrades.some((s: any) => s.mode === 'sell' && s.token === tokenAddress && s.status === 'success'));
  } catch {
    return false;
  }
}
import fs from 'fs';
import { Markup } from 'telegraf';

export function getErrorMessage(e: any): string {
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  return JSON.stringify(e);
}

export function limitHistory(user: any, max = 50) {
  if (user && Array.isArray(user.history) && user.history.length > max) {
    user.history = user.history.slice(-max);
  }
}

export function hasWallet(user: any): boolean {
  return !!(user && user.wallet && user.secret);
}

export function walletKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔑 Restore Wallet', 'restore_wallet')],
    [Markup.button.callback('🆕 Create Wallet', 'create_wallet')]
  ]);
}

export function loadUsers(): Record<string, any> {
  try {
    if (fs.existsSync('users.json')) {
      return JSON.parse(fs.readFileSync('users.json', 'utf8'));
    }
  } catch {}
  return {};
}

export function saveUsers(users: Record<string, any>) {
  try {
    fs.writeFileSync('users.json', JSON.stringify(users, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving users.json:', e);
  }
}