'use strict';
// Installs catalog items into Claude Code and/or Codex.
// Principles: show risks first, ask before changing anything, back up config
// files, and never write secrets to disk – configs reference environment variables.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { HOME, c, exists } = require('./util');
const { scanSkillDir } = require('./security');

const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');

function hasCmd(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

function run(cmd, args, dryRun, log) {
  log(c.dim(`$ ${[cmd, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`));
  if (dryRun) return true;
  // On Windows `claude`/`codex` are often .cmd shims that need a shell; cmd.exe
  // doesn't quote for us, so quote arguments with spaces ourselves.
  const win = process.platform === 'win32';
  const r = win
    ? spawnSync([cmd, ...args].map((a) => (/[\s&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' '), { stdio: 'inherit', shell: true })
    : spawnSync(cmd, args, { stdio: 'inherit' });
  return r.status === 0;
}

function backup(file) {
  if (exists(file)) fs.copyFileSync(file, `${file}.bak-skill-scout`);
}

// Replace {{VAR}} placeholders in args with user-provided values.
function resolveArgs(inst, values) {
  return (inst.args || []).map((a) => a.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!values[k]) throw new Error(`Missing value for ${k}. Pass --set ${k}=...`);
    return values[k];
  }));
}

// Secrets referenced from config. Optional ones only when the variable is already set.
const secretEnv = (inst) => (inst.env || []).filter((e) => !e.arg && (!e.optional || process.env[e.name]));

