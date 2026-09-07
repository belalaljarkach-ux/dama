<#
    uninstall-windows.ps1
    إزالة خدمة «سجل بوابة المجبل» من السيرفر.

    لا يحذف قاعدة البيانات ولا النسخ الاحتياطية — مجلد data يبقى كما هو.
    التشغيل: PowerShell كمسؤول ثم  .\uninstall-windows.ps1
#>

param(
  [int]$Port = 8787,
  [string]$TaskName = 'GateLog'
)

$ErrorActionPreference = 'Stop'
function Say($msg, $color = 'White') { Write-Host "  $msg" -ForegroundColor $color }

$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) { Say '✗ شغّل كمسؤول (Run as Administrator).' Red; exit 1 }

Write-Host ''
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Say "✓ أُزيلت المهمة المجدولة «$TaskName»" Green
} else {
  Say "• لا توجد مهمة باسم «$TaskName»" DarkGray
}

$rule = Get-NetFirewallRule -DisplayName "GateLog HTTP $Port" -ErrorAction SilentlyContinue
if ($rule) {
  $rule | Remove-NetFirewallRule
  Say "✓ أُزيلت قاعدة جدار الحماية للمنفذ $Port" Green
}

Write-Host ''
Say 'قاعدة البيانات والنسخ الاحتياطية لم تُحذف — ما زالت في مجلد data.' Yellow
Write-Host ''
