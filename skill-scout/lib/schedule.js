'use strict';
// Weekly automatic scan.
//  Windows: a Task Scheduler task (imported from XML so it can "run as soon as
//           possible after a missed start" – e.g. when the PC was off).
//  macOS / Linux: prints a crontab line.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TASK_NAME = 'SkillScout Weekly Scan';
const DAYS = { SUN: 'Sunday', MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday' };
const SCRIPT = path.join(__dirname, '..', 'bin', 'skill-scout.js');

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function parseWhen(day = 'SUN', time = '10:00') {
  const d = String(day).toUpperCase().slice(0, 3);
  if (!DAYS[d]) throw new Error('--day must be one of SUN MON TUE WED THU FRI SAT');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('--time must be HH:MM (24h), e.g. 10:00');
  return { day: d, time };
}

function windowsTaskXml({ day, time }, { nodePath = process.execPath, script = SCRIPT, workDir = os.homedir(), start = new Date() } = {}) {
  const date = start.toISOString().slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Weekly scan for new Skills / MCP servers and security alerts (skill-scout)</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${date}T${time}:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByWeek><DaysOfWeek><${DAYS[day]} /></DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>
    </CalendarTrigger>
  </Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <StartWhenAvailable>true</StartWhenAvailable>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEsc(nodePath)}</Command>
      <Arguments>"${xmlEsc(script)}" scan --notify</Arguments>
      <WorkingDirectory>${xmlEsc(workDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function install(o, log = console.log) {
  const when = parseWhen(o.day, o.time);
  if (process.platform !== 'win32') {
    const dow = Object.keys(DAYS).indexOf(when.day);
    const [h, m] = when.time.split(':').map(Number);
    log('Add this line with `crontab -e`:');
    log(`${m} ${h} * * ${dow} "${process.execPath}" "${SCRIPT}" scan --notify >> "${path.join(os.homedir(), '.skill-scout', 'scan.log')}" 2>&1`);
    return true;
  }
  const xml = windowsTaskXml(when);
  const file = path.join(os.tmpdir(), 'skill-scout-task.xml');
  log(`Creating Windows scheduled task "${TASK_NAME}": every ${DAYS[when.day]} at ${when.time} (runs later if the PC was off).`);
  if (o['dry-run']) { log(xml); return true; }
  // Task Scheduler expects UTF-16 LE with a BOM when the XML declares UTF-16.
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
  const r = spawnSync('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', file, '/F'], { encoding: 'utf8' });
  fs.rmSync(file, { force: true });
  log((r.stdout || '') + (r.stderr || ''));
  return r.status === 0;
}

function remove(log = console.log) {
  if (process.platform !== 'win32') { log('Remove the skill-scout line with `crontab -e`.'); return true; }
  const r = spawnSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { encoding: 'utf8' });
  log((r.stdout || '') + (r.stderr || ''));
  return r.status === 0;
}

function status(log = console.log) {
  if (process.platform !== 'win32') { log('Check with `crontab -l`.'); return; }
  const r = spawnSync('schtasks', ['/Query', '/TN', TASK_NAME, '/V', '/FO', 'LIST'], { encoding: 'utf8' });
  log(r.status === 0 ? r.stdout : 'No weekly scan is scheduled. Run: skill-scout schedule');
}

// Windows toast notification via PowerShell (no extra modules). Clicking opens the report.
function notify(title, message, reportPath) {
  if (process.platform !== 'win32') return false;
  const esc = (s) => xmlEsc(s).replace(/'/g, "''");
  const launch = reportPath ? ` activationType="protocol" launch="${esc('file:///' + reportPath.replace(/\\/g, '/'))}"` : '';
  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml('<toast${launch}><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(message)}</text></binding></visual></toast>')
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'ignore', windowsHide: true });
  return r.status === 0;
}

module.exports = { install, remove, status, notify, windowsTaskXml, parseWhen, TASK_NAME };
