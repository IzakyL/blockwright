param(
    [ValidateRange(1, 100)][int] $Iterations = 5,
    [ValidateRange(1, 3600)][int] $Frames = 120
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
    [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'This probe requires a Windows x64 desktop session.'
}

$probeBuild = Join-Path $PSScriptRoot 'build'
$libraries = Join-Path $probeBuild 'libraries'
$classes = Join-Path $probeBuild 'classes'
New-Item -ItemType Directory -Force -Path $probeBuild, $libraries, $classes | Out-Null

# Resolve the exact libraries shipped with Minecraft, including their official checksums.
# This downloads dependency jars only; it never downloads or launches the game.
$manifest = Invoke-RestMethod 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
$version = $manifest.versions | Where-Object id -eq '1.21.1'
if (-not $version) { throw 'Minecraft 1.21.1 was absent from the official version manifest.' }
$metadata = Invoke-RestMethod $version.url
$metadata | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $probeBuild 'minecraft-1.21.1.json') -Encoding utf8
$selected = @($metadata.libraries | Where-Object {
    $_.name -match '^org\.lwjgl:(lwjgl|lwjgl-glfw|lwjgl-opengl|lwjgl-openal):[^:]+(:natives-windows)?$'
})
if ($selected.Count -ne 8) { throw "Expected 8 LWJGL jars; received $($selected.Count)." }
foreach ($library in $selected) {
    $artifact = $library.downloads.artifact
    $target = Join-Path $libraries ([IO.Path]::GetFileName($artifact.path))
    if (-not (Test-Path -LiteralPath $target) -or
        (Get-FileHash -LiteralPath $target -Algorithm SHA1).Hash -ne $artifact.sha1) {
        Invoke-WebRequest -Uri $artifact.url -OutFile $target
    }
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA1).Hash -ne $artifact.sha1) {
        throw "Checksum mismatch: $($library.name)"
    }
}

$environmentReport = [ordered]@{
    timestamp = (Get-Date).ToUniversalTime().ToString('o')
    windows = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber
    gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion)
    java = (& java -version 2>&1 | Out-String).Trim()
    libraries = @($selected | ForEach-Object { [ordered]@{ name = $_.name; sha1 = $_.downloads.artifact.sha1 } })
    iterations = $Iterations
    framesPerIteration = $Frames
}
$environmentReport | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $probeBuild 'environment.json') -Encoding utf8

$classpath = Join-Path $libraries '*'
& javac --release 21 -encoding UTF-8 -classpath $classpath -d $classes (Join-Path $PSScriptRoot 'WindowsDisplayProbe.java')
if ($LASTEXITCODE -ne 0) { throw "Probe compilation failed ($LASTEXITCODE)." }
& java -classpath "$classes;$classpath" WindowsDisplayProbe $Iterations $Frames 2>&1 |
    Tee-Object -FilePath (Join-Path $probeBuild 'result.txt')
if ($LASTEXITCODE -ne 0) { throw "Windows display/audio probe failed ($LASTEXITCODE)." }
