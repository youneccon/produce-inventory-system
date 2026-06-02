# =============================================================================
# setup.ps1
# 在庫管理システム Windows セットアップスクリプト
# =============================================================================
# 使い方:
#   PowerShell を「管理者として実行」で開き、
#   このファイルのある場所で以下を実行してください。
#
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\setup.ps1
# =============================================================================

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  在庫管理システム セットアップ" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# -----------------------------------------------------------------------------
# Step 1: Python の確認
# -----------------------------------------------------------------------------
Write-Host "[1/4] Python を確認しています..." -ForegroundColor Yellow

try {
    $pythonVersion = python --version 2>&1
    Write-Host "  OK: $pythonVersion" -ForegroundColor Green
} catch {
    Write-Host "  ERROR: Python が見つかりません。" -ForegroundColor Red
    Write-Host "  https://www.python.org/downloads/ からインストールしてください。" -ForegroundColor Red
    Write-Host "  インストール時に「Add Python to PATH」にチェックを入れてください。" -ForegroundColor Red
    exit 1
}

# -----------------------------------------------------------------------------
# Step 2: 仮想環境の作成
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "[2/4] 仮想環境を作成しています..." -ForegroundColor Yellow

if (Test-Path ".venv") {
    Write-Host "  既存の .venv を使用します。" -ForegroundColor Gray
} else {
    python -m venv .venv
    Write-Host "  OK: .venv を作成しました。" -ForegroundColor Green
}

# 仮想環境を有効化
& ".venv\Scripts\Activate.ps1"
Write-Host "  OK: 仮想環境を有効化しました。" -ForegroundColor Green

# -----------------------------------------------------------------------------
# Step 3: ライブラリのインストール
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "[3/4] ライブラリをインストールしています..." -ForegroundColor Yellow

pip install -r requirements.txt --quiet
if ($LASTEXITCODE -eq 0) {
    Write-Host "  OK: インストール完了。" -ForegroundColor Green
} else {
    Write-Host "  ERROR: インストールに失敗しました。" -ForegroundColor Red
    exit 1
}

# -----------------------------------------------------------------------------
# Step 4: .env ファイルの確認
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "[4/4] 設定ファイルを確認しています..." -ForegroundColor Yellow

if (Test-Path ".env") {
    Write-Host "  OK: .env が存在します。" -ForegroundColor Green
} else {
    Copy-Item ".env.example" ".env"
    Write-Host "  OK: .env.example から .env を作成しました。" -ForegroundColor Green
    Write-Host "  .env を開いて DATABASE_URL を確認してください。" -ForegroundColor Yellow
}

# -----------------------------------------------------------------------------
# 完了
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  セットアップ完了！" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "次のステップ:" -ForegroundColor White
Write-Host "  1. PostgreSQL をインストール・起動する（手順書を参照）"
Write-Host "  2. .env の DATABASE_URL を確認する"
Write-Host "  3. DBにスキーマを適用する:"
Write-Host "       psql -U postgres -d inventory_db -f db\schema.sql" -ForegroundColor Cyan
Write-Host "  4. APIを起動する:"
Write-Host "       .\start.ps1" -ForegroundColor Cyan
Write-Host ""
