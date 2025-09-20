/**
 * عند تسجيل صفقة شراء، احفظ سعر الدخول والهدف وأضف أمر بيع pending
 */
export function registerBuyWithTarget(user: any, token: any, buyResult: any, targetPercent = 10) {
  // تأكد من وجود معرف المستخدم داخل الكائن
  const userId = user.id || user.userId || user.telegramId;
  if (!user.id && userId) user.id = userId;
  // إذا لم يوجد معرف، استخدم معرف من السياق أو المفتاح
  if (!user.id && typeof token === 'object' && token.userId) user.id = token.userId;
  // إذا لم يوجد معرف، حاول جلبه من السياق الخارجي (مثلاً من ctx)
  // إذا لم يوجد معرف بعد كل المحاولات، أوقف التنفيذ
  if (!user.id || user.id === 'undefined') {
    console.warn('[registerBuyWithTarget] Invalid userId, skipping trade record.');
    return;
  }
  const sentTokensDir = path.join(process.cwd(), 'sent_tokens');
  const userFile = path.join(sentTokensDir, `${userId}.json`);
  let userTrades: any[] = [];
  if (fs.existsSync(userFile)) {
    try { userTrades = JSON.parse(fs.readFileSync(userFile, 'utf8')); } catch {}
  }
  // تعريف نوع موحد للتداول
  type TradeEntry = {
    id: string;
    mode: 'buy' | 'sell';
    token: string;
    amount: number;
    tx?: string;
    entryPrice?: number;
    targetPercent?: number;
    targetPrice?: number;
    stopLossPercent?: number;
    stopLossPrice?: number;
    status: 'success' | 'fail' | 'pending';
    linkedBuyTx?: string;
    time: number;
    stage?: number | string;
    strategy?: any;
    note?: string;
    error?: string;
    summary?: string;
  };

  // دالة توليد معرف فريد
  function genId() {
    return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
  }

  const entryPrice = token.price || token.entryPrice || null;
  const amount = user.strategy.buyAmount || 0.01;
  const tx = buyResult?.tx;
  // سجل صفقة الشراء
  const buyTrade: TradeEntry = {
    id: genId(),
    mode: 'buy',
    token: token.address,
    amount,
    tx,
    entryPrice,
    time: Date.now(),
    status: tx ? 'success' : 'fail',
    strategy: { ...user.strategy },
    summary: `Buy ${token.address} | ${amount} SOL | ${tx ? 'Tx: ' + tx : 'No Tx'}`,
  };
  userTrades.push(buyTrade);

  // سجل أوامر البيع التلقائية (هدف1، هدف2، وقف خسارة)
  if (tx && entryPrice) {
    // هدف 1
    const target1 = user.strategy.target1 || 10;
    const sellPercent1 = user.strategy.sellPercent1 || 50;
    const targetPrice1 = entryPrice * (1 + target1 / 100);
    userTrades.push({
      id: genId(),
      mode: 'sell',
      token: token.address,
      amount: amount * (sellPercent1 / 100),
      entryPrice,
      targetPercent: target1,
      targetPrice: targetPrice1,
      status: 'pending',
      linkedBuyTx: tx,
      time: Date.now(),
      stage: 1,
      strategy: { ...user.strategy },
      summary: `AutoSell1 ${token.address} | ${sellPercent1}% | Target: ${targetPrice1}`,
    });
    // هدف 2
    const target2 = user.strategy.target2 || 20;
    const sellPercent2 = user.strategy.sellPercent2 || 50;
    const targetPrice2 = entryPrice * (1 + target2 / 100);
    userTrades.push({
      id: genId(),
      mode: 'sell',
      token: token.address,
      amount: amount * (sellPercent2 / 100),
      entryPrice,
      targetPercent: target2,
      targetPrice: targetPrice2,
      status: 'pending',
      linkedBuyTx: tx,
      time: Date.now(),
      stage: 2,
      strategy: { ...user.strategy },
      summary: `AutoSell2 ${token.address} | ${sellPercent2}% | Target: ${targetPrice2}`,
    });
    // وقف الخسارة
    const stopLoss = user.strategy.stopLoss;
    if (stopLoss && stopLoss > 0) {
      const stopLossPrice = entryPrice * (1 - stopLoss / 100);
      userTrades.push({
        id: genId(),
        mode: 'sell',
        token: token.address,
        amount: amount * ((100 - sellPercent1 - sellPercent2) / 100),
        entryPrice,
        stopLossPercent: stopLoss,
        stopLossPrice,
        status: 'pending',
        linkedBuyTx: tx,
        time: Date.now(),
        stage: 'stopLoss',
        strategy: { ...user.strategy },
        summary: `StopLoss ${token.address} | ${stopLoss}% | Price: ${stopLossPrice}`,
      });
    }
  }
  fs.writeFileSync(userFile, JSON.stringify(userTrades, null, 2));
}
/**
 * مراقبة صفقات الشراء للمستخدم وتنفيذ البيع تلقائياً عند تحقق الشروط
 * @param user بيانات المستخدم
 * @param tokens قائمة العملات الحالية (مع الأسعار)
 * @param priceField اسم الحقل الذي يحتوي على السعر الحالي في token (مثلاً 'price')
 */
