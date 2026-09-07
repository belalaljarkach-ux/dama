<#
    install-windows.ps1
    تثبيت «سجل بوابة المجبل» كخدمة تعمل تلقائيًا على Windows Server.

    يستخدم Task Scheduler المدمج في ويندوز — لا يحتاج تحميل أي أداة خارجية
    (مثل NSSM)، وهو ما يناسب سيرفرات الشركات المقيّدة.

    التشغيل: افتح PowerShell **كمسؤول (Run as Administrator)** ثم:
        cd C:\GateLog\deploy
        .\install-windows.ps1

    للتغيير: مرّر منفذًا مختلفًا مثلًا:
        .\install-windows.ps1 -Port 9000
#>

param(
  [int]$Port = 8787,
  [string]$TaskName = 'GateLog',
  [switch]$SkipFirewall
)

$ErrorActionPreference = 'Stop'

function Say($msg, $color = 'White') { Write-Host "  $msg" -ForegroundColor $color }

Write-Host ''
Write-Host '  ═══════════════════════════════════════════' -ForegroundColor Cyan
Write-Host '   تثبيت سجل بوابة المجبل كخدمة' -ForegroundColor Cyan
Write-Host '  ═══════════════════════════════════════════' -ForegroundColor Cyan
Write-Host ''

# ---- 1. صلاحيات المسؤول ----
$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Say '✗ يجب تشغيل هذا السكربت كمسؤول (Run as Administrator).' Red
  exit 1
}
Say '✓ صلاحيات المسؤول متوفرة' Green

# ---- 2. التحقق من Node.js ----
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Say '✗ Node.js غير مثبّت على هذا السيرفر.' Red
  Say '  ثبّته من https://nodejs.org/ (نسخة 24 LTS) ثم أعد تشغيل هذا السكربت.' Yellow
  exit 1
}

$version = (& node --version) -replace 'v', ''
$major = [int]($version -split '\.')[0]
$minor = [int]($version -split '\.')[1]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
  Say "✗ نسخة Node.js الحالية $version قديمة." Red
  Say '  البرنامج يحتاج 22.5 أو أحدث (يُفضَّل 24 LTS) لوجود وحدة node:sqlite.' Yellow
  exit 1
}
Say "✓ Node.js $version  ($($node.Source))" Green

# ---- 3. مسار التطبيق ----
$appRoot = Split-Path -Parent $PSScriptRoot
$serverJs = Join-Path $appRoot 'server.js'
if (-not (Test-Path $serverJs)) {
  Say "✗ لم يُعثر على server.js في $appRoot" Red
  exit 1
}
Say "✓ مجلد التطبيق  $appRoot" Green

# ---- 3ب. مكتبات npm ----
$nodeModules = Join-Path $appRoot 'node_modules\mongodb'
if (-not (Test-Path $nodeModules)) {
  Say '• مكتبة mongodb غير موجودة — جارٍ تنفيذ npm install...' Yellow
  Push-Location $appRoot
  & npm install --omit=dev 2>&1 | Out-Null
  $npmOk = $?
  Pop-Location
  if (-not $npmOk -or -not (Test-Path $nodeModules)) {
    Say '✗ فشل npm install.' Red
    Say '  إن كان الإنترنت ممنوعًا على السيرفر، انسخ مجلد node_modules جاهزًا' Yellow
    Say '  من جهاز آخر نُفِّذ عليه npm install، وضعه في:' Yellow
    Say "    $appRoot\node_modules" Yellow
    exit 1
  }
}
Say '✓ مكتبات npm جاهزة' Green

# ---- 3ج. التحقق من MongoDB ----
if (-not $env:MONGODB_URI) {
  $mongoSvc = Get-Service -Name 'MongoDB' -ErrorAction SilentlyContinue
  if (-not $mongoSvc) {
    Say '⚠ لم يُعثر على خدمة MongoDB على هذا السيرفر.' Yellow
    Say '  ثبّتها من https://www.mongodb.com/try/download/community' Yellow
    Say '  أو اضبط MONGODB_URI على عنوان قاعدة بيانات أخرى (Atlas مثلًا):' Yellow
    Say '    [Environment]::SetEnvironmentVariable("MONGODB_URI","mongodb+srv://...","Machine")' Yellow
    Say '  التثبيت سيستمر، لكن الخدمة لن تعمل حتى تتوفّر قاعدة البيانات.' Yellow
  } elseif ($mongoSvc.Status -ne 'Running') {
    Say "• خدمة MongoDB موجودة لكنها متوقفة ($($mongoSvc.Status)) — جارٍ تشغيلها" Yellow
    Start-Service -Name 'MongoDB' -ErrorAction SilentlyContinue
    Say '✓ شُغّلت خدمة MongoDB' Green
  } else {
    Say '✓ خدمة MongoDB تعمل' Green
  }
} else {
  Say "✓ سيُستخدم MONGODB_URI المضبوط مسبقًا" Green
}

