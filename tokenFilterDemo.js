// Dynamic, visual, English-only token filter demo for DexScreener Boosts API
const fetch = require('node-fetch');

const ENDPOINT = process.env.DEXSCREENER_API_ENDPOINT || 'https://api.dexscreener.com/token-boosts/latest/v1';


const readline = require('readline');

function askCriteria() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  /** @type {{minAmount?: number, description?: string}} */
  const criteria = {};
    rl.question('Enter minimum amount (number, default 10): ', (minAmount) => {
      criteria.minAmount = isNaN(Number(minAmount)) || minAmount === '' ? 10 : Number(minAmount);
      rl.question('Enter description substring to filter (leave empty for no filter): ', (desc) => {
        criteria.description = desc || '';
        rl.close();
        resolve(criteria);
      });
    });
  });
}

/**
 * @param {any[]} tokens
 * @param {{minAmount?: number, description?: string}} criteria
 */
function filterTokens(tokens, criteria) {
  return tokens.filter(t => {
    const amount = t && (t.amount ?? t.tokenAmount ?? t.balance ?? 0);
    const description = (t && (t.description || t.name || t.title || '')) || '';
    if (criteria.minAmount && amount < criteria.minAmount) return false;
    if (criteria.description && !description.toLowerCase().includes(criteria.description.toLowerCase())) return false;
    return true;
  });
}

/**
 * @param {any[]} tokens
 */
function printTokens(tokens) {
  if (!tokens || !tokens.length) {
    console.log('No tokens match the criteria.');
    return;
  }
  tokens.forEach((t, i) => {
    const amount = t && (t.amount ?? t.tokenAmount ?? t.balance ?? 0);
    const bar = '█'.repeat(Math.min(Math.max(0, Math.round(amount / 5)), 20));
    const description = (t && (t.description || t.name || t.title)) || 'Unknown';
    const tokenAddress = (t && (t.tokenAddress || t.address || t.id)) || 'N/A';
    const url = (t && (t.url || t.link)) || 'N/A';
    console.log(`\n${i+1}. ${description} (${tokenAddress})`);
    console.log(`Amount: ${amount} ${bar}`);
    console.log(`URL: ${url}`);
  });
}


async function main() {
  try {
    const criteria = await askCriteria();
    const res = await fetch(ENDPOINT);
    const data = await res.json();
    console.log('[DEBUG] Raw API response:', JSON.stringify(data, null, 2));
    // إذا كانت الاستجابة مصفوفة مباشرة (كما هو الحال مع Boosts API)، استخدمها كما هي
    let tokens = Array.isArray(data) ? data : Array.isArray(data.pairs) ? data.pairs : Array.isArray(data.tokens) ? data.tokens : Array.isArray(data.boosts) ? data.boosts : Array.isArray(data.profiles) ? data.profiles : [];
    console.log('--- Sample tokens (first 5) ---');
    printTokens(tokens.slice(0, 5));
    const filtered = filterTokens(tokens, criteria);
    console.log('\n--- Filtered tokens ---');
    printTokens(filtered.slice(0, 10));
  } catch (e) {
    console.error('Error fetching or filtering tokens:', e);
  }
}

main();