/**
 * StorageCanvas — 倉庫レイアウト表示用 SVG キャンバス。
 *
 * ナビゲーション (統一: Space を「ナビモード」修飾キーとする):
 *   - Space + ドラッグ        = パン (オブジェクトの上から掴んでも OK)
 *   - Space + ホイール        = ズーム (カーソル位置基準)
 *   - 中ボタンドラッグ        = パン (Space 不要)
 *   - 空白ドラッグ            = パン (後方互換)
 *   - 2 本指ピンチ (タッチ)   = ズーム
 *   - ツールバーの ＋/−       = 中心基準ズーム
 *
 * 編集モード:
 *   - 空白クリック            = オブジェクト追加
 *   - オブジェクトドラッグ    = 移動
 *   - 右下ハンドル            = リサイズ
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { MousePointer2, SquarePlus, Square, Slash, Eraser } from 'lucide-react'
import type { StorageObject, StorageWall } from '../api/types'
import PalletStackSvg from './PalletStackSvg'
import { useDialog } from './Dialog'
import { isDebugMode, logTrace } from '../lib/clientLog'

export type CanvasTool = 'select' | 'add-object' | 'wall' | 'outline' | 'eraser'

interface Props {
  /** 背景画像 URL */
  imageUrl: string | null
  /** 背景画像の原寸（座標系の基準） */
  imageWidth: number | null
  imageHeight: number | null
  /** 表示する全オブジェクト */
  objects: StorageObject[]
  /** 表示する壁 (間取り) */
  walls?: StorageWall[]
  /** 選択中オブジェクト ID */
  selectedId?: number | null
  /** 複数 選択 (= Shift+click + marquee で 集合)。 marquee で セットアップ 必要 */
  selectedIds?: Set<number>
  /** ハイライト状態 — 半透明にしないもの (filter feature) */
  highlightIds?: Set<number>
  /** 各オブジェクトの塗り色 (id → CSS color) */
  fillByObject?: Map<number, string>
  /** 各オブジェクトのラベル下に出す補助テキスト (id → string) */
  subtitleByObject?: Map<number, string>
  /** A3.2: 詳細 表示 用 の 行 配列 (id → 複数 行)。 規格 / 数量 / 仕入先 / 入荷日 等 */
  infoLinesByObject?: Map<number, string[]>
  /** 各オブジェクトの総ケース数 (パレット visualizer 用、 0/未定義なら非表示) */
  casesByObject?: Map<number, number>
  /** リサイズハンドル無効化 (寸法固定; 原料パレットモード) */
  lockSize?: boolean
  /** 編集モード */
  editable: boolean
  /** 編集スコープ: 'object' = オブジェクト 配置/移動/削除、 'floor' = 床面/壁/間取り 編集。
   *  editable=true の とき のみ 意味 を 持つ。 default 'object' (後方 互換)。
   *  canvas tool palette は scope に 応じて 表示 ツール を フィルタ。 */
  editScope?: 'object' | 'floor'
  /** オブジェクトのクリック (選択)。 shift で 加算 選択。 */
  onSelect?: (id: number | null, shift?: boolean) => void
  /** 矩形 マーキー で 複数選択 を 確定 (= 含まれる object id 配列)。 PC mouse のみ */
  onSelectMany?: (ids: number[], additive: boolean) => void
  /** 空白クリックで新規追加 (編集モードのみ、select ツール時) */
  onCreate?: (x: number, y: number) => void
  /** オブジェクト移動・リサイズ */
  onUpdate?: (id: number, patch: Partial<Pick<StorageObject, 'x' | 'y' | 'width' | 'height'>>) => void
  /** 複数 同 delta 移動 (= 選択 中 オブジェクト 全部 を 同じ x/y だけ ずらす)。
   *  与え られない なら 単一 onUpdate だけ 動く。 */
  onUpdateMany?: (updates: Array<{ id: number; x: number; y: number }>) => void
  /** Ctrl+Shift+Drag で 複製 (= PPT 風、 軸 拘束)。 与え られない なら 無効。
   *  PC mouse のみ 動作 (touch / iPad では 不可)。 */
  onDuplicate?: (sourceId: number, x: number, y: number) => void
  /** 壁新規作成 (編集モードのみ、wall ツール時) */
  onWallCreate?: (x1: number, y1: number, x2: number, y2: number) => void
  /** 壁削除 (eraser ツール 時 + select ツール 選択中 の DEL/✕) */
  onWallDelete?: (id: number) => void
  /** 壁 選択中 ID (select ツール で 壁 click → editor が state 管理 → ここに渡す) */
  selectedWallId?: number | null
  /** 壁 を 選択 (select ツールで 壁 click) */
  onSelectWall?: (id: number | null) => void
  /** 倉庫全体の床面アウトライン (頂点配列、3 以上で閉じた多角形) */
  floorOutline?: [number, number][] | null
  /** 床面アウトライン更新 */
  onFloorOutlineChange?: (next: [number, number][] | null) => void
  /** 取消/やり直し */
  canUndo?: boolean
  canRedo?: boolean
  onUndo?: () => void
  onRedo?: () => void
  /** 上に重ねる任意の子（変化バッジなど） */
  children?: ReactNode
}

// 表示用の viewBox 状態
interface View { x: number; y: number; w: number; h: number }

// グリッドピッチ (SVG 座標)。1cm 換算で 20px としているが純粋に表示単位。
const GRID = 20
const SNAP_THRESHOLD = 14   // 既存壁の端点に吸着する距離

