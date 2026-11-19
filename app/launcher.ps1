# Stem Mixer launcher for Windows.
# First run: sets up a private runtime (Python, PyTorch, Demucs, ffmpeg, AI model) in
#   %LOCALAPPDATA%\StemMixer  -- nothing is installed system-wide and no admin rights are needed.
# Every run: starts the app and opens it in the browser.
# (Kept pure ASCII: Windows PowerShell 5.1 misreads non-ASCII in files without a BOM.)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar on
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$SetupVersion = 'v2'   # bump to make existing installs re-run setup
$AppDir   = $PSScriptRoot
$Runtime  = Join-Path $env:LOCALAPPDATA 'StemMixer'
$UvDir    = Join-Path $Runtime 'uv'
$Uv       = Join-Path $UvDir 'uv.exe'
$Venv     = Join-Path $Runtime 'env'
$Python   = Join-Path $Venv 'Scripts\python.exe'
$Marker   = Join-Path $Runtime "installed-$SetupVersion.txt"
$Library  = Join-Path ([Environment]::GetFolderPath('MyMusic')) 'Stem Mixer'

# Keep every download and cache inside our runtime folder.
$env:UV_PYTHON_INSTALL_DIR = Join-Path $Runtime 'python'
$env:UV_CACHE_DIR          = Join-Path $Runtime 'cache'
$env:UV_PYTHON_PREFERENCE  = 'only-managed'   # never pick up a random system Python
$env:UV_LINK_MODE          = 'copy'
$env:TORCH_HOME            = Join-Path $Runtime 'models'
$env:PYTHONUTF8            = '1'
$env:PYTHONUNBUFFERED      = '1'   # print messages immediately (output is piped to the console)

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

# Run an external program; judge success by its exit code only. ('Continue' here so that
# progress text a tool writes to stderr is never mistaken for a PowerShell error.)
function Invoke-Native {
  param([scriptblock]$Command)
  $ErrorActionPreference = 'Continue'
  & $Command | Out-Host   # show output live instead of returning it as the function's result
  return $LASTEXITCODE
}

function Invoke-Checked {
  param([string]$What, [scriptblock]$Command)
  $code = Invoke-Native $Command
  if ($code -ne 0) { throw "$What failed (exit code $code)." }
}

