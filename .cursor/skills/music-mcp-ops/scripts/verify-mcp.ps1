<#
.SYNOPSIS
    Health-check the supported music MCP servers declared in .cursor/mcp.json.

.DESCRIPTION
    Parses the project MCP config and probes the supported servers:

      * stdio servers  -> real MCP handshake (initialize + tools/list) through
                          probe-mcp-stdio.js; a server is healthy only if it
                          answers with at least one tool.
      * url servers    -> HTTP reachability plus SSE-only detection (GET 200 and
                          POST 404 means the server needs an mcp-remote bridge).

    Where a server exposes a local port, the listening socket and its owning
    process are reported so transport problems can be told apart from endpoint
    problems.

    Only services on the supported allowlist are probed. Entries outside it are
    reported as SKIP: the allowlist is everything this project's skills actually
    drive (own library, own accounts, release metadata search, and downloads into
    the project downloads directory).

.OUTPUT
    One PROBE_RESULT JSON line per probed server, then a summary table.
    Exit code 0 when no supported server failed, 1 otherwise.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/music-mcp-ops/scripts/verify-mcp.ps1

.EXAMPLE
    # Check a single server with a longer timeout
    powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/music-mcp-ops/scripts/verify-mcp.ps1 -Server foo_ai -TimeoutMs 120000
#>
[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [ValidateSet('qqmusic-mcp', 'foo_ai', 'fleapit', 'torrent-search-mcp', 'fluxdown', '')]
    [string]$Server = '',
    [int]$TimeoutMs = 90000
)

$ErrorActionPreference = 'Continue'
$ProbeMarker = 'PROBE_RESULT '

# Services this project's skills drive. Anything else in the config is out of scope.
#   library / playback : qqmusic-mcp, foo_ai
#   metadata search    : fleapit, torrent-search-mcp
#   downloads          : fluxdown
$SupportedServices = @('qqmusic-mcp', 'foo_ai', 'fleapit', 'torrent-search-mcp', 'fluxdown')

if (-not $ProjectRoot) {
    # scripts/ -> music-mcp-ops/ -> skills/ -> .cursor/ -> project root
    $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
}

$configPath = Join-Path $ProjectRoot '.cursor\mcp.json'
$probeScript = Join-Path $PSScriptRoot 'probe-mcp-stdio.js'

$rows = [System.Collections.ArrayList]::new()
function Add-Row {
    param([string]$Name, [string]$Status, [string]$Detail)
    [void]$rows.Add([pscustomobject]@{ Name = $Name; Status = $Status; Detail = $Detail })
}

function Test-Port {
    param([int]$Port)
    try {
        $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
        if ($listeners.Count -eq 0) { return $null }
        $ownerPid = $listeners[0].OwningProcess
        $procName = 'unknown'
        try { $procName = (Get-Process -Id $ownerPid -ErrorAction Stop).ProcessName } catch { }
        $bind = ($listeners | ForEach-Object { $_.LocalAddress } | Select-Object -Unique) -join ','
        return [pscustomobject]@{ Port = $Port; Owner = $procName; Pid = $ownerPid; Bind = $bind }
    } catch {
        return $null
    }
}

function Test-SseEndpoint {
    param([string]$Url)
    $result = [ordered]@{}
    foreach ($method in @('GET', 'POST')) {
        try {
            $request = [System.Net.HttpWebRequest]::Create($Url)
            $request.Method = $method
            $request.Timeout = 8000
            $request.Accept = 'text/event-stream, application/json'
            if ($method -eq 'POST') {
                $request.ContentType = 'application/json'
                $body = [System.Text.Encoding]::UTF8.GetBytes('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')
                $request.ContentLength = $body.Length
                $stream = $request.GetRequestStream()
                $stream.Write($body, 0, $body.Length)
                $stream.Close()
            }
            $response = $request.GetResponse()
            $result[$method] = [int]$response.StatusCode
            $response.Close()
        } catch [System.Net.WebException] {
            $webResponse = $_.Exception.Response
            if ($webResponse) {
                $result[$method] = [int]$webResponse.StatusCode
            } else {
                $result[$method] = 'ERR'
            }
        } catch {
            $result[$method] = 'ERR'
        }
    }
    return $result
}

