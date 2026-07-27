# ── MONTHLY SAIS TRASPORTI REFRESH ──
# Task Scheduler job ("ManGO-IT SAIST refresh", first Tuesday 02:00): re-sweeps
# the Laser.Orchard booking API over a fresh 21-day window (plus holiday probe),
# restitches trips, rebuilds + validates + cross-verifies the feed, and deploys
# ONLY if every gate passes. A failed gate leaves the live feed untouched.
#
# Runtime: the sweep is ~1,800 OD edges x 22 dates at 1.1 s/request ≈ 12 h.
# It is resumable — an interrupted run picks up where it left off next start.
# Stale cache rule: runs-*.jsonl for dates >= today are deleted first, because
# the sweeper skips already-fetched (from,to) pairs per date and would otherwise
# keep month-old observations of future dates across service changes.
#
# Manual run:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\refresh-saist.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$log = Join-Path $repo 'pipeline\data\reports\saist-refresh.log'
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

Log '=== SAIS Trasporti refresh start ==='

# drop future-dated sweep cache so the new window refetches current data
$today = (Get-Date).ToString('yyyy-MM-dd')
Get-ChildItem 'pipeline\data\saist' -Filter 'runs-*.jsonl' | Where-Object {
    $_.Name -replace '^runs-|\.jsonl$', '' -ge $today
} | ForEach-Object { Log "purging stale future cache: $($_.Name)"; Remove-Item $_.FullName }

Step 'graph'    'python' @('pipeline/saist_harvest.py', '--graph')
Step 'sweep'    'python' @('pipeline/saist_harvest.py', '--sweep')
Step 'build'    'python' @('pipeline/saist_harvest.py', '--build')
Step 'emit'     'python' @('pipeline/emit_gtfs.py')
Step 'validate' 'python' @('pipeline/validate.py', 'pipeline/dist/sicily-coaches.gtfs.zip')
Step 'export'   'python' @('pipeline/export_stops.py')
Step 'verify'   'python' @('pipeline/saist_verify.py')
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

git add pipeline/data/routes pipeline/data/saist/graph.json pipeline/data/saist/localities.json `
    server/coach-stops.json server/coach-trips.json 2>&1 | Out-Null
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    # git writes progress to stderr; under ErrorActionPreference=Stop that
    # becomes a terminating NativeCommandError — relax around the push.
    $ErrorActionPreference = 'Continue'
    git commit -m "chore(pipeline): monthly SAIS Trasporti refresh $(Get-Date -Format 'yyyy-MM-dd')" 2>&1 | Out-Null
    git push 2>&1 | Out-Null
    $pushOk = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = 'Stop'
    if ($pushOk) { Log 'artifacts committed and pushed' }
    else { Log 'artifacts committed; PUSH FAILED (will ride along next push)' }
} else {
    Log 'no artifact changes (API data unchanged)'
}
Log '=== SAIS Trasporti refresh done ==='
