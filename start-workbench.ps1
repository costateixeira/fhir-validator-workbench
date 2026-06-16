<#
.SYNOPSIS
  One-shot launcher for the FHIR Transform Workbench.

.DESCRIPTION
  Does three things, in order:
    1. Downloads validator_cli.jar to -JarDir (or reuses it if already present).
    2. Starts the validator in a new console window:
         java -jar <JarDir>\validator_cli.jar server <ValidatorPort> -version <FhirVersion>
       Skip with -SkipValidator if you start it yourself.
    3. Starts cors-proxy.js (loopback only) in a new console window. The proxy's
       jar directory is set via the JAR_DIR env var so /__local/jar status/download
       resolves against -JarDir even if you launched the script from elsewhere.
    4. Opens transform-workbench.html in the default browser.

  The script exits as soon as everything is launched. Close each console window
  to stop the corresponding process.

.PARAMETER JarDir
  Where to read/write validator_cli.jar. Defaults to the folder this script sits in.

.PARAMETER JarUrl
  Where to download the jar from when it's not already in -JarDir.

.PARAMETER ProxyPort
  Port for the cors-proxy. Default 8090.

.PARAMETER ValidatorPort
  Port for the validator HTTP server. Default 8089. (cors-proxy.js is hard-coded
  to forward to 127.0.0.1:8089, so change both sides if you change this.)

.PARAMETER FhirVersion
  -version flag passed to the validator. Default 4.0.

.PARAMETER SkipDownload
  Don't try to download; insist the jar is already in -JarDir.

.PARAMETER SkipValidator
  Don't start the validator. Use when you already have one running.

.PARAMETER SkipProxy
  Don't start cors-proxy.js. Use when one is already running.

.PARAMETER NoBrowser
  Don't open the html in the default browser.

.EXAMPLE
  .\start-workbench.ps1
  # First run: downloads jar, starts validator + proxy, opens the page.

.EXAMPLE
  .\start-workbench.ps1 -JarDir D:\fhir\bin -FhirVersion 5.0
  # Stash jar in D:\fhir\bin and run the validator in R5 mode.

.EXAMPLE
  .\start-workbench.ps1 -SkipValidator -SkipDownload
  # I have the validator running elsewhere; just bring up the proxy and the page.
#>
param(
  [string] $JarDir        = $PSScriptRoot,
  [string] $JarUrl        = 'https://github.com/costateixeira/org.hl7.fhir.core/releases/download/wip/validator_cli.jar',
  [int]    $ProxyPort     = 8090,
  [int]    $ValidatorPort = 8089,
  [string] $FhirVersion   = '4.0',
  [switch] $SkipDownload,
  [switch] $SkipValidator,
  [switch] $SkipProxy,
  [switch] $NoBrowser
)

$ErrorActionPreference = 'Stop'

# Repo root (where this script lives) - cors-proxy.js, transform-workbench.html,
# packages.yaml and maps.yaml all live here.
$RepoRoot = $PSScriptRoot
$ProxyScript = Join-Path $RepoRoot 'cors-proxy.js'
$WorkbenchHtml = Join-Path $RepoRoot 'transform-workbench.html'

foreach ($p in @($ProxyScript, $WorkbenchHtml)) {
  if (-not (Test-Path $p)) { throw "Missing required file: $p" }
}

# Resolve and create the jar directory if needed.
if (-not (Test-Path $JarDir)) {
  New-Item -ItemType Directory -Path $JarDir -Force | Out-Null
}
$JarDir = (Resolve-Path $JarDir).Path
$JarPath = Join-Path $JarDir 'validator_cli.jar'

function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "Required command '$cmd' not on PATH. $hint"
  }
}

# -- 1. download jar -------------------------------------------------------

