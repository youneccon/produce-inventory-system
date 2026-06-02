/**
 * PalletStackSvg
 * ==============
 * SVG 描画でパレットスタックの「形」 を表現するミニ visualizer。
 *
 * 規格:
 *   - 1 パレット = 7 段 × 7 ケース = 49 ケース
 *   - 1 オブジェクトに複数パレット並ぶ (横並び)
 *   - 各段は 1 つの細い長方形、 端数の最上段は ケース単位の小セル
 *
 * 視覚効果:
 *   - 満段: 濃色塗り
 *   - 端数の段: ケース格子表示
 *   - パレット間の隙間で区切り
 *
 * StorageCanvas のオブジェクト内部、 ラベル下に重ねる想定。
 */

import { decomposeStackShape, type PalletConfig } from '../lib/palletStack'

interface Props {
  /** 総ケース数 (cases) */
  cases: number
  /** 描画領域の幅 (svg units) */
  width: number
  /** 描画領域の高さ (svg units) */
  height: number
  /** パレット規格 (default 7x7) */
  config?: PalletConfig
  /** 主色 (満段塗り色) */
  fill?: string
  /** 枠色 */
  stroke?: string
  /** opacity 全体 */
  opacity?: number
}

export default function PalletStackSvg({
  cases, width, height, config, fill = '#5C5644', stroke = 'rgba(60,50,30,0.3)', opacity = 0.85,
}: Props) {
  const shape = decomposeStackShape(cases, config)
  const cfg = config ?? { casesPerTier: 7, tiersPerPallet: 7 }
  if (shape.total <= 0) return null

  // 描画するパレット個数 (満 + 部分1)
  const totalPallets = shape.fullPallets + (shape.partialPallet ? 1 : 0)
  if (totalPallets === 0) return null

  const gap = Math.max(1, Math.min(3, width / (totalPallets * 12)))
  const palletWidth = (width - gap * (totalPallets - 1)) / totalPallets
  // 1 段の高さ
  const tierH = height / cfg.tiersPerPallet

  return (
    <g opacity={opacity}>
      {Array.from({ length: totalPallets }).map((_, pIdx) => {
        const isFull = pIdx < shape.fullPallets
        const partial = !isFull ? shape.partialPallet : null
        const px = pIdx * (palletWidth + gap)
        return (
          <g key={pIdx} transform={`translate(${px}, 0)`}>
            {/* パレット枠 */}
            <rect
              x={0} y={0}
              width={palletWidth} height={height}
              fill="none"
              stroke={stroke}
              strokeWidth={0.8}
              rx={1}
            />
            {/* 段 (下から積む) */}
            {Array.from({ length: cfg.tiersPerPallet }).map((_, tIdx) => {
              // 下から t = 0..6
              // 満段なら全部塗り、 部分パレなら下から fullTiers 段塗り + 上に端数段
              let renderType: 'full' | 'partial' | 'empty' = 'empty'
              let partialCases = 0
              if (isFull) {
                renderType = 'full'
              } else if (partial) {
                if (tIdx < partial.fullTiers) renderType = 'full'
                else if (tIdx === partial.fullTiers && partial.looseCases > 0) {
                  renderType = 'partial'
                  partialCases = partial.looseCases
                }
              }
              const ty = height - (tIdx + 1) * tierH   // 下から積む
              if (renderType === 'empty') return null
              if (renderType === 'full') {
                return (
                  <rect key={tIdx}
                    x={1} y={ty + 0.5}
                    width={palletWidth - 2} height={tierH - 1}
                    fill={fill} rx={0.6}
                  />
                )
              }
              // partial: 端数ケースを格子で
              const caseW = (palletWidth - 2) / cfg.casesPerTier
              return (
                <g key={tIdx}>
                  {Array.from({ length: partialCases }).map((_, cIdx) => (
                    <rect key={cIdx}
                      x={1 + cIdx * caseW + caseW * 0.1}
                      y={ty + 0.5 + tierH * 0.15}
                      width={caseW * 0.8} height={tierH * 0.7}
                      fill={fill} rx={0.4}
                    />
                  ))}
                </g>
              )
            })}
          </g>
        )
      })}
    </g>
  )
}
