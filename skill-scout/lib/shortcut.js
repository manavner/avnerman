'use strict';
// Desktop (and Start menu) shortcut that opens the dashboard – Windows only.
// Created through PowerShell's WScript.Shell; the script is passed with
// -EncodedCommand so paths with spaces or quotes survive intact.
const path = require('path');
const { spawnSync } = require('child_process');
const { HOME } = require('./util');

const NAME = 'Skill Scout';
const SCRIPT = path.join(__dirname, '..', 'bin', 'skill-scout.js');
const ICON = path.join(__dirname, '..', 'ui', 'skill-scout.ico');

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`; // PowerShell single-quoted string

function buildScript({ remove = false, startMenu = false, nodePath = process.execPath, script = SCRIPT, workDir = HOME, icon = ICON } = {}) {
  const folders = ["[Environment]::GetFolderPath('Desktop')"];
  if (startMenu) folders.push("[Environment]::GetFolderPath('Programs')");
  const lines = ['$ErrorActionPreference = "Stop"', `foreach ($dir in @(${folders.join(', ')})) {`, `  $lnk = Join-Path $dir ${psq(NAME + '.lnk')}`];
  if (remove) {
    lines.push('  if (Test-Path $lnk) { Remove-Item $lnk; Write-Output "Removed: $lnk" }');
  } else {
    lines.push(
      '  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)',
      `  $s.TargetPath = ${psq(nodePath)}`,
      `  $s.Arguments = ${psq(`"${script}" ui`)}`,
      `  $s.WorkingDirectory = ${psq(workDir)}`,
      '  $s.WindowStyle = 7', // start minimised: only the browser comes up
      `  $s.IconLocation = ${psq(icon + ',0')}`,
      `  $s.Description = ${psq('Skill Scout – find, vet and manage Skills & MCP servers')}`,
      '  $s.Save()',
      '  Write-Output "Created: $lnk"',
    );
  }
  lines.push('}');
  return lines.join('\n');
}

function run(opts = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, output: 'Shortcuts are created on Windows only. Elsewhere, run: skill-scout ui' };
  }
  const encoded = Buffer.from(buildScript(opts), 'utf16le').toString('base64');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

module.exports = { buildScript, run, NAME };