// ------------------------------- Claude Code --------------------------------
function claudeMcp(item, { scope, dryRun, values, log, cwd }) {
  const inst = item.install;
  const name = item.id;
  const claudeScope = scope === 'project' ? 'project' : 'user';
  if (hasCmd('claude') || dryRun) {
    // Name (and URL) go first: -e/--header are variadic and would swallow them.
    const args = ['mcp', 'add'];
    if (inst.transport === 'http') {
      args.push(name, inst.url, '-s', claudeScope, '--transport', 'http');
      for (const e of secretEnv(inst)) if (e.header) args.push('--header', `${e.header}: ${e.prefix || ''}\${${e.name}}`);
    } else {
      args.push(name, '-s', claudeScope);
      for (const e of secretEnv(inst)) args.push('-e', `${e.name}=\${${e.name}}`);
      args.push('--', inst.command, ...resolveArgs(inst, values));
    }
    return run('claude', args, dryRun, log);
  }
  if (claudeScope !== 'project') {
    log(c.yellow('`claude` CLI not found. Install Claude Code, or re-run with --scope project to write .mcp.json.'));
    return false;
  }
  const file = path.join(cwd, '.mcp.json');
  const cfg = exists(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  cfg.mcpServers = cfg.mcpServers || {};
  if (inst.transport === 'http') {
    const headers = {};
    for (const e of secretEnv(inst)) if (e.header) headers[e.header] = `${e.prefix || ''}\${${e.name}}`;
    cfg.mcpServers[name] = { type: 'http', url: inst.url, ...(Object.keys(headers).length ? { headers } : {}) };
  } else {
    const env = {};
    for (const e of secretEnv(inst)) env[e.name] = `\${${e.name}}`;
    cfg.mcpServers[name] = { type: 'stdio', command: inst.command, args: resolveArgs(inst, values), ...(Object.keys(env).length ? { env } : {}) };
  }
  backup(file);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  log(c.green(`Wrote ${file}`));
  return true;
}

// ---------------------------------- Codex -----------------------------------
const tomlStr = (s) => JSON.stringify(String(s));

function codexTomlBlock(item, values) {
  const inst = item.install;
  const lines = [`[mcp_servers.${tomlStr(item.id)}]`];
  if (inst.transport === 'http') {
    lines.push(`url = ${tomlStr(inst.url)}`);
    for (const e of secretEnv(inst)) {
      if (!e.header) continue;
      if (e.header === 'Authorization' && (e.prefix || '').startsWith('Bearer')) lines.push(`bearer_token_env_var = ${tomlStr(e.name)}`);
      else lines.push(`env_http_headers = { ${tomlStr(e.header)} = ${tomlStr(e.name)} }`);
    }
  } else {
    lines.push(`command = ${tomlStr(inst.command)}`);
    lines.push(`args = [${resolveArgs(inst, values).map(tomlStr).join(', ')}]`);
    const names = secretEnv(inst).map((e) => tomlStr(e.name));
    if (names.length) lines.push(`env_vars = [${names.join(', ')}]`);
  }
  return lines.join('\n') + '\n';
}

function codexMcp(item, { scope, dryRun, values, log, cwd }) {
  const file = scope === 'project' ? path.join(cwd, '.codex', 'config.toml') : path.join(CODEX_HOME, 'config.toml');
  const block = codexTomlBlock(item, values);
  const current = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  const header = new RegExp(`^\\[mcp_servers\\.("?)${item.id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\1\\]`, 'm');
  if (header.test(current)) { log(c.yellow(`Codex: "${item.id}" already configured in ${file} – skipped.`)); return true; }
  log(c.dim(`Append to ${file}:\n${block}`));
  if (dryRun) return true;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  fs.writeFileSync(file, current ? `${current.replace(/\n*$/, '\n')}\n${block}` : block);
  log(c.green(`Updated ${file}`));
  return true;
}

// ---------------------------------- Skills ----------------------------------
function skillDirs(target, scope, cwd) {
  const dirs = [];
  if (target !== 'codex') dirs.push(scope === 'project' ? path.join(cwd, '.claude', 'skills') : path.join(HOME, '.claude', 'skills'));
  if (target !== 'claude') dirs.push(scope === 'project' ? path.join(cwd, '.agents', 'skills') : path.join(CODEX_HOME, 'skills'));
  return dirs;
}

// Download one folder of a GitHub repo with a sparse, shallow git clone.
function fetchRepoPath(repo, subpath, ref, log) {
  if (!hasCmd('git')) throw new Error('git is required to download skills');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-scout-'));
  const q = { stdio: 'ignore' };
  const url = `https://github.com/${repo}.git`;
  log(c.dim(`Downloading ${repo}/${subpath || ''} ...`));
  const args = ['clone', '--depth', '1', '--filter=blob:none', '--sparse'];
  if (ref) args.push('--branch', ref);
  if (spawnSync('git', [...args, url, tmp], q).status !== 0) throw new Error(`git clone failed for ${url}`);
  if (subpath && spawnSync('git', ['-C', tmp, 'sparse-checkout', 'set', subpath], q).status !== 0) throw new Error(`path ${subpath} not found`);
  const dir = subpath ? path.join(tmp, subpath) : tmp;
  if (!exists(dir)) throw new Error(`path ${subpath} not found in ${repo}`);
  const commit = spawnSync('git', ['-C', tmp, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  return { dir, tmp, commit };
}

function printScan(scan, log) {
  const counts = { high: 0, medium: 0, low: 0 };
  scan.findings.forEach((f) => counts[f.severity]++);
  log(`Security scan: ${scan.files} files – ${c.red(counts.high + ' high')}, ${c.yellow(counts.medium + ' medium')}, ${counts.low} low`);
  for (const f of scan.findings.filter((x) => x.severity !== 'low').slice(0, 15)) {
    log(`  ${f.severity === 'high' ? c.red('HIGH') : c.yellow('MED ')} ${f.file}:${f.line}  ${f.msg}${f.text ? c.dim('  → ' + f.text) : ''}`);
  }
}

async function installSkill({ repo, path: subpath, ref }, opts) {
  const { target, scope, dryRun, log, cwd, confirm, force } = opts;
  const { dir, tmp, commit } = fetchRepoPath(repo, subpath, ref, log);
  try {
    const scan = scanSkillDir(dir);
    printScan(scan, log);
    if (scan.level === 'high' && !force) {
      log(c.red('High-risk patterns found. Review the files above; re-run with --force only if you trust them.'));
      return false;
    }
    if (scan.level === 'medium' && !(await confirm('Medium-risk patterns found. Install anyway?'))) return false;
    const name = path.basename(subpath || repo);
    for (const base of skillDirs(target, scope, cwd)) {
      const dest = path.join(base, name);
      log(`${dryRun ? '[dry-run] ' : ''}Copy → ${dest}`);
      if (dryRun) continue;
      fs.mkdirSync(base, { recursive: true });
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(dir, dest, { recursive: true });
      fs.writeFileSync(path.join(dest, '.skill-scout.json'), JSON.stringify({ repo, path: subpath, commit, installed: new Date().toISOString(), scanLevel: scan.level }, null, 2));
    }
    return true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------- Entry point --------------------------------
async function install(item, opts) {
  const { target, log } = opts;
  const inst = item.install || {};
  let ok = true;
  if (item.type === 'mcp') {
    if (target !== 'codex') ok = claudeMcp(item, opts) && ok;
    if (target !== 'claude') ok = codexMcp(item, opts) && ok;
    const secrets = secretEnv(inst).filter((e) => !e.optional);
    if (secrets.length) {
      const win = process.platform === 'win32';
      log(c.yellow(`\nThis server needs secrets. They are NOT stored in config files – ${win ? 'save them as Windows environment variables (then open a new terminal):' : 'add them to your shell profile (~/.zshrc or ~/.bashrc):'}`));
      for (const e of secrets) log(`  ${win ? `setx ${e.name} "..."` : `export ${e.name}="..."`}   ${c.dim((win ? 'REM ' : '# ') + e.description)}`);
    }
    if (inst.transport === 'http' && !secrets.length) log(c.dim('Remote server: on first use you will be asked to sign in (OAuth). In Claude Code use /mcp; in Codex: codex mcp login ' + item.id));
  } else if (item.type === 'skill') {
    ok = await installSkill(inst, opts);
  } else if (item.type === 'plugin') {
    if (target !== 'codex' && inst.claude) {
      log(c.bold('\nClaude Code plugins are installed from inside Claude Code. Run these commands in a Claude Code session:'));
      inst.claude.forEach((cmd) => log('  ' + c.cyan(cmd)));
    }
    if (target !== 'claude') {
      if (inst.codexSkills) {
        log(c.bold('\nInstalling the equivalent skills for Codex:'));
        for (const s of inst.codexSkills) ok = (await installSkill(s, { ...opts, target: 'codex' })) && ok;
      } else if (inst.codex) inst.codex.forEach((cmd) => log('  ' + c.cyan(cmd)));
      else log(c.yellow('No Codex equivalent for this plugin.'));
    }
  }
  return ok;
}

// ----------------------------- What's installed -----------------------------
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function listInstalled(cwd) {
  const out = { claudeMcp: [], codexMcp: [], claudeSkills: [], codexSkills: [] };
  const userCfg = readJson(path.join(HOME, '.claude.json'));
  if (userCfg && userCfg.mcpServers) out.claudeMcp.push(...Object.keys(userCfg.mcpServers).map((n) => `${n} (user)`));
  const proj = userCfg && userCfg.projects && userCfg.projects[cwd];
  if (proj && proj.mcpServers) out.claudeMcp.push(...Object.keys(proj.mcpServers).map((n) => `${n} (local)`));
  const mcpJson = readJson(path.join(cwd, '.mcp.json'));
  if (mcpJson && mcpJson.mcpServers) out.claudeMcp.push(...Object.keys(mcpJson.mcpServers).map((n) => `${n} (project)`));
  for (const f of [path.join(CODEX_HOME, 'config.toml'), path.join(cwd, '.codex', 'config.toml')]) {
    if (!exists(f)) continue;
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/^\[mcp_servers\.("?)([^\]"]+)\1\]/gm)) out.codexMcp.push(m[2]);
  }
  const ls = (d) => { try { return fs.readdirSync(d).filter((n) => exists(path.join(d, n, 'SKILL.md'))); } catch { return []; } };
  out.claudeSkills.push(...ls(path.join(HOME, '.claude', 'skills')), ...ls(path.join(cwd, '.claude', 'skills')).map((n) => `${n} (project)`));
  out.codexSkills.push(...ls(path.join(CODEX_HOME, 'skills')), ...ls(path.join(cwd, '.agents', 'skills')).map((n) => `${n} (project)`));
  return out;
}

module.exports = { install, installSkill, fetchRepoPath, listInstalled, codexTomlBlock, hasCmd, skillDirs };
