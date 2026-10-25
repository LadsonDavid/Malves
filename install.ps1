# Installs malves on Windows: no Node.js, pnpm, git or build needed.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
#
# It downloads malves-windows.zip from the latest GitHub release, checks it against the
# published SHA-256, unpacks it to %LOCALAPPDATA%\malves, and runs `malves doctor`. It asks
# before it touches your PATH or sets malves to start at login. Nothing else on the computer
# is changed, and nothing runs as administrator.
#
# Note on the check: the hash comes from the same release as the zip, so it protects
# against a broken or cut-short download, not against someone who controls the release.
#
# Options:
#   -Dir <folder>    where to install (default %LOCALAPPDATA%\malves)
#   -From <folder>   use malves-windows.zip and malves-windows.zip.sha256 from this folder
#                    instead of downloading (for testing, or an offline computer)
#   -Yes             answer yes to the questions (PATH and start at login)
#   -No              answer no to them, without asking
param(
  [string]$Dir = (Join-Path $env:LOCALAPPDATA "malves"),
  [string]$From = "",
  [switch]$Yes,
  [switch]$No
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Repo = "LadsonDavid/Malves"
$Zip = "malves-windows.zip"

function Say($text) { Write-Host $text }
function Ask($question) {
  if ($No) { return $false }
  if ($Yes) { return $true }
  $answer = Read-Host "$question [y/N]"
  return $answer -match "^(y|yes)$"
}

if ($env:OS -ne "Windows_NT") { throw "This installer is for Windows." }
if (-not [Environment]::Is64BitOperatingSystem) { throw "malves needs 64-bit Windows." }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$work = Join-Path ([IO.Path]::GetTempPath()) ("malves-install-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  # 1. Get the zip and its hash.
  $zipFile = Join-Path $work $Zip
  $hashFile = "$zipFile.sha256"
  if ($From) {
    Say "Using the files in $From"
    Copy-Item (Join-Path $From $Zip) $zipFile
    Copy-Item (Join-Path $From "$Zip.sha256") $hashFile
  } else {
    Say "Finding the latest release..."
    $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "malves-installer" }
    $zipAsset = $release.assets | Where-Object { $_.name -eq $Zip } | Select-Object -First 1
    $hashAsset = $release.assets | Where-Object { $_.name -eq "$Zip.sha256" } | Select-Object -First 1
    if (-not $zipAsset -or -not $hashAsset) { throw "The latest release ($($release.tag_name)) has no $Zip yet." }
    Say "Downloading malves $($release.tag_name) ($([math]::Round($zipAsset.size / 1MB)) MB)..."
    Invoke-WebRequest $zipAsset.browser_download_url -OutFile $zipFile -UseBasicParsing
    Invoke-WebRequest $hashAsset.browser_download_url -OutFile $hashFile -UseBasicParsing
  }

  # 2. Check it.
  $expected = ((Get-Content $hashFile -Raw).Trim() -split "\s+")[0].ToLower()
  $actual = (Get-FileHash $zipFile -Algorithm SHA256).Hash.ToLower()
  if ($expected -ne $actual) { throw "The download is damaged (its checksum doesn't match). Try again." }
  Say "Checksum OK."

  # 3. Unpack beside the old copy, then swap, so a failed install never leaves half a malves.
  $app = Join-Path $Dir "app"
  $fresh = Join-Path $Dir "app.new"
  $old = Join-Path $Dir "app.old"
  New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  if (Test-Path $fresh) { Remove-Item $fresh -Recurse -Force }
  New-Item -ItemType Directory -Path $fresh | Out-Null
  Say "Unpacking (this takes a minute)..."
  $tar = Join-Path $env:SystemRoot "System32\tar.exe"
  if (Test-Path $tar) { & $tar -xf $zipFile -C $fresh; if ($LASTEXITCODE -ne 0) { throw "Unpacking failed." } }
  else { Expand-Archive $zipFile -DestinationPath $fresh -Force }

  if (Test-Path $old) { Remove-Item $old -Recurse -Force }
  if (Test-Path $app) {
    try { Move-Item $app $old }
    catch { throw "malves is running. Stop it first (in PowerShell: Get-Process node | Stop-Process), then run this again." }
  }
  Move-Item $fresh $app

  # A small launcher in its own folder, so adding it to PATH doesn't put the bundled node.exe on PATH too.
  $bin = Join-Path $Dir "bin"
  New-Item -ItemType Directory -Path $bin -Force | Out-Null
  Set-Content (Join-Path $bin "malves.cmd") "@echo off`r`n`"%~dp0..\app\malves.cmd`" %*`r`n" -Encoding ASCII
  Say "Installed in $Dir"

  # 4. Ask before touching PATH.
  $launcher = Join-Path $bin "malves.cmd"
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($userPath -split ";") -notcontains $bin) {
    if (Ask "Add malves to your PATH, so you can type 'malves' in any window?") {
      [Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(";") + ";" + $bin), "User")
      Say "Added. Open a new window to use it."
    }
  }

  # 5. See that it works.
  Say ""
  & $launcher doctor

  # 6. Ask before setting up start at login.
  Say ""
  if (Ask "Start malves automatically when you log in?") { & $launcher autostart on }

  Say ""
  Say "Next:"
  Say "  1. Put your settings (your name, keys) in $env:USERPROFILE\.malves\.env if you want them. See .env.example in the repo."
  Say "  2. Run:  `"$launcher`" serve     (it shows a QR code)"
  Say "  3. Install Tailscale and the malves APK on your phone and scan the code."
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
