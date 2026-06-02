/**
 * Storage3DView (原料 ingredient 専用)
 * ====================================
 *
 * 視点モデル (シンプル化):
 *   - planarLocked = true (default): 真上視点固定 (polar=0, azimuth=0)
 *       ・OrbitControls: enableRotate=false, polar 範囲 [0, 0] で完全 lock
 *       ・許可される操作: 右ドラッグ=pan (target 移動), ホイール=zoom (距離変更)
 *       ・回転 NG。 真上から見た平面図そのもの
 *   - planarLocked = false: free orbit
 *       ・OrbitControls: enableRotate=true, polar 0..π*0.48
 *       ・全操作有効 (左ドラッグ=rotate, 右=pan, wheel=zoom)
 *
 * 切替遷移:
 *   - true → false: 即時、 アニメ無し (ユーザーが自分で回す)
 *   - false → true: 自動アニメ — 600ms かけて polar=0, azimuth=0 へ lerp、 アニメ中は
 *     OrbitControls 完全休止 + ユーザー入力 (click, drag) を全て無視
 *
 * 窓積み (1 段 7 ケース):
 *   - 全 7 ケース同寸法は数学的に square pallet を fill 不可能 (max 58%) なので
 *     代わりに 「上下 4+3 で各々の 半段を完全に埋める」 = 寸法差はあるが視覚的に
 *     uniform に見える (top 4 cases: W/4 × W/2, bottom 3 cases: W/3 × W/2)
 *   - 各 case の長辺 (W/2) は揃え、 短辺だけ違う
 */

