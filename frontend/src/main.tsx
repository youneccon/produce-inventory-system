import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './auth/AuthContext.tsx'
import { PreferencesProvider } from './auth/PreferencesContext.tsx'
import { DialogProvider } from './components/Dialog.tsx'
import { installBrowserZoomBlocker } from './lib/blockBrowserZoom.ts'
import { initClientLog } from './lib/clientLog.ts'

// アプリ内ズームとの干渉を防ぐためブラウザのズーム機能を抑制
installBrowserZoomBlocker()
// フロントエンド の エラー / 重要 操作 を サーバー DB (client_logs) に 集約。
// ?debug=<name> 付き で 各 機能 の 詳細 trace も 送信 可能 に。
initClientLog()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <PreferencesProvider>
          <DialogProvider>
            <App />
          </DialogProvider>
        </PreferencesProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
