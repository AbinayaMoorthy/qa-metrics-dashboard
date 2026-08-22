# collect-runs.ps1
#
# Runs the Playwright and Newman suites repeatedly, saving each run's JSON
# output with a timestamp. Multiple runs are what make trend and flakiness
# analysis possible — a single run only gives a snapshot.
#
# Usage, from the repository root:
#   .\collect-runs.ps1              # 15 runs of each suite
#   .\collect-runs.ps1 -Runs 10     # custom count
#   .\collect-runs.ps1 -SkipUi      # API only (much faster)

param(
    [int]$Runs = 15,
    [switch]$SkipUi,
    [switch]$SkipApi
)

$RawDir = "metrics\raw"
New-Item -ItemType Directory -Force -Path $RawDir | Out-Null

Write-Host ""
Write-Host "Collecting $Runs run(s) into $RawDir" -ForegroundColor Cyan
Write-Host ""

$start = Get-Date

for ($i = 1; $i -le $Runs; $i++) {
    $stamp = (Get-Date).ToString("yyyy-MM-ddTHH-mm-ss")
    Write-Host "[$i/$Runs] $stamp" -ForegroundColor Yellow

    # ---- Playwright UI suite ------------------------------------------------
    if (-not $SkipUi) {
        $pwFile = Join-Path $RawDir "playwright-$stamp.json"
        $env:PLAYWRIGHT_JSON_OUTPUT_NAME = $pwFile

        # A failing test makes Playwright exit non-zero. That is expected and
        # is itself data, so the exit code is deliberately not treated as an
        # error here.
        npx playwright test --reporter=json 2>&1 | Out-Null

        if (Test-Path $pwFile) {
            Write-Host "      UI  -> $(Split-Path $pwFile -Leaf)" -ForegroundColor Green
        } else {
            Write-Host "      UI  -> no output produced" -ForegroundColor Red
        }
    }

    # ---- Newman API suite ---------------------------------------------------
    if (-not $SkipApi) {
        $nmFile = Join-Path $RawDir "newman-$stamp.json"

        npx newman run postman/restful-booker-collection.json `
            --reporters json `
            --reporter-json-export $nmFile `
            --timeout-request 30000 2>&1 | Out-Null

        if (Test-Path $nmFile) {
            Write-Host "      API -> $(Split-Path $nmFile -Leaf)" -ForegroundColor Green
        } else {
            Write-Host "      API -> no output produced" -ForegroundColor Red
        }
    }

    # Brief pause so runs get distinct timestamps and the shared public
    # sandbox is not hammered.
    Start-Sleep -Seconds 2
}

$elapsed = (Get-Date) - $start
$count = (Get-ChildItem $RawDir -Filter *.json).Count

Write-Host ""
Write-Host "Done in $([math]::Round($elapsed.TotalMinutes,1)) min. $count JSON file(s) in $RawDir" -ForegroundColor Cyan
Write-Host "Next: node flatten-metrics.js metrics\raw metrics\csv" -ForegroundColor Cyan
Write-Host ""
