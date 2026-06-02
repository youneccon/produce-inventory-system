import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 0.0.0.0 で待ち受け: LAN・Tailscale・Cloudflare Tunnel から到達できるようにする
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,    // 5173 が埋まっていたら 5174 などへフォールバック
    // Host ヘッダー許可リスト (DNS Rebinding 攻撃対策)
    // - .trycloudflare.com: Cloudflare Quick Tunnel の動的サブドメイン
    // - .ts.net: Tailscale MagicDNS (例 <host>.tailXXXX.ts.net)
    allowedHosts: ['.trycloudflare.com', '.ts.net', 'localhost'],
    // フロントの /api/* と /uploads/* をバックエンド(8000)へプロキシ。CORSを避ける。
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/uploads': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
