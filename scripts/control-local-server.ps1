param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('web', 'backend')]
    [string]$Service,

    [Parameter(Mandatory = $true)]
    [ValidateSet('status', 'start', 'stop', 'restart')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
$taskName = if ($Service -eq 'web') { 'Haejumi-Web' } else { 'Haejumi-Backend' }
$port = if ($Service -eq 'web') { 5173 } else { 8765 }
$expectedCommand = if ($Service -eq 'web') { '*HaejumiAI*web*node_modules*vite*' } else { '*HaejumiAI*backend*node-http*server.js*' }

function Get-ListenerPid {
    $listeners = @(netstat -ano -p tcp | Select-String "127\.0\.0\.1:$port\s+.*LISTENING")
    if ($listeners.Count -gt 1) { throw "Port $port has multiple listeners; no process will be changed." }
    if ($listeners.Count -eq 0) { return $null }
    return [int](($listeners[0].ToString().Trim() -split '\s+')[-1])
}

function Assert-OwnedProcess([int]$processId) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
    if (-not $process -or $process.Name -ne 'node.exe' -or $process.CommandLine -notlike $expectedCommand) {
        throw "Port $port is not owned by the expected Haejumi $Service process."
    }
}

function Read-BackendState([string]$path) {
    try {
        $json = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop
    } catch {
        throw 'HAEJUMI_STATE_READ_FAILED: 작업 상태 파일을 읽을 수 없어 서버를 중지하지 않았습니다.'
    }
    try {
        $state = ConvertFrom-Json -InputObject $json -ErrorAction Stop
        if ($null -eq $state -or $null -eq $state.jobs -or $state.jobs -isnot [pscustomobject]) {
            throw 'Invalid jobs structure'
        }
        return $state
    } catch {
        throw 'HAEJUMI_STATE_INVALID: 작업 상태를 확인할 수 없어 서버를 중지하지 않았습니다.'
    }
}

function Stop-LocalServer {
    if ($Service -eq 'backend') {
        $state = Read-BackendState 'C:\HaejumiAI\data\state.json'
        $active = @($state.jobs.PSObject.Properties.Value | Where-Object { $_.status -in @('queued', 'running') })
        if ($active.Count) { throw 'An active render job exists; backend was not stopped.' }
    }
    $processId = Get-ListenerPid
    if ($null -ne $processId) { Assert-OwnedProcess $processId }
    Disable-ScheduledTask -TaskName $taskName | Out-Null
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -ne $processId -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $processId -Force
    }
    Start-Sleep -Milliseconds 500
    if ($null -ne (Get-ListenerPid)) { throw "Port $port remains open; inspect it before starting another server." }
}

function Start-LocalServer {
    $processId = Get-ListenerPid
    if ($null -ne $processId) {
        Assert-OwnedProcess $processId
        if ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') { return }
        throw "Port $port is held by a Haejumi process outside the scheduled task."
    }
    Enable-ScheduledTask -TaskName $taskName | Out-Null
    Start-ScheduledTask -TaskName $taskName
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 500
        if ($null -ne (Get-ListenerPid)) { return }
    }
    throw "$Service did not start within 10 seconds. Inspect data/runtime-logs/$Service.log."
}

switch ($Action) {
    'stop' { Stop-LocalServer }
    'start' { Start-LocalServer }
    'restart' { Stop-LocalServer; Start-LocalServer }
}

$task = Get-ScheduledTask -TaskName $taskName
$processId = Get-ListenerPid
[pscustomobject]@{ service = $Service; task = $taskName; task_state = $task.State.ToString(); listening = ($null -ne $processId); port = $port }
