$ErrorActionPreference = 'Stop'
$Project = Split-Path -Parent $PSScriptRoot
Set-Location $Project

Write-Host '==> Trust this exact project directory for Git'
git config --global --add safe.directory $Project
if ($LASTEXITCODE -ne 0) { throw 'Could not configure Git safe.directory.' }

Write-Host '==> Commit deployed source and captured evidence'
git init
git branch -M main
git remote set-url origin https://github.com/shoupeorg/pharos-wallet-risk-checker.git
git add .
git commit -m 'Publish live Wallet Risk Checker evidence'
if ($LASTEXITCODE -ne 0) { throw 'Git commit failed.' }
git push -u origin main
if ($LASTEXITCODE -ne 0) { throw 'GitHub push failed.' }
Write-Host 'GitHub publication completed. No deployment or chain reads were repeated.' -ForegroundColor Green