$dataDir = Join-Path $appRoot 'data'
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
Say "✓ مجلد البيانات $dataDir" Green

# ---- 4. إزالة أي تثبيت سابق ----
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Say "• توجد مهمة باسم $TaskName — سيتم استبدالها" Yellow
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# ---- 5. إنشاء المهمة المجدولة ----
# تعمل عند إقلاع السيرفر، بحساب SYSTEM، وتُعيد تشغيل نفسها إذا توقفت.
$action = New-ScheduledTaskAction `
  -Execute $node.Source `
  -Argument 'server.js' `
  -WorkingDirectory $appRoot

$trigger = New-ScheduledTaskTrigger -AtStartup

$principal = New-ScheduledTaskPrincipal `
  -UserId 'SYSTEM' `
  -LogonType ServiceAccount `
  -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description 'سجل بوابة المجبل — خادم تسجيل حركة الآليات' | Out-Null

Say "✓ أُنشئت المهمة المجدولة «$TaskName» (تعمل عند إقلاع السيرفر)" Green

# ---- 6. المنفذ في جدار الحماية ----
if (-not $SkipFirewall) {
  $ruleName = "GateLog HTTP $Port"
  Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue

  New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -Profile Domain,Private `
    -Description 'يسمح لأجهزة البوابة على الشبكة المحلية بالوصول إلى سجل البوابة' | Out-Null

  Say "✓ فُتح المنفذ TCP $Port لشبكة الشركة (Domain + Private)" Green
  Say '  ملاحظة: المنفذ غير مفتوح لشبكة Public عمدًا.' DarkGray
}

# ---- 7. ضبط المنفذ إن اختلف عن الافتراضي ----
if ($Port -ne 8787) {
  [Environment]::SetEnvironmentVariable('PORT', "$Port", 'Machine')
  Say "✓ ضُبط متغيّر البيئة PORT = $Port" Green
}

# ---- 8. التشغيل ----
Start-ScheduledTask -TaskName $TaskName
Say '• جارٍ تشغيل الخدمة...' DarkGray
Start-Sleep -Seconds 4

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Say "✓ الخدمة تعمل وتستمع على المنفذ $Port" Green
} else {
  Say "⚠ الخدمة لم تبدأ الاستماع بعد على المنفذ $Port." Yellow
  Say '  افحص السجل:  Get-WinEvent -LogName Microsoft-Windows-TaskScheduler/Operational -MaxEvents 20' Yellow
  Say "  أو شغّل يدويًا للاطلاع على الخطأ:  cd '$appRoot'; node server.js" Yellow
}

# ---- 9. العناوين ----
$ips = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -ExpandProperty IPAddress

Write-Host ''
Write-Host '  ═══════════════════════════════════════════' -ForegroundColor Cyan
Write-Host '   تم التثبيت' -ForegroundColor Cyan
Write-Host '  ═══════════════════════════════════════════' -ForegroundColor Cyan
Say "على السيرفر نفسه :  http://localhost:$Port"
foreach ($ip in $ips) { Say "من أجهزة البوابة  :  http://${ip}:$Port" }
Write-Host ''
Say 'كلمتا المرور الأوليتان مكتوبتان في:' Yellow
Say "  $dataDir\كلمات-المرور-الأولية.txt" Yellow
Say 'غيّرهما من تبويب «الإعدادات» ثم احذف الملف.' Yellow
Write-Host ''
Say 'أوامر مفيدة:' DarkGray
Say "  إيقاف   :  Stop-ScheduledTask -TaskName $TaskName" DarkGray
Say "  تشغيل   :  Start-ScheduledTask -TaskName $TaskName" DarkGray
Say "  الحالة  :  Get-ScheduledTask -TaskName $TaskName" DarkGray
Say "  إزالة   :  .\uninstall-windows.ps1" DarkGray
Write-Host ''
