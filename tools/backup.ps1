# =============================================================================
# tools/backup.ps1
# 在庫 DB バックアップ — タスクスケジューラ用 PowerShell ラッパー
# =============================================================================
# tools/backup_db.py を venv 経由で呼ぶ。ログを backups/log/ に残す。
#
# 直接実行:
#   .\tools\backup.ps1
#   .\tools\backup.ps1 -Keep 60
#
# Windows タスクスケジューラ登録 (管理者 PowerShell):
#   $action  = New-ScheduledTaskAction -Execute "powershell.exe" `
#              -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\backup.ps1`""
#   $trigger = New-ScheduledTaskTrigger -Daily -At 23:00
#   Register-ScheduledTask -TaskName "InventoryDailyBackup" `
#                          -Action $action -Trigger $trigger `
#                          -Description "在庫 DB バックアップ (daily)"
#
# Tailscale 経由で別 PC から取りに来る場合:
#   - backups/ ディレクトリを共有フォルダ化 (右クリック→共有)
#   - 別 PC から \\<office-pc>\backups\ にアクセス
#   - Tailscale で office-pc に名前で到達できる前提
# =============================================================================

param(
    [int]$Keep = 30,
    [string]$Dir = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# venv の python
$python = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    Write-Host "ERROR: .venv が見つかりません ($python)" -ForegroundColor Red
    exit 1
}

# ログディレクトリ
$logDir = if ($Dir) {
    Join-Path $Dir "log"
} else {
    Join-Path $root "backups\log"
}
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir ("backup_" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".log")

# Python 実行
$pyArgs = @("tools\backup_db.py", "--keep", $Keep)
if ($Dir) {
    $pyArgs += @("--dir", $Dir)
}

Write-Host "Running: $python $pyArgs" -ForegroundColor Cyan
Write-Host "Log    : $logFile" -ForegroundColor Cyan
Write-Host ""

# 標準出力 + エラー出力を tee してログに残す
& $python @pyArgs 2>&1 | Tee-Object -FilePath $logFile

$exitCode = $LASTEXITCODE
if ($exitCode -eq 0) {
    Write-Host ""
    Write-Host "✓ バックアップ成功" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "✗ バックアップ失敗 (exit $exitCode)" -ForegroundColor Red
}

# ログ自体のローテーション (60 件超で古いものを削除)
Get-ChildItem -Path $logDir -Filter "backup_*.log" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 60 |
    Remove-Item -Force -ErrorAction SilentlyContinue

exit $exitCode