export default function StorageCanvas(p: Props) {
  const dialog = useDialog()
  const svgRef = useRef<SVGSVGElement>(null)
  const iw = p.imageWidth ?? 1200
  const ih = p.imageHeight ?? 800

  // 床面塗りつぶし用のバウンディング: image bounds と outline bounds の union。
  // user が image 範囲外に outline を引いても、 床の白 + grid が見えるようにする。
  const floorBbox = useMemo(() => {
    let minX = 0, minY = 0, maxX = iw, maxY = ih
    if (p.floorOutline && p.floorOutline.length >= 3) {
      for (const [x, y] of p.floorOutline) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
      // 少し余裕を持たせる (clip path で polygon に切り取られる、 大きい分には害なし)
      const pad = 40
      minX -= pad; minY -= pad; maxX += pad; maxY += pad
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }, [p.floorOutline, iw, ih])

  // ─── 描画ツール ───
  // select=既存挙動, wall=壁, outline=倉庫の床面多角形, eraser=削除
  const [tool, setTool] = useState<CanvasTool>('select')
  /** 壁ドラフト: 1点目を打ったあと、2点目クリックで線分が確定 */
  // 壁 描画 state machine (2026-05-24 拡張):
  //   wallDraft       = 確定済み の 「次 の 始点」 (チェーン継続中)
  //   wallChainStart  = チェーン の 一番 最初 の 点 (閉じる検出 用)
  //   wallCandidate   = touch/click 中 の 「候補位置」 (release で 確定)
  //                     iPad で touch-down → drag → release UX を 実現
  const [wallDraft, setWallDraft] = useState<{ x: number; y: number } | null>(null)
  const [wallChainStart, setWallChainStart] = useState<{ x: number; y: number } | null>(null)
  const [wallCandidate, setWallCandidate] = useState<
    { x: number; y: number; snapped: boolean } | null
  >(null)
  // 同期 ref: setState の React render 待ち が pointermove より 遅れる レース 回避
  const wallCandidateRef = useRef<{ x: number; y: number; snapped: boolean } | null>(null)
  function updateWallCandidate(v: { x: number; y: number; snapped: boolean } | null) {
    wallCandidateRef.current = v
    setWallCandidate(v)
  }
  const WALL_SNAP_PX = 15          // 端点 snap 半径 (SVG 座標)
  const WALL_CLOSE_PX = 12         // 「閉じる」 検出 半径
  /** カーソル位置 (壁/アウトラインのプレビュー用) */
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  /** アウトライン編集中: 頂点番号 (ドラッグ中)。
   *  useRef = pointer event 内 で 即時 参照 する ため (state 更新 待ち の cost 不要)。 */
  const outlineDragIndex = useRef<number | null>(null)
  /** ドラッグ中 頂点 を 視覚的 に 強調 する ため の state (render に 反映)。
   *  ref と 二重 管理 だが、 ref は handler 内 で 同期 的 に 読み、 state は render 用。 */
  const [activeVertexIdx, setActiveVertexIdx] = useState<number | null>(null)
  /** アウトラインを長方形ドラッグで作成中 (SVG 座標) */
  const [outlineRect, setOutlineRect] = useState<
    { sx: number; sy: number; ex: number; ey: number } | null
  >(null)

  // 初期 viewBox: 画像全体が見える比率
  const [view, setView] = useState<View>({ x: 0, y: 0, w: iw, h: ih })

  // Space キー押下中はパンモード (Figma 風)
  const [spaceDown, setSpaceDown] = useState(false)
  const spaceDownRef = useRef(false)
  // ✋ ハンドツール (escape hatch): タッチ デバイス で 「オブジェクト/壁 の 上 でも
  // 強制 pan したい」 ときに toggle。 default = false (閲覧でも編集でも)。
  //   - touch + 空白エリア は 自動 pan (panMode 不要、 別経路 で 実装済み)
  //   - object/wall tap は select 動作 (panMode=false の とき)
  //   - panMode=true ⇒ 全 click が pan、 selection 無効
  // ✋ button は 閲覧 モード のみ 表示 (編集中 は 必要 性 低く 混乱要因 のため hide)
  const [panMode, setPanMode] = useState(false)
  const panModeRef = useRef(false)
  useEffect(() => { panModeRef.current = panMode }, [panMode])
  // editable mode 切替 で panMode リセット (前モード の 状態 が 残ら ない よう に)
  useEffect(() => { setPanMode(false) }, [p.editable])
  // editable 切替 で 壁チェーン 状態 を 完全 リセット (閲覧→編集 復帰時 に 古い
  // wallDraft が 残り 「次タップ で 2点目扱い → 想定外 の 壁」 バグ を 防ぐ)。
  // tool 切替 でも 同様 リセット (button onClick で 既に やってる が 念のため 二重保険)。
  useEffect(() => {
    setWallDraft(null)
    setWallChainStart(null)
    wallCandidateRef.current = null
    setWallCandidate(null)
    setCursor(null)   // hover preview の 古い 位置 も リセット
  }, [p.editable])
  useEffect(() => {
    function isEditingTarget(el: EventTarget | null): boolean {
      if (!(el instanceof HTMLElement)) return false
      const tag = el.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
    }
    function onKeyDown(e: KeyboardEvent) {
      if (isEditingTarget(e.target)) return
      if (e.code === 'Space') {
        if (e.repeat) { e.preventDefault(); return }
        spaceDownRef.current = true
        setSpaceDown(true)
        e.preventDefault()    // ページスクロール抑止
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code !== 'Space') return
      spaceDownRef.current = false
      setSpaceDown(false)
    }
    function onToolKey(e: KeyboardEvent) {
      if (!p.editable) return
      if (isEditingTarget(e.target)) return
      if (e.code === 'KeyV') setTool('select')
      else if (e.code === 'KeyA') setTool('add-object')
      else if (e.code === 'KeyW') setTool('wall')
      else if (e.code === 'KeyO') setTool('outline')
      else if (e.code === 'KeyE') setTool('eraser')
      else if (e.code === 'Escape') {
        setWallDraft(null); setWallChainStart(null); updateWallCandidate(null); setCursor(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('keydown', onToolKey)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('keydown', onToolKey)
    }
  }, [p.editable])

  // ─────────────────────────────────────────────────────────────────────
  // SVG pointer events を ネイティブ addEventListener で 処理 (iOS Safari + React
  // 18 で onPointerMove が 1 度 しか 発火 し ない 不具合 を 回避)。
  //
  // 経緯 (2026-05-24 デバッグ で 確定):
  //   ?debug=pan で 取った ログ で 「ネイティブ pointermove は 大量 発火 する のに
  //   React の onSvgPointerMove は 1 回 しか 呼ばれ ない」 と 判明。 React 18 の
  //   event delegation が iOS Safari の SVG 内部 で setPointerCapture と 噛み合わ
  //   ず pointermove を 取り逃がす らしい。
  //
  // 解決:
  //   - SVG (svgRef) に native addEventListener で pointerdown/move/up を 直接 紐付け
  //   - React の onPointer* は SVG 要素 から 外す (子要素 は そのまま で OK)
  //   - handlerRef パターン で 最新 の handler closure を 呼ぶ (state を 確実 に 取得)
  // ─────────────────────────────────────────────────────────────────────
  const handlerRef = useRef({
    down: undefined as ((e: React.PointerEvent<SVGSVGElement>) => void) | undefined,
    move: undefined as ((e: React.PointerEvent<SVGSVGElement>) => void) | undefined,
    up:   undefined as ((e: React.PointerEvent<SVGSVGElement>) => void) | undefined,
  })

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const debugPan = isDebugMode('pan')
    let lastMoveLog = 0

    function logNativePointer(e: PointerEvent) {
      if (!debugPan) return
      if (e.type === 'pointermove') {
        const now = performance.now()
        if (now - lastMoveLog < 100) return
        lastMoveLog = now
      }
      logTrace(`native:${e.type}`, {
        pointerType: e.pointerType, button: e.button,
        x: Math.round(e.clientX), y: Math.round(e.clientY),
        target: (e.target as Element | null)?.tagName,
      })
    }
    function noDefaultTouch(e: TouchEvent) {
      // touchstart のみ preventDefault (double-tap zoom 抑止)。 touchmove は
      // preventDefault する と iOS で pointer events 配信 が 怪しく なる 報告 あり、
      // touch-action: none CSS に 任せる。
      if (e.type === 'touchstart') e.preventDefault()
      if (debugPan) {
        logTrace(`native:${e.type}`, {
          touches: e.touches.length,
          target: (e.target as Element | null)?.tagName,
        })
      }
    }
    function nativeDown(e: PointerEvent) {
      logNativePointer(e)
      // インタラクティブ ハンドル (頂点/中点/壁/オブジェクト等) の 上 では SVG の
      // pan ロジック を 起動 し ない。 ネイティブ event は React stopPropagation で
      // 止まら ない ため、 ここ で 明示的 に 識別。
      // 各 ハンドル の <g>/<line> に data-storage-handle 属性 を 付与 して 識別。
      const tgt = e.target as Element | null
      if (tgt?.closest('[data-storage-handle]')) {
        if (debugPan) {
          logTrace('native:pointerdown skipped (interactive handle target)', {
            target: tgt.tagName,
          })
        }
        return
      }
      handlerRef.current.down?.(e as unknown as React.PointerEvent<SVGSVGElement>)
    }
    function nativeMove(e: PointerEvent) {
      logNativePointer(e)
      handlerRef.current.move?.(e as unknown as React.PointerEvent<SVGSVGElement>)
    }
    function nativeUp(e: PointerEvent) {
      logNativePointer(e)
      handlerRef.current.up?.(e as unknown as React.PointerEvent<SVGSVGElement>)
    }

    svg.addEventListener('touchstart', noDefaultTouch, { passive: false })
    svg.addEventListener('touchmove', noDefaultTouch, { passive: false })
    svg.addEventListener('pointerdown', nativeDown)
    svg.addEventListener('pointermove', nativeMove)
    svg.addEventListener('pointerup', nativeUp)
    svg.addEventListener('pointercancel', nativeUp)

    if (debugPan) {
      logTrace('debug=pan StorageCanvas mounted', {
        ua: navigator.userAgent,
        editable: p.editable,
      })
    }
    return () => {
      svg.removeEventListener('touchstart', noDefaultTouch)
      svg.removeEventListener('touchmove', noDefaultTouch)
      svg.removeEventListener('pointerdown', nativeDown)
      svg.removeEventListener('pointermove', nativeMove)
      svg.removeEventListener('pointerup', nativeUp)
      svg.removeEventListener('pointercancel', nativeUp)
    }
  }, [p.editable])

  // 毎 render で handlerRef を 最新 に 更新 (closure の view/tool/state を 反映)
  useEffect(() => {
    handlerRef.current.down = onSvgPointerDown
    handlerRef.current.move = onSvgPointerMove
    handlerRef.current.up   = onSvgPointerUp
  })

  // ─── スナップ: グリッド + 既存壁の端点 ───
  function snap(x: number, y: number): { x: number; y: number } {
    let nx = Math.round(x / GRID) * GRID
    let ny = Math.round(y / GRID) * GRID
    // 既存壁の端点に近ければそちらに優先吸着
    if (p.walls) {
      for (const w of p.walls) {
        for (const [px, py] of [[w.x1, w.y1], [w.x2, w.y2]] as const) {
          if (Math.hypot(px - x, py - y) < SNAP_THRESHOLD) {
            nx = px; ny = py
          }
        }
      }
    }
    return { x: nx, y: ny }
  }
  // (旧 orthoSnap 廃止 2026-05-24)

  /** 壁端点 snap: 既存壁の各端点を確認し、 threshold 以内なら吸着 */
  function snapToWallEndpoint(
    pt: { x: number; y: number }, threshold = WALL_SNAP_PX,
  ): { x: number; y: number; snapped: boolean } {
    if (!p.walls) return { ...pt, snapped: false }
    let best: { x: number; y: number; d: number } | null = null
    for (const w of p.walls) {
      for (const [ex, ey] of [[w.x1, w.y1], [w.x2, w.y2]] as const) {
        const d = Math.hypot(ex - pt.x, ey - pt.y)
        if (d <= threshold && (best === null || d < best.d)) {
          best = { x: ex, y: ey, d }
        }
      }
    }
    if (best) return { x: best.x, y: best.y, snapped: true }
    return { ...pt, snapped: false }
  }

  // 画像サイズ変更時に viewBox をリセット
  useEffect(() => {
    setView({ x: 0, y: 0, w: iw, h: ih })
  }, [iw, ih])

  // 印刷前に viewBox をフルサイズへ。印刷後も維持（ユーザーが復元したい時は ⟳ ボタン）。
  useEffect(() => {
    const before = () => setView({ x: 0, y: 0, w: iw, h: ih })
    window.addEventListener('beforeprint', before)
    return () => window.removeEventListener('beforeprint', before)
  }, [iw, ih])

  /** クライアント座標を SVG ローカル座標に変換 */
  /** iPad の 指 で 隠れる 問題: touch 時、 認識位置 を 指 から 30px 上 に オフセット。
   *  → 候補マーカー が 指 の 上 に 見える (lift-up callout pattern)。
   *  PC マウス は オフセット 無し。 PointerEvent を 直接 渡す ヘルパー。 */
  const IPAD_FINGER_OFFSET_Y = 30
  function pointerToSvg(e: { clientX: number; clientY: number; pointerType: string }): { x: number; y: number } {
    const offsetY = e.pointerType === 'touch' ? IPAD_FINGER_OFFSET_Y : 0
    return clientToSvg(e.clientX, e.clientY - offsetY)
  }

  function clientToSvg(cx: number, cy: number): { x: number; y: number } {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    // SVG デフォルト preserveAspectRatio="xMidYMid meet": content は uniform scale で
    // letterbox 配置 される。 X/Y 別倍率 で 計算 する と aspect 比 違い 時 に offset
    // 発生 (PC で マウス と プレビュー が ずれる バグ 真因)。 正しく letterbox を 考慮:
    const scale = Math.min(rect.width / view.w, rect.height / view.h)
    const contentW = view.w * scale
    const contentH = view.h * scale
    const letterX = (rect.width - contentW) / 2
    const letterY = (rect.height - contentH) / 2
    return {
      x: view.x + (cx - rect.left - letterX) / scale,
      y: view.y + (cy - rect.top - letterY) / scale,
    }
  }

  // -------- ホイールズーム --------
  // ナビモード (Space 押下中) または トラックパッドピンチ (ctrlKey 付き) で発火。
  // それ以外の通常ホイールはページスクロールに任せる。
  function onWheel(e: React.WheelEvent<SVGSVGElement>) {
    // Space = 単一ナビ修飾キー / ctrlKey=true はブラウザがピンチを伝える仕組み
    if (!spaceDownRef.current && !e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    const factor = Math.exp(e.deltaY * 0.0015) // 1 wheel notch ≈ 1.15x
    const center = clientToSvg(e.clientX, e.clientY)
    setView((v) => {
      const newW = Math.max(20, Math.min(iw * 8, v.w * factor))
      const newH = Math.max(20, Math.min(ih * 8, v.h * factor))
      return {
        x: center.x - (center.x - v.x) * (newW / v.w),
        y: center.y - (center.y - v.y) * (newH / v.h),
        w: newW, h: newH,
      }
    })
  }

  // -------- パン / ピンチズーム --------
  // 現在キャンバスに乗っているポインタ群 (pointerId → 位置)
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  // 単一指/マウスのパン状態（moved=true なら実際にドラッグした）
  // isPan=true の時 だけ 実際 に view を 動かす (= Space / 中ボタン / ✋ panMode)。
  // isPan=false の 場合 は タップ 検出 のみ で、 ドラッグ しても view は 動か ない
  // (空白 タップ → オブジェクト 配置 のため に panState は 設定 する)。
  const panState = useRef<{
    sx: number; sy: number; vx: number; vy: number; moved: boolean;
    pointerType: string; button: number; isPan: boolean;
  } | null>(null)
  // 2本指のピンチ状態
  const pinchState = useRef<{
    startDist: number; startCx: number; startCy: number;
    startView: View;
  } | null>(null)
  // クリック扱いかドラッグ扱いかの境界（px）
  const DRAG_THRESHOLD = 4

  function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.hypot(a.x - b.x, a.y - b.y)
  }

  /** このイベントが「パン操作」かどうか (panMode / Space 押下中 / 中ボタン)。
   *  iPad 等 タッチ デバイス は キーボード や 中ボタン が 無い ため、 ツールバー の
   *  ✋ ボタン で panMode を ON に する と オブジェクト/ハンドル の 上 でも pan できる。 */
  function isPanGesture(e: React.PointerEvent): boolean {
    return panModeRef.current || spaceDownRef.current || e.button === 1
  }

  function onSvgPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    // 頂点 ドラッグ 中 は 完全 に pan 抑止 (別 指 が 触っても 反応 しない)。
    // React stopPropagation は ネイティブ event を 止め ない ため、 SVG 上 の
    // ネイティブ listener が 必ず 呼ばれる → ここで flag check で 早期 return。
    if (outlineDragIndex.current !== null) {
      if (isDebugMode('pan')) {
        logTrace('react:onSvgPointerDown blocked (vertex drag in progress)', {
          vertex: outlineDragIndex.current,
        })
      }
      return
    }
    if (isDebugMode('pan')) {
      logTrace('react:onSvgPointerDown', {
        pointerType: e.pointerType, button: e.button,
        target: (e.target as Element | null)?.tagName,
        panMode: panModeRef.current, spaceDown: spaceDownRef.current,
        isPan: isPanGesture(e),
        tool,
      })
    }
    const onEmpty = e.target === svgRef.current
      || (e.target as SVGElement).tagName === 'image'
      || (e.target as SVGElement).tagName === 'rect'    // グリッド背景
    // アウトラインツール:
    // - 既存アウトラインなし → 長方形ドラッグで作成 (Figma フレーム方式)
    // - 既存アウトラインあり → 空白タップは何もしない (頂点/中点ハンドルが処理)
    if (p.editable && tool === 'outline' && !isPanGesture(e) && e.button === 0) {
      const hasOutline = (p.floorOutline?.length ?? 0) >= 3
      if (!hasOutline) {
        const sp = pointerToSvg(e)
        const pt = snap(sp.x, sp.y)
        setOutlineRect({ sx: pt.x, sy: pt.y, ex: pt.x, ey: pt.y })
        try { svgRef.current?.setPointerCapture(e.pointerId) } catch { /* noop */ }
      }
      return
    }

    // 壁ツール (2026-05-24 候補ドラッグモデル):
    //   pointerdown   → wallCandidate を 設定 (snap 適用)。 まだ 確定 しない
    //   pointermove   → candidate 追従 (ユーザー が 微調整 できる)
    //   pointerup     → 確定 (wallDraft セット or 壁 作成)
    //   PC click も 上記 で 動く (down→up が 即座 = 即確定)
    //   iPad touch-and-drag UX に 対応
    if (p.editable && tool === 'wall' && !isPanGesture(e) && e.button === 0) {
      const sp = pointerToSvg(e)  // iPad は finger-offset 補正
      const raw = { x: Math.max(0, sp.x), y: Math.max(0, sp.y) }
      const snapped = snapToWallEndpoint(raw)
      updateWallCandidate(snapped)
      try { svgRef.current?.setPointerCapture(e.pointerId) } catch { /* noop */ }
      return
    }
    if (!onEmpty && !isPanGesture(e)) {
      // オブジェクト/ハンドル上はその子の onPointerDown で処理
      // (ただし Space/中ボタンの場合は強制パン)
      return
    }
    // ─── マーキー 選択 (PC mouse のみ) ───────────────────────────────────
    // tool=select + 編集モード + 空白 mouse pointerdown → 矩形 ドラッグ 開始。
    // pan ジェスチャー (Space / ✋ / 中ボタン) と 競合 し ない よう、 isPan=false
    // が 確定 した あと だけ。 touch / iPad は そもそも 空白 タップ で pan に なる ので
    // marquee は PC mouse 限定 と する (= UX 仕様)。
    if (
      p.editable && p.editScope === 'object' && tool === 'select'
      && e.pointerType === 'mouse' && e.button === 0 && !isPanGesture(e)
      && p.onSelectMany
    ) {
      const sp = pointerToSvg(e)
      marqueeRef.current = {
        sx: sp.x, sy: sp.y, cx: sp.x, cy: sp.y,
        additive: e.shiftKey,
      }
      setMarqueeRect({ x: sp.x, y: sp.y, w: 0, h: 0, additive: e.shiftKey })
      try { svgRef.current?.setPointerCapture(e.pointerId) } catch { /* noop */ }
      return
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    // 2本指 → ピンチ開始
    if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values())
      pinchState.current = {
        startDist: dist(a, b),
        startCx:   (a.x + b.x) / 2,
        startCy:   (a.y + b.y) / 2,
        startView: { ...view },
      }
      panState.current = null
      return
    }

    // 左/中ボタン or タッチ: panState を 常 に 設定 (タップ 検出 + 場合 によって pan)。
    // isPan = 実際 に view を 動かす か:
    //   - Space / 中ボタン / ✋ panMode (isPanGesture)
    //   - OR タッチ + 空白エリア (iPad で 普段 の pan を 自動 化、 ✋ タップ 不要)
    // タッチ + オブジェクト/壁/ハンドル の 上 は ✋ 経由 が 必要 (escape hatch)。
    // isPan=false の 場合、 動かして も view は 動かず、 離した 時 に moved=false なら
    // タップ 扱い で オブジェクト 配置 が 走る。
    if (e.button === 0 || e.button === 1 || e.pointerType === 'touch') {
      const isPan = isPanGesture(e)
        || (e.pointerType === 'touch' && onEmpty)
      panState.current = {
        sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false,
        pointerType: e.pointerType, button: e.button,
        isPan,
      }
      try { svgRef.current?.setPointerCapture(e.pointerId) } catch { /* noop */ }
    }
  }

  function onSvgPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }

    // 壁ツール: candidate 更新 (touch/click ドラッグ中) と cursor 追跡
    //   wallCandidate != null ⇒ ユーザー が 触って いる/クリック中
    //   (pointers.current は 壁ツール ブランチ で 設定 し ない ため 使わない)
    if (p.editable && tool === 'wall') {
      const sp = pointerToSvg(e)  // iPad finger-offset 補正
      const raw = { x: Math.max(0, sp.x), y: Math.max(0, sp.y) }
      // wallCandidateRef = 同期 ref で 最新値 参照 (state 更新 待ち の race 回避)
      if (wallCandidateRef.current) {
        // touch/click 中: snap 適用 して 候補 を 追従 更新 (iPad の drag-to-refine)
        const sn = snapToWallEndpoint(raw)
        updateWallCandidate(sn)
      }
      // PC マウス hover: candidate なしでも cursor を 追跡 (preview 線 用)
      setCursor(raw)
    } else if (cursor) {
      setCursor(null)
    }

    // マーキー (= 矩形 選択) 更新
    if (marqueeRef.current) {
      const sp = pointerToSvg(e)
      marqueeRef.current.cx = sp.x
      marqueeRef.current.cy = sp.y
      const m = marqueeRef.current
      const x = Math.min(m.sx, m.cx), y = Math.min(m.sy, m.cy)
      const w = Math.abs(m.cx - m.sx), h = Math.abs(m.cy - m.sy)
      setMarqueeRect({ x, y, w, h, additive: m.additive })
      return
    }

    // アウトライン rect ドラッグ中
    if (outlineRect) {
      const sp = pointerToSvg(e)
      const pt = snap(sp.x, sp.y)
      setOutlineRect({ ...outlineRect, ex: pt.x, ey: pt.y })
      return
    }

    // ピンチ中 (2本指)
    const pinch = pinchState.current
    if (pinch && pointers.current.size === 2 && svgRef.current) {
      const [a, b] = Array.from(pointers.current.values())
      const d = dist(a, b)
      const scale = pinch.startDist > 0 ? pinch.startDist / d : 1
      const rect = svgRef.current.getBoundingClientRect()
      const centerClientX = (a.x + b.x) / 2
      const centerClientY = (a.y + b.y) / 2
      const startRatioX = pinch.startView.w / rect.width
      const startRatioY = pinch.startView.h / rect.height
      const centerSvgX = pinch.startView.x + (pinch.startCx - rect.left) * startRatioX
      const centerSvgY = pinch.startView.y + (pinch.startCy - rect.top)  * startRatioY
      const newW = Math.max(20, Math.min(iw * 8, pinch.startView.w * scale))
      const newH = Math.max(20, Math.min(ih * 8, pinch.startView.h * scale))
      const dxClient = centerClientX - pinch.startCx
      const dyClient = centerClientY - pinch.startCy
      const dx = dxClient * (newW / rect.width)
      const dy = dyClient * (newH / rect.height)
      setView({
        x: centerSvgX - (centerSvgX - pinch.startView.x) * (newW / pinch.startView.w) - dx,
        y: centerSvgY - (centerSvgY - pinch.startView.y) * (newH / pinch.startView.h) - dy,
        w: newW, h: newH,
      })
      return
    }

    // 単一指/マウスパン: 移動距離が閾値を超えたら moved=true にする。
    // ただし isPan=false (= 通常 タップ、 Space/✋ 無し) の 時 は view は 動かさず、
    // タップ vs ドラッグ の 判定 だけ 続ける (= moved 記録 のみ)。 PC で 偶然 マウス を
    // 動かして view が ずれる の を 防ぐ。
    const s = panState.current
    if (!s || !svgRef.current) return
    const dxC = Math.abs(e.clientX - s.sx)
    const dyC = Math.abs(e.clientY - s.sy)
    if (!s.moved && (dxC > DRAG_THRESHOLD || dyC > DRAG_THRESHOLD)) {
      s.moved = true
    }
    if (!s.moved) return
    if (!s.isPan) {
      if (isDebugMode('pan')) {
        logTrace('react:onSvgPointerMove blocked (not pan gesture)', {
          isPan: s.isPan, moved: s.moved, pointerType: s.pointerType,
        })
      }
      return     // ← 直接ドラッグ禁止: pan は Space / ✋ 経由 のみ
    }
    const rect = svgRef.current.getBoundingClientRect()
    const dx = (e.clientX - s.sx) * (view.w / rect.width)
    const dy = (e.clientY - s.sy) * (view.h / rect.height)
    setView((v) => ({ ...v, x: s.vx - dx, y: s.vy - dy }))
  }

  function onSvgPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) {
      pinchState.current = null
    }

    // マーキー 確定: 矩形 と 完全 に 含まれる object id を 集めて onSelectMany
    if (marqueeRef.current) {
      const m = marqueeRef.current
      const x = Math.min(m.sx, m.cx), y = Math.min(m.sy, m.cy)
      const w = Math.abs(m.cx - m.sx), h = Math.abs(m.cy - m.sy)
      marqueeRef.current = null
      setMarqueeRect(null)
      try { svgRef.current?.releasePointerCapture(e.pointerId) } catch { /* noop */ }
      // 極小 (= 偶発 click) は 無視 → 通常 の 空白 click 扱い で 全 解除
      if (w < 4 && h < 4) {
        if (!m.additive) p.onSelect?.(null, false)
        return
      }
      // intersect: object 矩形 が marquee 矩形 と 重なれば 選択 (= 完全 包含 でなく OK、
      // 部分 重なり でも 拾う = Figma 風 lasso)
      const hits: number[] = []
      for (const o of p.objects) {
        if (o.x + o.width < x) continue
        if (o.y + o.height < y) continue
        if (o.x > x + w) continue
        if (o.y > y + h) continue
        hits.push(o.id)
      }
      p.onSelectMany?.(hits, m.additive)
      return
    }

    // 壁 candidate 確定 (release で 確定 = iPad ドラッグ UX、 PC click も 同じ 経路)
    // ref を 参照 する こと で 直前 の pointermove で 更新 した 最新 候補 を 取得
    if (wallCandidateRef.current && p.editable && tool === 'wall') {
      const cand = wallCandidateRef.current
      updateWallCandidate(null)
      try { svgRef.current?.releasePointerCapture(e.pointerId) } catch { /* noop */ }
      // 閉じる検出: チェーン中 (wallDraft あり) + チェーン start に 近い → 閉じる
      if (wallDraft && wallChainStart) {
        const d = Math.hypot(cand.x - wallChainStart.x, cand.y - wallChainStart.y)
        if (d <= WALL_CLOSE_PX) {
          // 最終 segment を chain start まで 引いて 閉じる
          p.onWallCreate?.(wallDraft.x, wallDraft.y, wallChainStart.x, wallChainStart.y)
          setWallDraft(null)
          setWallChainStart(null)
          return
        }
      }
      // 初回 確定: チェーン start 設定
      if (!wallDraft) {
        setWallDraft({ x: cand.x, y: cand.y })
        setWallChainStart({ x: cand.x, y: cand.y })
        return
      }
      // チェーン継続: 同点 (誤タップ) は 無視
      if (Math.hypot(cand.x - wallDraft.x, cand.y - wallDraft.y) < 2) return
      p.onWallCreate?.(wallDraft.x, wallDraft.y, cand.x, cand.y)
      setWallDraft({ x: cand.x, y: cand.y })
      return
    }

    // アウトライン rect ドラッグ確定
    if (outlineRect) {
      const { sx, sy, ex, ey } = outlineRect
      const minX = Math.min(sx, ex), maxX = Math.max(sx, ex)
      const minY = Math.min(sy, ey), maxY = Math.max(sy, ey)
      if (maxX - minX >= GRID && maxY - minY >= GRID) {
        p.onFloorOutlineChange?.([
          [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY],
        ])
      }
      setOutlineRect(null)
      try { svgRef.current?.releasePointerCapture(e.pointerId) } catch { /* noop */ }
      return
    }

    const s = panState.current
    if (s && pointers.current.size === 0) {
      // ドラッグせずに離した = クリック扱い (select ツール時のみオブジェクト追加)
      // オブジェクト 新規 配置: tool === 'add-object' の とき のみ。
      // 旧 'select' tool 兼用 を 廃止 (select で 誤生成 バグ fix)。
      // 1 つ 配置 し たら 自動 で 'select' に 戻す (one-shot)。
      if (!s.moved && p.editable && s.button === 0 && tool === 'add-object') {
        const sp = pointerToSvg(e)
        p.onCreate?.(sp.x, sp.y)
        setTool('select')
      }
      panState.current = null
    }
    try { svgRef.current?.releasePointerCapture(e.pointerId) } catch { /* noop */ }
  }

  // -------- オブジェクト操作 --------
  // mode:
  //   'move'      = 単一 移動 (= selectedIds に 含まれて いれば 全選択 を 同 delta 移動)
  //   'resize'    = リサイズ (= 単一 のみ)
  //   'duplicate' = Ctrl+Shift で 軸拘束 複製 (PC mouse のみ、 2026-05-30 追加)
  const dragState = useRef<{
    id: number
    mode: 'move' | 'resize' | 'duplicate'
    sx: number; sy: number
    ox: number; oy: number
    ow: number; oh: number
    // multi-drag 用: drag 開始時 の 他 選択 object の 初期 位置 snapshot
    others?: Array<{ id: number; ox: number; oy: number }>
    // duplicate 用: 既に POST した か (= pointerup で 1 回 だけ)
    duplicated?: boolean
  } | null>(null)

  // -------- マーキー (= 矩形 選択) state --------
  // PC mouse で 空白 ドラッグ 開始 → 矩形 描画 → pointerup で 含まれる object 全選択
  const marqueeRef = useRef<{
    sx: number; sy: number       // SVG ローカル 起点
    cx: number; cy: number       // 現在 位置
    additive: boolean            // Shift 押下 で 既存 選択 に 加算
  } | null>(null)
  const [marqueeRect, setMarqueeRect] = useState<
    { x: number; y: number; w: number; h: number; additive: boolean } | null
  >(null)

  function onObjectPointerDown(
    e: React.PointerEvent<SVGElement>, o: StorageObject, mode: 'move' | 'resize',
  ) {
    // Pan ジェスチャー (Space / 中ボタン / panMode): オブジェクト 上 でも pan に 譲る。
    // 早期 return + stopPropagation しない → 自然 bubble で SVG の onPointerDown が
    // 受け取り、 そこ で 通常 の pan 処理。 iOS Safari の setPointerCapture 挙動
    // 差異 を 避ける ため、 ここ で 合成 呼び出し は しない。
    if (isPanGesture(e)) return
    // 床面/間取り編集 scope では オブジェクト 操作 を 完全 ブロック (選択 も 削除 も 不可)。
    // pan に 譲る ため stopPropagation せず 早期 return。
    if (p.editable && p.editScope === 'floor') return
    e.stopPropagation()
    if (!p.editable) {
      p.onSelect?.(o.id)
      return
    }
    // Ctrl+Shift+Drag (PC mouse のみ): 軸 拘束 で 複製 (PowerPoint 風)。 2026-05-30 追加
    const isMouse = e.pointerType === 'mouse'
    const wantDuplicate = isMouse && mode === 'move' && e.ctrlKey && e.shiftKey && !!p.onDuplicate
    if (wantDuplicate) {
      p.onSelect?.(o.id)
      dragState.current = {
        id: o.id, mode: 'duplicate',
        sx: e.clientX, sy: e.clientY,
        ox: o.x, oy: o.y, ow: o.width, oh: o.height,
        duplicated: false,
      }
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
      return
    }
    // 通常 選択 + drag
    p.onSelect?.(o.id, e.shiftKey)
    // multi-drag: drag 開始 時 の 全 選択 object 初期 位置 を snapshot
    const others: Array<{ id: number; ox: number; oy: number }> = []
    if (mode === 'move' && p.selectedIds && p.selectedIds.size > 1 && p.selectedIds.has(o.id)) {
      for (const otherObj of p.objects) {
        if (otherObj.id !== o.id && p.selectedIds.has(otherObj.id)) {
          others.push({ id: otherObj.id, ox: otherObj.x, oy: otherObj.y })
        }
      }
    }
    dragState.current = {
      id: o.id, mode,
      sx: e.clientX, sy: e.clientY,
      ox: o.x, oy: o.y, ow: o.width, oh: o.height,
      others: others.length > 0 ? others : undefined,
    }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  function onObjectPointerMove(e: React.PointerEvent<SVGElement>) {
    const d = dragState.current
    if (!d || !svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    // preserveAspectRatio="xMidYMid meet" は 統一 scale + letterbox (2026-05-30 fix)。
    const scale = Math.min(rect.width / view.w, rect.height / view.h)
    let dxC = (e.clientX - d.sx) / scale
    let dyC = (e.clientY - d.sy) / scale

    // Ctrl+Shift+Drag (duplicate): 軸 拘束 — 縦横 で 動き が 大きい 方 に 限定
    // (PPT 風)。 Alt で 拘束 解除。 source object は 動かさ ず、 pointerup で 複製 POST。
    if (d.mode === 'duplicate') {
      if (!e.altKey) {
        if (Math.abs(dxC) > Math.abs(dyC)) dyC = 0
        else                                dxC = 0
      }
      // この フェーズ で は preview だけ 描画 して も 良い が、 簡略化 で 何 も 出さ ず
      // pointerup で 1 回 だけ POST する。 source は そのまま で 動か ない。
      return
    }

    if (d.mode === 'move') {
      // Alt 押下 で grid snap 無効。 既定 は GRID (= 20) 倍数 に スナップ。
      const snapEnabled = !e.altKey
      const rawX = d.ox + dxC, rawY = d.oy + dyC
      const newX = Math.max(0, snapEnabled ? Math.round(rawX / GRID) * GRID : rawX)
      const newY = Math.max(0, snapEnabled ? Math.round(rawY / GRID) * GRID : rawY)
      // 単一 OR multi-drag (= 選択 中 全部 を 同 delta で 移動)
      const deltaX = newX - d.ox
      const deltaY = newY - d.oy
      if (d.others && d.others.length > 0 && p.onUpdateMany) {
        const updates: Array<{ id: number; x: number; y: number }> = [
          { id: d.id, x: newX, y: newY },
        ]
        for (const o of d.others) {
          updates.push({
            id: o.id,
            x: Math.max(0, o.ox + deltaX),
            y: Math.max(0, o.oy + deltaY),
          })
        }
        p.onUpdateMany(updates)
      } else {
        p.onUpdate?.(d.id, { x: newX, y: newY })
      }
    } else {
      // resize: 幅/高さ も grid snap (Alt で 無効)
      const snapEnabled = !e.altKey
      const rawW = d.ow + dxC, rawH = d.oh + dyC
      const newW = snapEnabled ? Math.round(rawW / GRID) * GRID : rawW
      const newH = snapEnabled ? Math.round(rawH / GRID) * GRID : rawH
      p.onUpdate?.(d.id, {
        width: Math.max(10, newW),
        height: Math.max(10, newH),
      })
    }
  }
  function onObjectPointerUp(e: React.PointerEvent<SVGElement>) {
    const d = dragState.current
    // duplicate モード: pointerup 時 に 1 回 だけ POST (= grid snap 後 の 位置)
    if (d && d.mode === 'duplicate' && !d.duplicated && p.onDuplicate && svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect()
      const scale = Math.min(rect.width / view.w, rect.height / view.h)
      let dxC = (e.clientX - d.sx) / scale
      let dyC = (e.clientY - d.sy) / scale
      // 軸 拘束 (Alt で 解除)
      if (!e.altKey) {
        if (Math.abs(dxC) > Math.abs(dyC)) dyC = 0
        else                                dxC = 0
      }
      // grid snap (Alt で 無効)
      const snapEnabled = !e.altKey
      const rawX = d.ox + dxC, rawY = d.oy + dyC
      const nx = Math.max(0, snapEnabled ? Math.round(rawX / GRID) * GRID : rawX)
      const ny = Math.max(0, snapEnabled ? Math.round(rawY / GRID) * GRID : rawY)
      // 0 移動 (= ただ の click) なら 複製 し ない
      if (nx !== d.ox || ny !== d.oy) {
        p.onDuplicate(d.id, nx, ny)
      }
      d.duplicated = true
    }
    dragState.current = null
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId) } catch { /* noop */ }
  }

  function reset() {
    setView({ x: 0, y: 0, w: iw, h: ih })
  }

  /** SVG キャンバスの中心を基準にズーム。factor < 1 = ズームイン */
  function zoomBy(factor: number) {
    setView((v) => {
      const newW = Math.max(20, Math.min(iw * 8, v.w * factor))
      const newH = Math.max(20, Math.min(ih * 8, v.h * factor))
      // 中心固定
      return {
        x: v.x + (v.w - newW) / 2,
        y: v.y + (v.h - newH) / 2,
        w: newW, h: newH,
      }
    })
  }

  const zoomPct = Math.round((iw / view.w) * 100)

  return (
    <div className="storage-canvas-wrap">
      <div className="storage-canvas-toolbar no-print">
        {/* ツールパレット (編集モードのみ) */}
        {p.editable && (
          <div className="canvas-tool-palette">
            {(() => {
              const allTools = [
                { id: 'select',     Icon: MousePointer2, title: '選択 (V) — クリックで オブジェクト/壁 選択' },
                { id: 'add-object', Icon: SquarePlus,    title: '追加 (A) — クリックで オブジェクト 新規 配置' },
                { id: 'outline',    Icon: Square,        title: '倉庫の床面を描く (O)' },
                { id: 'wall',       Icon: Slash,         title: '壁を描く (W)' },
                { id: 'eraser',     Icon: Eraser,        title: '削除 (E)' },
              ] as const
              // scope に 応じて ツール を フィルタ:
              //   object scope: 選択 + 追加 (オブジェクト 操作 のみ)
              //   floor scope:  選択 + 床面 + 壁 + 消ゴム (構造 編集)
              //   未指定 (後方互換): 全 表示
              const scope = p.editScope
              const filtered = scope === 'object'
                ? allTools.filter(t => t.id === 'select' || t.id === 'add-object')
                : scope === 'floor'
                  ? allTools.filter(t => t.id === 'select' || t.id === 'outline' || t.id === 'wall' || t.id === 'eraser')
                  : allTools
              return filtered.map((t) => (
              <button
                key={t.id}
                className={'tool-btn' + (tool === t.id ? ' active' : '')}
                onClick={() => {
                  setTool(t.id)
                  setWallDraft(null); setWallChainStart(null); updateWallCandidate(null); setCursor(null)
                }}
                title={t.title}
                aria-label={t.title}
              >
                <t.Icon size={16} strokeWidth={1.7} />
              </button>
              ))
            })()}
            {tool === 'wall' && (wallDraft || wallCandidate) && (
              <button
                className="ghost small"
                onClick={() => {
                  setWallDraft(null); setWallChainStart(null); updateWallCandidate(null); setCursor(null)
                }}
                title="壁チェーンを中断 (Esc または 右クリック)"
              >
                チェーン解除
              </button>
            )}
            {tool === 'outline' && p.floorOutline && p.floorOutline.length >= 3 && (
              <button
                className="ghost small"
                onClick={async () => {
                  if (await dialog.confirm({
                    title: '床面アウトラインをリセット',
                    message: '倉庫の輪郭を削除します。再度描き直すことができます。',
                    okLabel: 'リセット',
                    variant: 'warn',
                  })) {
                    p.onFloorOutlineChange?.(null)
                  }
                }}
                title="アウトラインを削除して描き直す"
              >
                床面リセット
              </button>
            )}
          </div>
        )}
        {p.editable && (p.onUndo || p.onRedo) && (
          <>
            <button
              className="ghost small"
              onClick={() => p.onUndo?.()}
              disabled={!p.canUndo}
              title="取消 (Ctrl+Z)"
            >↶</button>
            <button
              className="ghost small"
              onClick={() => p.onRedo?.()}
              disabled={!p.canRedo}
              title="やり直し (Ctrl+Shift+Z / Ctrl+Y)"
            >↷</button>
          </>
        )}
        {/* ✋ ハンドツール: 編集モード では hide。 編集中 は 頂点ハンドル等 が 常時
            応答 + 空白タッチ pan で 十分、 ✋ は 混乱 の 元 に なる */}
        {!p.editable && (
          <button
            className="ghost small"
            onClick={() => {
              setPanMode(m => {
                if (isDebugMode('pan')) logTrace('panMode toggled', { from: m, to: !m })
                return !m
              })
            }}
            title="ハンドツール: ON で 全タッチ pan / OFF で オブジェクト 選択 に 集中"
            style={panMode ? {
              background: 'var(--primary)', color: '#fff',
              borderColor: 'var(--primary)',
            } : undefined}
          >✋</button>
        )}
        <button className="ghost small" onClick={() => zoomBy(1 / 1.25)} title="ズームイン">＋</button>
        <button className="ghost small" onClick={() => zoomBy(1.25)} title="ズームアウト">−</button>
        <button className="ghost small" onClick={reset} title="全体表示にリセット">
          ⟳ {zoomPct}%
        </button>
        {(spaceDown || panMode) && (
          <span className="badge" style={{
            background: 'var(--primary-tint)', color: 'var(--primary)',
          }}>
            ✋ {panMode ? 'ハンドツール (タップで解除)' : 'ナビモード'}
          </span>
        )}
        <span className="muted" style={{ fontSize: 11 }}>
          {p.editable && tool === 'wall'
            ? <><kbd>W</kbd> 壁: タップ→タップで線、続けて描画継続。<kbd>Esc</kbd>で中断</>
            : p.editable && tool === 'outline'
              ? ((p.floorOutline?.length ?? 0) >= 3
                ? <><kbd>O</kbd> 床面: 頂点ドラッグで形状変更 / 中点 ＋ で頂点追加 / ダブルクリックで頂点削除</>
                : <><kbd>O</kbd> 床面: <strong>ドラッグして長方形を描画</strong>。不規則形は描画後に頂点を編集</>)
              : p.editable && tool === 'eraser'
                ? <><kbd>E</kbd> 削除: 壁をタップで消去 / 床面リセットはツールバーから</>
                : <>PC: <kbd>Space</kbd>+ドラッグ=パン / <kbd>Space</kbd>+ホイール=ズーム
                    {' / '}iPad: ✋ をタップしてからドラッグ / 2本指=パン+ズーム
                    {p.editable && ' / 空白クリック=配置追加'}</>}
        </span>
      </div>
      <svg
        ref={svgRef}
        className="storage-canvas"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        style={{
          // iPad / iOS Safari 対策: CSS で touch-action: none 指定 して いる が、
          // 一部 iOS バージョン で CSS が SVG に 効か ない 報告 が ある ため inline
          // style に も 明示 (二重保険)。 タッチ で の デフォルト スクロール/ズーム を
          // 抑止 し、 Pointer Events を 確実 に 発火 させる。
          touchAction: 'none',
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none',
          cursor: (spaceDown || panMode) ? 'grab'
            : tool === 'wall' ? 'crosshair'
            : tool === 'add-object' ? 'crosshair'
            : tool === 'outline' && (p.floorOutline?.length ?? 0) < 3 ? 'crosshair'
            : tool === 'eraser' ? 'not-allowed'
            : undefined,
        }}
        onContextMenu={(e) => {
          // 右クリック で 壁 チェーン キャンセル (PC)
          if (tool === 'wall' && (wallDraft || wallCandidate)) {
            e.preventDefault()
            setWallDraft(null); setWallChainStart(null); updateWallCandidate(null); setCursor(null)
          }
        }}
        onWheel={onWheel}
        /* pointerdown/move/up は ネイティブ addEventListener で 処理 (useEffect 内)。
           React の onPointer* は iOS Safari + SVG で pointermove が 1 回 しか 発火
           しない 不具合 が ある ため。 */
      >
        {/* SVG defs: パターン + フィルター + clip path */}
        <defs>
          {/* 外側 (建物外) のストライプ */}
          <pattern id="storage-stripes"
            width={14} height={14} patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)">
            <rect width={14} height={14} fill="rgba(0,0,0,0.025)" />
            <rect width={7}  height={14} fill="rgba(0,0,0,0.07)" />
          </pattern>
          {/* CAD マイナーグリッド (1 マス) */}
          <pattern id="storage-grid-minor"
            width={GRID} height={GRID} patternUnits="userSpaceOnUse">
            <path d={`M ${GRID} 0 L 0 0 0 ${GRID}`}
              fill="none" stroke="rgba(0,0,0,0.07)" strokeWidth={0.6} />
          </pattern>
          {/* CAD メジャーグリッド (5 マス毎の太線) */}
          <pattern id="storage-grid-major"
            width={GRID * 5} height={GRID * 5} patternUnits="userSpaceOnUse">
            <path d={`M ${GRID*5} 0 L 0 0 0 ${GRID*5}`}
              fill="none" stroke="rgba(0,0,0,0.16)" strokeWidth={1} />
          </pattern>
          {/* 床面クリップ: アウトラインが 3 頂点以上ある時のみ生成 */}
          {p.floorOutline && p.floorOutline.length >= 3 && (
            <clipPath id="floor-clip">
              <polygon points={p.floorOutline.map(([x, y]) => `${x},${y}`).join(' ')} />
            </clipPath>
          )}

          {/* オブジェクトのソフトシャドウ */}
          <filter id="object-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="2" />
            <feOffset dx="0" dy="1.5" result="off" />
            <feComponentTransfer><feFuncA type="linear" slope="0.16" /></feComponentTransfer>
            <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          {/* 壁のシャドウ (より強め) */}
          <filter id="wall-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="1.5" />
            <feOffset dx="0" dy="1.5" result="off" />
            <feComponentTransfer><feFuncA type="linear" slope="0.32" /></feComponentTransfer>
            <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          {/* 選択 オブジェクト の halo glow (= 朱赤 リング の 置換)。
              primary 色 を 6px ぼかし で 周囲 に 拡散 → 「赤=危険」 印象 を 軽減 + 上品。 */}
          <filter id="object-halo" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="4" />
          </filter>
        </defs>

        {/* ── 背景 (画像が無いときの 2 層構造) ── */}
        {p.imageUrl ? (
          <>
            <image
              href={p.imageUrl}
              x={0} y={0} width={iw} height={ih}
              preserveAspectRatio="xMidYMid meet"
            />
            {/* 画像有りの時も outline を表示 (描いた形が見えるように) */}
            {p.floorOutline && p.floorOutline.length >= 3 && (
              <polygon
                points={p.floorOutline.map(([x, y]) => `${x},${y}`).join(' ')}
                fill="none"
                stroke="rgba(255, 80, 60, 0.8)"
                strokeWidth={2}
                strokeDasharray="6 4"
                strokeLinejoin="round"
                pointerEvents="none"
              />
            )}
          </>
        ) : (
          <>
            {/* 「外」 = 縞模様は CSS (.storage-canvas-wrap) が担当。
               SVG 自体は透明にして wrap の縞をそのまま透かす。
               「内」 = 床 (白) + CAD グリッド を clipPath でアウトライン内に限定。
               outline が image bounds を超えてもいいよう floorBbox を使う */}
            <g clipPath={
              p.floorOutline && p.floorOutline.length >= 3
                ? "url(#floor-clip)" : undefined
            }>
              {/* 床面 色: 3D シーン の ground (#e8e4d6) に 合わせる。
                  白 だ と grab カーソル の 白手 が 見え なく なる 問題 も 解消。 */}
              <rect x={floorBbox.x} y={floorBbox.y} width={floorBbox.w} height={floorBbox.h} fill="#e8e4d6" />
              <rect x={floorBbox.x} y={floorBbox.y} width={floorBbox.w} height={floorBbox.h}
                fill="url(#storage-grid-minor)" pointerEvents="none" />
              <rect x={floorBbox.x} y={floorBbox.y} width={floorBbox.w} height={floorBbox.h}
                fill="url(#storage-grid-major)" pointerEvents="none" />
            </g>

            {/* 床面の輪郭線 */}
            {p.floorOutline && p.floorOutline.length >= 3 && (
              <polygon
                points={p.floorOutline.map(([x, y]) => `${x},${y}`).join(' ')}
                fill="none"
                stroke="rgba(28, 27, 25, 0.72)"
                strokeWidth={1.5}
                strokeLinejoin="round"
                pointerEvents="none"
              />
            )}
          </>
        )}

        {/* 長方形ドラッグ中のプレビュー */}
        {outlineRect && (() => {
          const minX = Math.min(outlineRect.sx, outlineRect.ex)
          const minY = Math.min(outlineRect.sy, outlineRect.ey)
          const w = Math.abs(outlineRect.ex - outlineRect.sx)
          const h = Math.abs(outlineRect.ey - outlineRect.sy)
          return (
            <g pointerEvents="none">
              <rect x={minX} y={minY} width={w} height={h}
                fill="rgba(255,255,255,0.6)"
                stroke="var(--primary)" strokeWidth={1.5} strokeDasharray="6 4" />
              {w > 12 && h > 12 && (
                <text x={minX + w/2} y={minY - 6} textAnchor="middle"
                  fill="var(--primary)" fontSize={11} fontWeight={600}>
                  {Math.round(w)} × {Math.round(h)}
                </text>
              )}
            </g>
          )
        })()}

        {/* マーキー 矩形 プレビュー (PC mouse、 tool=select、 空白 ドラッグ 中) */}
        {marqueeRect && (
          <g pointerEvents="none">
            <rect
              x={marqueeRect.x} y={marqueeRect.y}
              width={marqueeRect.w} height={marqueeRect.h}
              fill="rgba(59, 130, 246, 0.12)"
              stroke="var(--primary)"
              strokeWidth={1}
              strokeDasharray="4 3"
            />
          </g>
        )}

        {/* アウトライン未設定 + アウトラインツール選択時: 案内 */}
        {p.editable && tool === 'outline'
          && (!p.floorOutline || p.floorOutline.length < 3)
          && !outlineRect && (
          <g pointerEvents="none">
            <text x={iw / 2} y={ih / 2}
              textAnchor="middle" fontSize={14}
              fill="rgba(0,0,0,0.45)" fontWeight={500}>
              ドラッグして倉庫の輪郭 (長方形) を作成
            </text>
          </g>
        )}

        {/* 壁レイヤー (シャドウ付き) */}
        <g filter="url(#wall-shadow)">
          {p.walls?.map((w) => {
            const isSelected = p.selectedWallId === w.id
            // 編集モード + floor scope のみ interactive。 object scope では 壁 操作 を
            // 完全 ブロック (選択 も 削除 も 不可、 pan に 譲る)。
            const inFloorScope = p.editable && p.editScope !== 'object'
            const isInteractive = inFloorScope && (tool === 'eraser' || tool === 'select' || tool === 'wall')
            return (
              <g key={w.id}>
                {/* 視覚 線 */}
                <line
                  x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2}
                  stroke={isSelected ? 'var(--primary)' : '#1c1b19'}
                  strokeWidth={isSelected ? w.thickness + 2 : w.thickness}
                  strokeLinecap="round"
                  pointerEvents="none"
                />
                {/* 透明 hit area (mobile タップ し やすく)。
                    eraser / select ツール 時 のみ interactive。
                    data-storage-handle で native pan を skip させ React handler に 任せる */}
                <line
                  data-storage-handle={isInteractive ? 'wall' : undefined}
                  x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2}
                  stroke="transparent"
                  strokeWidth={Math.max(w.thickness + 12, 18)}
                  strokeLinecap="round"
                  style={{
                    cursor: isInteractive ? 'pointer' : 'default',
                    pointerEvents: isInteractive ? 'stroke' : 'none',
                  }}
                  onPointerDown={(e) => {
                    if (isPanGesture(e)) return     // panMode/Space で pan に 譲る
                    // eraser: 2 段階削除 (1st click 選択、 同じ壁 を 2nd click で削除、
                    //   別壁 click は 選択切替 のみ)。 「誤削除 防止」 user 要望。
                    if (tool === 'eraser') {
                      e.stopPropagation()
                      if (p.selectedWallId === w.id) {
                        // 2nd click 同じ壁 → 削除
                        p.onSelectWall?.(null)
                        p.onWallDelete?.(w.id)
                      } else {
                        // 1st click → 選択 のみ (削除待機)
                        p.onSelectWall?.(w.id)
                      }
                      return
                    }
                    // select / wall ツール: 既存壁 click = 選択 (壁ツール 中 でも 削除/編集
                    // 可能 に。 新規描画 は 空白部分 click)
                    if (tool === 'select' || tool === 'wall') {
                      e.stopPropagation()
                      p.onSelectWall?.(w.id)
                    }
                  }}
                />
              </g>
            )
          })}
        </g>

        {/* 壁描画プレビュー (2026-05-24 candidate モデル):
            - wallDraft  = チェーン中 の 確定基点 (filled primary 円)
            - wallCandidate = touch/click 中 の 候補位置 (release で 確定)
                              snap 中 は 色 強調 + リング
            - close 検出 = candidate が wallChainStart 付近 → 「閉じる」 視覚 hint
            - preview 線 = wallDraft → (candidate あれば candidate、 なければ cursor) */}
        {p.editable && tool === 'wall' && (() => {
          const tip = wallCandidate ?? cursor
          const candNearStart = wallCandidate && wallChainStart
            && Math.hypot(wallCandidate.x - wallChainStart.x,
                          wallCandidate.y - wallChainStart.y) <= WALL_CLOSE_PX
          return (
            <>
              {/* チェーン基点 (filled primary、 強調) + パルス リング */}
              {wallDraft && (
                <>
                  <circle
                    className="wall-first-pulse-ring"
                    cx={wallDraft.x} cy={wallDraft.y} r={14}
                    fill="none" stroke="var(--primary)" strokeWidth={2}
                    pointerEvents="none" />
                  <circle cx={wallDraft.x} cy={wallDraft.y} r={6}
                    fill="var(--primary)" stroke="#fff" strokeWidth={2}
                    pointerEvents="none" />
                </>
              )}
              {/* チェーン start マーカー (閉じる目印、 wallDraft と 違うとき のみ) */}
              {wallChainStart && wallDraft
                && (wallChainStart.x !== wallDraft.x || wallChainStart.y !== wallDraft.y) && (
                <circle cx={wallChainStart.x} cy={wallChainStart.y} r={candNearStart ? 12 : 7}
                  fill={candNearStart ? 'rgba(120, 200, 120, 0.4)' : 'none'}
                  stroke={candNearStart ? '#3a8' : 'var(--primary)'}
                  strokeWidth={candNearStart ? 3 : 1.5}
                  strokeDasharray={candNearStart ? undefined : '3 3'}
                  pointerEvents="none" />
              )}
              {/* プレビュー線 (wallDraft → tip) */}
              {wallDraft && tip && (
                <line
                  x1={wallDraft.x} y1={wallDraft.y} x2={tip.x} y2={tip.y}
                  stroke={candNearStart ? '#3a8' : 'var(--primary)'}
                  strokeWidth={4} strokeDasharray="6 4"
                  opacity={0.7} pointerEvents="none"
                />
              )}
              {/* 距離ラベル */}
              {wallDraft && tip && (() => {
                const dx = tip.x - wallDraft.x
                const dy = tip.y - wallDraft.y
                const len = Math.hypot(dx, dy)
                if (len < 8) return null
                return (
                  <text
                    x={(wallDraft.x + tip.x) / 2}
                    y={(wallDraft.y + tip.y) / 2 - 8}
                    fill="var(--primary)" fontSize={11} fontWeight={600}
                    textAnchor="middle" pointerEvents="none"
                  >{Math.round(len)}</text>
                )
              })()}
              {/* candidate マーカー (touch 中、 release 前): snap 時 は 強調 */}
              {wallCandidate && (
                <circle cx={wallCandidate.x} cy={wallCandidate.y}
                  r={wallCandidate.snapped ? 10 : 6}
                  fill={wallCandidate.snapped ? 'var(--primary)' : 'rgba(58,109,213,0.3)'}
                  stroke={wallCandidate.snapped ? '#fff' : 'var(--primary)'}
                  strokeWidth={2}
                  pointerEvents="none" />
              )}
              {/* hover preview (PC マウス、 candidate も draft も 無い 時) */}
              {!wallDraft && !wallCandidate && cursor && (
                <circle cx={cursor.x} cy={cursor.y} r={4}
                  fill="none" stroke="var(--primary)" strokeWidth={1.5}
                  pointerEvents="none" opacity={0.5} />
              )}
            </>
          )
        })()}

        {/* オブジェクト群 */}
        {p.objects.map((o) => {
          const selected = p.selectedId === o.id
          // marquee + Shift+click 由来 の 加算 選択 ハイライト (= selectedId 以外)
          const multiSelected = !selected && (p.selectedIds?.has(o.id) ?? false)
          const hl = !p.highlightIds || p.highlightIds.has(o.id)
          const fill = p.fillByObject?.get(o.id) ?? o.color ?? '#3b82f6'
          const subtitle = p.subtitleByObject?.get(o.id)
          const totalCases = p.casesByObject?.get(o.id) ?? 0
          // visualizer 領域: オブジェクト下部 1/3 高さ (高さが小さい時は非表示)
          const showPallet = totalCases > 0 && o.height >= 36 && o.width >= 40
          const vizPadX = 4
          const vizPadY = 4
          const vizW = o.width - vizPadX * 2
          const vizH = Math.min(o.height * 0.42, 32)
          const vizY = o.y + o.height - vizPadY - vizH
          return (
            <g
              key={o.id}
              data-storage-handle="object"
              opacity={hl ? 1 : 0.25}
              onPointerDown={(e) => onObjectPointerDown(e, o, 'move')}
              onPointerMove={onObjectPointerMove}
              onPointerUp={onObjectPointerUp}
              style={{
                cursor: spaceDown ? 'grab' : (p.editable ? 'move' : 'pointer'),
              }}
            >
              {/* 選択 時 の halo glow (= 朱赤 リング → primary 色 の soft glow に 置換、
                  2026-05-27 halo proposal 2️⃣)。 外側 に ぼかし 円 を 配置 して
                  「赤=危険」 印象 を 減らし、 上品 な 浮き出し感 を 出す。 */}
              {selected && (
                <>
                  <rect
                    x={o.x - 5} y={o.y - 5}
                    width={o.width + 10} height={o.height + 10}
                    fill="none"
                    stroke="var(--primary)"
                    strokeWidth={5}
                    rx={12}
                    opacity={0.55}
                    filter="url(#object-halo)"
                    pointerEvents="none"
                  />
                  <rect
                    x={o.x - 1.5} y={o.y - 1.5}
                    width={o.width + 3} height={o.height + 3}
                    fill="none"
                    stroke="var(--primary)"
                    strokeWidth={1.5}
                    rx={9}
                    opacity={0.9}
                    pointerEvents="none"
                  />
                </>
              )}
              {/* multi-selected (= marquee / Shift+click 加算): primary 単線 だけ で
                  控え目 に。 main selection (上記 halo) と 区別 する。 */}
              {multiSelected && (
                <rect
                  x={o.x - 1.5} y={o.y - 1.5}
                  width={o.width + 3} height={o.height + 3}
                  fill="none"
                  stroke="var(--primary)"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  rx={9}
                  opacity={0.8}
                  pointerEvents="none"
                />
              )}
              <rect
                x={o.x} y={o.y}
                width={o.width} height={o.height}
                fill={fill}
                fillOpacity={selected ? 0.92 : 0.78}
                stroke="rgba(28, 27, 25, 0.20)"
                strokeWidth={1}
                rx={8}
                filter="url(#object-shadow)"
              />
              {/* ラベル */}
              {(o.label || subtitle) && (
                <g pointerEvents="none">
                  {o.label && (
                    <text
                      x={o.x + o.width / 2}
                      y={o.y + 4 + Math.min(o.height * 0.20, 11)}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={Math.min(o.height * 0.22, 13)}
                      fontWeight={600}
                      fill="#1f1e1b"
                    >
                      {o.label}
                    </text>
                  )}
                  {subtitle && (
                    <text
                      x={o.x + o.width / 2}
                      y={o.y + (o.label ? 4 + Math.min(o.height * 0.20, 11) * 2 + 4 : o.height / 2)}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={Math.min(o.height * 0.16, 10)}
                      fill="#5c5644"
                    >
                      {subtitle}
                    </text>
                  )}
                </g>
              )}
              {/* A3.2: 詳細 情報 行 (showInfo=true で 親 が 渡す)。
                  label の 下 に N 行 連続。 box 高さ を 食う が、 user の 明示 要望 で 全部 表示。 */}
              {(() => {
                const lines = p.infoLinesByObject?.get(o.id)
                if (!lines || lines.length === 0) return null
                const lineH = Math.min(o.width * 0.04, 9)
                const fontSize = Math.min(o.width * 0.038, 8.5)
                // 開始 y: label の 下 (label が 無ければ 上 から)
                const startY = o.y + (o.label ? 4 + Math.min(o.height * 0.20, 11) + 6 : 8)
                return (
                  <g pointerEvents="none">
                    {lines.map((line, idx) => (
                      <text
                        key={idx}
                        x={o.x + 4}
                        y={startY + idx * (lineH + 1)}
                        textAnchor="start"
                        dominantBaseline="hanging"
                        fontSize={fontSize}
                        fill="#3a3525"
                      >{line}</text>
                    ))}
                  </g>
                )
              })()}
              {/* パレットスタック visualizer (オブジェクト下部) */}
              {showPallet && (
                <g pointerEvents="none" transform={`translate(${o.x + vizPadX}, ${vizY})`}>
                  <PalletStackSvg
                    cases={totalCases}
                    width={vizW}
                    height={vizH}
                    fill="#7a5d3e"
                    stroke="rgba(60,50,30,0.25)"
                  />
                </g>
              )}
              {/* リサイズハンドル (編集モード+選択時、 lockSize でない時のみ) */}
              {p.editable && selected && !p.lockSize && (
                <circle
                  data-storage-handle="resize"
                  cx={o.x + o.width} cy={o.y + o.height}
                  r={6}
                  fill="#fff" stroke="var(--primary)" strokeWidth={2}
                  style={{ cursor: 'nwse-resize' }}
                  onPointerDown={(e) => onObjectPointerDown(e, o, 'resize')}
                  onPointerMove={onObjectPointerMove}
                  onPointerUp={onObjectPointerUp}
                />
              )}
            </g>
          )
        })}

        {/* アウトライン編集ハンドル: 中点 (頂点追加用) + 頂点 (移動/削除) */}
        {p.editable && tool === 'outline' && p.floorOutline && p.floorOutline.length >= 3 && (
          <g>
            {/* 中点: 各辺の中央に薄い + マーカー、タップで頂点を挿入 */}
            {p.floorOutline.map(([x, y], i) => {
              const next = p.floorOutline![(i + 1) % p.floorOutline!.length]
              const mx = (x + next[0]) / 2
              const my = (y + next[1]) / 2
              return (
                <g key={`mid-${i}`}
                  data-storage-handle="midpoint"
                  style={{ cursor: 'copy' }}
                  onPointerDown={(e) => {
                    // 床編集 ハンドル は ✋ panMode を 無視 して 常時 応答
                    // (空白 タップ で pan、 ハンドル タップ で 編集 を 両立)。
                    // Space (PC) は 引き続き pan 優先 (キーボード ユーザー の 意図 尊重)。
                    if (spaceDownRef.current || e.button === 1) return
                    e.stopPropagation()
                    if (!p.floorOutline) return
                    const inserted = [...p.floorOutline]
                    inserted.splice(i + 1, 0, [mx, my])
                    p.onFloorOutlineChange?.(inserted as [number, number][])
                  }}
                >
                  {/* 透明 hit area (タッチ デバイス で 指 で 押し やすく): 見た目 は
                       r=6 の まま、 実際 の クリック判定 は r=18。 */}
                  <circle cx={mx} cy={my} r={18}
                    fill="transparent" pointerEvents="all" />
                  <circle cx={mx} cy={my} r={6}
                    fill="rgba(255,255,255,0.9)"
                    stroke="rgba(28,27,25,0.4)" strokeWidth={1}
                    pointerEvents="none" />
                  <text x={mx} y={my + 3} textAnchor="middle"
                    fontSize={10} fontWeight={700} fill="var(--primary)"
                    pointerEvents="none">＋</text>
                </g>
              )
            })}
            {/* 頂点: 大きめハンドル + 透明 hit area で 指 タップ し やすく */}
            {p.floorOutline.map(([x, y], i) => (
              <g
                key={`ov-${i}`}
                data-storage-handle="vertex"
                style={{ cursor: 'move' }}
                onPointerDown={(e) => {
                  // 頂点 ハンドル は ✋ panMode を 無視 して 常時 応答 (中点 と 同様)。
                  // Space (PC) のみ pan に 譲る。
                  if (spaceDownRef.current || e.button === 1) return
                  e.stopPropagation()
                  outlineDragIndex.current = i
                  setActiveVertexIdx(i)   // 視覚 強調 用
                  try { (e.currentTarget as Element).setPointerCapture(e.pointerId) } catch { /* noop */ }
                }}
                onPointerMove={(e) => {
                  if (outlineDragIndex.current !== i || !p.floorOutline) return
                  const sp = pointerToSvg(e)  // iPad finger-offset
                  const pt = snap(sp.x, sp.y)
                  const next = p.floorOutline.map(([px, py], idx) =>
                    idx === i ? [pt.x, pt.y] : [px, py]
                  ) as [number, number][]
                  p.onFloorOutlineChange?.(next)
                }}
                onPointerUp={(e) => {
                  outlineDragIndex.current = null
                  setActiveVertexIdx(null)
                  try { (e.currentTarget as Element).releasePointerCapture(e.pointerId) } catch { /* noop */ }
                }}
                onPointerCancel={(e) => {
                  // タッチ が キャンセル された (system gesture 等) ら も flag 解除
                  outlineDragIndex.current = null
                  setActiveVertexIdx(null)
                  try { (e.currentTarget as Element).releasePointerCapture(e.pointerId) } catch { /* noop */ }
                }}
                onDoubleClick={(e) => {
                  // ダブルクリックで頂点削除。3頂点未満になる場合は全消去で null に
                  e.stopPropagation()
                  if (!p.floorOutline) return
                  const next = p.floorOutline.filter((_, idx) => idx !== i)
                  p.onFloorOutlineChange?.(next.length >= 3 ? next as [number, number][] : null)
                }}
              >
                {/* 透明 hit area: 見た目 は r=7 の まま、 タッチ 判定 は r=18 */}
                <circle cx={x} cy={y} r={18}
                  fill="transparent" pointerEvents="all" />
                {/* 視覚: ドラッグ 中 は 拡大 + primary 色 で フィードバック */}
                <circle cx={x} cy={y}
                  r={activeVertexIdx === i ? 10 : 7}
                  fill={activeVertexIdx === i ? 'var(--primary)' : '#ffffff'}
                  stroke="var(--primary)"
                  strokeWidth={activeVertexIdx === i ? 3 : 2}
                  pointerEvents="none"
                  style={{ transition: 'r 0.08s ease, fill 0.08s ease' }} />
              </g>
            ))}
          </g>
        )}

        {p.children}
      </svg>
    </div>
  )
}
