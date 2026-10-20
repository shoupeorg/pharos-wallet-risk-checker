$ErrorActionPreference = 'Stop'
$Project = Split-Path -Parent $PSScriptRoot
Set-Location $Project
$env:npm_config_cache = Join-Path $Project '.npm-cache'

Write-Host '==> Full verification'
npm test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

$Config = Join-Path $Project 'wrangler.jsonc'
$Text = Get-Content -Raw $Config
if ($Text.Contains('REPLACE_WITH_D1_ID')) {
  Write-Host '==> Create exact D1 database'
  $Created = (& npx wrangler d1 create pharos-wallet-risk-checker 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw $Created }
  $Match = [regex]::Match($Created, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
  if (-not $Match.Success) { throw 'D1 was created but its database ID was not found.' }
  $Text.Replace('REPLACE_WITH_D1_ID', $Match.Value) | Set-Content -NoNewline $Config
}

Write-Host '==> Migrate and deploy'
npx wrangler d1 migrations apply pharos-wallet-risk-checker --remote
if ($LASTEXITCODE -ne 0) { throw 'Remote D1 migration failed.' }
npm run deploy
if ($LASTEXITCODE -ne 0) { throw 'Cloudflare deployment failed.' }

Write-Host '==> Capture real live demonstrations'
node scripts/capture-live-evidence.mjs 'https://pharos-wallet-risk-checker.shoupeorg.workers.dev'
if ($LASTEXITCODE -ne 0) { throw 'Live evidence capture failed; no result was relabeled.' }

Write-Host '==> Publish exact source and evidence'
git -c safe.directory=$Project init
git -c safe.directory=$Project branch -M main
git -c safe.directory=$Project remote remove origin 2>$null
git -c safe.directory=$Project remote add origin https://github.com/shoupeorg/pharos-wallet-risk-checker.git
git -c safe.directory=$Project add .
git -c safe.directory=$Project commit -m 'Build Pharos Wallet Risk Checker'
if ($LASTEXITCODE -ne 0) { throw 'Git commit failed.' }
git -c safe.directory=$Project push -u origin main
if ($LASTEXITCODE -ne 0) { throw 'GitHub push failed.' }
Write-Host 'Wallet Risk Checker publication, deployment, and evidence completed.' -ForegroundColor Green
