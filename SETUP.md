# 在庫管理システム — Windows セットアップ手順

Docker不要。PostgreSQL と Python を直接インストールして動かします。

---

## 必要なもの（インストール順）

1. **Python 3.12**
2. **PostgreSQL 16**

---

## Step 1 — Python のインストール

1. https://www.python.org/downloads/ を開く
2. 「Download Python 3.12.x」をクリック
3. インストーラーを起動
4. **「Add python.exe to PATH」に必ずチェックを入れる** ← 重要
5. 「Install Now」をクリック

インストール後、確認:
```
python --version
```
`Python 3.12.x` と表示されればOK。

---

## Step 2 — PostgreSQL のインストール

1. https://www.postgresql.org/download/windows/ を開く
2. 「Download the installer」をクリック
3. バージョン **16.x** の Windows x86-64 をダウンロード
4. インストーラーを起動
5. 設定はすべてデフォルトでOK
6. **「Password」は必ず控えておく**（後で使います）
7. Port はデフォルトの `5432` のまま

インストール後、スタートメニューから **pgAdmin 4** が起動できればOK。

---

## Step 3 — データベースの作成

pgAdmin 4 を使う場合:

1. pgAdmin 4 を起動
2. 左のツリーで `Servers > PostgreSQL 16 > Databases` を右クリック
3. `Create > Database` を選択
4. 「Database」欄に `inventory_db` と入力して Save

コマンドラインで行う場合:
```
psql -U postgres -c "CREATE DATABASE inventory_db;"
```
（パスワードを聞かれたら Step 2 で設定したものを入力）

---

## Step 4 — スキーマの適用

コマンドプロンプトで `inventory_system` フォルダに移動して実行:

```
psql -U postgres -d inventory_db -f db\schema.sql
```

エラーなく終了すればOK。

---

## Step 5 — プロジェクトのセットアップ

PowerShell を開き、`inventory_system` フォルダに移動して実行:

```
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\setup.ps1
```

途中で止まらずに「セットアップ完了！」と表示されればOK。

---

## Step 6 — .env の編集

`inventory_system` フォルダにある `.env` をメモ帳で開き、
`password` の部分を Step 2 で設定したパスワードに変更する:

```
DATABASE_URL=postgresql://postgres:ここをパスワードに変更@localhost:5432/inventory_db
```

保存して閉じる。

---

## Step 7 — 起動

PowerShell で:

```
.\start.ps1
```

以下が表示されれば起動成功:

```
Application startup complete.
```

ブラウザで http://localhost:8000/docs を開くと
全APIエンドポイントの一覧（Swagger UI）が表示されます。

---

## 停止方法

PowerShell で `Ctrl + C`

---

## 2回目以降の起動

Step 7 だけでOKです。

```
.\start.ps1
```

---

## うまくいかない場合

### `python` が認識されない
→ Python インストール時に「Add python.exe to PATH」のチェックを入れ忘れた可能性があります。
　 Python を一度アンインストールして、チェックを入れてインストールし直してください。

### `psql` が認識されない
→ コマンドプロンプトを一度閉じて開き直してください。
　 それでも解決しない場合は、PostgreSQL の `bin` フォルダを PATH に追加してください。
　 例: `C:\Program Files\PostgreSQL\16\bin`

### `connection refused` エラー
→ PostgreSQL が起動していない可能性があります。
　 スタートメニューで「サービス」を検索し、`postgresql-x64-16` が「実行中」か確認してください。

### `password authentication failed` エラー
→ `.env` の DATABASE_URL のパスワードが間違っています。
　 Step 6 を見直してください。
