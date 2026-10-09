param(
    [string]$MsysRoot = 'C:\msys64',
    [string]$BuildRoot = '',
    [int]$Jobs = 2
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
if (-not $BuildRoot) { $BuildRoot = Join-Path $MsysRoot 'tmp\tpms-libfive-build' }
if ($BuildRoot -match '[^\x00-\x7F]') { throw 'BuildRoot must be an ASCII path for MinGW.' }
$PinnedRevision = 'c9e97343e0af998cd1696e85583eccba95532b96'
$SourceRoot = Join-Path $BuildRoot 'source'
$BinaryRoot = Join-Path $BuildRoot 'build'
$ToolBin = Join-Path $MsysRoot 'ucrt64\bin'
$Cmake = Join-Path $ToolBin 'cmake.exe'
if (-not (Test-Path -LiteralPath $Cmake)) {
    throw 'Install MSYS2 UCRT64 gcc, cmake, ninja, eigen3, boost, libpng, pkgconf first. See docs/libfive.md.'
}
if ($Jobs -lt 1) { throw 'Jobs must be positive.' }
$OriginalPath = $env:PATH
$OriginalTemp = $env:TEMP
$OriginalTmp = $env:TMP
try {
    New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
    $env:TEMP = $BuildRoot
    $env:TMP = $BuildRoot
    $env:PATH = "$ToolBin;$(Join-Path $MsysRoot 'usr\bin');$OriginalPath"
    if (-not (Test-Path -LiteralPath $SourceRoot)) {
        New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
        & git clone https://github.com/libfive/libfive.git $SourceRoot
        if ($LASTEXITCODE -ne 0) { throw 'libfive clone failed.' }
        & git -C $SourceRoot checkout --detach $PinnedRevision
        if ($LASTEXITCODE -ne 0) { throw 'libfive pinned revision checkout failed.' }
    }
    $ActualRevision = & git -C $SourceRoot rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $ActualRevision -ne $PinnedRevision) {
        throw 'Source revision mismatch. Choose a fresh BuildRoot; existing source is preserved.'
    }
    if (& git -C $SourceRoot status --porcelain) { throw 'Upstream source has local edits; choose a fresh BuildRoot.' }
    # libfive was written for Eigen 3; MSYS2's eigen3 package now contains 5.
    $EigenRoot = Join-Path $BuildRoot 'eigen-3.4.0'
    if (-not (Test-Path -LiteralPath (Join-Path $EigenRoot 'Eigen\Core'))) {
        $EigenArchive = Join-Path $BuildRoot 'eigen-3.4.0.tar.gz'
        Invoke-WebRequest -UseBasicParsing 'https://gitlab.com/libeigen/eigen/-/archive/3.4.0/eigen-3.4.0.tar.gz' -OutFile $EigenArchive
        if ((Get-FileHash -LiteralPath $EigenArchive -Algorithm SHA256).Hash -ne '8586084F71F9BDE545EE7FA6D00288B264A2B7AC3607B974E54D13E7162C1C72') {
            throw 'Eigen archive checksum mismatch.'
        }
        & tar -xf $EigenArchive -C $BuildRoot
        if ($LASTEXITCODE -ne 0) { throw 'Eigen extraction failed.' }
    }
    & $Cmake -S (Join-Path $ProjectRoot 'native') -B $BinaryRoot -G Ninja `
        "-DLIBFIVE_SOURCE_DIR=$SourceRoot" '-DCMAKE_BUILD_TYPE=Release' `
        "-DTPMS_EIGEN_DIR=$EigenRoot" "-DCMAKE_PREFIX_PATH=$(Join-Path $MsysRoot 'ucrt64')" `
        "-DPNG_LIBRARY_RELEASE=$(Join-Path $MsysRoot 'ucrt64\lib\libpng.dll.a')" `
        "-DPNG_PNG_INCLUDE_DIR=$(Join-Path $MsysRoot 'ucrt64\include\libpng16')" `
        "-DZLIB_LIBRARY_RELEASE=$(Join-Path $MsysRoot 'ucrt64\lib\libz.dll.a')" `
        "-DZLIB_INCLUDE_DIR=$(Join-Path $MsysRoot 'ucrt64\include')" `
        "-DCMAKE_C_COMPILER=$(Join-Path $ToolBin 'gcc.exe')" `
        "-DCMAKE_CXX_COMPILER=$(Join-Path $ToolBin 'g++.exe')" `
        "-DCMAKE_MAKE_PROGRAM=$(Join-Path $ToolBin 'ninja.exe')"
    if ($LASTEXITCODE -ne 0) { throw 'libfive CMake configure failed.' }
    & $Cmake --build $BinaryRoot --target libfive --parallel $Jobs
    if ($LASTEXITCODE -ne 0) { throw 'libfive compile failed.' }
    $Destination = Join-Path $ProjectRoot 'native\libfive'
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $BinaryRoot 'upstream-kernel\libfive.dll') -Destination $Destination
    foreach ($Name in @('libgcc_s_seh-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll', 'libpng16-16.dll', 'zlib1.dll')) {
        Copy-Item -LiteralPath (Join-Path $ToolBin $Name) -Destination $Destination
    }
    # Keep distribution license notices alongside the native dependencies.
    $Licenses = Join-Path $Destination 'licenses'
    New-Item -ItemType Directory -Path $Licenses -Force | Out-Null
    $LicenseRoot = Join-Path $MsysRoot 'ucrt64\share\licenses'
    foreach ($Package in @('gcc-libs', 'libgcc', 'libstdc++', 'libwinpthread', 'libpng', 'zlib')) {
        $PackagePath = Join-Path $LicenseRoot $Package
        if (Test-Path -LiteralPath $PackagePath) {
            Copy-Item -LiteralPath $PackagePath -Destination $Licenses -Recurse -Force
        }
    }
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'native\MPL-2.0.txt') -Destination $Licenses
    Write-Host "Built libfive $PinnedRevision in $Destination"
} finally {
    $env:PATH = $OriginalPath
    $env:TEMP = $OriginalTemp
    $env:TMP = $OriginalTmp
}
