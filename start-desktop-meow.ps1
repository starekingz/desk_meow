param(
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$packageFile = Join-Path $projectRoot "package.json"
$modulesDirectory = Join-Path $projectRoot "node_modules"
$logFile = Join-Path $projectRoot "desktop-game-meow-startup.log"
$runnerFile = Join-Path $projectRoot "start-desktop-meow-runner.cmd"

if (-not (Test-Path -LiteralPath $packageFile)) {
    Write-Error "package.json was not found. Keep this launcher in the project directory."
    exit 1
}

$npmCommand = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
if (-not $npmCommand) {
    Write-Error "Node.js/npm was not found. Install Node.js 20 or newer first."
    exit 1
}

if (-not (Test-Path -LiteralPath $modulesDirectory)) {
    Write-Error "Project dependencies are missing. Run npm install first."
    exit 1
}

if (-not (Test-Path -LiteralPath $runnerFile)) {
    Write-Error "The background runner is missing: $runnerFile"
    exit 1
}

$runningApp = Get-NetTCPConnection -LocalPort 32145 -State Listen -ErrorAction SilentlyContinue
if ($runningApp) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait("{F9}")
    Write-Output "Desktop Game Meow is already running. The control panel was requested."
    exit 0
}

if ($CheckOnly) {
    Write-Output "Launcher environment check passed."
    exit 0
}

Start-Process `
    -FilePath $runnerFile `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden

Write-Output "Desktop Game Meow is building and starting in the background."
Write-Output "If no window appears, inspect: $logFile"