if (Test-Path $JarPath) {
  $sizeMB = [math]::Round((Get-Item $JarPath).Length / 1MB, 1)
  Write-Host "Jar already present: $JarPath ($sizeMB MB)" -ForegroundColor Yellow
} elseif ($SkipDownload) {
  throw "Jar not found at $JarPath and -SkipDownload was set."
} else {
  Write-Host "Downloading validator_cli.jar ..." -ForegroundColor Cyan
  Write-Host "  from: $JarUrl"
  Write-Host "  to:   $JarPath"
  # Use BITS when available (resumable, progress bar); fall back to Invoke-WebRequest.
  try {
    Start-BitsTransfer -Source $JarUrl -Destination $JarPath -ErrorAction Stop
  } catch {
    Write-Host "  BITS unavailable, falling back to Invoke-WebRequest ..." -ForegroundColor DarkGray
    Invoke-WebRequest -Uri $JarUrl -OutFile $JarPath -UseBasicParsing
  }
  $sizeMB = [math]::Round((Get-Item $JarPath).Length / 1MB, 1)
  Write-Host "  done ($sizeMB MB)" -ForegroundColor Green
}

# -- 2. start validator (new console window) ------------------------------

$validatorProc = $null
if (-not $SkipValidator) {
  Need 'java' "Install a JDK 17+ and put 'java' on PATH (or run with -SkipValidator)."
  Write-Host "Starting validator on port $ValidatorPort (FHIR $FhirVersion) ..." -ForegroundColor Cyan
  $validatorOut = Join-Path $JarDir 'validator.out.log'
  $validatorErr = Join-Path $JarDir 'validator.err.log'
  # Hidden window + redirected stdout/stderr so a crash doesn't take the
  # diagnostic with it. NoNewWindow=false isn't enough since the console
  # closes the moment java exits.
  $validatorProc = Start-Process -FilePath 'java' `
    -ArgumentList @('-jar', $JarPath, 'server', $ValidatorPort, '-version', $FhirVersion) `
    -WorkingDirectory $JarDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $validatorOut `
    -RedirectStandardError  $validatorErr `
    -PassThru
  Write-Host "  PID $($validatorProc.Id)" -ForegroundColor DarkGray
  Write-Host "  stdout: $validatorOut" -ForegroundColor DarkGray
  Write-Host "  stderr: $validatorErr" -ForegroundColor DarkGray
  # Poll the validator's HTTP port until it answers. Cold start can take
  # 30-90s while it loads the core FHIR package. /openapi.json accepts any
  # method, returns 200 unconditionally once the server is bound, and doesn't
  # touch the terminology server - perfect for a readiness probe.
  $deadline = (Get-Date).AddSeconds(180)
  $ready = $false
  Write-Host -NoNewline "  Waiting for port $ValidatorPort " -ForegroundColor DarkGray
  while ((Get-Date) -lt $deadline) {
    if ($validatorProc.HasExited) { break }
    try {
      $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$ValidatorPort/openapi.json" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
      if ($probe.StatusCode -eq 200) { $ready = $true; break }
    } catch {
      Write-Host -NoNewline "." -ForegroundColor DarkGray
      Start-Sleep -Milliseconds 750
    }
  }
  Write-Host ""
  if ($validatorProc.HasExited) {
    Write-Host "  Validator exited with code $($validatorProc.ExitCode) before binding to $ValidatorPort." -ForegroundColor Red
    if (Test-Path $validatorErr) {
      $errText = (Get-Content $validatorErr -Tail 40 -ErrorAction SilentlyContinue) -join "`n"
      if ($errText) { Write-Host "  --- last lines of stderr ---" -ForegroundColor Red; Write-Host $errText -ForegroundColor DarkGray }
    }
    if (Test-Path $validatorOut) {
      $outText = (Get-Content $validatorOut -Tail 40 -ErrorAction SilentlyContinue) -join "`n"
      if ($outText) { Write-Host "  --- last lines of stdout ---" -ForegroundColor Red; Write-Host $outText -ForegroundColor DarkGray }
    }
    throw "Validator failed to stay up. See logs above (and $validatorErr / $validatorOut)."
  }
  if (-not $ready) {
    Write-Host "  Timed out after 180s waiting for $ValidatorPort - validator may still be starting; tail $validatorOut to follow." -ForegroundColor Yellow
  } else {
    Write-Host "  Validator listening on $ValidatorPort." -ForegroundColor Green
  }
} else {
  Write-Host "Skipping validator startup (-SkipValidator)." -ForegroundColor Yellow
}

