'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const DATA_DIR = process.env.SKILL_SCOUT_HOME || path.join(HOME, '.skill-scout');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  bold: wrap('1'), dim: wrap('2'), red: wrap('31'), green: wrap('32'),
  yellow: wrap('33'), blue: wrap('34'), magenta: wrap('35'), cyan: wrap('36'),
};

const LEVEL_ORDER = { low: 0, medium: 1, high: 2, blocked: 3 };
function levelBadge(level) {
  const map = { low: c.green('LOW'), medium: c.yellow('MEDIUM'), high: c.red('HIGH'), blocked: c.red(c.bold('BLOCKED')) };
  return map[level] || level;
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function writeCache(cache) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch { /* cache is best-effort */ }
}

// GitHub's search API allows 10 requests/min without a token, 30 with one.
let lastSearch = 0;
async function searchPace() {
  const gap = githubHeaders().authorization ? 2100 : 6100;
  const wait = lastSearch + gap - Date.now();
  lastSearch = Math.max(Date.now(), lastSearch + gap);
  if (wait > 0 && !process.env.SKILL_SCOUT_NO_PACE) await new Promise((r) => setTimeout(r, wait));
}

// The scan turns the cache off so security data is always fresh.
let cacheEnabled = true;
function setCache(on) { cacheEnabled = on; }

// fetch JSON with a timeout and a 24h on-disk cache. Returns null on any failure.
async function fetchJson(url, { headers = {}, method = 'GET', body, cache = cacheEnabled, timeoutMs = 12000 } = {}) {
  const key = `${method} ${url} ${body || ''}`;
  const store = cache ? readCache() : null;
  if (store && store[key] && Date.now() - store[key].t < CACHE_TTL_MS) return store[key].v;
  if (url.includes('api.github.com/search/')) await searchPace();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method, body, signal: ctrl.signal,
      headers: { 'user-agent': 'skill-scout', accept: 'application/json', ...headers },
    });
    if (!res.ok) return null;
    const v = await res.json();
    if (store) { store[key] = { t: Date.now(), v }; writeCache(store); }
    return v;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function githubHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

module.exports = { setCache, HOME, DATA_DIR, c, LEVEL_ORDER, levelBadge, fetchJson, githubHeaders, exists };
