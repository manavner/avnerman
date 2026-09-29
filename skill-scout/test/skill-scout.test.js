'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const catalog = require('../lib/catalog');
const { scanSkillDir, assess } = require('../lib/security');
const { detectProject, tagsFromText } = require('../lib/detect');
const { recommend } = require('../lib/recommend');
const { codexTomlBlock } = require('../lib/install');

const fx = (n) => path.join(__dirname, 'fixtures', n);

test('catalog items are complete and unique', () => {
  const ids = new Set();
  for (const i of catalog.all()) {
    assert.ok(!ids.has(i.id), `duplicate id ${i.id}`); ids.add(i.id);
    for (const k of ['type', 'name', 'publisher', 'description', 'tags', 'rating', 'install', 'security']) assert.ok(i[k] !== undefined, `${i.id} missing ${k}`);
    assert.ok(['low', 'medium', 'high'].includes(i.security.level), `${i.id} bad level`);
    assert.ok(i.security.risks.length > 0, `${i.id} must describe its risks`);
    if (i.type === 'mcp') assert.ok(['stdio', 'http'].includes(i.install.transport), `${i.id} transport`);
  }
});

test('scanner flags a malicious skill as high risk', () => {
  const scan = scanSkillDir(fx('evil-skill'));
  assert.strictEqual(scan.level, 'high');
  const rules = new Set(scan.findings.map((f) => f.rule));
  for (const r of ['prompt-injection', 'hide-from-user', 'pipe-to-shell', 'secret-files', 'exfil-endpoint', 'hidden-text', 'env-dump', 'broad-tools']) assert.ok(rules.has(r), `missing ${r}`);
});

test('scanner works on Windows (CRLF) line endings', () => {
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-crlf-'));
  const text = fs.readFileSync(path.join(fx('evil-skill'), 'SKILL.md'), 'utf8').replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
  const rules = new Set(scanSkillDir(dir).findings.map((f) => f.rule));
  for (const r of ['broad-tools', 'prompt-injection', 'pipe-to-shell']) assert.ok(rules.has(r), `missing ${r}`);
});

test('scanner passes a clean skill', () => {
  const scan = scanSkillDir(fx('good-skill'));
  assert.strictEqual(scan.level, 'low');
  assert.deepStrictEqual(scan.findings, []);
});

test('deprecated items get a low trust score', async () => {
  const a = await assess(catalog.get('postgres-reference'));
  assert.ok(a.trust < 50);
});

test('detects this website project (vercel + static html + api)', () => {
  const tags = detectProject(path.join(__dirname, '..', '..'));
  for (const t of ['vercel', 'web', 'html']) assert.ok(tags.has(t), `missing ${t}`);
});

test('Hebrew descriptions map to tags', () => {
  const tags = tagsFromText('אתר חנות עם תשלומים ומסד נתונים');
  for (const t of ['web', 'payments', 'database']) assert.ok(tags.has(t), `missing ${t}`);
});

test('specific needs outrank generic web matches', async () => {
  const rows = await recommend(tagsFromText('online shop website with payments'), { target: 'both' });
  assert.strictEqual(rows[0].item.id, 'stripe');
});

test('codex filter drops Claude-only plugins', async () => {
  const rows = await recommend(new Map([['security', 'x'], ['web', 'x']]), { target: 'codex', limit: 50 });
  assert.ok(!rows.some((r) => r.item.id === 'security-guidance'));
});

test('codex TOML never contains secret values', () => {
  const gh = codexTomlBlock(catalog.get('github'), {});
  assert.match(gh, /bearer_token_env_var = "GITHUB_PERSONAL_ACCESS_TOKEN"/);
  const fc = codexTomlBlock(catalog.get('firecrawl'), {});
  assert.match(fc, /env_vars = \["FIRECRAWL_API_KEY"\]/);
  assert.throws(() => codexTomlBlock(catalog.get('filesystem'), {}), /ALLOWED_DIR/);
});
