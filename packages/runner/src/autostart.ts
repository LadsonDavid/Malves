import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `malves autostart on|off|status`: starts `malves serve` when you log in to
 * Windows, through Task Scheduler. It runs in a minimized console window, so
 * the pairing QR and typed commands (`add`, `pair`) are one click away on the
 * taskbar. It's restarted if it crashes, and never stopped for running long.
 */
const TASK = "malves serve";

export function autostart(sub: string | undefined, dataDir: string): number {
  if (process.platform !== "win32") {
    console.error("autostart is Windows only for now. Elsewhere, use systemd or launchd.");
    return 1;
  }
  if (sub === "on") return on(dataDir);
  if (sub === "off") return off();
  if (sub === "status" || sub === undefined) return status();
  console.error("Usage: malves autostart on|off|status");
  return 1;
}

/** A PowerShell single-quoted string. */
const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;

function on(dataDir: string): number {
  const main = path.join(path.dirname(fileURLToPath(import.meta.url)), "main.js");
  const launcher = path.join(dataDir, "start-serve.ps1");
  // From the folder it was turned on in, so `.env` there is read.
  writeFileSync(
    launcher,
    [
      "$Host.UI.RawUI.WindowTitle = 'malves serve'",
      `Set-Location -LiteralPath ${quote(process.cwd())}`,
      `& ${quote(process.execPath)} --env-file-if-exists=.env ${quote(main)} serve`,
      "exit $LASTEXITCODE",
      "",
    ].join("\r\n"),
  );
  const ok = powershell(`
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quote(
      `-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File "${launcher}"`,
    )}
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName ${quote(TASK)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  `);
  if (!ok) return 1;
  console.log(`On. malves serve starts minimized each time you log in, from ${process.cwd()}.
To start it now, close any open malves serve, then run: pnpm malves autostart start
Turn it off with: pnpm malves autostart off`);
  return 0;
}

function off(): number {
  const ok = powershell(
    `Unregister-ScheduledTask -TaskName ${quote(TASK)} -Confirm:$false -ErrorAction SilentlyContinue`,
  );
  if (ok) console.log("Off. malves serve no longer starts when you log in.");
  return ok ? 0 : 1;
}

function status(): number {
  return powershell(`
    $task = Get-ScheduledTask -TaskName ${quote(TASK)} -ErrorAction SilentlyContinue
    if (-not $task) { 'Off. Turn it on with: pnpm malves autostart on'; exit 0 }
    $info = $task | Get-ScheduledTaskInfo
    if ($info.LastTaskResult -eq 267011) { "On ($($task.State)). Not started yet: it starts at your next login." }
    else { "On ($($task.State)). Last started $($info.LastRunTime), result $($info.LastTaskResult) (0 = fine, 267009 = running)." }
  `)
    ? 0
    : 1;
}

/** Starts the task now, e.g. right after turning it on. */
export function startNow(): number {
  if (process.platform !== "win32") return 1;
  return powershell(`Start-ScheduledTask -TaskName ${quote(TASK)}`) ? 0 : 1;
}

function powershell(script: string): boolean {
  // -EncodedCommand: no quoting surprises; powershell.exe is a real program, not a .cmd shim.
  const encoded = Buffer.from(
    `$ProgressPreference = 'SilentlyContinue'
${script}`,
    "utf16le",
  ).toString("base64");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { stdio: "inherit", windowsHide: true },
  );
  if (result.status !== 0) console.error("Task Scheduler didn't accept it (see above).");
  return result.status === 0;
}
