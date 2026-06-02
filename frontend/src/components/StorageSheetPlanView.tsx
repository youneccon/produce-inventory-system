/**
 * StorageSheetPlanView — 集計表頁 用 の 専用 2D 平面図 レンダラ
 * ============================================================
 *
 * 設計 方針 (industry research 2026-05-24 ベース):
 *   - 印刷物 は 2D top-down 一択 (3D は 営業 用)
 *   - object は 単純 な 角丸 矩形、 内部 に bin code (太字) + 詳細 行
 *   - 1 印刷 1 色分け 変数 (混ぜると 読めなく なる)
 *   - 必須 要素: タイトルブロック / コンパス / スケール バー / 凡例 / グリッド
 *   - SVG ベース で 解像度 フリー (印刷 PDF の vector 出力 向き)
 *   - 既存 storage_canvas の インタラクティブ 要素 は 入れない (read-only)
 *
 * Storage3DView (planarLocked) は 3D シーン の 真上 view で、 立体パレット の
 * 影 や 奥行き が ノイズ に なる。 印刷 レポート に は 不向き。
 * → 専用 平面 レンダラ を 用意 (こちら)。
 */

import { useMemo } from 'react'
import type { StorageObject, StorageWall } from '../api/types'

// =============================================================================
// 定数 (industry pattern に 準拠)
// =============================================================================

// 画像 px 座標系 = 1 cm を 約 20px と 想定 (StorageCanvas の GRID と 同じ)。
// 1m = 200px、 1m 単位 で グリッド を 引く。
const PX_PER_METER = 200
const GRID_PX = PX_PER_METER  // 1m グリッド (主)

const COLOR = {
  bg:            '#fffdf6',
  floorFill:     '#f4ecd6',
  floorStroke:   '#7a6f4f',
  wall:          '#1c1b19',
  gridMinor:     '#e8e3d2',
  objectStroke:  '#1c1b19',
  objectFill:    '#f8f3e3',
  objectLabel:   '#1c1b19',
  objectInfo:    '#3a3525',
  compass:       '#1c1b19',
  scale:         '#1c1b19',
  titleFg:       '#1c1b19',
  titleBg:       '#fffdf6',
  legendBg:      'rgba(255, 253, 246, 0.95)',
} as const

// =============================================================================
// 型
// =============================================================================

export interface LegendEntry {
  color: string
  label: string
}

interface Props {
  /** タイトル ブロック 用 */
  layoutName: string
  /** タイトル ブロック 用 (事業部 や 種別 等) */
  layoutMeta?: string
  /** 棚卸 日 (タイトル 右下 に 印字) */
  reportDate?: string

  /** 画像 px 座標系 の bounds (背景画像 が 無くても 床面 outline / objects の bbox を 包含) */
  imageWidth?: number | null
  imageHeight?: number | null
  floorOutline?: [number, number][] | null

  objects: StorageObject[]
  walls?: StorageWall[]

  /** object id → 表示 行 (3 行 推奨)。 1 行目 = label に 追加 表示。 */
  infoLinesByObject?: Map<number, string[]>

  /** object id → 色 (色分け 軸 ON 時 のみ)。 未指定 は 既定 fill。 */
  colorByObject?: Map<number, string>

  /** 凡例 (色分け 軸 ON 時 のみ)。 空 配列 で 凡例 ボックス 非表示。 */
  legend?: LegendEntry[]

  /** 詳細 表示 モード: 'inline' は box 内 (現行)、 'callout' は box は 番号 のみ で
   *  別途 numberByObject から 採番 + 親 が リスト を 描画 */
  infoMode?: 'inline' | 'callout'
  /** callout モード で 各 object に 表示 する 番号。 entries 持ち object のみ。 */
  numberByObject?: Map<number, number>

  /** 描画 サイズ (CSS px) - 親 から 指定。 未指定 は SVG の preserveAspectRatio が 効く */
  width?: number | string
  height?: number | string
}

// =============================================================================
// Component
// =============================================================================