export async function monitorAndAutoSellTrades(user: any, tokens: any[], priceField = 'price') {
  const userId = user.id || user.userId || user.telegramId;
  const sentTokensDir = path.join(process.cwd(), 'sent_tokens');
  const userFile = path.join(sentTokensDir, `${userId}.json`);
  if (!fs.existsSync(userFile)) return;
  let userTrades: any[] = [];
  try { userTrades = JSON.parse(fs.readFileSync(userFile, 'utf8')); } catch {}
  // إيجاد أوامر البيع pending المرتبطة بصفقات شراء ناجحة
  const pendingSells = userTrades.filter(t => t.mode === 'sell' && t.status === 'pending' && t.linkedBuyTx);
  for (const sell of pendingSells) {
    const token = tokens.find(t => t.address === sell.token);
    if (!token || !token[priceField]) continue;
    const currentPrice = token[priceField];
    let shouldSell = false;
    // تحقق من أهداف الربح
    if (sell.targetPrice && currentPrice >= sell.targetPrice) shouldSell = true;
    // تحقق من وقف الخسارة
    if (sell.stopLossPrice && currentPrice <= sell.stopLossPrice) shouldSell = true;
    if (shouldSell) {
      try {
        const result = await unifiedSell(token.address, sell.amount, user.secret /*, { slippage: user.strategy.slippage }*/);
        const { fee, slippage } = extractTradeMeta(result, 'sell');
        // حدث حالة الأمر من pending إلى success
        sell.status = result?.tx ? 'success' : 'fail';
        sell.tx = result?.tx;
        sell.fee = fee;
        sell.slippage = slippage;
        sell.executedTime = Date.now();
        fs.writeFileSync(userFile, JSON.stringify(userTrades, null, 2));
      } catch (e) {
        sell.status = 'fail';
        sell.error = (e instanceof Error ? e.message : String(e));
        sell.executedTime = Date.now();
        fs.writeFileSync(userFile, JSON.stringify(userTrades, null, 2));
      }
    }
  }
}
// دالة مساعدة لاستخراج الرسوم والانزلاق من نتيجة unifiedBuy/unifiedSell
function extractTradeMeta(result: any, mode: 'buy' | 'sell') {
  let fee = null, slippage = null;
  if (mode === 'buy' && result) {
    fee = result.fee ?? result.feeAmount ?? null;
    slippage = result.slippage ?? null;
  } else if (mode === 'sell' && result) {
    fee = result.fee ?? result.feeAmount ?? null;
    slippage = result.slippage ?? null;
  }
  return { fee, slippage };
}
import fs from 'fs';
import path from 'path';
import { unifiedBuy, unifiedSell } from '../tradeSources';
/**
 * تنفيذ صفقات متعددة (شراء أو بيع) للمستخدم على قائمة عملات
 * @param user بيانات المستخدم
 * @param tokens قائمة العملات
 * @param mode 'buy' أو 'sell'
 * @param delayMs تأخير بين كل صفقة (ms)
 */