function Install-Runtime {
  Say ''
  if (Get-ChildItem -Path $Runtime -Filter 'installed-*.txt' -ErrorAction SilentlyContinue) {
    Say '  Updating Stem Mixer' 'Cyan'
    Say '  -------------------' 'Cyan'
  } else {
    Say '  First-time setup' 'Cyan'
    Say '  ----------------' 'Cyan'
  }
  Say '  Stem Mixer is downloading what it needs. This happens only once and takes'
  Say '  about 5-15 minutes depending on your internet speed. Please keep this window open.'
  Say "  Everything goes into $Runtime"
  Say ''
  New-Item -ItemType Directory -Force -Path $Runtime | Out-Null

  if (-not (Test-Path $Uv)) {
    Say '  [1/5] Downloading the installer tool (uv)...' 'White'
    $zip = Join-Path $Runtime 'uv.zip'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/astral-sh/uv/releases/download/0.9.5/uv-x86_64-pc-windows-msvc.zip' -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $UvDir -Force
    Remove-Item $zip
  }

  Say '  [2/5] Setting up a private copy of Python...' 'White'
  if (Test-Path $Venv) { Remove-Item -Recurse -Force $Venv }
  Invoke-Checked 'Python setup' { & $Uv venv $Venv --python 3.11 --quiet }

  # Pick the PyTorch build that matches the graphics card. RTX 50-series cards (compute
  # capability 12.x) need PyTorch 2.7+ built for CUDA 12.8; older NVIDIA cards use 2.5.1 / CUDA 12.4.
  # (separator.py makes Demucs work on the newer PyTorch, and falls back to the CPU if a card
  # still can't be used.)
  $smi = (Get-Command nvidia-smi -ErrorAction SilentlyContinue).Source
  if (-not $smi -and (Test-Path "$env:SystemRoot\System32\nvidia-smi.exe")) { $smi = "$env:SystemRoot\System32\nvidia-smi.exe" }
  $gpu = $false
  if ($smi) {
    $cap = 0.0
    # Older drivers don't know this query; then $cap stays 0 and the CUDA 12.4 build is used.
    $raw = (& { $ErrorActionPreference = 'Continue'; & $smi --query-gpu=compute_cap --format=csv,noheader 2>$null } | Select-Object -First 1)
    if ($raw) { [void][double]::TryParse(([string]$raw).Trim(), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$cap) }
    if ($cap -ge 10) { $torchVer = '2.7.1'; $cuda = 'cu128'; $size = '3 GB' } else { $torchVer = '2.5.1'; $cuda = 'cu124'; $size = '2.5 GB' }
    Say "  [3/5] NVIDIA graphics card found - installing the GPU version of the AI engine (about $size)..." 'White'
    $code = Invoke-Native { & $Uv pip install --python $Python "torch==$torchVer" "torchaudio==$torchVer" --index-url "https://download.pytorch.org/whl/$cuda" }
    if ($code -eq 0) { $gpu = $true } else { Say '        GPU version failed to install; using the CPU version instead.' 'Yellow' }
  }
  if (-not $gpu) {
    if (-not $smi) { Say '  [3/5] Installing the AI engine (about 250 MB)...' 'White' }
    # On Windows the standard PyPI build of PyTorch is the CPU build.
    Invoke-Checked 'AI engine install' { & $Uv pip install --python $Python torch==2.5.1 torchaudio==2.5.1 }
  }

  Say '  [4/5] Installing the separation model code and audio decoder...' 'White'
  Invoke-Checked 'Demucs install' { & $Uv pip install --python $Python demucs==4.0.1 'numpy<2' imageio-ffmpeg==0.8.1 }

  Say '  [5/5] Downloading the AI model (about 80 MB)...' 'White'
  Invoke-Checked 'Model download' { & $Python (Join-Path $AppDir 'setup_check.py') }

  $mode = 'CPU'; if ($gpu) { $mode = 'GPU' }
  Set-Content -Path $Marker -Value "Installed $(Get-Date -Format s) ($mode)"
  Say ''
  Say "  Setup complete ($mode mode)." 'Green'
}

function Add-DesktopShortcut {
  try {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $lnk = Join-Path $desktop 'Stem Mixer.lnk'
    $bat = Join-Path (Split-Path -Parent $AppDir) 'Start Stem Mixer.bat'
    $shell = New-Object -ComObject WScript.Shell
    $s = $shell.CreateShortcut($lnk)
    if ($s.TargetPath -ne $bat) {
      $s.TargetPath = $bat
      $s.WorkingDirectory = Split-Path -Parent $bat
      $s.IconLocation = (Join-Path $AppDir 'stem-mixer.ico')
      $s.Description = 'Split songs into instruments and practice along'
      $s.Save()
      Say '  A "Stem Mixer" shortcut was added to your desktop.' 'Green'
    }
  } catch {
    Say '  (Could not create a desktop shortcut - you can still start Stem Mixer from this folder.)' 'Yellow'
  }
}

try {
  if (-not (Test-Path $Marker) -or -not (Test-Path $Python)) {
    Install-Runtime
    Add-DesktopShortcut
  }
  New-Item -ItemType Directory -Force -Path $Library | Out-Null

  Clear-Host
  Say ''
  Say '  Stem Mixer is running - it opens in your web browser.' 'Green'
  Say ''
  Say '  Keep this window open while you practice. Close it to quit Stem Mixer.'
  Say "  Your separated songs are saved in: $Library"
  Say ''
  $code = Invoke-Native { & $Python (Join-Path $AppDir 'server.py') --cache $Library }
  if ($code -ne 0) { throw "Stem Mixer stopped unexpectedly (exit code $code)." }
} catch {
  Say ''
  Say "  Something went wrong: $($_.Exception.Message)" 'Red'
  Say '  Check your internet connection and double-click "Start Stem Mixer" again;'
  Say '  setup continues where it left off. If it keeps failing, delete the folder'
  Say "  $Runtime and try once more."
  exit 1
}