export default function StorageSheetPlanView(p: Props) {
  // viewBox: 床面 outline + 壁 + objects の bbox を 包含。 余白 = 1m。
  const view = useMemo(() => {
    const margin = PX_PER_METER * 1.0   // 1m 余白
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const include = (x: number, y: number) => {
      if (x < minX) minX = x; if (y < minY) minY = y
      if (x > maxX) maxX = x; if (y > maxY) maxY = y
    }
    if (p.imageWidth != null && p.imageHeight != null && p.imageWidth > 0 && p.imageHeight > 0) {
      include(0, 0); include(p.imageWidth, p.imageHeight)
    }
    for (const [x, y] of p.floorOutline ?? []) include(x, y)
    for (const o of p.objects) {
      include(o.x, o.y); include(o.x + o.width, o.y + o.height)
    }
    for (const w of p.walls ?? []) {
      include(w.x1, w.y1); include(w.x2, w.y2)
    }
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1200; maxY = 800 }
    return {
      x: minX - margin, y: minY - margin,
      w: (maxX - minX) + margin * 2,
      h: (maxY - minY) + margin * 2,
    }
  }, [p.imageWidth, p.imageHeight, p.floorOutline, p.objects, p.walls])

  // グリッド: 1m 単位 で 縦横 線。 viewBox 内 だけ 描画。
  const gridLines = useMemo(() => {
    const lines: { x1: number; y1: number; x2: number; y2: number }[] = []
    const startX = Math.floor(view.x / GRID_PX) * GRID_PX
    const startY = Math.floor(view.y / GRID_PX) * GRID_PX
    for (let x = startX; x <= view.x + view.w; x += GRID_PX) {
      lines.push({ x1: x, y1: view.y, x2: x, y2: view.y + view.h })
    }
    for (let y = startY; y <= view.y + view.h; y += GRID_PX) {
      lines.push({ x1: view.x, y1: y, x2: view.x + view.w, y2: y })
    }
    return lines
  }, [view])

  // 床面 outline polygon の SVG path
  const floorPath = useMemo(() => {
    if (!p.floorOutline || p.floorOutline.length < 3) return null
    return p.floorOutline.map(([x, y], i) =>
      (i === 0 ? 'M' : 'L') + x + ',' + y
    ).join(' ') + ' Z'
  }, [p.floorOutline])

  // 線幅 は viewBox 単位 で 指定 (印刷 で 0.5mm = 約 4px を 目安)
  const wallStroke = Math.max(view.w, view.h) * 0.0035

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      width={p.width ?? '100%'}
      height={p.height ?? '100%'}
      preserveAspectRatio="xMidYMid meet"
      style={{ background: COLOR.bg, display: 'block' }}
    >
      {/* グリッド (薄い) */}
      <g>
        {gridLines.map((l, i) => (
          <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
                stroke={COLOR.gridMinor} strokeWidth={wallStroke * 0.15} />
        ))}
      </g>

      {/* 床面 fill */}
      {floorPath && (
        <path d={floorPath} fill={COLOR.floorFill} fillOpacity={0.7}
              stroke={COLOR.floorStroke} strokeWidth={wallStroke * 0.5}
              strokeLinejoin="round" />
      )}

      {/* 壁 (太線) */}
      <g>
        {(p.walls ?? []).map(w => (
          <line key={w.id}
                x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2}
                stroke={COLOR.wall} strokeWidth={wallStroke}
                strokeLinecap="round" />
        ))}
      </g>

      {/* オブジェクト (角丸 rect + 内部 ラベル + 詳細 行)。
           entries 無し は 薄く して 「使っていない 場所」 を 視覚的 に 区別 */}
      <g>
        {p.objects.map(o => {
          const lines = p.infoLinesByObject?.get(o.id) ?? []
          const isEmpty = lines.length === 0 && !(o.label && !/^#\d+$/.test(o.label.trim()))
          const num = p.numberByObject?.get(o.id)
          return (
            <PlanObject key={o.id}
              obj={o}
              color={p.colorByObject?.get(o.id) ?? COLOR.objectFill}
              infoLines={p.infoMode === 'callout' ? [] : lines}
              dim={isEmpty}
              calloutNumber={p.infoMode === 'callout' ? num : undefined}
            />
          )
        })}
      </g>

      {/* オーバーレイ: コンパス / スケールバー / タイトルブロック / 凡例 */}
      <OverlayChrome view={view} layoutName={p.layoutName}
        layoutMeta={p.layoutMeta} reportDate={p.reportDate}
        legend={p.legend ?? []} wallStroke={wallStroke} />
    </svg>
  )
}