export async function executeBatchTradesForUser(user: any, tokens: any[], mode: 'buy' | 'sell' = 'buy', delayMs = 2000) {
  if (!user || !user.wallet || !user.secret || !user.strategy) return;
  const userId = user.id || user.userId || user.telegramId;
  const sentTokensDir = path.join(process.cwd(), 'sent_tokens');
  const userFile = path.join(sentTokensDir, `${userId}.json`);
  if (!fs.existsSync(sentTokensDir)) fs.mkdirSync(sentTokensDir);
  let userTrades: any[] = [];
  if (fs.existsSync(userFile)) {
    try { userTrades = JSON.parse(fs.readFileSync(userFile, 'utf8')); } catch {}
  }
  for (const token of tokens) {
    try {
      let result, amount, tx = null;
      if (mode === 'buy') {
        amount = user.strategy.buyAmount || 0.01;
        result = await unifiedBuy(token.address, amount, user.secret /*, { slippage }*/);
        tx = result?.tx;
      } else {
        const sellPercent = user.strategy.sellPercent1 || 100;
        const balance = token.balance || 0;
        amount = (balance * sellPercent) / 100;
        result = await unifiedSell(token.address, amount, user.secret /*, { slippage }*/);
        tx = result?.tx;
      }
      const { fee, slippage } = extractTradeMeta(result, mode);
      userTrades.push({
        mode,
        token: token.address,
        amount,
        tx,
        fee,
        slippage,
        time: Date.now(),
        status: tx ? 'success' : 'fail',
      });
      fs.writeFileSync(userFile, JSON.stringify(userTrades, null, 2));
    } catch (e) {
      userTrades.push({
        mode,
        token: token.address,
        error: (e instanceof Error ? e.message : String(e)),
        time: Date.now(),
        status: 'fail',
      });
      fs.writeFileSync(userFile, JSON.stringify(userTrades, null, 2));
    }
    if (delayMs > 0) await new Promise(res => setTimeout(res, delayMs));
  }
}
import type { Strategy } from './types';

/**
 * Filters a list of tokens based on the user's strategy settings.
 * All comments and variable names are in English for clarity.
 */
export function filterTokensByStrategy(tokens: any[], strategy: Strategy): any[] {
  if (!strategy || !Array.isArray(tokens)) return [];
  // Use getField from tokenUtils for robust field extraction
  const { getField } = require('../utils/tokenUtils');
  const filtered = tokens.filter(token => {
    // Price in USD
    const price = Number(getField(token, 'priceUsd', 'price', 'priceNative', 'baseToken.priceUsd', 'baseToken.price'));
    if (strategy.minPrice !== undefined && price < strategy.minPrice) return false;
    if (strategy.maxPrice !== undefined && price > strategy.maxPrice) return false;

    // Market Cap
    const marketCap = Number(getField(token, 'marketCap', 'fdv', 'baseToken.marketCap', 'baseToken.fdv'));
    if (strategy.minMarketCap !== undefined && marketCap < strategy.minMarketCap) return false;

    // Liquidity
    const liquidity = Number(getField(token, 'liquidity', 'liquidityUsd', 'baseToken.liquidity', 'baseToken.liquidityUsd'));
    if (strategy.minLiquidity !== undefined && liquidity < strategy.minLiquidity) return false;

    // Volume
    const volume = Number(getField(token, 'volume', 'volume24h', 'amount', 'totalAmount', 'baseToken.volume', 'baseToken.amount'));
    if (strategy.minVolume !== undefined && volume < strategy.minVolume) return false;

    // Holders
    const holders = Number(getField(token, 'holders', 'totalAmount', 'baseToken.holders', 'baseToken.totalAmount'));
    if (strategy.minHolders !== undefined && holders < strategy.minHolders) return false;

  // Age in minutes (robust extraction)
  let ageMinutes: number | undefined = undefined;
    let ageVal = getField(token, 'ageMinutes', 'age', 'createdAt', 'poolOpenTime', 'genesis_date', 'baseToken.createdAt');
    if (typeof ageVal === 'string') {
      if (!isNaN(Number(ageVal))) ageVal = Number(ageVal);
      else if (/^\d{4}-\d{2}-\d{2}/.test(ageVal)) ageVal = Date.parse(ageVal);
    }
    if (typeof ageVal === 'number' && !isNaN(ageVal)) {
      if (ageVal > 1e12) { // ms timestamp
        ageMinutes = Math.floor((Date.now() - ageVal) / 60000);
      } else if (ageVal > 1e9) { // s timestamp
        ageMinutes = Math.floor((Date.now() - ageVal * 1000) / 60000);
      } else if (ageVal < 1e7 && ageVal > 0) { // already in minutes
        ageMinutes = ageVal;
      }
    }
    if (typeof ageMinutes !== 'number' || isNaN(ageMinutes)) {
      console.warn(`[filterTokensByStrategy] Token ${token.address || token.symbol || token.name} ignored: cannot determine age.`);
      return false;
    }
    if (strategy.minAge !== undefined && ageMinutes < strategy.minAge) return false;

    // Verification
    const verified = getField(token, 'verified', 'baseToken.verified') === true || getField(token, 'verified', 'baseToken.verified') === 'true';
    if (strategy.onlyVerified === true && !verified) return false;

    // Strategy enabled
    if (strategy.enabled === false) return false;

    // طباعة معلومات العملة المقبولة
    console.log(`[filterTokensByStrategy] Accepted token: ${token.address || token.symbol || token.name}, ageMinutes=${ageMinutes}`);
    return true;
  });
  return filtered;
}