# -- 3. start cors-proxy (new console window) -----------------------------

$proxyProc = $null
if (-not $SkipProxy) {
  Need 'node' "Install Node.js (https://nodejs.org) and put 'node' on PATH (or run with -SkipProxy)."
  Write-Host "Starting cors-proxy on port $ProxyPort (JAR_DIR=$JarDir) ..." -ForegroundColor Cyan
  # Start-Process -Environment is PS 7+ only. On 5.1 we set the env vars in this
  # session, spawn the child (which inherits them), then restore. JAR_DIR tells the
  # proxy where the jar/logs live; FHIR_VERSION lets its Start/Restart endpoints
  # relaunch the validator with the same -version this script used.
  $prevJarDir = $env:JAR_DIR
  $prevFhirVersion = $env:FHIR_VERSION
  $env:JAR_DIR = $JarDir
  $env:FHIR_VERSION = $FhirVersion
  try {
    $proxyProc = Start-Process -FilePath 'node' `
      -ArgumentList @($ProxyScript) `
      -WorkingDirectory $RepoRoot `
      -PassThru
  } finally {
    if ($null -eq $prevJarDir) { Remove-Item Env:\JAR_DIR -ErrorAction SilentlyContinue }
    else { $env:JAR_DIR = $prevJarDir }
    if ($null -eq $prevFhirVersion) { Remove-Item Env:\FHIR_VERSION -ErrorAction SilentlyContinue }
    else { $env:FHIR_VERSION = $prevFhirVersion }
  }
  Write-Host "  PID $($proxyProc.Id) - close its window to stop." -ForegroundColor DarkGray
} else {
  Write-Host "Skipping cors-proxy startup (-SkipProxy)." -ForegroundColor Yellow
}

# -- 4. open the page ------------------------------------------------------

if (-not $NoBrowser) {
  # Give the validator and proxy a moment to bind.
  Start-Sleep -Seconds 2
  $WorkbenchUrl = "http://127.0.0.1:$ProxyPort/"

  # We want every launch to open in a NEW window, not reuse an existing tab.
  # `Start-Process <url>` hands off to the OS shell, which routes through the
  # default browser's existing instance. Calling the browser exe directly with
  # its --new-window flag forces a fresh window. We try Chrome, Edge, then
  # Firefox in well-known install locations; if none match we fall back to the
  # shell launch (and accept tab reuse).
  $browserCandidates = @(
    @{ Path = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe";        Flag = '--new-window' }
    @{ Path = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"; Flag = '--new-window' }
    @{ Path = "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe";        Flag = '--new-window' }
    @{ Path = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe";       Flag = '--new-window' }
    @{ Path = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe";Flag = '--new-window' }
    @{ Path = "$env:ProgramFiles\Mozilla Firefox\firefox.exe";                 Flag = '-new-window'  }
    @{ Path = "${env:ProgramFiles(x86)}\Mozilla Firefox\firefox.exe";          Flag = '-new-window'  }
  )
  $opened = $false
  foreach ($b in $browserCandidates) {
    if ($b.Path -and (Test-Path $b.Path)) {
      Write-Host "Opening $WorkbenchUrl in a new window ($([System.IO.Path]::GetFileName($b.Path))) ..." -ForegroundColor Cyan
      Start-Process -FilePath $b.Path -ArgumentList @($b.Flag, $WorkbenchUrl) | Out-Null
      $opened = $true
      break
    }
  }
  if (-not $opened) {
    Write-Host "No known browser executable found; falling back to the OS handler (may reuse a tab)." -ForegroundColor Yellow
    Write-Host "Opening $WorkbenchUrl ..." -ForegroundColor Cyan
    Start-Process $WorkbenchUrl
  }
} else {
  Write-Host "Skipping browser launch (-NoBrowser)." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. Workbench should be loading; the proxy is on http://127.0.0.1:$ProxyPort." -ForegroundColor Green
Write-Host "Close the validator/proxy console windows when you're finished." -ForegroundColor Green