import { Suspense, useMemo, useRef, useState, useCallback, useEffect } from 'react'
import { Canvas, useLoader, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Text, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { StorageObject, StorageWall } from '../api/types'
import { decomposeStackShape, type PalletConfig } from '../lib/palletStack'
import { haptic } from '../lib/haptic'

interface Props {
  imageUrl: string | null
  imageWidth: number | null
  imageHeight: number | null
  objects: StorageObject[]
  selectedId?: number | null
  selectedIds?: Set<number>
  fillByObject?: Map<number, string>
  casesByObject?: Map<number, number>
  /** 新 model パレ 構造 (per-row): 各 object の パレット 列 (pallet_index 昇順)。
   *  与え られた object は cases ベース 描画 を バイパス し、 各 行 の (tier, case,
   *  紐付け 有無) で 個別 に 高さ を 積み上げて 描画 する。 空 パレ は 木台 のみ。
   *  ない object は 旧 casesByObject 経由 fallback。 「構造-主」 refactor。 */
  palletRowsByObject?: Map<number, Array<{ tierCount: number; caseCount: number; isEmpty: boolean }>>
  /** steel_container オブジェクト の 段数 (= 紐付け 件数)。 0 / undefined なら 1 段
   *  (= 「空 コンテナ 1 つ」 を 描画 して 存在感 を 出す)。 後方 互換 で 残す。 */
  containerCountByObject?: Map<number, number>
  /** steel_container の per-row 構造 (構造-主 refactor 2026-05-27)。
   *  与え られた object は count ベース より 優先。 各 row = 1 コンテナ slot で、
   *  isEmpty=true は ghost 描画、 false は 通常 描画。 順序 = 下 から 上 (pallet_index 順)。 */
  containerRowsByObject?: Map<number, Array<{ id: number; isEmpty: boolean; capacity: number | null }>>
  labelByObject?: Map<number, string>
  /** A3.2: 詳細 表示 用 の 行 配列 (id → 複数 行)。 規格 / 数量 / 仕入先 / 入荷日 等。
   *  渡された 場合 のみ、 object 上空 に 多行 テキスト を 表示。 */
  infoLinesByObject?: Map<number, string[]>
  palletConfig?: PalletConfig
  /** true: 真上固定, false: 自由 orbit */
  planarLocked?: boolean
  editable?: boolean
  tool?: 'select' | 'add'
  /** 編集スコープ: 'object' = パレット 編集、 'floor' = 床面/壁/間取り 編集。
   *  Phase 2 では 'floor' + planarLocked + outline.length>=3 の とき 頂点 編集 ハンドル を 出す。 */
  editScope?: 'object' | 'floor'
  /** 倉庫の床面アウトライン (image px coords)。 編集は editScope='floor' + planarLocked の とき 3D 内 で 行う。 */
  floorOutline?: [number, number][] | null
  /** 床面アウトライン 変更 callback (頂点 drag / 挿入 / 削除 で 発火)。 null = 全削除。 */
  onFloorOutlineChange?: (next: [number, number][] | null) => void
  /** 壁 (画像 px 座標)。 3D では ground 上に flat box (線状) で 描画。 read-only。
   *  選択ハイライト は 設けない: 3D で 壁 を 選択 する operation が 無い ため
   *  (壁 編集 は 平面ロック中 の 床面・間取り モード で 完結。 Phase 3 で 3D 統合 時 に 再検討)。 */
  walls?: StorageWall[]
  /** "Fit to screen" 要求カウンタ — インクリメントするたびにカメラがレイアウト全体を映す */
  fitToScreenTick?: number
  onSelect?: (id: number | null, shift?: boolean) => void
  onCreate?: (x: number, y: number) => void
  onUpdate?: (id: number, patch: { x: number; y: number }) => void
}

const DEFAULT_CFG: PalletConfig = { casesPerTier: 7, tiersPerPallet: 7 }

const COLOR = {
  ground: '#e8e4d6',
  // パレット (slate blue) と ケース (pure yellow) — 「土色」 撲滅 振り (2026-05-27 ④)。
  // hue 47→48、 S 76→91、 L 60→58 で sunglow 寄り の vivid 黄 に。
  // パレ も L51→56 に 上げて 平衡 (差 2pt) → 黄 と 青 が 同じ 重 さ で 共存。
  palletBase: '#6c93b5',    // slate blue brightened (~ HSL 208° 32% 56%)
  caseFill: '#f5c930',      // vivid sunglow yellow (~ HSL 48° 91% 58%)
  caseFillAlt: '#c9a51e',   // darker mustard (段 交互、 ~ HSL 48° 73% 45%)
  partialCase: '#fbe687',   // light pale yellow (端ケ 強調、 ~ HSL 48° 93% 75%)
  groundOverlay: '#d9d4c4',
  selected: '#c8362d',
  multiSelected: '#e6a541',
  labelFg: '#ece7da',
  labelBg: '#1f1e1b',
  // steel_container 用 (金属 籠 イメージ)
  // body は ガラス 透ける感 ではなく、 視認できる スチール 色 で。 緑 (heatmap) は
  // 違和感 ある と user 指摘、 純白 半透明 は 床 と 同化 で 見えない → 中間 の
  // 銀グレー で 確定。
  containerBody:  '#cbd5e1',    // 中身 (明るい 銀グレー、 やや 透ける)
  containerFrame: '#64748b',    // 縁 (濃 スチール、 body と コントラスト)
  containerEmpty: '#e2e8f0',    // 紐付け なし時 の 更に 薄 (= 空 コンテナ)
}

const SCALE = 30
const TIER_H = 0.45
const PALLET_BASE_H = 0.18
// スチール コンテナ (1700×1000×826mm)。 1 コンテナ あたり の 高さ (world unit)。
// canvas default 寸法 85×50 px (= 17:10 比) → world 2.83×1.67 = 1700mm×1000mm。
// 1 world ≈ 1700/2.83 ≈ 600mm スケール。 826mm = 826/600 ≈ 1.38 world。
const CONTAINER_H = 1.38
// PALLET_TOTAL_H は per-object に effectiveCfg.tiersPerPallet × TIER_H で算出する


export default function Storage3DView({
  imageUrl, imageWidth, imageHeight,
  objects, selectedId, selectedIds, fillByObject, casesByObject,
  palletRowsByObject,
  containerCountByObject, containerRowsByObject, labelByObject,
  infoLinesByObject,
  palletConfig = DEFAULT_CFG,
  planarLocked = true,
  editable = false,
  tool = 'select',
  editScope = 'object',
  floorOutline,
  onFloorOutlineChange,
  walls,
  fitToScreenTick = 0,
  onSelect, onCreate, onUpdate,
}: Props) {
  const iw = (imageWidth ?? 1200) / SCALE
  const ih = (imageHeight ?? 800) / SCALE
  const camTarget = useMemo<[number, number, number]>(() => [iw / 2, 0, ih / 2], [iw, ih])
  const initialDist = Math.max(iw, ih) * 2.5
  const initialPos = useMemo<[number, number, number]>(
    () => [camTarget[0], initialDist, camTarget[2] + 0.001],
    [camTarget, initialDist]
  )

  // 自動アニメ中フラグ (true なら全入力ブロック)
  const animatingRef = useRef(false)
  const cursorStyle = (editable && tool === 'add' && planarLocked) ? 'crosshair' : 'default'

  return (
    <div style={{
      width: '100%', height: '100%', position: 'relative',
      background: COLOR.ground, cursor: cursorStyle,
      // iPad/タッチ: ブラウザの pinch-zoom / double-tap zoom / pull-to-refresh を抑止
      // (Three.js 側で pinch を pinch-to-zoom (Dolly) に使う)
      touchAction: 'none',
      // iOS Safari: タップ時のハイライトを消す
      WebkitTapHighlightColor: 'transparent',
      // テキスト選択を抑止 (ドラッグ操作で選択が走ると邪魔)
      userSelect: 'none',
      WebkitUserSelect: 'none',
    }}>
      <Canvas
        camera={{ position: initialPos, fov: 25, near: 0.1, far: initialDist * 5 }}
        gl={{ antialias: true }}
      >
        <ambientLight intensity={0.9} />
        <hemisphereLight args={['#ffffff', '#d9d4c4', 0.4]} />
        <directionalLight position={[iw, iw * 1.5, ih]} intensity={0.25} />

        <ControlsAndLock
          camTarget={camTarget}
          initialDist={initialDist}
          planarLocked={planarLocked}
          animatingRef={animatingRef}
          fitToScreenTick={fitToScreenTick}
        />

        <Suspense fallback={null}>
          <FloorPlane
            imageUrl={imageUrl} width={iw} height={ih}
            editable={editable}
            tool={tool}
            planarLocked={planarLocked}
            animatingRef={animatingRef}
            onCreate={onCreate}
            onSelect={onSelect}
            /* outline がある + image なし時は default solid plane を非表示
               (visual は FloorOutlineMesh が担当、 click だけ通す) */
            hideDefaultVisual={!imageUrl && !!floorOutline && floorOutline.length >= 3}
            /* outline 0 件 で 間取り モード の とき、 drag で 初期 矩形 を 描画 */
            editScope={editScope}
            floorOutline={floorOutline}
            onFloorOutlineChange={onFloorOutlineChange}
          />
        </Suspense>

        {/* 床面アウトライン (倉庫の輪郭) — 視覚 (半透明 fill + 縁取り)。 */}
        {floorOutline && floorOutline.length >= 3 && (
          <FloorOutlineMesh outline={floorOutline} />
        )}

        {/* 床面アウトライン 編集 ハンドル (Phase 2) — editScope='floor' + planarLocked の とき のみ。
            2D 平面図 と 同じ 振る舞い: 頂点 drag、 中点 click で 挿入、 頂点 dblclick で 削除。 */}
        {editable && editScope === 'floor' && planarLocked
          && floorOutline && floorOutline.length >= 3 && onFloorOutlineChange && (
          <OutlineEditHandles
            outline={floorOutline}
            onChange={onFloorOutlineChange}
            animatingRef={animatingRef}
          />
        )}

        {/* 壁 — 3D 上 で 床に flat box (線状) で 描画。 read-only。 編集 は 床面・間取り
            モード で 行う (Phase 3 で 3D 編集 統合 予定)。 */}
        {walls && walls.length > 0 && (
          <WallLines walls={walls} />
        )}

        {objects.map((o) => (
          o.object_type === 'steel_container' ? (
            <SteelContainerStack3D
              key={o.id}
              obj={o}
              allObjects={objects}
              containers={containerCountByObject?.get(o.id) ?? 0}
              containerRows={containerRowsByObject?.get(o.id)}
              fill={fillByObject?.get(o.id) ?? o.color ?? COLOR.containerBody}
              label={labelByObject?.get(o.id) ?? o.label ?? undefined}
              infoLines={infoLinesByObject?.get(o.id)}
              selected={selectedId === o.id}
              multiSelected={selectedIds?.has(o.id) && selectedId !== o.id}
              editable={editable}
              tool={tool}
              planarLocked={planarLocked}
              animatingRef={animatingRef}
              onSelect={onSelect}
              onUpdate={onUpdate}
            />
          ) : (
            <PalletStack3D
              key={o.id}
              obj={o}
              allObjects={objects}
              cases={casesByObject?.get(o.id) ?? 0}
              palletRows={palletRowsByObject?.get(o.id)}
              fill={fillByObject?.get(o.id) ?? o.color ?? COLOR.palletBase}
              label={labelByObject?.get(o.id) ?? o.label ?? undefined}
              infoLines={infoLinesByObject?.get(o.id)}
              selected={selectedId === o.id}
              multiSelected={selectedIds?.has(o.id) && selectedId !== o.id}
              palletConfig={palletConfig}
              editable={editable}
              tool={tool}
              planarLocked={planarLocked}
              animatingRef={animatingRef}
              onSelect={onSelect}
              onUpdate={onUpdate}
            />
          )
        ))}
      </Canvas>
    </div>
  )
}


/**
 * ControlsAndLock:
 *   - planarLocked true: OrbitControls の polar を [0, 0] に lock、 enableRotate=false
 *   - planarLocked false: 自由 orbit
 *   - false → true 遷移: 自動アニメで polar=0, azimuth=0 へ lerp、 アニメ中は ctrl.enabled=false
 *   - true → false: 即時、 アニメ無し
 */
function ControlsAndLock({ camTarget, initialDist, planarLocked, animatingRef, fitToScreenTick = 0 }: {
  camTarget: [number, number, number]
  initialDist: number
  planarLocked: boolean
  animatingRef: React.MutableRefObject<boolean>
  fitToScreenTick?: number
}) {
  const controlsRef = useRef<OrbitControlsImpl>(null!)
  const { camera } = useThree()
  const targetVec = useMemo(() => new THREE.Vector3(camTarget[0], camTarget[1], camTarget[2]), [camTarget])
  // アニメ目標 (null = アニメ無し / idle)
  const animTargetRef = useRef<'planar' | 'fit' | null>(null)

  // planarLocked が false → true に変化したらアニメ開始
  // true → false は即時 (アニメ不要)
  useEffect(() => {
    if (planarLocked) {
      // free → locked: アニメ開始
      animTargetRef.current = 'planar'
      animatingRef.current = true
      if (controlsRef.current) controlsRef.current.enabled = false
    } else {
      // locked → free: 即時 (アニメ無し)。 OrbitControls の制約を緩める
      animTargetRef.current = null
      animatingRef.current = false
      if (controlsRef.current) controlsRef.current.enabled = true
    }
  }, [planarLocked, animatingRef])

  // Fit-to-screen: tick が変化したら距離もリセットしつつ planarLocked と同じアニメで戻す
  // (planarLocked 状態は維持、 ただし pan で target がずれている分も戻す)
  const lastFitTickRef = useRef(fitToScreenTick)
  useEffect(() => {
    if (fitToScreenTick === lastFitTickRef.current) return
    lastFitTickRef.current = fitToScreenTick
    // 距離をリセット (現在の方向を保持、 distance だけ initialDist に)
    if (controlsRef.current) {
      const ctrl = controlsRef.current
      const offset = new THREE.Vector3().copy(camera.position).sub(ctrl.target)
      const sph = new THREE.Spherical().setFromVector3(offset)
      sph.radius = initialDist
      const newPos = new THREE.Vector3().setFromSpherical(sph).add(ctrl.target)
      // target アニメ + 距離リセットを同じアニメで処理
      animTargetRef.current = 'fit'
      animatingRef.current = true
      ctrl.enabled = false
      // 即時に距離だけ反映 (続いて target/angle アニメが走る)
      camera.position.copy(newPos)
      camera.lookAt(ctrl.target)
    }
  }, [fitToScreenTick, initialDist, camera, animatingRef])

  useFrame(() => {
    if (animTargetRef.current === null) return
    const ctrl = controlsRef.current
    if (!ctrl) return
    const mode = animTargetRef.current   // 'planar' | 'fit'

    // ctrl.target を layout center (initial targetVec) へ lerp
    const dtx = targetVec.x - ctrl.target.x
    const dty = targetVec.y - ctrl.target.y
    const dtz = targetVec.z - ctrl.target.z
    const targetDist = Math.sqrt(dtx * dtx + dty * dty + dtz * dtz)

    const offset = new THREE.Vector3().copy(camera.position).sub(ctrl.target)
    const sph = new THREE.Spherical().setFromVector3(offset)

    // 'planar' は角度を (0, 0) に lerp、 'fit' は角度を維持
    const targetPolar = mode === 'planar' ? 0.0001 : sph.phi
    const targetAzimuth = mode === 'planar' ? 0 : sph.theta
    const dp = targetPolar - sph.phi
    const da = targetAzimuth - sph.theta
    const eps = 0.001

    const angleSettled = Math.abs(dp) <= eps && Math.abs(da) <= eps
    const targetSettled = targetDist <= eps

    if (!angleSettled || !targetSettled) {
      ctrl.target.x += dtx * 0.12
      ctrl.target.y += dty * 0.12
      ctrl.target.z += dtz * 0.12
      sph.phi += dp * 0.12
      sph.theta += da * 0.12
      const newPos = new THREE.Vector3().setFromSpherical(sph).add(ctrl.target)
      camera.position.copy(newPos)
      camera.lookAt(ctrl.target)
    } else {
      ctrl.target.copy(targetVec)
      if (mode === 'planar') {
        sph.phi = 0.0001
        sph.theta = 0
      }
      const newPos = new THREE.Vector3().setFromSpherical(sph).add(targetVec)
      camera.position.copy(newPos)
      camera.lookAt(targetVec)
      ctrl.enabled = true
      ctrl.update()
      animTargetRef.current = null
      animatingRef.current = false
    }
  })

  // ロック状態に応じて OrbitControls の polar 範囲を設定
  const polarMin = planarLocked ? 0.0001 : 0.0001
  const polarMax = planarLocked ? 0.0001 : Math.PI * 0.48

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      target={camTarget}
      enableDamping
      // iPad/touch では damping 0.05 が反応良く感じる (0.1 だと "重い")
      dampingFactor={0.05}
      enableRotate={!planarLocked}
      enablePan
      enableZoom
      // ホイール / pinch のズーム速度をやや上げる (iPad pinch 体感改善)
      zoomSpeed={1.2}
      rotateSpeed={0.8}
      panSpeed={1.0}
      mouseButtons={{
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      }}
      touches={{
        // 1本指 = パン (iPad で 1 本指は地図 swipe 感覚、 これが直感)
        ONE: THREE.TOUCH.PAN,
        // 2本指 = pinch ズーム + 回転 (planarLocked 時は回転無効、 ズームのみ働く)
        TWO: THREE.TOUCH.DOLLY_ROTATE,
      }}
      // iPad で近づくほど操作しやすいよう、 最小ズーム距離を緩めに
      minDistance={initialDist * 0.08}
      maxDistance={initialDist * 3.0}
      minPolarAngle={polarMin}
      maxPolarAngle={polarMax}
    />
  )
}