// =============================================================================
// 子: 1 オブジェクト の 描画
// =============================================================================

/**
 * 行 の 自然 幅 を フォント サイズ から 概算 (kanji ≈ 1.0em、 半角 ≈ 0.55em)。
 * 厳密 で ない (DOM 測定 でなく 文字 種別 集計)。 textLength の 判定 用。
 */
function estimateLineWidth(line: string, fontSize: number): number {
  let w = 0
  for (const ch of line) {
    // ASCII / 半角 カナ / 記号 ≈ 0.55em、 それ以外 (kanji / 全角) ≈ 1.0em
    w += /[\x20-\x7e｡-ﾟ]/.test(ch) ? 0.55 : 1.0
  }
  return w * fontSize
}

function PlanObject({ obj, color, infoLines, dim = false, calloutNumber }: {
  obj: StorageObject
  color: string
  infoLines: string[]
  /** entries / 意図 ラベル 無し は 薄く 表示 (印刷 で 「使ってない 場所」 と わかる) */
  dim?: boolean
  /** callout モード で 表示 する 番号 (1 始まり)。 undefined なら 通常 描画。 */
  calloutNumber?: number
}) {
  const pad = Math.min(obj.width, obj.height) * 0.06
  const innerW = Math.max(0, obj.width - pad * 2)
  const innerH = Math.max(0, obj.height - pad * 2)

  // label: 未設定 / 自動 番号 (#<id>) パターン は 表示 しない (user 仕様 2026-05-25)。
  // 自動 番号 は DB に 保存 された 場合 で も 「人間 が 意図 した ラベル」 で は ない ので 除外。
  const rawLabel = obj.label?.trim() ?? ''
  const isAutoNumber = /^#\d+$/.test(rawLabel)
  const label = isAutoNumber ? '' : rawLabel

  // ラベル fs: 上限 32 (元 22 → 拡大、 画面 で 視認 し やすく)
  const labelFs = label
    ? Math.max(10, Math.min(obj.width * 0.18, obj.height * 0.32, 32))
    : 0
  const labelBlockH = labelFs ? labelFs + 4 : 0

  // 詳細 fs: 上限 20 (元 14 → 拡大)。 高さ に 入ら ない 分 は 1px ずつ 縮小、 最低 8px
  const visibleLines = infoLines   // separator '' 含む
  let infoFs = Math.max(8, Math.min(labelFs * 0.7 || 14, 20))
  const lineGap = 1.25
  const remainingH = innerH - labelBlockH
  while (infoFs > 8 && remainingH < visibleLines.length * infoFs * lineGap) {
    infoFs -= 0.5
  }
  const maxLines = Math.max(0, Math.floor(remainingH / (infoFs * lineGap)))
  const shown = visibleLines.slice(0, maxLines)
  const hiddenCount = visibleLines.length - shown.length

  return (
    <g opacity={dim ? 0.35 : 1}>
      <rect
        x={obj.x} y={obj.y} width={obj.width} height={obj.height}
        fill={dim ? '#ffffff' : color}
        fillOpacity={dim ? 0.5 : 0.85}
        stroke={COLOR.objectStroke}
        strokeWidth={Math.min(obj.width, obj.height) * (dim ? 0.008 : 0.012)}
        strokeDasharray={dim ? '4 3' : undefined}
        rx={Math.min(obj.width, obj.height) * 0.04}
      />
      {/* callout モード: 大きな 番号 を 中央 に */}
      {calloutNumber != null && (
        <text
          x={obj.x + obj.width / 2}
          y={obj.y + obj.height / 2}
          textAnchor="middle" dominantBaseline="central"
          fontSize={Math.min(obj.width, obj.height) * 0.55}
          fontWeight={700}
          fill={COLOR.objectLabel}
        >{calloutNumber}</text>
      )}
      {/* ラベル (空 なら 省略、 callout モード 時 は label を 小さく 上部 に) */}
      {label && calloutNumber == null && (
        <FitText
          text={label} x={obj.x + pad} y={obj.y + pad}
          fontSize={labelFs} maxWidth={innerW}
          fontWeight={700} fill={COLOR.objectLabel}
        />
      )}
      {/* 詳細 行 — textLength で 自動 横圧縮 (切り詰め 廃止) */}
      {shown.map((line, i) => (
        <FitText key={i}
          text={line}
          x={obj.x + pad}
          y={obj.y + pad + labelBlockH + i * infoFs * lineGap}
          fontSize={infoFs} maxWidth={innerW}
          fill={COLOR.objectInfo}
        />
      ))}
      {hiddenCount > 0 && (
        <text
          x={obj.x + obj.width - pad}
          y={obj.y + obj.height - pad}
          textAnchor="end" dominantBaseline="text-after-edge"
          fontSize={Math.max(8, infoFs * 0.9)} fill={COLOR.objectInfo} opacity={0.7}
        >… +{hiddenCount}</text>
      )}
    </g>
  )
}

