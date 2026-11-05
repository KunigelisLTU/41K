<#
  Prepares BSData files for the Codex app.

  Usage:
    powershell -ExecutionPolicy Bypass -File build.ps1 -Update          # download latest data from GitHub if it changed
    powershell -ExecutionPolicy Bypass -File build.ps1 -Update -Force   # download and rebuild even if unchanged
    powershell -ExecutionPolicy Bypass -File build.ps1 -Source "C:\path\to\wh40k-11e-main.zip"
    powershell -ExecutionPolicy Bypass -File build.ps1 -Source "C:\path\to\wh40k-11e-main"
    powershell -ExecutionPolicy Bypass -File build.ps1                  # rebuild from existing data\raw files

  Output: data\bsdata.js (loaded by index.html), data\version.json, data\update.log
          data\stratagems.js (with -Update; stratagems from pguetschow/warhammer-40k-stratagem-card-generator)
#>
param(
  [string]$Source = "",
  [switch]$Update,
  [switch]$Force,
  [string]$Repo = "BSData/wh40k-11e",
  [string]$Branch = "main",
  [string]$StratRepo = "pguetschow/warhammer-40k-stratagem-card-generator",
  [string]$StratBranch = "main",
  [string]$StratFile = "public/data/11/cards.json"
)

$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $root 'data'
$rawDir  = Join-Path $dataDir 'raw'
$outJs   = Join-Path $dataDir 'bsdata.js'
$verFile = Join-Path $dataDir 'version.json'
$logFile = Join-Path $dataDir 'update.log'
$utf8    = New-Object System.Text.UTF8Encoding($false)
New-Item -ItemType Directory -Force $dataDir | Out-Null

function Log([string]$msg) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg
  Write-Host $msg
  try { Add-Content -Path $logFile -Value $line -Encoding UTF8 } catch { }
}

$version = $null
if (Test-Path $verFile) { try { $version = Get-Content $verFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $version = $null } }
$cleanup = @()

