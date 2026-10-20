$ErrorActionPreference = 'Stop'
$Project = Split-Path -Parent $PSScriptRoot
Set-Location $Project

Write-Host '==> Resume bounded live evidence capture (no tests, migration, or deployment)'
node scripts/capture-live-evidence.mjs 'https://pharos-wallet-risk-checker.shoupeorg.workers.dev'
if ($LASTEXITCODE -ne 0) { throw 'Live evidence capture failed; no result was relabeled.' }

Write-Host '==> Commit and publish corrected source and versioned evidence'
git -c safe.directory=$Project add .
git -c safe.directory=$Project commit -m 'Correct transaction attribution and evidence'
if ($LASTEXITCODE -ne 0) { throw 'Git commit failed.' }
git -c safe.directory=$Project push -u origin main
if ($LASTEXITCODE -ne 0) { throw 'GitHub push failed.' }

Write-Host 'Evidence capture and publication completed; deployment was not repeated.' -ForegroundColor Green
