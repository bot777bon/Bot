const fs = require('fs');
const path = require('path');
const p = path.resolve(__dirname, '..', 'users.json');
try {
  const data = fs.readFileSync(p, 'utf8');
  const users = JSON.parse(data);
  let dirty = false;
  for (const id of Object.keys(users)) {
    /** @type {{wallets?: any[], wallet?: string, secret?: string}} */
    const u = users[id] || {};
    u.wallets = Array.isArray(u.wallets) ? u.wallets.slice() : [];

    if (u.wallet && u.secret) {
      const found = u.wallets.find((w) => w && w.wallet === u.wallet);
      if (!found) {
        u.wallets.push({ wallet: u.wallet, secret: u.secret, createdAt: Date.now() });
        dirty = true;
      } else if (!found.secret) {
        found.secret = u.secret;
        dirty = true;
      }
    }

    // dedupe by wallet keeping the newest (highest createdAt)
    const map = new Map();
    for (const item of u.wallets) {
      if (!item || !item.wallet) continue;
      const prev = map.get(item.wallet);
      if (!prev || (item.createdAt || 0) > (prev.createdAt || 0)) {
        map.set(item.wallet, { ...item });
      }
    }
    const arr = Array.from(map.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    u.wallets = arr;

    if (u.wallets.length) {
      const active = u.wallets[u.wallets.length - 1];
      u.wallets = u.wallets.map((w) => ({ ...w, active: !!(w && active && w.wallet === active.wallet) }));
      if (u.wallet !== active.wallet || u.secret !== active.secret) {
        u.wallet = active.wallet;
        u.secret = active.secret;
        dirty = true;
      }
    } else {
      if (u.wallet || u.secret) {
        delete u.wallet;
        delete u.secret;
        dirty = true;
      }
    }
    users[id] = u;
  }
  if (dirty) {
    fs.writeFileSync(p, JSON.stringify(users, null, 2));
  }
  console.log('normalized', dirty);
} catch (e) {
  const err = /** @type {any} */ (e);
  const msg = (err && (err.message || err.toString())) || 'unknown';
  console.error('normalize failed:', msg);
  process.exit(2);
}
