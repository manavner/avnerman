'use strict';
const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');
const src = require('./sources');
const { LEVEL_ORDER } = require('./util');

// ---------------------------------------------------------------------------
// Static scanner for skills (SKILL.md + bundled scripts). Skills are plain
// instructions + code that the agent follows with YOUR permissions, so we look
// for prompt injection, hidden text, exfiltration and dangerous shell usage.
// ---------------------------------------------------------------------------
const RULES = [
  { id: 'pipe-to-shell', severity: 'high', re: /(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i, msg: 'Downloads and executes a remote script' },
  { id: 'prompt-injection', severity: 'high', re: /(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts)/i, msg: 'Classic prompt-injection phrase' },
  { id: 'hide-from-user', severity: 'high', re: /(do not|don't|never)\s+(tell|inform|mention|show|reveal)[^\n]{0,40}(the )?user/i, msg: 'Asks the agent to hide actions from the user' },
  { id: 'secret-files', severity: 'high', re: /(\.ssh\/|id_rsa|id_ed25519|\.aws\/credentials|\.netrc|\.npmrc|keychain|wallet\.dat|\.gnupg)/i, msg: 'References credential / key files' },
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
// zero-width, bidi override and Unicode "tag" characters are used to hide instructions
const HIDDEN_CHARS = /[​-‏‪-‮⁠-⁤﻿]|\uDB40[\uDC00-\uDC7F]/;
const BINARY_EXT = /\.(exe|dll|so|dylib|bin|msi|scr|jar)$/i;
const TEXT_EXT = /\.(md|txt|py|js|mjs|cjs|ts|sh|bash|zsh|ps1|rb|json|ya?ml|toml|html)$/i;

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
  if (!files.some((f) => path.basename(f) === 'SKILL.md')) {
    findings.push({ severity: 'low', rule: 'no-skill-md', file: '.', line: 0, msg: 'No SKILL.md found – may not be a valid skill' });
  }
  for (const file of files) {
    const rel = path.relative(dir, file) || path.basename(file);
    if (BINARY_EXT.test(file)) { findings.push({ severity: 'medium', rule: 'binary', file: rel, line: 0, msg: 'Bundled executable/binary cannot be reviewed' }); continue; }
    if (!TEXT_EXT.test(file)) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    lines.forEach((ln, i) => {
      if (HIDDEN_CHARS.test(ln)) findings.push({ severity: 'high', rule: 'hidden-text', file: rel, line: i + 1, msg: 'Invisible/bidi Unicode characters (can hide instructions)' });
      for (const r of RULES) {
        if (r.id === 'broad-tools') continue;
        if (r.re.test(ln)) findings.push({ severity: r.severity, rule: r.id, file: rel, line: i + 1, msg: r.msg, text: ln.trim().slice(0, 120) });
      }
    });
    if (path.basename(file) === 'SKILL.md') {
      const fm = text.match(/^---\n([\s\S]*?)\n---/);
      const broad = RULES.find((r) => r.id === 'broad-tools');
      if (fm && broad.re.test(fm[1])) findings.push({ severity: broad.severity, rule: broad.id, file: rel, line: 1, msg: broad.msg });
    }
  }
  return { files: files.length, findings, level: levelFromFindings(findings) };
}

function levelFromFindings(findings) {
  if (findings.some((f) => f.severity === 'high')) return 'high';
  if (findings.filter((f) => f.severity === 'medium').length >= 1) return 'medium';
  return 'low';
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

module.exports = { scanSkillDir, assess, RULES };
