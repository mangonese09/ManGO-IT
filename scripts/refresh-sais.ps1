# ── WEEKLY SAIS AUTOLINEE REFRESH ──
# Task Scheduler job ("ManGO-IT SAIS refresh", Sundays 05:00): re-sweeps the
# Albatross API (validities currently end each timetable period; the next
# period appears in the API over time), rebuilds + validates + cross-verifies
# the feed, and deploys ONLY if every gate passes. A failed gate leaves the
# live feed untouched and logs the failure.
#
# Manual run:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\refresh-sais.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$log = Join-Path $repo 'pipeline\data\reports\sais-refresh.log'
$env:PYTHONIOENCODING = 'utf-8'

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    Add-Content -Path $log -Value $line
    Write-Host $line
}

function Step($name, $cmd, $cmdArgs) {
    Log "step: $name"
    & $cmd @cmdArgs 2>&1 | Tee-Object -Variable out | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Log "FAIL at ${name}: exit $LASTEXITCODE"
        $out | Select-Object -Last 15 | ForEach-Object { Add-Content -Path $log -Value "    $_" }
        Log 'aborted — live feed untouched'
        exit 1
    }
}

Log '=== SAIS refresh start ==='
Step 'harvest'  'python' @('pipeline/sais_harvest.py', '--refetch')
Step 'emit'     'python' @('pipeline/emit_gtfs.py')
Step 'validate' 'python' @('pipeline/validate.py', 'pipeline/dist/sicily-coaches.gtfs.zip')
Step 'export'   'python' @('pipeline/export_stops.py')
Step 'verify'   'python' @('pipeline/sais_verify.py')
Step 'tests'    'npm'    @('test')

Step 'deploy-feed'  'scp' @('pipeline/dist/sicily-coaches.gtfs.zip', 'root@107.172.39.168:/var/www/mangoit/gtfs/')
Step 'deploy-index' 'scp' @('server/coach-stops.json', 'server/coach-trips.json', 'root@107.172.39.168:/opt/mangoit/')
Step 'pm2'          'ssh' @('root@107.172.39.168', 'pm2 restart mangoit-proxy')

Start-Sleep -Seconds 3
$health = (Invoke-WebRequest -Uri 'https://it.mangonese.dev/api/health' -UseBasicParsing -TimeoutSec 15).Content
if ($health -notmatch '"ok":true') {
    Log "FAIL: health check after deploy: $health"
    exit 1
}
Log "health OK: $health"

git add pipeline/data/routes pipeline/data/sais-stop-coords.json pipeline/data/sais/manifest.json `
    pipeline/data/sais/stops.json pipeline/data/sais/lines.json server/coach-stops.json server/coach-trips.json 2>&1 | Out-Null
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    git commit -m "chore(pipeline): weekly SAIS refresh $(Get-Date -Format 'yyyy-MM-dd')" | Out-Null
    git push 2>&1 | Out-Null
    Log 'artifacts committed and pushed'
} else {
    Log 'no artifact changes (API data unchanged)'
}
Log '=== SAIS refresh done ==='
