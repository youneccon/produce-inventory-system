# =============================================================================
# start-all.ps1
# 在庫管理システムの バックエンド(API) と フロントエンド(画面) を
# それぞれ別の PowerShell ウィンドウで同時に起動する。
# =============================================================================
# 使い方:
#   このファイルのある場所で  .\start-all.ps1
#
#   実行ポリシーで止められる場合:
#     powershell -ExecutionPolicy Bypass -File .\start-all.ps1
# =============================================================================

$root = $PSScriptRoot

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  在庫管理システム 起動" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# バックエンド（FastAPI / http://localhost:8000）
Write-Host "[1/2] バックエンドを起動しています..." -ForegroundColor Yellow
$backendCmd = "`$Host.UI.RawUI.WindowTitle='在庫管理システム - バックエンド (:8000)'; Set-Location '$root'; .\start.ps1"
Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $backendCmd

# フロントエンド（Vite / http://localhost:5173）
# npm.cmd を使うことで PowerShell の実行ポリシー問題（npm.ps1 ブロック）を回避。
Write-Host "[2/2] フロントエンドを起動しています..." -ForegroundColor Yellow
$frontendDir = Join-Path $root "frontend"
$frontendCmd = "`$Host.UI.RawUI.WindowTitle='在庫管理システム - フロントエンド (:5173)'; Set-Location '$frontendDir'; npm.cmd run dev"
Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $frontendCmd

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  起動コマンドを送信しました" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  バックエンド  : http://localhost:8000   (API / docs)" -ForegroundColor Green
Write-Host "  フロントエンド: http://localhost:5173   (ブラウザでここを開く)" -ForegroundColor Green
Write-Host ""
Write-Host "  各サーバーは別ウィンドウで動いています。" -ForegroundColor Gray
Write-Host "  停止する場合はそれぞれのウィンドウで Ctrl + C を押してください。" -ForegroundColor Gray
Write-Host ""