/**
 * FloorOutlineMesh — 倉庫の床面アウトラインを 3D ground 上に描く。
 * outline 座標は画像 px (image space)。 SCALE で割って world coords に変換。
 * 半透明の polygon + 縁取り (細長 box) で 「ここが倉庫の床」 をはっきり示す。
 */
function FloorOutlineMesh({ outline }: { outline: [number, number][] }) {
  // 画像座標 → world coords。
  // ground plane は world (X, 0, Z) で width=iw/SCALE, height=ih/SCALE。
  // -PI/2 rotation around X で local (x, y) → world (x, 0, -y) になるため、
  // Shape を作る際に y を負にして変換相殺する (= 結果として local (x, -wz) → world (x, 0, wz))。
  const shape = useMemo(() => {
    const s = new THREE.Shape()
    outline.forEach(([x, y], i) => {
      const wx = x / SCALE
      const wz = y / SCALE
      // -PI/2 around X で y → -z なので、 shape では -wz を入れる
      if (i === 0) s.moveTo(wx, -wz)
      else s.lineTo(wx, -wz)
    })
    s.closePath()
    return s
  }, [outline])

  // 縁取り (各辺を細長い box として描く — line より太く確実に表示)
  const edges = useMemo(() => {
    const result: { mid: [number, number, number]; len: number; angle: number }[] = []
    for (let i = 0; i < outline.length; i++) {
      const [x1, y1] = outline[i]
      const [x2, y2] = outline[(i + 1) % outline.length]
      const wx1 = x1 / SCALE, wz1 = y1 / SCALE
      const wx2 = x2 / SCALE, wz2 = y2 / SCALE
      const mx = (wx1 + wx2) / 2
      const mz = (wz1 + wz2) / 2
      const dx = wx2 - wx1
      const dz = wz2 - wz1
      const len = Math.sqrt(dx * dx + dz * dz)
      const angle = Math.atan2(dz, dx)
      result.push({ mid: [mx, 0.04, mz], len, angle })
    }
    return result
  }, [outline])

  return (
    <group>
      {/* 半透明の床面 fill (薄いクリーム色で 「ここが倉庫」 を強調) */}
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <shapeGeometry args={[shape]} />
        <meshBasicMaterial color="#f1ead6" transparent opacity={0.55} side={THREE.DoubleSide} />
      </mesh>
      {/* 縁取り (濃いめの細長 box) — world 座標で直接配置するので Y rotation は通常通り */}
      {edges.map((e, i) => (
        <mesh key={i} position={e.mid} rotation={[0, -e.angle, 0]}>
          <boxGeometry args={[e.len, 0.04, 0.08]} />
          <meshBasicMaterial color="#7a6f4f" />
        </mesh>
      ))}
    </group>
  )
}

/**
 * WallLines — 壁 を 3D ground 上 に flat box (線状) で 描画。 read-only。
 *   - user 仕様 (2026-05-24): 「床に絵を描くくらい」 シンプル に。
 *   - mesh は 高さ 0.05、 thickness は wall.thickness (image px) / SCALE で 換算。
 *   - 選択ハイライト 無し: 3D 内 で 壁 を 選択 する operation が 無い ため
 *     (壁 編集 は 平面ロック中 の 床面・間取り モード で 完結)。
 */
function WallLines({ walls }: { walls: StorageWall[] }) {
  return (
    <group>
      {walls.map(w => {
        const dx = w.x2 - w.x1
        const dz = w.y2 - w.y1
        const len = Math.hypot(dx, dz) / SCALE
        const angle = Math.atan2(dz, dx)
        const cx = ((w.x1 + w.x2) / 2) / SCALE
        const cz = ((w.y1 + w.y2) / 2) / SCALE
        const th = Math.max(w.thickness ?? 8, 4) / SCALE
        return (
          <mesh
            key={w.id}
            position={[cx, 0.03, cz]}
            rotation={[0, -angle, 0]}
          >
            <boxGeometry args={[len, 0.05, th]} />
            <meshStandardMaterial color="#1c1b19" roughness={0.7} />
          </mesh>
        )
      })}
    </group>
  )
}


/**
 * OutlineEditHandles — 床面アウトライン の 3D 編集 ハンドル (Phase 2)。
 *   - 頂点 sphere: drag で 移動、 dblclick で 削除 (3頂点未満 → outline 全削除 = null)
 *   - 中点 sphere: click (= pointer down→up で 移動 なし) で その位置 に 頂点 挿入
 *   - 高さ: 床面 (y≈0.04〜0.06) の すぐ 上。 視認性 確保
 *   - iPad finger offset: PointerEvent の clientY を 30px 上 補正 (2D 平面図 と 同等)
 *
 * 座標 変換:
 *   image px → world = (x/SCALE, _, y/SCALE)。 raycaster で ground plane (y=0) と
 *   intersect → world (x, 0, z) を 取得 → image px に 戻す → snap (GRID=10) → onChange
 *
 * planarLocked の とき OrbitControls は 1本指 PAN を 取る が、 ハンドル は
 * onPointerDown で stopPropagation + setPointerCapture する ので 干渉 なし。
 */
const HANDLE_Y = 0.07          // 床面 fill (0.02) + 縁取り (0.04) より 上 に 置く
const VERTEX_R_VISIBLE = 0.32
const VERTEX_R_HIT = 0.85
const MIDPOINT_R_VISIBLE = 0.22
const MIDPOINT_R_HIT = 0.7
const HANDLE_GRID = 10         // 2D 平面図 と 同じ snap 単位
const IPAD_FINGER_OFFSET_Y_PX = 30

function snapPx(v: number): number {
  return Math.round(v / HANDLE_GRID) * HANDLE_GRID
}

