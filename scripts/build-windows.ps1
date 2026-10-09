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

$cudaPath = if ($env:CUDA_PATH) { $env:CUDA_PATH } else { 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.0' }
$useCuda = -not $CpuStt -and (Test-Path (Join-Path $cudaPath 'bin\nvcc.exe'))
Set-Location -LiteralPath $projectRoot
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    $releaseKey = Join-Path $env:LOCALAPPDATA 'MockInterviewRelease\signing.key'
    if (-not (Test-Path -LiteralPath $releaseKey)) {
        throw 'Release signing key required. Configure TAURI_SIGNING_PRIVATE_KEY before building.'
    }
    $env:TAURI_SIGNING_PRIVATE_KEY = $releaseKey
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
}
if ($useCuda) {
    # Rust and the C++ parts of whisper.cpp use the static MSVC runtime.
    # CMake's CUDA default is /MD, which otherwise fails at link time (LNK2038).
    $env:CMAKE_CUDA_FLAGS_RELEASE = '-Xcompiler="-MT -O2 -Ob2" -DNDEBUG'
    npm run tauri build -- --features cuda-stt
} else {
    npm run tauri build
}
if ($LASTEXITCODE -ne 0) { throw "Windows build failed: $LASTEXITCODE" }
Get-ChildItem (Join-Path $env:CARGO_TARGET_DIR 'release\bundle\nsis') -Filter '*.exe' |
    Select-Object FullName, Length
