<#
  Registers a daily Windows Task Scheduler task that runs "build.ps1 -Update".
  The task runs as the current user, hidden, every day at the given time
  (or as soon as possible after it, if the computer was off), only when a network is available.

  Install:    powershell -ExecutionPolicy Bypass -File install-update-task.ps1
  Other time: powershell -ExecutionPolicy Bypass -File install-update-task.ps1 -At 18:30
  Remove:     powershell -ExecutionPolicy Bypass -File install-update-task.ps1 -Remove
#>
param(
  [string]$At = "09:00",
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$taskName = "40k Codex - BSData update"
$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $root 'build.ps1'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Removed: $taskName"
  exit 0
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Update" `
  -WorkingDirectory $root
$trigger  = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $taskName -Description "Downloads the latest BSData/wh40k-11e data if it changed and rebuilds $root\data\bsdata.js" `
  -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Host "Installed: $taskName"
Write-Host ("Next run: {0}" -f $info.NextRunTime)
Write-Host ("Log: {0}" -f (Join-Path $root 'data\update.log'))