function OutlineEditHandles({ outline, onChange, animatingRef }: {
  outline: [number, number][]
  onChange: (next: [number, number][] | null) => void
  animatingRef: React.MutableRefObject<boolean>
}) {
  const { camera, gl } = useThree()
  const controls = useThree(s => s.controls) as OrbitControlsImpl | undefined
  // 共有 raycaster / ground plane (再生成 を 避ける)
  const groundRef = useRef(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0))
  const raycasterRef = useRef(new THREE.Raycaster())
  const ndcRef = useRef(new THREE.Vector2())
  const dragIndexRef = useRef<number | null>(null)

  /** PointerEvent → image px coords (iPad finger offset 込み)。 ground plane との 交点。 */
  const pickGroundPx = useCallback((e: ThreeEvent<PointerEvent>): { x: number; y: number } | null => {
    const native = e.nativeEvent as PointerEvent
    const rect = gl.domElement.getBoundingClientRect()
    const offsetY = native.pointerType === 'touch' ? IPAD_FINGER_OFFSET_Y_PX : 0
    const clientY = native.clientY - offsetY
    const clientX = native.clientX
    ndcRef.current.x = ((clientX - rect.left) / rect.width) * 2 - 1
    ndcRef.current.y = -((clientY - rect.top) / rect.height) * 2 + 1
    raycasterRef.current.setFromCamera(ndcRef.current, camera)
    const hit = new THREE.Vector3()
    const ok = raycasterRef.current.ray.intersectPlane(groundRef.current, hit)
    if (!ok) return null
    return { x: hit.x * SCALE, y: hit.z * SCALE }
  }, [camera, gl])

  // ---- 頂点 handlers ----
  function handleVertexPointerDown(i: number, e: ThreeEvent<PointerEvent>) {
    if (animatingRef.current) return
    e.stopPropagation()
    dragIndexRef.current = i
    // OrbitControls の 1本指 pan / マウス pan を 一時 停止 (release は pointerUp で)
    if (controls) controls.enabled = false
    try { (e.target as Element)?.setPointerCapture?.(e.pointerId) } catch { /* noop */ }
  }
  function handleVertexPointerMove(e: ThreeEvent<PointerEvent>) {
    const i = dragIndexRef.current
    if (i === null) return
    e.stopPropagation()
    const pt = pickGroundPx(e)
    if (!pt) return
    // clamp は しない: 2D 版 (StorageCanvas) と 同じ 挙動。 画像 範囲 外 にも 頂点 を 置ける。
    const sx = snapPx(pt.x)
    const sy = snapPx(pt.y)
    const cur = outline[i]
    if (cur[0] === sx && cur[1] === sy) return
    const next = outline.map(([px, py], idx) =>
      idx === i ? [sx, sy] as [number, number] : [px, py] as [number, number]
    )
    onChange(next)
  }
  function handleVertexPointerUp(e: ThreeEvent<PointerEvent>) {
    if (dragIndexRef.current !== null) {
      e.stopPropagation()
      try { (e.target as Element)?.releasePointerCapture?.(e.pointerId) } catch { /* noop */ }
    }
    dragIndexRef.current = null
    if (controls) controls.enabled = true
  }
  function handleVertexDoubleClick(i: number, e: ThreeEvent<MouseEvent>) {
    e.stopPropagation()
    const next = outline.filter((_, idx) => idx !== i)
    onChange(next.length >= 3 ? next : null)
  }

  // ---- 中点 handler (click で 挿入) ----
  function handleMidpointClick(i: number, e: ThreeEvent<MouseEvent>) {
    e.stopPropagation()
    const a = outline[i]
    const b = outline[(i + 1) % outline.length]
    const mx = snapPx((a[0] + b[0]) / 2)
    const my = snapPx((a[1] + b[1]) / 2)
    const inserted = [...outline]
    inserted.splice(i + 1, 0, [mx, my])
    onChange(inserted as [number, number][])
  }

  // 中点 座標 (世界系)
  const midpoints = useMemo(() => {
    const out: { wx: number; wz: number; idx: number }[] = []
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i]
      const b = outline[(i + 1) % outline.length]
      out.push({
        wx: (a[0] + b[0]) / 2 / SCALE,
        wz: (a[1] + b[1]) / 2 / SCALE,
        idx: i,
      })
    }
    return out
  }, [outline])

  return (
    <group>
      {/* 頂点 ハンドル */}
      {outline.map(([x, y], i) => {
        const wx = x / SCALE
        const wz = y / SCALE
        return (
          <group key={`v-${i}`} position={[wx, HANDLE_Y, wz]}>
            {/* 透明 hit area (指 タップ し やすく) */}
            <mesh
              onPointerDown={(e) => handleVertexPointerDown(i, e)}
              onPointerMove={handleVertexPointerMove}
              onPointerUp={handleVertexPointerUp}
              onPointerCancel={handleVertexPointerUp}
              onDoubleClick={(e) => handleVertexDoubleClick(i, e)}
            >
              <sphereGeometry args={[VERTEX_R_HIT, 12, 8]} />
              <meshBasicMaterial visible={false} />
            </mesh>
            {/* 視覚: 白 sphere + 縁取り 風 (depth test off で 床 を 突き抜けて 見える) */}
            <mesh>
              <sphereGeometry args={[VERTEX_R_VISIBLE, 16, 12]} />
              <meshBasicMaterial color="#ffffff" depthTest={false} transparent opacity={0.95} />
            </mesh>
            <mesh>
              <sphereGeometry args={[VERTEX_R_VISIBLE * 1.18, 16, 12]} />
              <meshBasicMaterial color="#c8362d" depthTest={false} transparent opacity={0.4} />
            </mesh>
          </group>
        )
      })}
      {/* 中点 ハンドル (click で 頂点 挿入) */}
      {midpoints.map((m) => (
        <group key={`m-${m.idx}`} position={[m.wx, HANDLE_Y, m.wz]}>
          <mesh onClick={(e) => handleMidpointClick(m.idx, e)}>
            <sphereGeometry args={[MIDPOINT_R_HIT, 12, 8]} />
            <meshBasicMaterial visible={false} />
          </mesh>
          <mesh>
            <sphereGeometry args={[MIDPOINT_R_VISIBLE, 14, 10]} />
            <meshBasicMaterial color="#ffffff" depthTest={false} transparent opacity={0.85} />
          </mesh>
          <mesh>
            <sphereGeometry args={[MIDPOINT_R_VISIBLE * 0.6, 12, 8]} />
            <meshBasicMaterial color="#c8362d" depthTest={false} />
          </mesh>
        </group>
      ))}
    </group>
  )
}


