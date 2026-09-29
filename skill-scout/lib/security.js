'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const catalog = require('./catalog');
const src = require('./sources');
const { LEVEL_ORDER, c, levelBadge } = require('./util');

// ---------------------------------------------------------------------------
// Static scanner for skills (SKILL.md + bundled scripts). Skills are plain
// instructions + code that the agent follows with YOUR permissions, so we look
// for prompt injection, hidden text, exfiltration and dangerous shell usage.
// ---------------------------------------------------------------------------
const RULES = [
  { id: 'pipe-to-shell', severity: 'high', re: /(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i, msg: 'Downloads and executes a remote script' },
  { id: 'prompt-injection', severity: 'high', re: /(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts)/i, msg: 'Classic prompt-injection phrase' },
  // "never tell the user to X" is normal advice; hiding something FROM the user is not.
  { id: 'hide-from-user', severity: 'high', re: /((do not|don't|never)\s+(tell|inform|notify|mention|reveal|show)\s+(this\s+|it\s+|anything\s+)?(to\s+)?the\s+user\b(?!\s+to\b)|without\s+(telling|informing|notifying)\s+the\s+user|hide\s[^\n]{0,30}from\s+the\s+user)/i, msg: 'Asks the agent to hide actions from the user' },
  { id: 'secret-files', severity: 'high', re: /(\.ssh[\/\\]|\bid_rsa\b|\bid_ed25519\b|\.aws[\/\\]credentials|\.netrc\b|\.npmrc\b|\.pypirc\b|login\.keychain|security\s+find-(generic|internet)-password|wallet\.dat|\.gnupg[\/\\])/i, msg: 'Reads credential / key files' },
  { id: 'browser-cookies', severity: 'high', re: /(browser_cookie3|pycookiecheat|rookiepy|(Chrome|Chromium|Brave|Edge) Safe Storage|[\/\\](Default|Profile \d+)[\/\\](Network[\/\\])?Cookies\b)/, msg: 'Reads your browser cookies (logged-in sessions)' },
  { id: 'exfil-endpoint', severity: 'high', re: /(discord(app)?\.com\/api\/webhooks|webhook\.site|requestbin|ngrok\.(io|app)|pastebin\.com|transfer\.sh|pipedream\.net)/i, msg: 'Known data-exfiltration endpoint' },
  { id: 'skip-permissions', severity: 'high', re: /(dangerously-skip-permissions|--yolo|bypassPermissions|approval_policy\s*=\s*"?never)/i, msg: 'Tries to disable agent permission prompts' },
  { id: 'destructive-rm', severity: 'high', re: /rm\s+-(rf|fr)\s+(\/|~|\$HOME)(\s|$)/i, msg: 'Destructive delete of home/root' },
  { id: 'env-dump', severity: 'medium', re: /(process\.env\b(?!\.)|os\.environ\b(?!\.get|\[)|printenv|\benv\s*\|)/, msg: 'Reads the whole environment (may contain API keys)' },
  { id: 'dotenv', severity: 'medium', re: /(^|[\s'"/])\.env(\.local)?\b/, msg: 'Touches .env secret files' },
  { id: 'obfuscation', severity: 'medium', re: /(base64\s+(-d|--decode)|b64decode|atob\(|fromCharCode\(|\\x[0-9a-f]{2}\\x[0-9a-f]{2}\\x[0-9a-f]{2})/i, msg: 'Decodes obfuscated content' },
  { id: 'dynamic-exec', severity: 'medium', re: /(\beval\s*\(|\bexec\s*\(|child_process|subprocess\.(Popen|call|run)\([^)]*shell\s*=\s*True|os\.system\()/, msg: 'Dynamic code / shell execution' },
  { id: 'outbound-post', severity: 'medium', re: /(curl\s[^\n]*(-X\s*POST|--data|-d\s)|requests\.post\(|method:\s*['"]POST['"]|urllib\.request\.urlopen\()/i, msg: 'Sends data to a remote server' },
  { id: 'sudo', severity: 'medium', re: /\bsudo\s+/, msg: 'Uses sudo (root privileges)' },
  { id: 'broad-tools', severity: 'medium', re: /^allowed-tools:.*\bBash\b(?!\()/m, msg: 'Pre-approves unrestricted Bash for this skill' },
  { id: 'global-install', severity: 'low', re: /(npm\s+(i|install)\s+-g|pip3?\s+install|curl\s[^\n]*-o\s)/i, msg: 'Installs software' },
  { id: 'chmod', severity: 'low', re: /chmod\s+(\+x|777)/, msg: 'Changes file permissions' },
];
// Zero-width space, bidi overrides/isolates, word joiners and Unicode "tag"
// characters can hide instructions. ZWJ/ZWNJ and LRM/RLM are NOT flagged: they
// are normal in Hebrew, Persian and emoji. A BOM is only suspicious mid-file.
const HIDDEN_CHARS = /[​‪-‮⁠-⁤⁦-⁩]|\uDB40[\uDC00-\uDC7F]|.﻿/;
// In code, only bidi controls matter ("Trojan Source"); other invisible
// characters are common in minified bundles and string literals.
const BIDI_CHARS = /[\u202A-\u202E\u2066-\u2069]/;
const PROSE_EXT = /\.(md|txt)$/i;
// Comment lines in code don't execute; skip them (prose files are all "comments").
const COMMENT_LINE = /^\s*(\/\/|#(?!!)|\*|\/\*|<!--|REM\s)/i;
const BINARY_EXT = /\.(exe|dll|so|dylib|bin|msi|scr|jar)$/i;
const TEXT_EXT = /\.(md|txt|py|js|mjs|cjs|ts|sh|bash|zsh|ps1|rb|json|ya?ml|toml|html)$/i;
// Files the agent doesn't load or run while using the skill (docs for humans,
// tests, CI). Security tools legitimately quote attack strings here, so
// findings in them are reported but never raise the risk level.
const NOT_LOADED = /(^|[\/\\])(tests?|__tests__|spec|docs?|examples?|translations?|i18n|fixtures|\.github|\.gitlab)([\/\\])|(^|[\/\\])(README|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|HISTORY|SECURITY|LICENSE|TODOS?)[^\/\\]*$|\.(test|spec)\.[a-z]+$|^\.gitlab-ci\.yml$/i;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

function scanSkillDir(dir) {
  const findings = [];
  const files = walk(dir);
  const hash = crypto.createHash('sha256');
  if (!files.some((f) => path.basename(f) === 'SKILL.md')) {
    findings.push({ severity: 'low', rule: 'no-skill-md', file: '.', line: 0, msg: 'No SKILL.md found – may not be a valid skill' });
  }
  for (const file of files.sort()) {
    const rel = path.relative(dir, file) || path.basename(file);
    const context = NOT_LOADED.test(rel) ? 'docs/tests' : 'loaded';
    const add = (f) => findings.push(context === 'loaded' ? { ...f, context } : { ...f, context, severity: 'low', original: f.severity });
    try { hash.update(rel).update(fs.readFileSync(file)); } catch { /* unreadable */ }
    if (BINARY_EXT.test(file)) { add({ severity: 'medium', rule: 'binary', file: rel, line: 0, msg: 'Bundled executable/binary cannot be reviewed' }); continue; }
    if (!TEXT_EXT.test(file)) continue;
    let text;
    // Normalise Windows (CRLF) line endings so every rule sees the same text.
    try { text = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n'); } catch { continue; }
    const lines = text.split('\n');
    const prose = PROSE_EXT.test(file);
    lines.forEach((ln, i) => {
      if (!prose && COMMENT_LINE.test(ln)) return;
      if ((prose ? HIDDEN_CHARS : BIDI_CHARS).test(ln)) add({ severity: 'high', rule: 'hidden-text', file: rel, line: i + 1, msg: 'Invisible/bidi Unicode characters (can hide instructions)' });
      for (const r of RULES) {
        if (r.id === 'broad-tools') continue;
        if (r.re.test(ln)) add({ severity: r.severity, rule: r.id, file: rel, line: i + 1, msg: r.msg, text: ln.trim().slice(0, 120) });
      }
    });
    if (path.basename(file) === 'SKILL.md') {
      const fm = text.match(/^---\n([\s\S]*?)\n---/);
      const broad = RULES.find((r) => r.id === 'broad-tools');
      if (fm && broad.re.test(fm[1])) add({ severity: broad.severity, rule: broad.id, file: rel, line: 1, msg: broad.msg });
    }
  }
  return { files: files.length, findings, level: levelFromFindings(findings), hash: hash.digest('hex').slice(0, 16), summary: summarize(findings) };
}

function levelFromFindings(findings) {
  if (findings.some((f) => f.severity === 'high')) return 'high';
  if (findings.filter((f) => f.severity === 'medium').length >= 1) return 'medium';
  return 'low';
}

// Group findings by rule: [{ rule, severity, msg, count, examples: [finding...] }], worst first.
function summarize(findings) {
  const groups = new Map();
  for (const f of findings) {
    const key = `${f.severity}|${f.rule}`;
    if (!groups.has(key)) groups.set(key, { rule: f.rule, severity: f.severity, msg: f.msg, count: 0, examples: [] });
    const g = groups.get(key);
    g.count++;
    if (g.examples.length < 3) g.examples.push(f);
  }
  const order = { high: 0, medium: 1, low: 2 };
  return [...groups.values()].sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
}

// ---------------------------------------------------------------------------
// Risk + trust assessment of a catalog item (optionally with live data).
// ---------------------------------------------------------------------------
function monthsSince(iso) {
  return iso ? (Date.now() - new Date(iso).getTime()) / (30 * 24 * 3600 * 1000) : null;
}

async function assess(item, { live = false } = {}) {
  const sec = item.security || {};
  const res = {
    id: item.id, level: sec.level || 'medium', reasons: [], warnings: [...(sec.warnings || [])],
    userWarnings: [], advisories: [], vulns: [], popularity: {}, trust: 50,
  };
  let trust = 40 + (item.official ? 25 : 0) + (item.rating || 0) * 5;
  if (item.official) res.reasons.push(`Published by the vendor/maintainer (${item.publisher})`);
  else res.reasons.push(`Community project (${item.publisher}) – review before trusting`);
  if (item.deprecated) { trust -= 30; res.reasons.push('Deprecated / archived'); }

  for (const p of item.packages || []) {
    const bl = catalog.blocklisted(p.ecosystem, p.name);
    if (bl) { res.level = 'blocked'; res.reasons.push(`BLOCKLISTED: ${bl.reason}`); trust = 0; }
    for (const w of catalog.globalWarningsFor(p.ecosystem, p.name)) res.warnings.push(w);
  }

  if (live) {
    const tasks = [src.githubRepo(item.repo), src.githubUserWarnings(item.repo), src.githubAdvisories(item.repo)];
    const [gh, userWarnings, advisories] = await Promise.all(tasks);
    if (gh) {
      res.popularity.stars = gh.stars;
      trust += Math.min(15, Math.log10(gh.stars + 1) * 3);
      if (gh.archived) { trust -= 25; res.reasons.push('Repository is ARCHIVED (no more security fixes)'); }
      const m = monthsSince(gh.pushedAt);
      if (m !== null && m > 12) { trust -= 10; res.reasons.push(`No commits for ${Math.round(m)} months`); }
      if (!gh.license) res.reasons.push('No license declared');
    }
    res.userWarnings = userWarnings;
    res.advisories = advisories;
    if (advisories.some((a) => ['high', 'critical'].includes(a.severity))) res.reasons.push('Has published HIGH/CRITICAL security advisories (check they are fixed)');

    for (const p of item.packages || []) {
      if (p.ecosystem === 'npm') {
        const [info, dl] = await Promise.all([src.npmInfo(p.name), src.npmWeeklyDownloads(p.name)]);
        if (dl !== null) { res.popularity.weeklyDownloads = (res.popularity.weeklyDownloads || 0) + dl; trust += Math.min(10, Math.log10(dl + 1) * 2); }
        if (info) {
          if (info.deprecated) { trust -= 20; res.reasons.push(`npm: deprecated – ${info.deprecated}`); }
          if (info.installScripts.length) { trust -= 5; res.reasons.push(`npm: runs install scripts (${info.installScripts.join('; ')})`); }
          const vulns = await src.osvVulns('npm', p.name, info.latest);
          if (vulns) res.vulns.push(...vulns);
        }
      } else if (p.ecosystem === 'PyPI') {
        const info = await src.pypiInfo(p.name);
        const vulns = await src.osvVulns('PyPI', p.name, info && info.latest);
        if (vulns) res.vulns.push(...vulns);
      }
    }
    if (res.vulns.some((v) => v.malicious)) { res.level = 'blocked'; trust = 0; res.reasons.push('OSV lists this package as MALICIOUS'); }
    else if (res.vulns.length) { trust -= 15; res.reasons.push(`${res.vulns.length} known vulnerabilit${res.vulns.length === 1 ? 'y' : 'ies'} in the latest version`); }
  }

  res.trust = Math.max(0, Math.min(100, Math.round(trust - LEVEL_ORDER[res.level] * 5)));
  return res;
}

// Human-readable, grouped scan result (a few examples per rule instead of every hit).
function scanLines(scan) {
  const out = [`Skill scan: ${scan.files} files → risk ${levelBadge(scan.level)}`];
  const main = scan.summary.filter((g) => g.severity !== 'low');
  if (!main.length) out.push(c.green('  No suspicious patterns in the files the agent loads or runs.'));
  for (const g of main) {
    out.push(`  ${g.severity === 'high' ? c.red('HIGH') : c.yellow('MED ')} ${g.msg} ${c.dim(`(${g.rule}, ${g.count}x)`)}`);
    g.examples.forEach((f) => out.push(c.dim(`       ${f.file}:${f.line}${f.text ? '  → ' + f.text : ''}`)));
  }
  const ignored = scan.findings.filter((f) => f.context === 'docs/tests').length;
  if (ignored) out.push(c.dim(`  + ${ignored} match(es) in docs/tests/changelogs – not counted (security docs often quote attacks).`));
  out.push(c.dim('  Pattern scanning catches common tricks, not everything – read SKILL.md before trusting a skill.'));
  return out;
}

module.exports = { scanSkillDir, scanLines, assess, RULES };
