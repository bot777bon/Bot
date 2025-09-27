import path from 'path';
import fs from 'fs';
import { loadUsers, saveUsers } from './bot/helpers';

const LOCALES_DIR = path.resolve(__dirname, '..', 'locales');
let locales: Record<string, any> = {};

function loadLocaleFiles() {
  try {
    if (!fs.existsSync(LOCALES_DIR)) return;
    const files = fs.readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const lang = f.replace(/\.json$/, '');
        const p = path.join(LOCALES_DIR, f);
        const raw = fs.readFileSync(p, 'utf8');
        locales[lang] = JSON.parse(raw);
      } catch (e) {
        console.error('Failed to load locale', f, e && (e as any).message);
      }
    }
  } catch (e) {
    console.error('loadLocaleFiles failed', e && (e as any).message);
  }
}

loadLocaleFiles();

function getUserLang(userId?: string) {
  if (!userId) return 'en';
  const users = loadUsers();
  const u = users[String(userId)] || {};
  return u.lang || 'en';
}

export function setUserLang(userId: string, lang: string) {
  const users = loadUsers();
  users[String(userId)] = users[String(userId)] || {};
  users[String(userId)].lang = lang;
  saveUsers(users);
}

// simple dot-notation lookup and variable replacement
export function t(key: string, userId?: string, vars?: Record<string, string>) {
  const lang = getUserLang(userId) || 'en';
  const dict = locales[lang] || locales['en'] || {};
  const parts = key.split('.');
  let cur: any = dict;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p]; else { cur = null; break; }
  }
  let out = (cur && typeof cur === 'string') ? cur : key;
  if (vars) {
    for (const k of Object.keys(vars)) {
      out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), vars[k]);
    }
  }
  return out;
}

// Get translation for a specific language (bypass userId lookup)
export function tForLang(key: string, lang?: string, vars?: Record<string, string>) {
  const _lang = lang || 'en';
  const dict = locales[_lang] || locales['en'] || {};
  const parts = key.split('.');
  let cur: any = dict;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p]; else { cur = null; break; }
  }
  let out = (cur && typeof cur === 'string') ? cur : key;
  if (vars) {
    for (const k of Object.keys(vars)) {
      out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), vars[k]);
    }
  }
  return out;
}

export function getAvailableLangs() {
  // reload locale files on each call so changes on disk (new locales/fixes) are picked up
  try { loadLocaleFiles(); } catch (_) {}
  return Object.keys(locales);
}
