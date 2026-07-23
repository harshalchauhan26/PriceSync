# Provision (or repair) the Windows Scheduled Task that refreshes the
# local-only brands from THIS machine's India IP. These stores (labelanushree,
# anitadongre, saakshakinni) block/geo-distort the cloud + relay IPs, so the
# cloud pipeline skips them and they are fetched only from here.
#
# Run once in an elevated-or-normal PowerShell:  .\setup-local-refresh-task.ps1
# Idempotent — re-run any time to reset the task to the correct config.
$ErrorActionPreference = 'Stop'

$TaskName = 'PriceSync local-only refresh'
$Server   = (Resolve-Path (Join-Path $PSScriptRoot '.')).Path      # web\server
$Cmd      = Join-Path $env:USERPROFILE 'pricesync-local-refresh.cmd'
$LogVar   = '%LOCALAPPDATA%\pricesync-local-refresh.log'

# 1. Wrapper .cmd — cd into web\server and run the local-only pipeline, logging output.
@"
@echo off
cd /d "$Server"
node run-local-only.mjs >> "$LogVar" 2>&1
"@ | Set-Content -Path $Cmd -Encoding ascii
Write-Host "[setup] wrote $Cmd" -ForegroundColor Cyan

# 2. Triggers: 10:00 AM + 8:00 PM daily (evening run is a backup in case the
#    machine was off in the morning).
$triggers = @(
  New-ScheduledTaskTrigger -Daily -At 10:00AM
  New-ScheduledTaskTrigger -Daily -At 8:00PM
)

# 3. Action + settings. No battery conditions (they caused 0x800710E0 "request
#    refused" when on battery); catch up missed runs; 3-hour cap.
$action   = New-ScheduledTaskAction -Execute $Cmd
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 3) `
  -MultipleInstances IgnoreNew

# 4. (Re)register under the current user.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
  -Settings $settings -User $env:USERNAME -RunLevel Limited | Out-Null

Write-Host "[setup] registered '$TaskName' (daily 10:00 & 20:00, India IP)" -ForegroundColor Green
Get-ScheduledTaskInfo -TaskName $TaskName | Format-List TaskName, NextRunTime, LastRunTime, LastTaskResult