# PowerShell's ConvertTo-Json unwraps single-element arrays, so build the JSON
# literal by hand to guarantee the probe always receives a real array.
function ConvertTo-JsonArrayLiteral {
    param([string[]]$Items)
    if ($null -eq $Items -or $Items.Count -eq 0) { return '[]' }
    $parts = foreach ($item in $Items) {
        $escaped = ([string]$item).Replace('\', '\\').Replace('"', '\"')
        '"' + $escaped + '"'
    }
    return '[' + ($parts -join ',') + ']'
}

Write-Host ''
Write-Host '=== Music MCP health check ===' -ForegroundColor Cyan
Write-Host "project root : $ProjectRoot"
Write-Host "config       : $configPath"
Write-Host "timeout      : ${TimeoutMs}ms per stdio server"
Write-Host ''

# ---------------------------------------------------------------- prerequisites
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    Add-Row 'prerequisite: node' 'PASS' ("{0} ({1})" -f $nodeCmd.Source, (& node --version 2>$null))
} else {
    Add-Row 'prerequisite: node' 'FAIL' 'node not found on PATH; stdio probing is unavailable'
}

# ---------------------------------------------------------------- config
$servers = $null
if (-not (Test-Path $configPath)) {
    Add-Row 'config: mcp.json' 'FAIL' "not found at $configPath"
} else {
    try {
        $config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $servers = $config.mcpServers
        if ($null -eq $servers) {
            Add-Row 'config: mcp.json' 'FAIL' 'parsed but has no mcpServers object'
        } else {
            $names = @($servers.PSObject.Properties.Name)
            Add-Row 'config: mcp.json' 'PASS' ("valid JSON; servers: " + ($names -join ', '))
        }
    } catch {
        Add-Row 'config: mcp.json' 'FAIL' ("invalid JSON: " + $_.Exception.Message)
    }
}