try {
  # ---------- 0. Stratagems (separate repository, one JSON file) ----------
  if ($Update) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $headers = @{ 'User-Agent' = '40k-codex-build'; 'Accept' = 'application/vnd.github+json' }
    try {
      $sJs = Join-Path $dataDir 'stratagems.js'
      $sVerFile = Join-Path $dataDir 'stratagems.version.json'
      $sVer = $null
      if (Test-Path $sVerFile) { try { $sVer = Get-Content $sVerFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { } }
      $sc = Invoke-RestMethod -Uri "https://api.github.com/repos/$StratRepo/commits/$StratBranch" -Headers $headers -UseBasicParsing
      if ($Force -or -not $sVer -or $sVer.sha -ne $sc.sha -or -not (Test-Path $sJs)) {
        Log ("Downloading stratagems {0}..." -f $sc.sha.Substring(0, 7))
        $sTmp = Join-Path ([IO.Path]::GetTempPath()) ("strat-" + [guid]::NewGuid().ToString('N') + ".json")
        Invoke-WebRequest -Uri "https://raw.githubusercontent.com/$StratRepo/$($sc.sha)/$StratFile" -OutFile $sTmp -Headers @{ 'User-Agent' = '40k-codex-build' } -UseBasicParsing
        $cleanup += $sTmp
        $sText = [IO.File]::ReadAllText($sTmp, [Text.Encoding]::UTF8).Trim()
        if ($sText.Length -gt 0 -and $sText[0] -eq [char]0xFEFF) { $sText = $sText.Substring(1) }
        $null = $sText | ConvertFrom-Json
        $sVerObj = [ordered]@{ repo = $StratRepo; branch = $StratBranch; sha = $sc.sha; date = [string]$sc.commit.committer.date; file = $StratFile; built = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') }
        $sVerJson = $sVerObj | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($sJs + '.tmp', "window.STRAT_VERSION=$sVerJson;`nwindow.STRATDATA=$sText;`n", $utf8)
        Move-Item ($sJs + '.tmp') $sJs -Force
        [IO.File]::WriteAllText($sVerFile, ($sVerObj | ConvertTo-Json), $utf8)
        Log ("Done: data\stratagems.js {0}" -f $sc.sha.Substring(0, 7))
      } else {
        Log ("Stratagems up to date: {0}" -f $sc.sha.Substring(0, 7))
      }
    } catch {
      Log ("Stratagems update failed: " + $_.Exception.Message)
    }
  }

  # ---------- 1. Check GitHub for a newer commit and download it ----------
  if ($Update) {
    Log "Checking $Repo ($Branch)..."
    $commit = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/commits/$Branch" -Headers $headers -UseBasicParsing
    $sha  = [string]$commit.sha
    $date = [string]$commit.commit.committer.date
    if (-not $sha) { throw "Could not read the latest commit from GitHub" }

    if (-not $Force -and $version -and $version.sha -eq $sha -and (Test-Path $outJs)) {
      Log ("Up to date: {0} ({1})" -f $sha.Substring(0, 7), $date)
      exit 0
    }

    $zip = Join-Path ([IO.Path]::GetTempPath()) ("bsdata-" + $sha.Substring(0, 7) + ".zip")
    Log ("Downloading {0} ({1})..." -f $sha.Substring(0, 7), $date)
    Invoke-WebRequest -Uri "https://codeload.github.com/$Repo/zip/$sha" -OutFile $zip -Headers @{ 'User-Agent' = '40k-codex-build' } -UseBasicParsing
    $cleanup += $zip
    $Source = $zip
    $version = [pscustomobject]@{ repo = $Repo; branch = $Branch; sha = $sha; date = $date }
  } elseif ($Source -ne "") {
    $version = [pscustomobject]@{ repo = $Repo; branch = ''; sha = ''; date = ''; source = (Split-Path $Source -Leaf) }
  }

  # ---------- 2. Copy JSON files into data\raw ----------
  if ($Source -ne "") {
    if (-not (Test-Path $Source)) { throw "Source not found: $Source" }
    if ((Get-Item $Source).PSIsContainer) {
      $srcDir = $Source
    } else {
      $srcDir = Join-Path ([IO.Path]::GetTempPath()) ("bsdata-" + [guid]::NewGuid().ToString('N'))
      Log "Extracting archive..."
      Expand-Archive -Path $Source -DestinationPath $srcDir -Force
      $cleanup += $srcDir
    }
    $files = Get-ChildItem $srcDir -Recurse -File -Filter *.json | Where-Object { $_.FullName -notmatch '\\\.github\\' }
    if ($files.Count -eq 0) { throw "No .json files found in source" }
    if (Test-Path $rawDir) { Get-ChildItem $rawDir -File -Filter *.json | Remove-Item -Confirm:$false }
    New-Item -ItemType Directory -Force $rawDir | Out-Null
    foreach ($f in $files) { Copy-Item $f.FullName (Join-Path $rawDir $f.Name) -Force }
    Log ("Copied files: {0}" -f $files.Count)
  }

  # ---------- 3. Build data\bsdata.js (written to a temp file, then swapped in) ----------
  if (-not (Test-Path $rawDir)) { throw "data\raw is missing. Run with -Update or -Source <zip or folder>." }
  $raw = Get-ChildItem $rawDir -File -Filter *.json | Sort-Object Name
  if ($raw.Count -eq 0) { throw "No .json files in data\raw" }

  $built = Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'
  $verObj = [ordered]@{ built = $built }
  if ($version) { foreach ($p in $version.PSObject.Properties) { if ($p.Name -ne 'built') { $verObj[$p.Name] = $p.Value } } }
  $verJson = $verObj | ConvertTo-Json -Compress

  $tmpJs = $outJs + '.tmp'
  $w = New-Object System.IO.StreamWriter($tmpJs, $false, $utf8)
  try {
    $w.Write("/* Generated by build.ps1 $built */`n")
    $w.Write("window.BSDATA_VERSION=$verJson;`n")
    $w.Write("window.BSDATA=[`n")
    $first = $true
    foreach ($f in $raw) {
      $text = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8).Trim()
      if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
      if (-not $text.StartsWith('{')) { Log "Skipped (not a JSON object): $($f.Name)"; continue }
      if (-not $first) { $w.Write(",`n") }
      $first = $false
      $w.Write('{"file":' + ($f.Name | ConvertTo-Json) + ',"data":')
      $w.Write($text)
      $w.Write('}')
    }
    $w.Write("`n];`n")
  } finally { $w.Close() }
  Move-Item -Path $tmpJs -Destination $outJs -Force
  [IO.File]::WriteAllText($verFile, ($verObj | ConvertTo-Json), $utf8)
  [IO.File]::WriteAllText((Join-Path $dataDir 'version.js'), "window.BSDATA_VERSION=$verJson;`n", $utf8)

  $size = [math]::Round((Get-Item $outJs).Length / 1MB, 1)
  $tag = if ($verObj.sha) { ' ' + $verObj.sha.Substring(0, 7) } else { '' }
  Log ("Done: data\bsdata.js ({0} MB, {1} files){2}" -f $size, $raw.Count, $tag)
}
catch {
  Log ("ERROR: " + $_.Exception.Message)
  exit 1
}
finally {
  foreach ($c in $cleanup) { if (Test-Path $c) { Remove-Item $c -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue } }
}
