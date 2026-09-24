#Requires -Version 5.1
<#
.SYNOPSIS
  Inspect the project downloads directory: layout, audio count, and file locks.

.DESCRIPTION
  Reports how many audio tracks are on disk, how many non-audio sidecar files are present,
  and whether any audio file is still held by another process. The lock probe mirrors how
  foobar2000 opens media files (FileShare.Read); files that fail it cannot be opened by a
  player until the holding task is removed from the downloader.

  Exit codes:
    0 - no locked audio files
    1 - at least one audio file is locked
    2 - the downloads directory was not found

.PARAMETER Dir
  Downloads directory to inspect.

.PARAMETER Json
  Emit a single JSON object instead of the human-readable report.
#>
[CmdletBinding()]
param(
    [string]$Dir = 'd:\project\my-music\downloads',
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

$AudioExtensions = @(
    '.flac', '.m4a', '.mp3', '.wav', '.ape', '.wv', '.ogg', '.opus',
    '.aac', '.dsf', '.dff', '.wma', '.aiff', '.aif', '.mpc', '.tta'
)

if (-not (Test-Path -LiteralPath $Dir -PathType Container)) {
    # Write to stderr directly: Write-Error under ErrorActionPreference=Stop would throw
    # and pre-empt the exit code below.
    [Console]::Error.WriteLine("downloads directory not found: $Dir")
    exit 2
}

$allFiles = @(Get-ChildItem -LiteralPath $Dir -Recurse -File -ErrorAction SilentlyContinue)
$audioFiles = @($allFiles | Where-Object { $AudioExtensions -contains $_.Extension.ToLowerInvariant() })
$otherFiles = @($allFiles | Where-Object { $AudioExtensions -notcontains $_.Extension.ToLowerInvariant() })

# Player-style open: request only FileShare.Read. A file held for writing fails here.
$lockedFiles = @(
    foreach ($file in $audioFiles) {
        try {
            $stream = [System.IO.FileStream]::new(
                $file.FullName,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                [System.IO.FileShare]::Read
            )
            $stream.Close()
        }
        catch {
            $file.FullName
        }
    }
)

$audioBytes = ($audioFiles | Measure-Object -Property Length -Sum).Sum
if (-not $audioBytes) { $audioBytes = 0 }

$result = [ordered]@{
    dir          = (Resolve-Path -LiteralPath $Dir).Path
    audioCount   = $audioFiles.Count
    audioBytes   = [int64]$audioBytes
    otherCount   = $otherFiles.Count
    lockedCount  = $lockedFiles.Count
    lockedFiles  = $lockedFiles
    otherFiles   = @($otherFiles | ForEach-Object { $_.FullName })
}

if ($Json) {
    $result | ConvertTo-Json -Depth 4
}
else {
    Write-Output "DIR          = $($result.dir)"
    Write-Output "AUDIO_COUNT  = $($result.audioCount)"
    Write-Output "AUDIO_BYTES  = $($result.audioBytes)"
    Write-Output "OTHER_COUNT  = $($result.otherCount)"
    Write-Output "LOCKED_COUNT = $($result.lockedCount)"

    $byExtension = $audioFiles |
        Group-Object { $_.Extension.ToLowerInvariant() } |
        Sort-Object Count -Descending
    if ($byExtension) {
        Write-Output '--- audio by extension ---'
        foreach ($group in $byExtension) {
            Write-Output ("  {0,-6} {1}" -f $group.Name, $group.Count)
        }
    }

    if ($otherFiles) {
        Write-Output '--- non-audio (sidecars) ---'
        foreach ($file in $otherFiles) {
            Write-Output "  $($file.FullName)"
        }
    }

    if ($lockedFiles) {
        Write-Output '--- LOCKED (a player cannot open these) ---'
        foreach ($path in $lockedFiles) {
            Write-Output "  $path"
        }
        Write-Output 'Remove the owning download task (deleteFiles: false) to release the handle.'
    }
    else {
        Write-Output 'OK: no audio file is locked.'
    }
}

if ($lockedFiles.Count -gt 0) { exit 1 }
exit 0
