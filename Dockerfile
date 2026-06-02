# =============================================================================
# 農産物在庫管理システム — 本番(デモ)用 単一コンテナ
#   1. node ステージで React フロントを build
#   2. python ステージで FastAPI を動かし、build 済フロントを同梱して配信
#      (SERVE_FRONTEND=true で api/main.py が frontend/dist を配信)
# =============================================================================

# ---- フロントエンド build ----
FROM node:20-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Python ランタイム ----
FROM python:3.12-slim
WORKDIR /app

# 依存インストール (レイヤキャッシュのため requirements を先に)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# アプリ本体
COPY api/ ./api/
COPY db/ ./db/
COPY tools/ ./tools/
COPY run.py ./

# build 済フロントを api/main.py が探す場所に配置
COPY --from=frontend /app/frontend/dist ./frontend/dist

# StaticFiles マウント用にアップロードディレクトリを用意
RUN mkdir -p uploads

# build 済フロントを配信する
ENV SERVE_FRONTEND=true
EXPOSE 8000

# 起動時: DB を自動ブートストラップ(初回のみ schema+seed) してから API 起動。
# Render 等は $PORT を注入する。run.py は API_PORT を読む。
CMD ["sh", "-c", "python tools/bootstrap_db.py && API_PORT=${PORT:-8000} python run.py"]
