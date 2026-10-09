# Keep the old switch accepted by existing local build commands. Release packages
# always use CPU Whisper so that startup does not depend on a developer's CUDA PATH.
param([switch]$CpuStt)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $env:CARGO_TARGET_DIR) {
    $env:CARGO_TARGET_DIR = Join-Path $projectRoot 'src-tauri\target'
}

if (-not $env:LIBCLANG_PATH) {
    $defaultClang = 'C:\Program Files\LLVM\bin'
    if (Test-Path (Join-Path $defaultClang 'libclang.dll')) {
        $env:LIBCLANG_PATH = $defaultClang
    }
}

Set-Location -LiteralPath $projectRoot
# Do not specialize the distributed speech runtime for the build machine's
# AVX-512 capabilities. AVX2 is the fixed Windows 11 x64 release baseline.
$env:GGML_NATIVE = 'OFF'
$env:GGML_AVX = 'ON'
$env:GGML_AVX2 = 'ON'
$env:GGML_AVX512 = 'OFF'
$env:GGML_AVX512_VBMI = 'OFF'
$env:GGML_AVX512_VNNI = 'OFF'
$env:GGML_AVX512_BF16 = 'OFF'
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    $releaseKey = Join-Path $env:LOCALAPPDATA 'MockInterviewRelease\signing.key'
    if (-not (Test-Path -LiteralPath $releaseKey)) {
        throw 'Release signing key required. Configure TAURI_SIGNING_PRIVATE_KEY before building.'
    }
    $env:TAURI_SIGNING_PRIVATE_KEY = $releaseKey
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
}
# Automated release builds must fail on signing errors instead of waiting on an
# invisible password prompt when Windows PowerShell drops an empty environment value.
npm run tauri build -- --ci
if ($LASTEXITCODE -ne 0) { throw "Windows build failed: $LASTEXITCODE" }
python scripts/verify_portable_runtime.py (Join-Path $env:CARGO_TARGET_DIR 'release\interview-cue.exe')
if ($LASTEXITCODE -ne 0) { throw 'Release runtime verification failed; do not publish this package.' }
Get-ChildItem (Join-Path $env:CARGO_TARGET_DIR 'release\bundle\nsis') -Filter '*.exe' |
    Select-Object FullName, Length