# ---------------------------------------------------------------- per-server probes
if ($null -ne $servers) {
    $skipped = @()

    foreach ($property in $servers.PSObject.Properties) {
        $name = $property.Name
        if ($Server -and $name -ne $Server) { continue }

        if ($SupportedServices -notcontains $name) {
            $skipped += $name
            Add-Row "server: $name" 'SKIP' 'not a supported service; out of scope for this project'
            continue
        }

        $entry = $property.Value
        $hasCommand = $null -ne $entry.command
        $hasUrl = $null -ne $entry.url

        if ($hasCommand) {
            $command = [string]$entry.command
            $cmdArgs = @()
            if ($null -ne $entry.args) { $cmdArgs = @($entry.args) | ForEach-Object { [string]$_ } }

            Add-Row "server: $name" 'INFO' ("stdio via {0} {1}" -f $command, ($cmdArgs -join ' '))

            if ($nodeCmd) {
                $env:PROBE_CMD = $command
                $env:PROBE_ARGS_JSON = ConvertTo-JsonArrayLiteral -Items $cmdArgs
                $env:PROBE_TIMEOUT_MS = "$TimeoutMs"
                try {
                    $probeOutput = & node $probeScript 2>$null
                } finally {
                    Remove-Item Env:PROBE_CMD, Env:PROBE_ARGS_JSON, Env:PROBE_TIMEOUT_MS -ErrorAction SilentlyContinue
                }

                $probeLine = @($probeOutput) | Where-Object { $_ -like "$ProbeMarker*" } | Select-Object -Last 1
                if (-not $probeLine) {
                    Add-Row "probe: $name" 'FAIL' 'probe produced no PROBE_RESULT line'
                } else {
                    Write-Host ($probeLine)
                    $payload = $probeLine.Substring($ProbeMarker.Length) | ConvertFrom-Json
                    if ($payload.ok) {
                        $version = if ($payload.serverInfo) { "$($payload.serverInfo.name) v$($payload.serverInfo.version)" } else { 'unknown' }
                        $unconfigured = $payload.stderrTail -match '(?i)(not configured|awaiting configuration|setup mode)'
                        if ($unconfigured) {
                            # Some MCP servers start in setup mode and only expose
                            # configuration tools until credentials are saved.
                            Add-Row "probe: $name" 'WARN' ("starts OK ({0}) but reports unconfigured; configure it before use" -f $version)
                        } else {
                            Add-Row "probe: $name" 'PASS' ("handshake OK; {0}; {1} tools" -f $version, $payload.toolCount)
                        }
                    } else {
                        $detail = "stage=$($payload.stage): $($payload.error)"
                        if ($payload.stderrTail) {
                            $tail = ($payload.stderrTail -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 2) -join ' | '
                            if ($tail) { $detail += " | stderr: $tail" }
                        }
                        Add-Row "probe: $name" 'FAIL' $detail
                    }
                }
            }

            # local port referenced by this server (e.g. an SSE bridge target)
            foreach ($arg in $cmdArgs) {
                if ($arg -notmatch '^(https?://)') { continue }
                $portMatch = [regex]::Match($arg, ':(?<port>\d{2,5})(/|$)')
                if (-not $portMatch.Success) { continue }
                $port = [int]$portMatch.Groups['port'].Value

                $listener = Test-Port -Port $port
                if ($listener) {
                    Add-Row "port: $port ($name)" 'PASS' ("listening on {0}; owner={1} (pid {2})" -f $listener.Bind, $listener.Owner, $listener.Pid)
                    if ($listener.Owner -eq 'foobar2000') {
                        # Confirm the MCP component is actually loaded rather than just
                        # a player running on the same port.
                        $builtin = @('foo_ui_std', 'foo_input_std', 'foo_dsp_std', 'foo_dsp_eq', 'foo_out_upnp',
                            'foo_converter', 'foo_fileops', 'foo_freedb2', 'foo_unpack')
                        try {
                            $thirdParty = @((Get-Process -Id $listener.Pid -ErrorAction Stop).Modules |
                                Where-Object { $_.ModuleName -like 'foo_*' -and ($builtin -notcontains ($_.ModuleName -replace '\.dll$', '')) })
                            if ($thirdParty.Count -gt 0) {
                                $names = ($thirdParty | ForEach-Object { $_.ModuleName }) -join ', '
                                Add-Row "module: ($name)" 'PASS' "third-party component loaded: $names"
                            } else {
                                Add-Row "module: ($name)" 'WARN' 'no third-party foobar2000 component in process modules'
                            }
                        } catch {
                            Add-Row "module: ($name)" 'WARN' 'could not enumerate process modules'
                        }
                    }
                } else {
                    Add-Row "port: $port ($name)" 'FAIL' 'nothing listening; the target service is not running'
                }

                $status = Test-SseEndpoint -Url $arg
                $getCode = $status['GET']
                $postCode = $status['POST']
                if ($getCode -eq 200) {
                    $detail = "GET=$getCode POST=$postCode"
                    if ($postCode -eq 404) {
                        $detail += ' (SSE-only: requires the mcp-remote bridge, not a direct url entry)'
                    }
                    Add-Row "endpoint: $arg" 'PASS' $detail
                } else {
                    Add-Row "endpoint: $arg" 'FAIL' "GET=$getCode POST=$postCode"
                }
            }
        } elseif ($hasUrl) {
            $url = [string]$entry.url
            Add-Row "server: $name" 'INFO' "remote url $url"
            $status = Test-SseEndpoint -Url $url
            $getCode = $status['GET']
            $postCode = $status['POST']
            if ($getCode -eq 200) {
                $detail = "GET=$getCode POST=$postCode"
                if ($postCode -eq 404) {
                    $detail += ' (SSE-only: Cursor cannot connect directly; bridge it with mcp-remote)'
                }
                Add-Row "endpoint: $name" 'PASS' $detail
            } else {
                Add-Row "endpoint: $name" 'FAIL' "GET=$getCode POST=$postCode"
            }
        } else {
            Add-Row "server: $name" 'FAIL' 'entry has neither command nor url'
        }
    }

    if ($skipped.Count -gt 0) {
        Add-Row 'out-of-scope entries' 'SKIP' ("found in config but not supported here: " + ($skipped -join ', '))
    }
}

# ---------------------------------------------------------------- summary
Write-Host ''
Write-Host '--- summary ---' -ForegroundColor Cyan
$rows | Format-Table -AutoSize -Wrap

$failCount = @($rows | Where-Object { $_.Status -eq 'FAIL' }).Count
$warnCount = @($rows | Where-Object { $_.Status -eq 'WARN' }).Count
$passCount = @($rows | Where-Object { $_.Status -eq 'PASS' }).Count
$skipCount = @($rows | Where-Object { $_.Status -eq 'SKIP' }).Count

Write-Host ("PASS={0}  WARN={1}  FAIL={2}  SKIP={3}" -f $passCount, $warnCount, $failCount, $skipCount)
if ($failCount -eq 0) {
    Write-Host 'RESULT: OK - all supported services are healthy.' -ForegroundColor Green
    exit 0
} else {
    Write-Host 'RESULT: FAILURES DETECTED - see the FAIL rows above.' -ForegroundColor Red
    exit 1
}
