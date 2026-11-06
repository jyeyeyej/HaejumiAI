$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path $PSScriptRoot -Parent
$nodePath = 'C:\Program Files\nodejs\node.exe'
$npmPath = 'C:\Program Files\nodejs\npm.cmd'

function Test-LocalPort([int]$port) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connection = $client.BeginConnect('127.0.0.1', $port, $null, $null)
        if (-not $connection.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($connection)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

if (-not (Test-LocalPort 8765)) {
    Start-Process -FilePath $nodePath -ArgumentList 'backend/src/adapters/node-http/server.js' -WorkingDirectory $projectRoot -WindowStyle Hidden
}

if (-not (Test-LocalPort 5173)) {
    Start-Process -FilePath $npmPath -ArgumentList 'run', 'dev' -WorkingDirectory (Join-Path $projectRoot 'web') -WindowStyle Hidden
}