/**
 * FitText — テキスト が maxWidth に 入ら ない 場合 のみ SVG textLength で
 * 自動 横圧縮。 切り詰め (…) は し ない。 半角/全角 混在 を 想定 し た 概算 で 判定。
 * lengthAdjust='spacingAndGlyphs' は glyph も 圧縮 する ので 過度 だ と 不自然 だ
 * が、 0.7× 程度 まで なら 実用 範囲。
 */
function FitText({ text, x, y, fontSize, maxWidth, fontWeight, fill }: {
  text: string
  x: number
  y: number
  fontSize: number
  maxWidth: number
  fontWeight?: number
  fill: string
}) {
  if (!text) return null
  const natural = estimateLineWidth(text, fontSize)
  const needsFit = natural > maxWidth
  return (
    <text
      x={x} y={y}
      textAnchor="start" dominantBaseline="hanging"
      fontSize={fontSize} fontWeight={fontWeight} fill={fill}
      {...(needsFit
        ? { textLength: maxWidth, lengthAdjust: 'spacingAndGlyphs' }
        : {})}
    >{text}</text>
  )
}


// =============================================================================
// オーバーレイ: コンパス / スケールバー / タイトル ブロック / 凡例
// =============================================================================

function OverlayChrome({ view, layoutName, layoutMeta, reportDate, legend, wallStroke }: {
  view: { x: number; y: number; w: number; h: number }
  layoutName: string
  layoutMeta?: string
  reportDate?: string
  legend: LegendEntry[]
  wallStroke: number
}) {
  // 各 オーバーレイ は viewBox の 端 から 一定 px (= viewBox 単位) で 配置
  const inset = Math.min(view.w, view.h) * 0.025

  // ── コンパス: 右上、 N を 上向き 矢印 (画像 座標系 は Y 下向き なので 矢印 は -Y) ──
  const compassR = Math.min(view.w, view.h) * 0.04
  const compassCx = view.x + view.w - inset - compassR
  const compassCy = view.y + inset + compassR
  const compassFs = compassR * 0.6

  // ── スケール バー: 左下、 1m / 5m の 2 段 ──
  const sbLen = PX_PER_METER * 5    // 5m バー
  const sbX = view.x + inset
  const sbY = view.y + view.h - inset
  const sbH = wallStroke * 1.2
  const sbFs = compassFs * 0.85

  // ── タイトル ブロック: 右下 角 ──
  const titleW = Math.min(view.w * 0.32, PX_PER_METER * 10)
  const titleH = Math.min(view.h * 0.10, PX_PER_METER * 2.5)
  const titleX = view.x + view.w - inset - titleW
  const titleY = view.y + view.h - inset - titleH
  const titleFs = titleH * 0.28
  const titleSubFs = titleFs * 0.65

  // ── 凡例: 右上 (コンパス の 下)、 軸 ON 時 のみ ──
  const legendShow = legend.length > 0
  const legendSwatch = compassFs * 0.7
  const legendItemH = legendSwatch + 4
  const legendW = (() => {
    if (!legendShow) return 0
    const maxChar = Math.max(0, ...legend.map(e => e.label.length))
    return legendSwatch * 1.6 + maxChar * compassFs * 0.45 + inset
  })()
  const legendH = legendItemH * legend.length + 12
  const legendX = view.x + view.w - inset - legendW
  const legendY = compassCy + compassR + inset * 0.6

  return (
    <g pointerEvents="none">
      {/* コンパス */}
      <g>
        <circle cx={compassCx} cy={compassCy} r={compassR}
                fill={COLOR.titleBg} stroke={COLOR.compass} strokeWidth={wallStroke * 0.4} />
        <line x1={compassCx} y1={compassCy + compassR * 0.7}
              x2={compassCx} y2={compassCy - compassR * 0.7}
              stroke={COLOR.compass} strokeWidth={wallStroke * 0.6} />
        <polygon
          points={`${compassCx - compassR * 0.25},${compassCy - compassR * 0.4} ${compassCx},${compassCy - compassR * 0.9} ${compassCx + compassR * 0.25},${compassCy - compassR * 0.4}`}
          fill={COLOR.compass} />
        <text x={compassCx} y={compassCy - compassR * 1.05}
              textAnchor="middle" dominantBaseline="text-after-edge"
              fontSize={compassFs} fontWeight={700} fill={COLOR.compass}>N</text>
      </g>

      {/* スケールバー (5m + ラベル) */}
      <g>
        <rect x={sbX} y={sbY - sbH} width={sbLen} height={sbH}
              fill={COLOR.scale} />
        {/* 中央分割 (1m / 5m を 視覚的 に) */}
        {[1, 2, 3, 4].map(k => (
          <line key={k}
            x1={sbX + (sbLen * k / 5)} y1={sbY - sbH}
            x2={sbX + (sbLen * k / 5)} y2={sbY - sbH * 0.4}
            stroke={COLOR.bg} strokeWidth={wallStroke * 0.5} />
        ))}
        <text x={sbX} y={sbY - sbH - 4}
              textAnchor="start" dominantBaseline="text-after-edge"
              fontSize={sbFs} fill={COLOR.scale}>0</text>
        <text x={sbX + sbLen} y={sbY - sbH - 4}
              textAnchor="end" dominantBaseline="text-after-edge"
              fontSize={sbFs} fill={COLOR.scale}>5m</text>
      </g>

      {/* タイトル ブロック */}
      <g>
        <rect x={titleX} y={titleY} width={titleW} height={titleH}
              fill={COLOR.titleBg} stroke={COLOR.titleFg} strokeWidth={wallStroke * 0.4} />
        <text x={titleX + 8} y={titleY + titleH * 0.4}
              textAnchor="start" dominantBaseline="middle"
              fontSize={titleFs} fontWeight={700} fill={COLOR.titleFg}>{layoutName}</text>
        {layoutMeta && (
          <text x={titleX + 8} y={titleY + titleH * 0.72}
                textAnchor="start" dominantBaseline="middle"
                fontSize={titleSubFs} fill={COLOR.titleFg}>{layoutMeta}</text>
        )}
        {reportDate && (
          <text x={titleX + titleW - 8} y={titleY + titleH * 0.72}
                textAnchor="end" dominantBaseline="middle"
                fontSize={titleSubFs} fill={COLOR.titleFg}>{reportDate}</text>
        )}
      </g>

      {/* 凡例 (右上、 軸 ON の とき のみ) */}
      {legendShow && (
        <g>
          <rect x={legendX} y={legendY} width={legendW} height={legendH}
                fill={COLOR.legendBg} stroke={COLOR.titleFg} strokeWidth={wallStroke * 0.3} />
          {legend.map((e, i) => (
            <g key={i} transform={`translate(${legendX + 8}, ${legendY + 8 + i * legendItemH})`}>
              <rect width={legendSwatch} height={legendSwatch}
                    fill={e.color} stroke={COLOR.titleFg} strokeWidth={wallStroke * 0.2} />
              <text x={legendSwatch + 4} y={legendSwatch / 2}
                    textAnchor="start" dominantBaseline="middle"
                    fontSize={compassFs * 0.7} fill={COLOR.titleFg}>{e.label}</text>
            </g>
          ))}
        </g>
      )}
    </g>
  )
}
