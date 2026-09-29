'use strict';
// Detects a project's technology stack from its files and turns it into tags
// that match the catalog's tags.
const fs = require('fs');
const path = require('path');
const { exists } = require('./util');

const DEP_TAGS = {
  react: ['react', 'frontend', 'web'], next: ['nextjs', 'react', 'frontend', 'web', 'vercel'],
  vue: ['vue', 'frontend', 'web'], svelte: ['frontend', 'web'], vite: ['frontend', 'web'],
  '@supabase/supabase-js': ['supabase', 'database', 'auth'], stripe: ['stripe', 'payments'],
  '@stripe/stripe-js': ['stripe', 'payments'], pg: ['postgres', 'database'], prisma: ['database', 'postgres'],
  '@prisma/client': ['database'], mongoose: ['database'], playwright: ['testing', 'browser'],
  '@playwright/test': ['testing', 'browser'], jest: ['testing'], vitest: ['testing'], cypress: ['testing', 'browser'],
  '@sentry/node': ['sentry', 'monitoring'], '@sentry/react': ['sentry', 'monitoring'], '@sentry/nextjs': ['sentry', 'monitoring'],
  '@modelcontextprotocol/sdk': ['mcp-dev', 'ai'], '@anthropic-ai/sdk': ['ai'], openai: ['ai'],
  express: ['backend', 'node'], fastify: ['backend', 'node'], tailwindcss: ['frontend', 'design', 'css'],
  xlsx: ['excel', 'documents'], exceljs: ['excel', 'documents'], 'pdf-lib': ['pdf', 'documents'], docx: ['documents'],
  'tone': ['audio', 'music'], 'howler': ['audio', 'music'], wrangler: ['cloudflare'],
};
const PY_TAGS = {
  django: ['backend', 'web'], flask: ['backend', 'web'], fastapi: ['backend'], pandas: ['data'], openpyxl: ['excel', 'documents'],
  torch: ['ai', 'ml'], transformers: ['ai', 'ml'], librosa: ['audio', 'music'], psycopg: ['postgres', 'database'],
  psycopg2: ['postgres', 'database'], supabase: ['supabase', 'database'], stripe: ['stripe', 'payments'], mcp: ['mcp-dev', 'ai'],
  anthropic: ['ai'], openai: ['ai'], pytest: ['testing'], 'sentry-sdk': ['sentry', 'monitoring'], playwright: ['testing', 'browser'],
};
const FILE_TAGS = [
  ['vercel.json', ['vercel', 'deploy']], ['wrangler.toml', ['cloudflare']], ['supabase', ['supabase', 'database']],
  ['Dockerfile', ['devops']], ['.github', ['github']], ['index.html', ['web', 'frontend', 'html']],
  ['go.mod', ['go', 'backend']], ['Cargo.toml', ['rust']], ['pom.xml', ['java']], ['build.gradle', ['java']],
  ['.mcp.json', ['mcp-dev']], ['figma.config.json', ['figma', 'design']],
];
// words in a free-text description (English + Hebrew) → tags
const KEYWORDS = {
  website: ['web', 'frontend', 'html'], 'אתר': ['web', 'frontend', 'html'], app: ['web', 'frontend'], 'אפליקציה': ['web', 'frontend'],
  react: ['react', 'frontend'], next: ['nextjs'], api: ['backend'], server: ['backend'], 'שרת': ['backend'],
  database: ['database'], 'מסד נתונים': ['database'], 'דאטהבייס': ['database'], supabase: ['supabase', 'database'], postgres: ['postgres', 'database'],
  payment: ['payments', 'stripe'], 'תשלום': ['payments', 'stripe'], 'תשלומים': ['payments', 'stripe'], shop: ['ecommerce', 'payments'], 'חנות': ['ecommerce', 'payments'],
  test: ['testing'], 'בדיקות': ['testing'], design: ['design', 'frontend'], 'עיצוב': ['design', 'frontend'], figma: ['figma', 'design'],
  music: ['music', 'audio'], 'מוזיקה': ['music', 'audio'], audio: ['audio'], 'שמע': ['audio'], ai: ['ai'], 'בינה מלאכותית': ['ai'],
  excel: ['excel', 'documents'], 'אקסל': ['excel', 'documents'], word: ['documents'], pdf: ['pdf', 'documents'], report: ['documents', 'reports'], 'דוח': ['documents', 'reports'],
  mcp: ['mcp-dev', 'ai'], scraping: ['scraping'], 'סריקה': ['scraping'], search: ['search'], 'חיפוש': ['search'],
  security: ['security'], 'אבטחה': ['security'], github: ['github'], vercel: ['vercel'], deploy: ['devops', 'deploy'],
  notion: ['notion'], jira: ['jira'], linear: ['linear'], python: ['python'], 'פייתון': ['python'], telegram: ['backend', 'node'], 'טלגרם': ['backend'],
  bot: ['backend', 'ai'], 'בוט': ['backend', 'ai'], image: ['images'], 'תמונות': ['images'], docs: ['docs'], 'תיעוד': ['docs'],
};

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function detectProject(dir) {
  const tags = new Map(); // tag -> evidence
  const add = (list, why) => list.forEach((t) => { if (!tags.has(t)) tags.set(t, why); });

  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg) {
    add(['node'], 'package.json');
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const d of Object.keys(deps)) if (DEP_TAGS[d]) add(DEP_TAGS[d], `dependency "${d}"`);
  }
  for (const f of ['requirements.txt', 'pyproject.toml', 'Pipfile']) {
    const p = path.join(dir, f);
    if (!exists(p)) continue;
    add(['python'], f);
    const text = fs.readFileSync(p, 'utf8').toLowerCase();
    for (const [dep, t] of Object.entries(PY_TAGS)) if (new RegExp(`(^|[\\s"'\\[])${dep.replace(/[-.]/g, '\\$&')}([\\s=<>~\\[;"',]|$)`, 'm').test(text)) add(t, `${f}: ${dep}`);
  }
  for (const [f, t] of FILE_TAGS) if (exists(path.join(dir, f))) add(t, f);
  if (exists(path.join(dir, 'api')) && exists(path.join(dir, 'vercel.json'))) add(['backend', 'node'], 'api/ serverless functions');
  try {
    const gitCfg = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    if (/github\.com/.test(gitCfg)) add(['github'], '.git remote on GitHub');
  } catch { /* not a git repo */ }
  try {
    const names = fs.readdirSync(dir);
    if (names.some((n) => /\.(xlsx|docx|pptx|pdf)$/i.test(n))) add(['documents'], 'office/pdf files in project');
    if (names.some((n) => /\.(mp3|wav|flac|mid)$/i.test(n))) add(['audio', 'music'], 'audio files in project');
    const loc = names.filter((n) => /\.(js|ts|py|go|rs|java|cs)$/.test(n)).length;
    if (loc > 200) add(['large-codebase'], `${loc} source files at top level`);
  } catch { /* unreadable */ }
  return tags;
}

function tagsFromText(text) {
  const tags = new Map();
  const lower = (text || '').toLowerCase();
  for (const [kw, list] of Object.entries(KEYWORDS)) {
    const hit = /^[a-z]+$/.test(kw) ? new RegExp(`\\b${kw}`).test(lower) : lower.includes(kw);
    if (hit) list.forEach((t) => { if (!tags.has(t)) tags.set(t, `description mentions "${kw}"`); });
  }
  return tags;
}

module.exports = { detectProject, tagsFromText };