function FloorPlane({
  imageUrl, width, height, editable, tool, onCreate, onSelect,
  planarLocked, animatingRef, hideDefaultVisual,
  editScope, floorOutline, onFloorOutlineChange,
}: {
  imageUrl: string | null
  width: number
  height: number
  editable: boolean
  tool: 'select' | 'add'
  onCreate?: (x: number, y: number) => void
  onSelect?: (id: number | null, shift?: boolean) => void
  planarLocked: boolean
  animatingRef: React.MutableRefObject<boolean>
  hideDefaultVisual?: boolean
  /** 編集スコープ。 'floor' + outline 無し + drag で 初期 矩形 描画 */
  editScope?: 'object' | 'floor'
  /** 現状 の outline (これ が 0 件 の とき だけ drag-to-rect 有効) */
  floorOutline?: [number, number][] | null
  /** outline 更新 callback */
  onFloorOutlineChange?: (next: [number, number][] | null) => void
}) {
  const controls = useThree(s => s.controls) as OrbitControlsImpl | undefined
  // drag-to-rect (床面 初期描画) 用 state
  const [drawRect, setDrawRect] = useState<{
    sx: number; sy: number; ex: number; ey: number
  } | null>(null)
  const drawStartRef = useRef<{ sx: number; sy: number; moved: boolean } | null>(null)

  // 床面 初期描画 が 可能 か (= floor scope + outline 無し + editable + planarLocked)
  const canDrawOutline =
    editable && planarLocked && editScope === 'floor' &&
    !!onFloorOutlineChange &&
    (!floorOutline || floorOutline.length < 3)

  function pickGround(e: ThreeEvent<PointerEvent>): { ix: number; iy: number } | null {
    if (!e.ray) return null
    const o = e.ray.origin, d = e.ray.direction
    if (Math.abs(d.y) < 1e-6) return null
    const t = -o.y / d.y
    if (t < 0) return null
    const wx = o.x + d.x * t
    const wz = o.z + d.z * t
    return { ix: wx * SCALE, iy: wz * SCALE }
  }

  function handlePointerDown(e: ThreeEvent<PointerEvent>) {
    if (!canDrawOutline) return
    e.stopPropagation()
    if (animatingRef.current) return
    const pt = pickGround(e)
    if (!pt) return
    drawStartRef.current = { sx: pt.ix, sy: pt.iy, moved: false }
    if (controls) controls.enabled = false
    ;(e.target as Element)?.setPointerCapture?.(e.pointerId)
  }
  function handlePointerMove(e: ThreeEvent<PointerEvent>) {
    if (!drawStartRef.current) return
    const pt = pickGround(e)
    if (!pt) return
    const dx = pt.ix - drawStartRef.current.sx
    const dy = pt.iy - drawStartRef.current.sy
    if (!drawStartRef.current.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
    drawStartRef.current.moved = true
    setDrawRect({
      sx: drawStartRef.current.sx, sy: drawStartRef.current.sy,
      ex: pt.ix, ey: pt.iy,
    })
  }
  function handlePointerUp(e: ThreeEvent<PointerEvent>) {
    const start = drawStartRef.current
    drawStartRef.current = null
    if (controls) controls.enabled = true
    try { (e.target as Element)?.releasePointerCapture?.(e.pointerId) } catch { /* noop */ }
    if (!start || !start.moved || !drawRect) {
      // 単 click (drag なし) → 通常 click 処理 (deselect 等) に 委譲
      setDrawRect(null)
      return
    }
    // 矩形 確定 → 4 頂点 (グリッド 20px スナップ、 LT/RT/RB/LB 順 で 時計回り)
    const x1 = Math.round(Math.min(drawRect.sx, drawRect.ex) / 20) * 20
    const y1 = Math.round(Math.min(drawRect.sy, drawRect.ey) / 20) * 20
    const x2 = Math.round(Math.max(drawRect.sx, drawRect.ex) / 20) * 20
    const y2 = Math.round(Math.max(drawRect.sy, drawRect.ey) / 20) * 20
    setDrawRect(null)
    // 最小 サイズ 制限 (40px = 2 grid) — 誤操作 防止
    if (x2 - x1 < 40 || y2 - y1 < 40) return
    const outline: [number, number][] = [
      [x1, y1], [x2, y1], [x2, y2], [x1, y2],
    ]
    haptic.success()
    onFloorOutlineChange?.(outline)
  }

  function handleClick(e: ThreeEvent<MouseEvent>) {
    e.stopPropagation()
    if (animatingRef.current) return   // アニメ中は無視
    // outline 描画 drag だった なら click は 無視 (= 既に pointerUp で 処理)
    if (drawRect) { setDrawRect(null); return }
    if (editable && tool === 'add' && planarLocked && onCreate) {
      const ix = e.point.x * SCALE
      const iy = e.point.z * SCALE
      // グリッドスナップ (中心位置を GRID=20 単位に)
      const sx = Math.round(ix / 20) * 20
      const sy = Math.round(iy / 20) * 20
      // 作成 — 成功フィードバック
      haptic.success()
      onCreate(sx, sy)
    } else {
      onSelect?.(null)
    }
  }

  // pointer handlers props (drag-to-rect が 有効 な とき のみ 付与)
  const pointerProps: Record<string, (e: ThreeEvent<PointerEvent>) => void> =
    canDrawOutline ? {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
    } : {}

  // 描画中 の プレビュー 矩形 (半透明 クリーム色)
  const previewRect = drawRect ? (() => {
    const x1 = Math.min(drawRect.sx, drawRect.ex) / SCALE
    const y1 = Math.min(drawRect.sy, drawRect.ey) / SCALE
    const x2 = Math.max(drawRect.sx, drawRect.ex) / SCALE
    const y2 = Math.max(drawRect.sy, drawRect.ey) / SCALE
    const w = x2 - x1
    const h = y2 - y1
    return (
      <mesh position={[(x1 + x2) / 2, 0.03, (y1 + y2) / 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial color="#f1ead6" transparent opacity={0.7} side={THREE.DoubleSide} />
      </mesh>
    )
  })() : null

  // hideDefaultVisual: outline が描かれていて image なしの場合、
  // 視覚は FloorOutlineMesh に任せ、 ここでは透明な click 用 mesh だけ大きめに置く。
  if (hideDefaultVisual) {
    // 透明 + 広め (画像 bounds × 4 倍) の click catcher
    const w = Math.max(width, 200) * 4
    const h = Math.max(height, 200) * 4
    return (
      <>
        <mesh position={[width / 2, 0, height / 2]} rotation={[-Math.PI / 2, 0, 0]}
          onClick={handleClick} {...pointerProps}>
          <planeGeometry args={[w, h]} />
          <meshBasicMaterial color={COLOR.ground} transparent opacity={0} depthWrite={false} />
        </mesh>
        {previewRect}
      </>
    )
  }
  if (!imageUrl) {
    return (
      <>
        <mesh position={[width / 2, 0, height / 2]} rotation={[-Math.PI / 2, 0, 0]}
          onClick={handleClick} {...pointerProps}>
          <planeGeometry args={[width, height]} />
          <meshStandardMaterial color={COLOR.ground} roughness={1} />
        </mesh>
        {previewRect}
      </>
    )
  }
  return (
    <>
      <FloorWithTexture imageUrl={imageUrl} width={width} height={height}
        onClick={handleClick} pointerProps={pointerProps} />
      {previewRect}
    </>
  )
}

function FloorWithTexture({ imageUrl, width, height, onClick, pointerProps }: {
  imageUrl: string
  width: number
  height: number
  onClick: (e: ThreeEvent<MouseEvent>) => void
  pointerProps?: Record<string, (e: ThreeEvent<PointerEvent>) => void>
}) {
  const texture = useLoader(THREE.TextureLoader, imageUrl)
  return (
    <mesh position={[width / 2, 0, height / 2]} rotation={[-Math.PI / 2, 0, 0]}
      onClick={onClick} {...(pointerProps ?? {})}>
      <planeGeometry args={[width, height]} />
      <meshStandardMaterial map={texture} roughness={0.95} />
    </mesh>
  )
}


/**
 * 1 段 7 ケース 窓積み (7:6 アスペクト pallet, PDF 仕様)
 *
 *   pallet: 長辺 W (=X 軸方向) × 短辺 D (=Z 軸方向), W:D = 7:6
 *   ケース: 同寸法 7 個、 ケース短辺 a × 長辺 b, b/a = 1.5 (=2:3)
 *           a = W/3.5 = 2W/7, b = D/2 = 3W/7 (同値だが向き違い)
 *
 *   Pattern A (N 段目):
 *     - 左側 (x in [-W/2, -W/2 + 2a]): 2×2 縦長 (4 ケース)、 each (a × b)
 *     - 右側 (x in [-W/2 + 2a, W/2]): 1×3 横長 (3 ケース)、 each (b × a, 90°回転)
 *
 *   Pattern B (N+1 段目): X 軸ミラー = 左右反転 (PDF 方向変換)
 *     - 各ケースを (x, z) → (-x, z) で反射
 *     - 結果: 左に 3 横長 + 右に 2×2 縦長
 */
interface CasePos { x: number; z: number; sx: number; sz: number }
function getTierCasePositions(W: number, D: number, tierIndex: number): CasePos[] {
  const m = 0.94   // case 内 6% gap
  // ケース寸法 (同寸法、 a=短辺、 b=長辺)
  const a = (W / 3.5)        // 2W/7 — 短辺
  const b = (D / 2)          // D/2 — 長辺 (= W * 6/14 = 3W/7、 W:D=7:6 の時 b=3a/2 ✓)
  const caseShort = a * m
  const caseLong  = b * m
  // 左側 2×2: x range [-W/2, -W/2 + 2a], 中央 x = -W/2 + a = -W/2 + 2W/7 = -3W/14
  // 4 ケース 縦長 (sx=a 短辺, sz=b 長辺)
  const leftX1 = -W / 2 + a / 2       // 左列 x
  const leftX2 = -W / 2 + a * 3 / 2   // 右列 x (左 2×2 の内)
  const upperZ = -D / 4               // 上段
  const lowerZ =  D / 4               // 下段
  // 右側 1×3: x range [-W/2 + 2a, W/2] = [-W/2 + 4W/7, W/2] = [W/14, W/2]、 中央 x = (W/14 + W/2)/2 = 4W/14
  const rightX = -W / 2 + 2 * a + b / 2   // = -W/2 + 4W/7 + 3W/14 = -W/2 + 11W/14 = 4W/14
  // 3 ケース 横長 (sx=b 長辺, sz=a 短辺), z 位置は 3 等分
  const rightZ1 = -D / 2 + a / 2          // 上
  const rightZ2 =  0                       // 中央
  const rightZ3 =  D / 2 - a / 2          // 下
  const patternA: CasePos[] = [
    // 左 2×2 縦長
    { x: leftX1, z: upperZ, sx: caseShort, sz: caseLong },
    { x: leftX2, z: upperZ, sx: caseShort, sz: caseLong },
    { x: leftX1, z: lowerZ, sx: caseShort, sz: caseLong },
    { x: leftX2, z: lowerZ, sx: caseShort, sz: caseLong },
    // 右 1×3 横長
    { x: rightX, z: rightZ1, sx: caseLong, sz: caseShort },
    { x: rightX, z: rightZ2, sx: caseLong, sz: caseShort },
    { x: rightX, z: rightZ3, sx: caseLong, sz: caseShort },
  ]
  if (tierIndex % 2 === 0) return patternA
  // Pattern B: X 座標ミラー = 左右反転 (PDF 方向変換)
  return patternA.map(p => ({ ...p, x: -p.x }))
}


function PalletStack3D({
  obj, allObjects, cases, palletRows, label, infoLines, selected, multiSelected, palletConfig, editable, tool,
  planarLocked, animatingRef, onSelect, onUpdate,
}: {
  obj: StorageObject
  allObjects: StorageObject[]
  cases: number
  /** 新 model: 行 ご と の パレット 構造。 与え られたら cases ベース より 優先。
   *  各 要素 = 1 パレット の (tier_count, case_count, isEmpty)。 順序 = 下 から 上。 */
  palletRows?: Array<{ tierCount: number; caseCount: number; isEmpty: boolean }>
  fill: string
  label?: string
  infoLines?: string[]
  selected: boolean
  multiSelected?: boolean
  palletConfig: PalletConfig
  editable: boolean
  tool: 'select' | 'add'
  planarLocked: boolean
  animatingRef: React.MutableRefObject<boolean>
  onSelect?: (id: number | null, shift?: boolean) => void
  onUpdate?: (id: number, patch: { x: number; y: number }) => void
}) {
  // 中心 (world coords)
  const cx = (obj.x + obj.width / 2) / SCALE
  const cz = (obj.y + obj.height / 2) / SCALE
  // bounding box (world)
  const bbW = (obj.width / SCALE)
  const bbD = (obj.height / SCALE)
  // 長辺 / 短辺 (寸法そのもの。 内部 pattern 用、 常に long along X)
  const longSide  = Math.max(bbW, bbD) * 0.92
  const shortSide = Math.min(bbW, bbD) * 0.92
  // orientation: 0 = 長辺 X (default), 90 = 長辺 Y (rotated)
  const isRotated = (obj.orientation ?? 0) === 90
  const rotationY = isRotated ? Math.PI / 2 : 0

  const controls = useThree(s => s.controls) as OrbitControlsImpl | undefined

  // per-object 段数 override (6 or 7、 default = palletConfig)
  const effectiveCfg = useMemo<PalletConfig>(() => {
    const tiers = obj.pallet_tiers
    if (tiers && tiers !== palletConfig.tiersPerPallet) {
      return { ...palletConfig, tiersPerPallet: tiers }
    }
    return palletConfig
  }, [palletConfig, obj.pallet_tiers])
  const shape = useMemo(() => decomposeStackShape(cases, effectiveCfg), [cases, effectiveCfg])

  // 描画 する パレット の リスト (= 新 model 優先、 fallback で shape 由来)。
  // 各 要素 = 1 パレット の 構造。 高さ は 「PALLET_BASE_H + (fullTiers + (partial>0?1:0)) × TIER_H」、
  // empty は PALLET_BASE_H だけ。
  const palletsToDraw = useMemo(() => {
    type Draw = { fullTiers: number; partialCases: number; isEmpty: boolean }
    if (palletRows && palletRows.length > 0) {
      // 新 model: 各 行 そのまま (case_count > effectiveCfg.casesPerTier の とき も そのまま 表示)
      return palletRows.map<Draw>(r => ({
        fullTiers: r.tierCount,
        partialCases: r.caseCount,
        isEmpty: r.isEmpty,
      }))
    }
    // Legacy: cases 合計 を decomposeStackShape で フル パレ + 端数 に 詰め直し
    const out: Draw[] = []
    for (let i = 0; i < shape.fullPallets; i++) {
      out.push({ fullTiers: effectiveCfg.tiersPerPallet, partialCases: 0, isEmpty: false })
    }
    if (shape.partialPallet) {
      out.push({
        fullTiers: shape.partialPallet.fullTiers,
        partialCases: shape.partialPallet.looseCases,
        isEmpty: false,
      })
    }
    return out
  }, [palletRows, shape, effectiveCfg])

  // 各 パレット の baseY (= 累積 高さ)。 トップ ラベル 位置 用 に 合計 高さ も 保持。
  // 「構造-主」 思想: empty パレ も 構造 (tier+partial) で 高さ を 計算 (= ゴースト ケース の
  // 区画 サイズ ぶん の 空間 を 確保)。 tier=0 case=0 の とき は 木台 だけ。
  const palletLayout = useMemo(() => {
    const positions: number[] = []
    let cumY = 0
    for (const p of palletsToDraw) {
      positions.push(cumY)
      const tierSlots = p.fullTiers + (p.partialCases > 0 ? 1 : 0)
      cumY += PALLET_BASE_H + tierSlots * TIER_H
    }
    return { positions, totalH: cumY }
  }, [palletsToDraw])

  const dragRef = useRef<null | {
    startWX: number; startWZ: number; objStartX: number; objStartY: number; moved: boolean
  }>(null)

  const groundPoint = useCallback((e: ThreeEvent<PointerEvent>): { x: number; z: number } | null => {
    if (!e.ray) return null
    const o = e.ray.origin
    const d = e.ray.direction
    if (Math.abs(d.y) < 1e-6) return null
    const t = -o.y / d.y
    if (t < 0) return null
    return { x: o.x + d.x * t, z: o.z + d.z * t }
  }, [])

  function handlePointerDown(e: ThreeEvent<PointerEvent>) {
    e.stopPropagation()
    if (animatingRef.current) return
    if (tool === 'add' && editable) return
    if (!editable || !planarLocked) return
    // ─── iPad/タッチ UX: select-then-drag パターン ───
    // 未選択オブジェクト への タッチ ダウンでは drag を開始しない (誤ドラッグ防止)。
    // タップ → 選択 → 改めて ドラッグ という 2 段階。
    // マウスでは 1 ドラッグで即移動 (デスクトップ慣習)。
    const isTouch = e.pointerType === 'touch' || e.pointerType === 'pen'
    if (isTouch && !selected && !multiSelected) {
      // OrbitControls が pan を処理し、 pointerUp 時に handleClick が select する
      return
    }
    const pt = groundPoint(e)
    if (!pt) return
    dragRef.current = { startWX: pt.x, startWZ: pt.z, objStartX: obj.x, objStartY: obj.y, moved: false }
    if (controls) controls.enabled = false
    ;(e.target as Element)?.setPointerCapture?.(e.pointerId)
  }
  function handlePointerMove(e: ThreeEvent<PointerEvent>) {
    if (!dragRef.current) return
    const pt = groundPoint(e)
    if (!pt) return
    const dx = (pt.x - dragRef.current.startWX) * SCALE
    const dz = (pt.z - dragRef.current.startWZ) * SCALE
    if (!dragRef.current.moved && Math.abs(dx) < 4 && Math.abs(dz) < 4) return
    dragRef.current.moved = true
    // 1) グリッドスナップ (GRID=20)
    let gx = Math.round((dragRef.current.objStartX + dx) / 20) * 20
    let gy = Math.round((dragRef.current.objStartY + dz) / 20) * 20
    // 2) 他オブジェクトのエッジへの吸着 (snap threshold 8px)
    const SNAP = 8
    const myW = obj.width
    const myH = obj.height
    // 自分の各エッジ候補
    let myLeft = gx
    let myRight = gx + myW
    let myTop = gy
    let myBottom = gy + myH
    let bestSnapX: number | null = null
    let bestSnapY: number | null = null
    let bestSnapXDist = SNAP + 1
    let bestSnapYDist = SNAP + 1
    for (const other of allObjects) {
      if (other.id === obj.id) continue
      const oLeft = other.x
      const oRight = other.x + other.width
      const oTop = other.y
      const oBottom = other.y + other.height
      // X 軸: my(left/right) と other(left/right) の組合せ
      for (const [my, target, isRight] of [
        [myLeft,  oLeft,  false],
        [myLeft,  oRight, false],
        [myRight, oLeft,  true],
        [myRight, oRight, true],
      ] as [number, number, boolean][]) {
        const d = Math.abs(my - target)
        if (d < bestSnapXDist) {
          bestSnapXDist = d
          bestSnapX = isRight ? target - myW : target
        }
      }
      for (const [my, target, isBottom] of [
        [myTop,    oTop,    false],
        [myTop,    oBottom, false],
        [myBottom, oTop,    true],
        [myBottom, oBottom, true],
      ] as [number, number, boolean][]) {
        const d = Math.abs(my - target)
        if (d < bestSnapYDist) {
          bestSnapYDist = d
          bestSnapY = isBottom ? target - myH : target
        }
      }
    }
    if (bestSnapX != null) gx = bestSnapX
    if (bestSnapY != null) gy = bestSnapY
    // unused vars cleanup
    void myLeft; void myRight; void myTop; void myBottom
    onUpdate?.(obj.id, { x: Math.max(0, gx), y: Math.max(0, gy) })
  }
  function handlePointerUp(e: ThreeEvent<PointerEvent>) {
    if (dragRef.current) {
      if (controls) controls.enabled = true
      // 念のため try-catch で囲む (capture 失敗時の noisy warning 抑止)
      try { (e.target as Element)?.releasePointerCapture?.(e.pointerId) } catch { /* noop */ }
    }
  }
  function handleClick(e: ThreeEvent<MouseEvent>) {
    e.stopPropagation()
    if (animatingRef.current) return
    if (tool === 'add' && editable) return
    if (dragRef.current?.moved) {
      dragRef.current = null
      // ドラッグ完了 → 触覚: select 強度
      haptic.select()
      return
    }
    dragRef.current = null
    // 通常クリック (select) — 軽いタップフィードバック
    haptic.tap()
    onSelect?.(obj.id, (e as unknown as { shiftKey?: boolean }).shiftKey)
  }

  const frameColor = selected ? COLOR.selected : (multiSelected ? COLOR.multiSelected : null)

  return (
    <group
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClick={handleClick}
    >
      {/* 床 footprint (bounding box 寸法、 world coords) */}
      <mesh position={[cx, 0.01, cz]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[bbW, bbD]} />
        <meshBasicMaterial color={frameColor ?? COLOR.groundOverlay}
                            opacity={frameColor ? 0.30 : 0.5} transparent />
      </mesh>
      {frameColor && (
        <SelectedFrame cx={cx} cz={cz} w={bbW} d={bbD} color={frameColor} />
      )}

      {/* パレット中身 — orientation に応じて group を回転 (local coords は長辺 = X)。
          per-row 構造-主 描画: 各 行 の (tier, case, isEmpty) を 累積 baseY で 積む。
          empty パレ は ゴースト ケース (半透明) で 区画 サイズ を 視覚化 (option B)。 */}
      <group position={[cx, 0, cz]} rotation={[0, rotationY, 0]}>
        {palletsToDraw.map((p, pIdx) => {
          const baseY = palletLayout.positions[pIdx]
          const tierSlots = p.fullTiers + (p.partialCases > 0 ? 1 : 0)
          return (
            <group key={pIdx}>
              {/* 木製 パレット ベース。 empty は やや 透ける (0.75 で 「区画 が ある」 を 明示)。 */}
              <mesh position={[0, baseY + PALLET_BASE_H / 2, 0]}>
                <boxGeometry args={[longSide, PALLET_BASE_H, shortSide]} />
                <meshStandardMaterial color={COLOR.palletBase} roughness={0.85}
                                      opacity={p.isEmpty ? 0.75 : 1.0}
                                      transparent={p.isEmpty} />
              </mesh>
              {Array.from({ length: tierSlots }).map((_, tIdx) => {
                const isPartialTier = tIdx === p.fullTiers && p.partialCases > 0
                const casesInTier = isPartialTier ? p.partialCases : effectiveCfg.casesPerTier
                const tierY = baseY + PALLET_BASE_H + tIdx * TIER_H + TIER_H / 2
                const positions = getTierCasePositions(longSide, shortSide, tIdx)
                const color = isPartialTier ? COLOR.partialCase : (tIdx % 2 === 0 ? COLOR.caseFill : COLOR.caseFillAlt)
                return (
                  <group key={tIdx}>
                    {positions.slice(0, casesInTier).map((cp, ci) => (
                      <mesh key={ci} position={[cp.x, tierY, cp.z]}>
                        <boxGeometry args={[cp.sx, TIER_H * 0.92, cp.sz]} />
                        <meshStandardMaterial color={color} roughness={0.75}
                                              opacity={p.isEmpty ? 0.32 : 1.0}
                                              transparent={p.isEmpty} />
                      </mesh>
                    ))}
                  </group>
                )
              })}
            </group>
          )
        })}
        {/* ラベル — group 内 (回転と一緒に動くが、 Text は自動で billboard 風に振る舞う) */}
        {label && (
          <Text
            position={[0, Math.max(palletLayout.totalH, 0.3) + 0.4 + (planarLocked ? 0 : 0.3), 0]}
            fontSize={0.55 + (planarLocked ? 0.15 : 0)}
            color={COLOR.labelFg}
            anchorX="center" anchorY="middle"
            outlineWidth={0.04} outlineColor={COLOR.labelBg}
            rotation={[0, -rotationY, 0]}    /* ラベルは回転打ち消しで常に正面 */
          >
            {label}
          </Text>
        )}
        {/* A3.2: 詳細 情報 (showInfo=true で 親 が 渡す)。 ラベル の 上 に N 行 積む。
            planarLocked 時 に 一番 見やすい よう に サイズ + マージン 調整。 */}
        {infoLines && infoLines.length > 0 && (() => {
          const lineH = 0.32
          const fontSize = 0.26
          const baseY = Math.max(palletLayout.totalH, 0.3)
            + 0.4 + (planarLocked ? 0 : 0.3) + 0.5
          return (
            <>
              {infoLines.map((line, idx) => (
                <Text
                  key={idx}
                  position={[0, baseY + idx * lineH, 0]}
                  fontSize={fontSize}
                  color={COLOR.labelFg}
                  anchorX="center" anchorY="middle"
                  outlineWidth={0.02} outlineColor={COLOR.labelBg}
                  rotation={[0, -rotationY, 0]}
                  maxWidth={(Math.max(bbW, bbD)) * 1.6}
                >
                  {line}
                </Text>
              ))}
            </>
          )
        })()}
      </group>
    </group>
  )
}


/**
 * SteelContainerStack3D
 * ----------------------
 * 長芋 用 スチール コンテナ (1000×800×510mm)。 1 オブジェクト = N 個 の コンテナ
 * を Y 軸 に 積み重ねる。 N は 紐付け 数 (= containers prop) で 動的 に 決まる。
 *
 * Phase 1 (現在):
 *   - 紐付け 0 件 → 「空 コンテナ 1 つ」 を 半透明 灰 で 描画 (placeholder)
 *   - 紐付け N 件 → fill 色 で N 段 積む。 全段 同色 (per-container 色 は Phase 2)
 *   - 移動 / 選択 / ラベル / info 行 は PalletStack3D と 同等
 *
 * Phase 2 (将来):
 *   - 段ごと に 個別 色 (fillByContainerIndex)
 *   - 段ごと に 個別 ラベル / kg
 */
function SteelContainerStack3D({
  obj, allObjects, containers, containerRows, fill, label, infoLines,
  selected, multiSelected, editable, tool, planarLocked, animatingRef,
  onSelect, onUpdate,
}: {
  obj: StorageObject
  allObjects: StorageObject[]
  containers: number
  /** 構造-主 model (2026-05-27): per-row 描画 用。 与え られたら count より 優先。
   *  各 row = 1 コンテナ slot。 isEmpty=true は ghost (半透明 灰)、 false は 通常 描画。 */
  containerRows?: Array<{ id: number; isEmpty: boolean; capacity: number | null }>
  fill: string
  label?: string
  infoLines?: string[]
  selected: boolean
  multiSelected?: boolean
  editable: boolean
  tool: 'select' | 'add'
  planarLocked: boolean
  animatingRef: React.MutableRefObject<boolean>
  onSelect?: (id: number | null, shift?: boolean) => void
  onUpdate?: (id: number, patch: { x: number; y: number }) => void
}) {
  // 中心 (world coords)
  const cx = (obj.x + obj.width / 2) / SCALE
  const cz = (obj.y + obj.height / 2) / SCALE
  // bounding box (world)。 コンテナ 本体 は bbox の 96% 程度 に 縮めて 隣接
  // コンテナ と 重ならない よう に。
  const bbW = obj.width / SCALE
  const bbD = obj.height / SCALE
  const innerW = bbW * 0.96
  const innerD = bbD * 0.96

  const controls = useThree(s => s.controls) as OrbitControlsImpl | undefined

  // 描画 する コンテナ の リスト (構造-主 refactor 2026-05-27):
  //   containerRows あり (空配列 含む) → 各 row そのまま (0 件 なら 何も 描か ない)
  //   containerRows undefined (= 旧 経路) → containers 数 で fallback、 0 で placeholder
  // 新 model で 0 件 = 「まだ 追加 して ない」 を 視覚 で 表現 (= 床面 だけ 残る)。
  const renderRows = useMemo<Array<{ isEmpty: boolean }>>(() => {
    if (containerRows) {
      return containerRows.map(r => ({ isEmpty: r.isEmpty }))
    }
    if (containers > 0) {
      return Array.from({ length: containers }, () => ({ isEmpty: false }))
    }
    return [{ isEmpty: true }]  // 0 件 placeholder (旧 経路 のみ)
  }, [containerRows, containers])
  const stackCount = renderRows.length
  const totalH = stackCount * CONTAINER_H
  void fill  // fill prop は 今 は 使わない (Phase 2+ で per-container 色 を 検討)

  // ─── drag (PalletStack3D と 同じ ロジック) ───
  const dragRef = useRef<null | {
    startWX: number; startWZ: number; objStartX: number; objStartY: number; moved: boolean
  }>(null)
  const groundPoint = useCallback((e: ThreeEvent<PointerEvent>): { x: number; z: number } | null => {
    if (!e.ray) return null
    const o = e.ray.origin
    const d = e.ray.direction
    if (Math.abs(d.y) < 1e-6) return null
    const t = -o.y / d.y
    if (t < 0) return null
    return { x: o.x + d.x * t, z: o.z + d.z * t }
  }, [])

  function handlePointerDown(e: ThreeEvent<PointerEvent>) {
    e.stopPropagation()
    if (animatingRef.current) return
    if (tool === 'add' && editable) return
    if (!editable || !planarLocked) return
    const isTouch = e.pointerType === 'touch' || e.pointerType === 'pen'
    if (isTouch && !selected && !multiSelected) return
    const pt = groundPoint(e)
    if (!pt) return
    dragRef.current = { startWX: pt.x, startWZ: pt.z, objStartX: obj.x, objStartY: obj.y, moved: false }
    if (controls) controls.enabled = false
    ;(e.target as Element)?.setPointerCapture?.(e.pointerId)
  }
  function handlePointerMove(e: ThreeEvent<PointerEvent>) {
    if (!dragRef.current) return
    const pt = groundPoint(e)
    if (!pt) return
    const dx = (pt.x - dragRef.current.startWX) * SCALE
    const dz = (pt.z - dragRef.current.startWZ) * SCALE
    if (!dragRef.current.moved && Math.abs(dx) < 4 && Math.abs(dz) < 4) return
    dragRef.current.moved = true
    let gx = Math.round((dragRef.current.objStartX + dx) / 20) * 20
    let gy = Math.round((dragRef.current.objStartY + dz) / 20) * 20
    // 簡易 edge snap (PalletStack3D と 同 ロジック)
    const SNAP = 8
    const myW = obj.width, myH = obj.height
    let bestX: number | null = null, bestY: number | null = null
    let bestXD = SNAP + 1, bestYD = SNAP + 1
    for (const other of allObjects) {
      if (other.id === obj.id) continue
      const oL = other.x, oR = other.x + other.width
      const oT = other.y, oB = other.y + other.height
      for (const [my, target, isRight] of [
        [gx,         oL, false], [gx,         oR, false],
        [gx + myW,   oL, true],  [gx + myW,   oR, true],
      ] as [number, number, boolean][]) {
        const d = Math.abs(my - target)
        if (d < bestXD) { bestXD = d; bestX = isRight ? target - myW : target }
      }
      for (const [my, target, isBottom] of [
        [gy,         oT, false], [gy,         oB, false],
        [gy + myH,   oT, true],  [gy + myH,   oB, true],
      ] as [number, number, boolean][]) {
        const d = Math.abs(my - target)
        if (d < bestYD) { bestYD = d; bestY = isBottom ? target - myH : target }
      }
    }
    if (bestX != null) gx = bestX
    if (bestY != null) gy = bestY
    onUpdate?.(obj.id, { x: Math.max(0, gx), y: Math.max(0, gy) })
  }
  function handlePointerUp(e: ThreeEvent<PointerEvent>) {
    if (dragRef.current) {
      if (controls) controls.enabled = true
      try { (e.target as Element)?.releasePointerCapture?.(e.pointerId) } catch { /* noop */ }
    }
  }
  function handleClick(e: ThreeEvent<MouseEvent>) {
    e.stopPropagation()
    if (animatingRef.current) return
    if (tool === 'add' && editable) return
    if (dragRef.current?.moved) {
      dragRef.current = null
      haptic.select()
      return
    }
    dragRef.current = null
    haptic.tap()
    onSelect?.(obj.id, (e as unknown as { shiftKey?: boolean }).shiftKey)
  }

  const frameColor = selected ? COLOR.selected : (multiSelected ? COLOR.multiSelected : null)

  return (
    <group
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClick={handleClick}
    >
      {/* 床 footprint */}
      <mesh position={[cx, 0.01, cz]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[bbW, bbD]} />
        <meshBasicMaterial color={frameColor ?? COLOR.groundOverlay}
                            opacity={frameColor ? 0.30 : 0.5} transparent />
      </mesh>
      {frameColor && (
        <SelectedFrame cx={cx} cz={cz} w={bbW} d={bbD} color={frameColor} />
      )}

      {/* コンテナ 本体 — N 段 を Y 軸 に 積む。 per-row で 空/充填 を 区別。 */}
      <group position={[cx, 0, cz]}>
        {renderRows.map((row, idx) => {
          const yCenter = idx * CONTAINER_H + CONTAINER_H / 2
          const bodyColor = row.isEmpty ? COLOR.containerEmpty : COLOR.containerBody
          return (
            <group key={idx}>
              {/* 内側 (中身 = ロット / 灰色 placeholder)。 視認できる 銀グレー で、
                  わずか に 透ける (opacity 0.85) こと で 籠 感 を 出す。 空 のとき は
                  更に 薄く 0.55 で 「未 充填」 を 表現。 */}
              <mesh position={[0, yCenter, 0]}>
                <boxGeometry args={[innerW * 0.92, CONTAINER_H * 0.85, innerD * 0.92]} />
                <meshStandardMaterial
                  color={bodyColor}
                  roughness={0.55}
                  metalness={0.15}
                  opacity={row.isEmpty ? 0.55 : 0.9}
                  transparent
                />
              </mesh>
              {/* 縁 (天板 = 上 フレーム のみ)。 旧版 で 底板 (y=idx*CH) も 出し
                  て いた が:
                   ・最下段 (idx=0) の 底板 が y=0 で 床面 と z-fighting (点滅)
                   ・段間 で 上の段 底板 と 下の段 天板 が 同 Y で z-fighting
                  天板 のみ に する と:
                   ・段間 = 天板 1 枚 で 仕切り 表現
                   ・最下段 底 = 床面 が そのまま 見える (= 干渉 なし) */}
              <mesh position={[0, idx * CONTAINER_H + CONTAINER_H, 0]}>
                <boxGeometry args={[innerW, 0.04, innerD]} />
                <meshStandardMaterial color={COLOR.containerFrame} roughness={0.4} metalness={0.4} />
              </mesh>
            </group>
          )
        })}
        {/* ラベル */}
        {label && (
          <Text
            position={[0, totalH + 0.35, 0]}
            fontSize={0.55 + (planarLocked ? 0.15 : 0)}
            color={COLOR.labelFg}
            anchorX="center" anchorY="middle"
            outlineWidth={0.04} outlineColor={COLOR.labelBg}
          >
            {label}
          </Text>
        )}
        {/* 詳細 情報 行 */}
        {infoLines && infoLines.length > 0 && (() => {
          const lineH = 0.32
          const fontSize = 0.26
          const baseY = totalH + 0.35 + 0.5
          return (
            <>
              {infoLines.map((line, idx) => (
                <Text
                  key={idx}
                  position={[0, baseY + idx * lineH, 0]}
                  fontSize={fontSize}
                  color={COLOR.labelFg}
                  anchorX="center" anchorY="middle"
                  outlineWidth={0.02} outlineColor={COLOR.labelBg}
                  maxWidth={Math.max(bbW, bbD) * 1.6}
                >
                  {line}
                </Text>
              ))}
            </>
          )
        })()}
      </group>
    </group>
  )
}


function SelectedFrame({ cx, cz, w, d, color }: {
  cx: number; cz: number; w: number; d: number; color: string
}) {
  const hw = w / 2
  const hd = d / 2
  const len = Math.min(w, d) * 0.20
  const thick = 0.06
  const y = 0.025
  const corners = [
    { x: -hw, z: -hd, dx: 1, dz: 1 },
    { x:  hw, z: -hd, dx: -1, dz: 1 },
    { x: -hw, z:  hd, dx: 1, dz: -1 },
    { x:  hw, z:  hd, dx: -1, dz: -1 },
  ]
  return (
    <group position={[cx, y, cz]}>
      {corners.map((c, i) => (
        <group key={i}>
          <mesh position={[c.x + c.dx * len / 2, 0, c.z]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[len, thick]} />
            <meshBasicMaterial color={color} />
          </mesh>
          <mesh position={[c.x, 0, c.z + c.dz * len / 2]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[thick, len]} />
            <meshBasicMaterial color={color} />
          </mesh>
        </group>
      ))}
    </group>
  )
}
