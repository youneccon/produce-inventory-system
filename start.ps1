# =============================================================================
# start.ps1
# 在庫管理システム 起動スクリプト
# =============================================================================
# 使い方: PowerShell でこのファイルのある場所で実行
#   .\start.ps1
# =============================================================================

# 仮想環境を有効化
if (Test-Path ".venv\Scripts\Activate.ps1") {
    & ".venv\Scripts\Activate.ps1"
} else {
    Write-Host "ERROR: .venv が見つかりません。先に setup.ps1 を実行してください。" -ForegroundColor Red
    exit 1
}

# .env を読み込む
if (Test-Path ".env") {
    Get-Content ".env" | ForEach-Object {
        if ($_ -match "^\s*([^#][^=]+)=(.*)$") {
            [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process")
        }
    }
} else {
    Write-Host "ERROR: .env が見つかりません。setup.ps1 を先に実行してください。" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  在庫管理システム API 起動中..." -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  API:   http://localhost:8000" -ForegroundColor Green
Write-Host "  docs:  http://localhost:8000/docs" -ForegroundColor Green
Write-Host ""
Write-Host "  停止: Ctrl + C" -ForegroundColor Gray
Write-Host ""

python run.py
