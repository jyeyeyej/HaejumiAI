
$ErrorActionPreference = "Stop"

# Backup settings
$backupDir = "C:\HaejumiAI-backups\postgres"
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"

$backupFile = Join-Path $backupDir "haejumi_dev_$timestamp.dump"
$tempFile = "/tmp/haejumi_backup_$timestamp.dump"

# Create backup directory
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

# PostgreSQL password
$securePassword = Read-Host "PostgreSQL password" -AsSecureString
$env:PGPASSWORD = [System.Net.NetworkCredential]::new(
    "",
    $securePassword
).Password

try {
    Write-Host "=================================="
    Write-Host " Haejumi PostgreSQL Backup"
    Write-Host "=================================="

    Write-Host "Database: haejumi"
    Write-Host "Schema: haejumi_dev"
    Write-Host "Backup file: $backupFile"

    # Create PostgreSQL backup
    docker exec `
        -e "PGPASSWORD=$env:PGPASSWORD" `
        haejumi-postgres `
        pg_dump `
        -U haejumi_user `
        -d haejumi `
        -n haejumi_dev `
        -Fc `
        -f $tempFile

    if ($LASTEXITCODE -ne 0) {
        throw "PostgreSQL backup failed"
    }

    # Copy backup from Docker to Windows
    docker cp "haejumi-postgres:$tempFile" $backupFile

    if ($LASTEXITCODE -ne 0) {
        throw "Backup file copy failed"
    }

    # Verify backup file
    $file = Get-Item $backupFile

    if ($file.Length -le 0) {
        throw "Backup file is empty"
    }

    # Verify PostgreSQL archive structure
    docker exec haejumi-postgres pg_restore --list $tempFile | Out-Null

    if ($LASTEXITCODE -ne 0) {
        throw "Backup archive validation failed"
    }

    # Calculate backup checksum
    $hash = Get-FileHash $backupFile -Algorithm SHA256

    Write-Host ""
    Write-Host "=================================="
    Write-Host " BACKUP PASS"
    Write-Host "=================================="

    Write-Host "File: $backupFile"
    Write-Host "Size: $($file.Length) bytes"
    Write-Host "SHA256: $($hash.Hash)"

} finally {
    # Remove temporary backup from Docker
    docker exec haejumi-postgres rm -f $tempFile | Out-Null

    # Remove password from environment
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    Remove-Variable securePassword -ErrorAction SilentlyContinue
}
