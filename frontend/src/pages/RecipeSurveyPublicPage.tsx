/**
 * RecipeSurveyPublicPage (v2 — 全面 redesign)
 * ==============================================
 * 担当者向け 公開レシピ提案フォーム。 認証不要。
 *
 * URL: /recipe-survey/{division_code}
 *
 * 新 UX 仕様:
 *   1 資材ごとに 1 画面、 商品候補を 3 ゾーンに分けて並べる:
 *     ✓ 関連あり (qty 編集可、 default=1)
 *     ? 候補 (未判定の商品)
 *     ✗ 無関係 (スワイプ済 or 同カテゴリ別資材で使用済の自動配置)
 *
 *   操作:
 *     - 候補カード: 右スワイプ or タップ → 関連
 *     - 候補カード: 左スワイプ → 無関係
 *     - 関連カード: タップで qty 編集、 ↙ アイコンで 無関係 へ
 *     - 無関係カード: タップで 関連 へ戻す (qty=1)
 *
 *   保存: 1 資材ごとに「保存して次へ」 ボタン押下時にサーバへ送信。
 *   ブラウザを閉じてもサーバ側に残り、 後で同じ URL を開けば反映されている。
 *
 *   特殊:
 *     - 資材名はスクロールしても画面上部に固定 (sticky)
 *     - 長さ管理資材 (has_length=true) は qty=cm、 単位 cm 表示
 *     - 長さ未設定だが unit=巻/本 の資材は 「1巻=何cm?」 をオプション入力 (admin 反映用)
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useDialog } from '../components/Dialog'
import { tokenize, matchesAllTokens } from '../lib/search'

interface SurveyProduct {
  id: number; name: string; unit: string | null
  pack_size: string | null
}
interface SurveyMaterial {
  id: number; code: string; item_name: string; supplier_name: string
  unit: string | null; category: string | null; division: number | null
  has_length: boolean
  length_per_roll_cm: string | null
  is_general_supply: boolean
}
interface ExistingRecipeEntry {
  product_id: number; product_name: string
  material_id: number; quantity_per_unit: string
  note: string | null
}
interface SurveySeed {
  division_code: number; division_name: string
  products: SurveyProduct[]; materials: SurveyMaterial[]
  // PMU (承認済みレシピ) — 公開アンケートでは反映しない (真っ白方針)
  existing_recipes: Record<string, ExistingRecipeEntry[]>
  // 他担当者の pending 提案がある material_id (「未編集の資材へ」 ジャンプで使用)
  pending_material_ids: number[]
}

interface ProductState {
  id: number; name: string; unit: string | null
  pack_size: string | null
  linked_qty: string | null
  linked_in_same_category: boolean
}
interface MaterialState {
  material_id: number; material_name: string; category: string | null
  unit: string | null; has_length: boolean
  length_per_roll_cm: string | null
  products: ProductState[]
}

type Zone = 'related' | 'undetermined' | 'unrelated'
type Section = 'main' | 'samecat'

interface UIProduct {
  product: SurveyProduct
  section: Section            // main = 通常、 samecat = 同カテゴリ別資材で使用中
  zone: Zone                  // related = 関連あり (qty 入力)、 undetermined = 未判定、 unrelated = グレーアウト
  qty: string                 // related のみ意味あり
  note: string                // samecat の related のみ意味あり (「A様専用」 など)
  uncertain: boolean
}

// v3: 2026-05-19 — 資材切替時の stale draft 汚染バグを修正したのに伴い、
// 既存の汚染済み v2 draft を一括無視するためバージョンバンプ。
const draftKey = (division: number) => `recipe_survey_v3_draft_div${division}`
const lastMatKey = (division: number) => `recipe_survey_v3_lastmat_div${division}`

function trimDecimal(s: string | number | null | undefined): string {
  if (s == null) return ''
  const str = String(s)
  if (!str.includes('.')) return str
  return str.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

/**
 * authMode='public': 認証不要 (/api/public/recipe-survey/...)
 * authMode='private': 認証必須 (/api/recipe-survey/...) — X-Device-Token 自動付与
 *
 * private mode は 内部ルート /materials/survey/:divisionCode で 使う。
 * UI は 同一、 違いは fetch の URL と headers のみ。
 */
export default function RecipeSurveyPublicPage({
  authMode = 'public',
}: { authMode?: 'public' | 'private' } = {}) {
  const dialog = useDialog()
  const params = useParams<{ divisionCode: string }>()
  const divisionCode = Number(params.divisionCode || 0)

  // ── API パス + ヘッダ helper (mode により 切替) ──
  const apiBase = authMode === 'private'
    ? `/api/recipe-survey/${divisionCode}`
    : `/api/public/recipe-survey/${divisionCode}`
  function authHeaders(): Record<string, string> {
    if (authMode !== 'private') return {}
    const token = localStorage.getItem('inventory_device_token') || ''
    return token ? { 'X-Device-Token': token } : {}
  }
  const [seed, setSeed] = useState<SurveySeed | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitterName, setSubmitterName] = useState<string>('')
  const [showFinalThanks, setShowFinalThanks] = useState(false)

  // 担当者が長さ未設定資材に対して提案する 1巻あたり cm
  const [suggestedLength, setSuggestedLength] = useState<string>('')

  // ─── シード取得 ───
  useEffect(() => {
    if (!divisionCode || divisionCode < 1) {
      setLoadError('URL が正しくありません')
      return
    }
    fetch(`${apiBase}/seed`, { headers: authHeaders() })
      .then(async (r) => {
        if (!r.ok) throw new Error('サーバ応答エラー')
        setSeed(await r.json())
      })
      .catch((e) => setLoadError(String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [divisionCode, authMode])

  // ─── 資材ソート (段ボール → 包装 → ... → 消耗品) ───
  const sortedMaterials = useMemo(() => {
    if (!seed) return []
    const priority = (m: SurveyMaterial): number => {
      const text = `${m.category ?? ''} ${m.item_name}`
      if (/段ボール|ダンボール|箱|カートン/.test(text)) return 0
      if (/包装|袋|フィルム|シール|ラベル|帯|封テープ/.test(text)) return 1
      if (/容器|コンテナ|トレー|パック/.test(text)) return 2
      if (/インク|印字|印刷/.test(text)) return 3
      if (/手袋|マスク|帽子|エプロン|衛生|消毒|洗剤|清掃/.test(text)) return 8
      if (/工具|道具|機械|部品|備品/.test(text)) return 9
      return 5
    }
    return [...seed.materials].sort((a, b) => {
      const pa = priority(a); const pb = priority(b)
      if (pa !== pb) return pa - pb
      return a.code.localeCompare(b.code)
    })
  }, [seed])

  // ─── 現在の資材インデックス (localStorage で続きから再開) ───
  const [matIdx, setMatIdx] = useState(0)
  useEffect(() => {
    if (!divisionCode) return
    try {
      const raw = localStorage.getItem(lastMatKey(divisionCode))
      if (raw) {
        const n = Number(raw)
        if (Number.isFinite(n) && n >= 0) setMatIdx(n)
      }
    } catch { /* ignore */ }
  }, [divisionCode])
  useEffect(() => {
    if (!divisionCode) return
    try { localStorage.setItem(lastMatKey(divisionCode), String(matIdx)) }
    catch { /* */ }
  }, [matIdx, divisionCode])

  const currentMaterial = sortedMaterials[matIdx]

  // ─── 「編集済み」 判定 (M3 2026-05 修正) ───
  // 編集済み = (1) is_general_supply = TRUE、 または
  //           (2) PMU に 既存レシピ あり (= seed.existing_recipes に エントリあり)、 または
  //           (3) 他担当者の pending 提案あり (seed.pending_material_ids)、 または
  //           (4) localStorage に自分の draft あり
  // 「未編集」 = いずれにも該当しない → まだ誰も触っていない資材
  const draftMap = useMemo<Record<string, unknown>>(() => {
    if (!divisionCode) return {}
    try {
      const raw = localStorage.getItem(draftKey(divisionCode))
      return raw ? JSON.parse(raw) : {}
    } catch { return {} }
  }, [divisionCode, matIdx])  // matIdx 変化で再評価 (保存後のジャンプ判定用)

  const pendingMatIdSet = useMemo<Set<number>>(() => {
    return new Set(seed?.pending_material_ids ?? [])
  }, [seed])

  // PMU に 既存レシピ ある material_id (= 承認済みデータあり = 編集済み扱い)
  const pmuMatIdSet = useMemo<Set<number>>(() => {
    if (!seed?.existing_recipes) return new Set()
    const ids = Object.keys(seed.existing_recipes)
      .filter(k => (seed.existing_recipes[k] ?? []).length > 0)
      .map(k => Number(k))
    return new Set(ids)
  }, [seed])

  function isEdited(mat: SurveyMaterial): boolean {
    if (mat.is_general_supply) return true
    if (pmuMatIdSet.has(mat.id)) return true        // ← M3 修正: PMU 既存も 編集済み扱い
    if (pendingMatIdSet.has(mat.id)) return true
    if (draftMap[String(mat.id)]) return true
    return false
  }

  function jumpToNextUnedited() {
    for (let i = matIdx + 1; i < sortedMaterials.length; i++) {
      if (!isEdited(sortedMaterials[i])) {
        setMatIdx(i)
        window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
        return
      }
    }
    // 後ろに無ければ最初から探す
    for (let i = 0; i < matIdx; i++) {
      if (!isEdited(sortedMaterials[i])) {
        setMatIdx(i)
        window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
        return
      }
    }
    void dialog.alert({
      title: '全資材編集済',
      message: '未編集の資材はありません。全資材に何らかのデータが入っています。',
    })
  }

  // ─── 一般消耗品トグル ───
  const [generalBusy, setGeneralBusy] = useState(false)
  async function toggleGeneralSupply(next: boolean) {
    if (!currentMaterial) return
    setGeneralBusy(true)
    try {
      const res = await fetch(
        `${apiBase}/material/${currentMaterial.id}/general-supply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ is_general_supply: next }),
        },
      )
      if (!res.ok) throw new Error('サーバ応答エラー')
      // seed のローカル状態を更新 (このマテリアルだけ)
      setSeed((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          materials: prev.materials.map((m) =>
            m.id === currentMaterial.id ? { ...m, is_general_supply: next } : m),
        }
      })
    } catch (e) {
      setSubmitError(String((e as Error).message))
    } finally {
      setGeneralBusy(false)
    }
  }

  // ─── 現資材の状態 (サーバから) + UI 状態 ───
  const [matState, setMatState] = useState<MaterialState | null>(null)
  const [uiProducts, setUiProducts] = useState<UIProduct[]>([])
  const [loadingState, setLoadingState] = useState(false)
  // uiProducts がどの material 用に初期化済みかを ref で追跡。
  // 資材切替時 (currentMaterial.id が変わった瞬間) は uiProducts はまだ前資材のもの。
  // この ref と currentMaterial.id が一致するまで draft save をスキップする。
  // (バグ修正: 切替直後の stale state が新資材のキーに保存され、 次資材で復元されて
  //  「前資材で関連付けた商品が選択済みのまま」 になる問題を防ぐ)
  const uiInitForMatId = useRef<number | null>(null)

  useEffect(() => {
    if (!currentMaterial) {
      setMatState(null); setUiProducts([])
      uiInitForMatId.current = null
      return
    }
    uiInitForMatId.current = null   // 切替中フラグ: 初期化完了まで draft save をスキップ
    setLoadingState(true)
    setSuggestedLength('')
    fetch(`${apiBase}/material/${currentMaterial.id}/state`, { headers: authHeaders() })
      .then(async (r) => {
        if (!r.ok) throw new Error('資材状態取得エラー')
        return r.json()
      })
      .then((state: MaterialState) => {
        setMatState(state)
        // UI 状態を初期化 — 「真っ白アンケート (PMU 不反映) + スクロール選択型」 方針:
        // - 全商品は基本「未判定」 (普通の黒字)。
        // - 担当者がスクロールしてタップすると、 その行が「関連」 になり、
        //   それより上の「未判定」 行が自動で 「無関係」 に倒される (グレーアウト)。
        // - pending 提案あり (linked_qty>0) は 'related' を pre-fill (qty 入り)。
        // - 同カテゴリの別資材で使用中 (linked_in_same_category) は section='samecat'
        //   にしてリスト下方に押しやる (グレーアウトはしない)。
        const ordered: UIProduct[] = []
        const mainItems: UIProduct[] = []
        const samecatItems: UIProduct[] = []
        for (const p of state.products) {
          const sp: SurveyProduct = { id: p.id, name: p.name, unit: p.unit, pack_size: p.pack_size }
          const hasPendingLink = p.linked_qty != null && Number(p.linked_qty) > 0
          const section: Section = p.linked_in_same_category ? 'samecat' : 'main'
          const item: UIProduct = {
            product: sp,
            section,
            zone: hasPendingLink ? 'related' : 'undetermined',
            qty: hasPendingLink ? trimDecimal(p.linked_qty) : '1',
            note: '',
            uncertain: false,
          }
          if (section === 'main') mainItems.push(item)
          else samecatItems.push(item)
        }
        ordered.push(...mainItems, ...samecatItems)
        const ui = ordered
        // draft (localStorage) の上書きを優先
        try {
          const draftRaw = localStorage.getItem(draftKey(divisionCode))
          if (draftRaw) {
            const draft = JSON.parse(draftRaw)
            const matDraft = draft[String(currentMaterial.id)]
            if (matDraft) {
              for (const u of ui) {
                const d = matDraft[String(u.product.id)]
                if (d) {
                  u.zone = d.zone
                  u.qty = d.qty
                  u.uncertain = !!d.uncertain
                  if (typeof d.note === 'string') u.note = d.note
                }
              }
            }
          }
        } catch { /* */ }
        setUiProducts(ui)
        uiInitForMatId.current = currentMaterial.id   // 「この資材用に初期化済み」 を mark
      })
      .catch((e) => setSubmitError(String(e)))
      .finally(() => setLoadingState(false))
  }, [currentMaterial?.id, divisionCode])

  // draft を保存。 ただし uiProducts が 「この資材用に初期化済み」 になるまで
  // スキップ (資材切替直後の stale state でキーを汚染しないため)。
  useEffect(() => {
    if (!currentMaterial || !divisionCode) return
    if (uiInitForMatId.current !== currentMaterial.id) return
    try {
      const raw = localStorage.getItem(draftKey(divisionCode))
      const draft = raw ? JSON.parse(raw) : {}
      draft[String(currentMaterial.id)] = uiProducts.reduce((acc, u) => {
        // undetermined は記録不要 (初期値)、 related / unrelated だけ記録
        if (u.zone !== 'undetermined') {
          acc[String(u.product.id)] = {
            zone: u.zone, qty: u.qty,
            note: u.note || '', uncertain: u.uncertain,
          }
        }
        return acc
      }, {} as Record<string, { zone: Zone; qty: string; note: string; uncertain: boolean }>)
      localStorage.setItem(draftKey(divisionCode), JSON.stringify(draft))
    } catch { /* */ }
  }, [uiProducts, currentMaterial?.id, divisionCode])

  // ─── タップ操作 (新仕様: スクロール選択型) ───
  // 商品行をタップすると、 その行が 'related' になり (qty=1 デフォルト)、
  // それより上 (同セクション内) の 'undetermined' 行が 'unrelated' に倒される。
  // 既に 'related' な行をタップすると undetermined に戻る (un-tap)。
  // 'unrelated' 行のタップは 'related' に上書き (気が変わった場合)。
  function toggleRowAtIndex(idx: number) {
    setUiProducts((prev) => {
      const tapped = prev[idx]
      if (!tapped) return prev
      const becomingRelated = tapped.zone !== 'related'
      return prev.map((u, i) => {
        if (i === idx) {
          if (becomingRelated) {
            return {
              ...u, zone: 'related',
              qty: (!u.qty || u.qty === '0') ? '1' : u.qty,
              uncertain: false,
            }
          }
          // un-tap: related → undetermined
          return { ...u, zone: 'undetermined' }
        }
        // 同セクション内・自分より上・未判定 → 無関係
        if (becomingRelated
            && i < idx
            && u.zone === 'undetermined'
            && u.section === tapped.section) {
          return { ...u, zone: 'unrelated' }
        }
        return u
      })
    })
  }
  function setRowQty(idx: number, qty: string) {
    setUiProducts((prev) => prev.map((u, i) =>
      i === idx ? { ...u, qty, uncertain: false } : u))
  }
  function setRowNote(idx: number, note: string) {
    setUiProducts((prev) => prev.map((u, i) =>
      i === idx ? { ...u, note } : u))
  }
  function setRowUncertain(idx: number, v: boolean) {
    setUiProducts((prev) => prev.map((u, i) =>
      i === idx ? { ...u, uncertain: v } : u))
  }

  const related = uiProducts.filter((u) => u.zone === 'related')
  const undetermined = uiProducts.filter((u) => u.zone === 'undetermined')
  const unrelated = uiProducts.filter((u) => u.zone === 'unrelated')

  // ─── 絞り込み (商品名検索) ───
  // スペース区切りで AND マッチ (Combobox と同じ tokenize ロジック)。
  // 例: 「生姜 100」 → 「中国産生姜100g ピロ」 がヒット (順不同 OK)。
  const [filterQuery, setFilterQuery] = useState('')
  useEffect(() => { setFilterQuery('') }, [currentMaterial?.id])  // 資材切替で絞り込みクリア

  const filterTokens = useMemo(() => tokenize(filterQuery), [filterQuery])
  const matchesFilter = (u: UIProduct) =>
    filterTokens.length === 0 || matchesAllTokens(u.product.name, filterTokens)

  const mainList = uiProducts
    .map((u, i) => ({ u, i }))
    .filter(({ u }) => u.section === 'main' && matchesFilter(u))
  const samecatList = uiProducts
    .map((u, i) => ({ u, i }))
    .filter(({ u }) => u.section === 'samecat' && matchesFilter(u))
  const filteredCount = mainList.length + samecatList.length
  const totalCount = uiProducts.length

  // ─── 現在の資材を submission staging に POST (中身が空なら no-op) ───
  // 戻り値: true=保存成功 or 保存不要 / false=失敗
  // 成功時は seed.pending_material_ids にも追加し、 直後の 「未編集判定」 で
  // 自動的に 「編集済み」 扱いとなりジャンプ対象から外れる。
  async function submitCurrentIfAny(): Promise<boolean> {
    if (!currentMaterial) return true
    const validLines = related.filter((u) => {
      if (u.uncertain) return true
      const q = Number(u.qty)
      return Number.isFinite(q) && q > 0
    })
    const hasLengthSuggestion = suggestedLength.trim() !== ''
      && Number(suggestedLength) > 0
    if (validLines.length === 0 && !hasLengthSuggestion) {
      return true   // 保存対象なし — 成功扱いで進む
    }
    setSubmitting(true); setSubmitError(null)
    try {
      const lines = validLines.length > 0 ? validLines.map((u) => ({
        product_id:        u.product.id,
        product_text:      null,
        material_id:       currentMaterial.id,
        material_text:     null,
        quantity_per_unit: u.uncertain ? 0 : Number(u.qty),
        unit_note:         currentMaterial.has_length ? 'cm' : (currentMaterial.unit ?? null),
        line_note:         (u.note || '').trim() || null,
        is_uncertain:      u.uncertain,
      })) : [{
        product_id: null,
        product_text: '(長さ提案のみ)',
        material_id: currentMaterial.id,
        material_text: null,
        quantity_per_unit: 0,
        unit_note: null,
        line_note: '長さ提案のみ',
        is_uncertain: true,
      }]
      const res = await fetch(apiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          submitter_name: submitterName || null,
          submitter_note: null,
          lines,
          suggested_length_per_roll_cm: hasLengthSuggestion ? Number(suggestedLength) : null,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        throw new Error(err?.detail || `送信失敗 (${res.status})`)
      }
      // 成功時に optimistic update — 自分の提案を pending リストに反映
      const matId = currentMaterial.id
      setSeed((prev) => prev ? {
        ...prev,
        pending_material_ids: prev.pending_material_ids.includes(matId)
          ? prev.pending_material_ids
          : [...prev.pending_material_ids, matId],
      } : prev)
      return true
    } catch (e) {
      setSubmitError(String((e as Error).message))
      return false
    } finally {
      setSubmitting(false)
    }
  }

  // ─── 確認モーダル ───
  // 「確認」 ボタンで開く。 関連付け一覧 (qty 編集可) を見て「保存して次へ」 で submit。
  const [confirming, setConfirming] = useState(false)

  // ─── 保存して次へ (確認モーダル内のメインボタン) ───
  async function saveAndNext() {
    const ok = await submitCurrentIfAny()
    if (ok) {
      setConfirming(false)
      moveNext()
    }
  }

  // ─── 保存して 「次の未編集の資材」 へ (StickyHeader の 「編集済みスキップ→」) ───
  async function saveAndJumpUnedited() {
    const ok = await submitCurrentIfAny()
    if (ok) jumpToNextUnedited()
  }

  function moveNext() {
    if (matIdx + 1 < sortedMaterials.length) {
      setMatIdx(matIdx + 1)
      // 次の資材のスクロール位置を先頭にリセット
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
    } else {
      // 全部終わった
      setShowFinalThanks(true)
      try { localStorage.removeItem(draftKey(divisionCode)) } catch { /* */ }
    }
  }

  function skipMaterial() { moveNext() }
  function goPrev() {
    if (matIdx > 0) {
      setMatIdx(matIdx - 1)
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
    }
  }

  // ─── render ───
  if (loadError) return <PublicShell><div className="alert error">{loadError}</div></PublicShell>
  if (!seed) return <PublicShell><div className="muted">読み込み中…</div></PublicShell>
  if (showFinalThanks) return (
    <PublicShell>
      <div style={{ textAlign: 'center', padding: 32 }}>
        <div style={{ fontSize: 64, marginBottom: 16 }}>✅</div>
        <h2>ご協力ありがとうございました</h2>
        <p style={{ color: 'var(--muted)' }}>
          送信した情報は管理者の確認後、 システムに反映されます。
        </p>
        <button onClick={() => { setMatIdx(0); setShowFinalThanks(false) }}
          style={{ marginTop: 24 }}>最初から見直す</button>
      </div>
    </PublicShell>
  )
  if (!currentMaterial) return <PublicShell><div className="muted">資材がありません</div></PublicShell>

  return (
    <PublicShell>
      {/* ─── スティッキー資材ヘッダー ─── */}
      <StickyHeader
        divisionName={seed.division_name}
        material={currentMaterial}
        matIdx={matIdx}
        total={sortedMaterials.length}
        relatedCount={related.length}
        undeterminedCount={undetermined.length}
        unrelatedCount={unrelated.length}
        onPrev={goPrev}
        onNext={skipMaterial}
        onSkipEdited={saveAndJumpUnedited}
      />

      {/* 入力者名 (最初の資材だけ表示) */}
      {matIdx === 0 && (
        <div className="field" style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>あなたのお名前 (任意)</label>
          <input
            value={submitterName}
            onChange={(e) => setSubmitterName(e.target.value)}
            placeholder="任意 (空欄でも OK)"
            maxLength={50}
            style={{ fontSize: 15 }}
          />
        </div>
      )}

      {/* 資材情報 + 長さ提案 */}
      <div style={{
        padding: 12, marginBottom: 12,
        background: currentMaterial.is_general_supply
          ? 'rgba(150, 150, 150, 0.08)'
          : 'var(--surface, #fbfcfd)',
        border: '1px solid var(--border)', borderRadius: 8,
      }}>
        <div className="muted" style={{ fontSize: 11 }}>
          仕入先: {currentMaterial.supplier_name} / 単位: {currentMaterial.unit ?? '—'}
          {currentMaterial.category && ` / ${currentMaterial.category}`}
        </div>
        {/* 一般消耗品トグル: ON で 「全商品候補をスキップ (どれにも紐付けない)」 */}
        <label style={{
          display: 'flex', alignItems: 'flex-start', gap: 8,
          marginTop: 8, padding: '6px 8px',
          background: currentMaterial.is_general_supply
            ? 'rgba(150, 150, 150, 0.15)'
            : 'rgba(245, 166, 35, 0.06)',
          border: '1px solid ' + (currentMaterial.is_general_supply
            ? 'rgba(150, 150, 150, 0.5)' : 'rgba(245, 166, 35, 0.3)'),
          borderRadius: 4, fontSize: 12, cursor: 'pointer',
        }}>
          <input
            type="checkbox"
            checked={currentMaterial.is_general_supply}
            disabled={generalBusy}
            onChange={(e) => toggleGeneralSupply(e.target.checked)}
            style={{ marginTop: 2, flexShrink: 0 }}
          />
          <span>
            <strong>一般消耗品 (どの商品にも紐付けない)</strong>
            <br />
            <span className="muted" style={{ fontSize: 11 }}>
              手袋・洗剤・印字インクなど、 製造過程で全商品共通に消費される資材。
              ON にするとこの資材は以降のアンケートで自動的にスキップされます。
            </span>
          </span>
        </label>
        {/* 長さ管理資材ヒント */}
        {currentMaterial.has_length && matState?.length_per_roll_cm && (
          <div style={{
            marginTop: 8, padding: '6px 8px',
            background: 'rgba(33, 150, 243, 0.08)',
            border: '1px solid rgba(33, 150, 243, 0.3)',
            borderRadius: 4, fontSize: 12,
          }}>
            📏 数量は <strong>cm 単位</strong> で。 (1 {currentMaterial.unit ?? '巻'} = {trimDecimal(matState.length_per_roll_cm)}cm)
          </div>
        )}
        {/* 長さ未設定 + 巻/本 単位 = 長さ提案を促す */}
        {!currentMaterial.has_length && (currentMaterial.unit === '巻' || currentMaterial.unit === '本') && (
          <div style={{
            marginTop: 8, padding: '8px',
            background: 'rgba(245, 166, 35, 0.08)',
            border: '1px solid rgba(245, 166, 35, 0.3)',
            borderRadius: 4, fontSize: 12,
          }}>
            <div style={{ marginBottom: 6 }}>
              📏 この資材は <strong>長さ未設定</strong> です。 1{currentMaterial.unit}あたり何 cm か教えてください (任意):
            </div>
            <div className="inline" style={{ gap: 4 }}>
              <input
                type="number" step="1" min="0"
                value={suggestedLength}
                onChange={(e) => setSuggestedLength(e.target.value)}
                placeholder="例: 5000"
                style={{ width: 100, fontSize: 14 }}
              />
              <span style={{ fontSize: 13 }}>cm / 1{currentMaterial.unit}</span>
            </div>
          </div>
        )}
      </div>

      {loadingState && <div className="muted">資材データ読み込み中…</div>}

      <p className="muted" style={{ fontSize: 11, margin: '8px 0' }}>
        スクロールしてこの資材を使う商品をタップしてください。
        タップした行は <span style={{ color: '#28a745', fontWeight: 700 }}>関連</span>、
        それより上の未判定行は自動で <span style={{ color: '#999' }}>無関係</span> になります。
      </p>

      {/* 絞り込み入力 (スペース区切りで AND 検索) */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        marginBottom: 8, padding: '6px 8px',
        background: 'var(--surface, #f8f9fa)',
        border: '1px solid var(--border)', borderRadius: 6,
      }}>
        <span style={{ color: 'var(--muted)', fontSize: 14 }}>🔍</span>
        <input
          type="text"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          placeholder="商品名で絞り込み (スペース区切りで AND)"
          style={{
            flex: 1, padding: '4px 6px', fontSize: 13,
            border: '1px solid var(--border)', borderRadius: 4,
            background: '#fff',
          }}
        />
        {filterQuery && (
          <>
            <span className="muted" style={{ fontSize: 11, flexShrink: 0 }}>
              {filteredCount} / {totalCount}
            </span>
            <button type="button"
              onClick={() => setFilterQuery('')}
              title="絞り込みクリア"
              style={{
                width: 22, height: 22, padding: 0, fontSize: 11, lineHeight: 1,
                background: 'transparent', color: 'var(--muted)',
                border: '1px solid var(--border)', borderRadius: '50%',
                cursor: 'pointer', flexShrink: 0,
              }}>×</button>
          </>
        )}
      </div>

      {/* メインリスト */}
      {mainList.map(({ u, i }) => (
        <ProductRow key={u.product.id} ui={u} index={i}
          unitLabel={currentMaterial.has_length ? 'cm' : (currentMaterial.unit ?? '')}
          step={currentMaterial.has_length ? 5 : 1}
          onTap={() => toggleRowAtIndex(i)}
          onQtyChange={(v) => setRowQty(i, v)}
          onNoteChange={(v) => setRowNote(i, v)}
          onUncertain={(v) => setRowUncertain(i, v)}
        />
      ))}

      {/* 同カテゴリの別資材で使用中セクション */}
      {samecatList.length > 0 && (
        <>
          <div style={{
            marginTop: 16, marginBottom: 6,
            paddingBottom: 4, borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'baseline', gap: 8,
          }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#a85a00' }}>
              ⚐ 同カテゴリ・別資材で使用中
            </span>
            <span style={{ fontSize: 12, color: '#a85a00' }}>
              ({samecatList.length})
            </span>
            <span className="muted" style={{ fontSize: 10, marginLeft: 'auto' }}>
              重複紐付け OK。 紐付ける場合は備考に理由を
            </span>
          </div>
          {samecatList.map(({ u, i }) => (
            <ProductRow key={u.product.id} ui={u} index={i}
              unitLabel={currentMaterial.has_length ? 'cm' : (currentMaterial.unit ?? '')}
              step={currentMaterial.has_length ? 5 : 1}
              onTap={() => toggleRowAtIndex(i)}
              onQtyChange={(v) => setRowQty(i, v)}
              onNoteChange={(v) => setRowNote(i, v)}
              onUncertain={(v) => setRowUncertain(i, v)}
            />
          ))}
        </>
      )}

      {submitError && <div className="alert error" style={{ marginTop: 12 }}>{submitError}</div>}

      {/* 確認ボタン */}
      <div style={{
        position: 'sticky', bottom: 0, padding: '12px 0',
        background: 'linear-gradient(to top, #f5f7fa 80%, transparent)',
        marginTop: 16,
      }}>
        <button
          onClick={() => setConfirming(true)}
          disabled={submitting || loadingState}
          style={{
            width: '100%', padding: '14px', fontSize: 16, fontWeight: 700,
            background: 'var(--primary, #1a73e8)', color: '#fff',
          }}
        >
          確認
        </button>
      </div>

      {/* 確認モーダル */}
      {confirming && (
        <ConfirmModal
          related={related}
          unitLabel={currentMaterial.has_length ? 'cm' : (currentMaterial.unit ?? '')}
          step={currentMaterial.has_length ? 5 : 1}
          submitting={submitting}
          submitError={submitError}
          matIdx={matIdx}
          total={sortedMaterials.length}
          onQtyChange={(productId, v) => {
            const idx = uiProducts.findIndex((u) => u.product.id === productId)
            if (idx >= 0) setRowQty(idx, v)
          }}
          onNoteChange={(productId, v) => {
            const idx = uiProducts.findIndex((u) => u.product.id === productId)
            if (idx >= 0) setRowNote(idx, v)
          }}
          onUncertain={(productId, v) => {
            const idx = uiProducts.findIndex((u) => u.product.id === productId)
            if (idx >= 0) setRowUncertain(idx, v)
          }}
          onRemove={(productId) => {
            const idx = uiProducts.findIndex((u) => u.product.id === productId)
            if (idx >= 0) toggleRowAtIndex(idx)   // un-tap → undetermined
          }}
          onBack={() => setConfirming(false)}
          onSave={saveAndNext}
        />
      )}
      {/* ─── 別 View へ の ナビ (公開、 2026-05-25 追加) ─── */}
      <div style={{
        marginTop: 24, padding: '12px 0',
        borderTop: '1px solid var(--divider, #e5e2d6)',
        display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center',
      }}>
        <div className="muted" style={{ fontSize: 11 }}>
          別 ビュー で 編集 する:
        </div>
        <a href={`/recipe-survey/${seed.division_code}/by-product`}
           style={{
             display: 'inline-block', padding: '10px 18px', fontSize: 13,
             background: 'var(--primary)', color: '#fff',
             borderRadius: 6, textDecoration: 'none', fontWeight: 600,
           }}>
          📊 商品別 資材使用状況 集計
        </a>
        <div className="muted" style={{ fontSize: 10, textAlign: 'center' }}>
          各 商品 ごと に 「この 商品 を 作る の に 必要 な 資材」 を 編集 できます
        </div>
      </div>
    </PublicShell>
  )
}

/** スティッキー資材ヘッダー (画面上部に常時表示)
 *  レイアウト:
 *    Row 1: [資材名]                              [← 前へ]  [後へ →]
 *    Row 2: [✓N  ?N  ✗N] (左)        [編集済みスキップ →] (右)
 */
function StickyHeader({
  divisionName, material, matIdx, total,
  relatedCount, undeterminedCount, unrelatedCount,
  onPrev, onNext, onSkipEdited,
}: {
  divisionName: string
  material: SurveyMaterial
  matIdx: number; total: number
  relatedCount: number; undeterminedCount: number; unrelatedCount: number
  onPrev: () => void; onNext: () => void
  onSkipEdited: () => void
}) {
  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 10,
      background: '#fff', padding: '8px 0',
      borderBottom: '1px solid var(--border)',
      marginBottom: 12,
    }}>
      <div className="muted" style={{ fontSize: 11 }}>
        {divisionName} 事業部 ・ 資材 {matIdx + 1} / {total}
      </div>
      {/* Row 1: 資材名 + 前へ / 後へ */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 2,
      }}>
        <div style={{
          flex: 1, minWidth: 0,
          fontWeight: 700, fontSize: 20, lineHeight: 1.25,
          wordBreak: 'break-word',
        }}>
          {material.item_name}
          {material.is_general_supply && (
            <span style={{
              marginLeft: 8, fontSize: 11, fontWeight: 500,
              padding: '2px 6px', borderRadius: 3,
              background: 'rgba(150, 150, 150, 0.15)', color: '#777',
              verticalAlign: 'middle',
            }}>
              一般消耗品
            </span>
          )}
        </div>
        <button type="button" onClick={onPrev} disabled={matIdx === 0}
          className="ghost small"
          style={{ padding: '2px 8px', fontSize: 11, flexShrink: 0 }}>
          ← 前へ
        </button>
        <button type="button" onClick={onNext}
          className="ghost small"
          style={{ padding: '2px 8px', fontSize: 11, flexShrink: 0 }}>
          後へ →
        </button>
      </div>
      {/* Row 2: カウント (左) + 編集済みスキップ (右) */}
      <div style={{ display: 'flex', gap: 6, marginTop: 6, fontSize: 11, alignItems: 'center' }}>
        <span style={{ color: '#28a745' }}>✓ {relatedCount}</span>
        <span style={{ color: '#1a73e8' }}>? {undeterminedCount}</span>
        <span style={{ color: '#999' }}>✗ {unrelatedCount}</span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onSkipEdited}
          className="ghost small" style={{
            padding: '2px 10px', fontSize: 11, fontWeight: 600,
            color: 'var(--primary, #1a73e8)',
            border: '1px solid var(--primary, #1a73e8)', background: '#fff',
          }}>
          編集済みスキップ →
        </button>
      </div>
      <div style={{
        height: 3, background: 'var(--border)', borderRadius: 2, marginTop: 6,
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%', background: 'var(--primary)',
          width: `${(matIdx / Math.max(1, total)) * 100}%`,
        }} />
      </div>
    </div>
  )
}

/** 統一商品行コンポーネント (新仕様: 単一リスト、 行は zone でビジュアル切替)。
 *  - undetermined: 普通の黒字、 タップで related
 *  - related: 緑系強調、 qty 入力 (−/+/手入力), 入り数バッジ, 不明 ?, 解除 ✕。
 *             samecat セクションの場合は備考欄追加。
 *  - unrelated: グレーアウト、 タップで related に上書き
 */
function ProductRow({
  ui, index, unitLabel, step, onTap, onQtyChange, onNoteChange, onUncertain,
}: {
  ui: UIProduct
  index: number
  unitLabel: string
  step: number
  onTap: () => void
  onQtyChange: (v: string) => void
  onNoteChange: (v: string) => void
  onUncertain: (v: boolean) => void
}) {
  const isRelated = ui.zone === 'related'
  const isUnrelated = ui.zone === 'unrelated'
  const pack = ui.product.pack_size
  const packNum = pack ? Number(pack) : 0
  const packStr = packNum > 0 ? `${trimDecimal(pack!)}入` : ''
  const packTapped = packNum > 0 && Number(ui.qty) === packNum

  // 全体クリックで toggle (related → undetermined / undetermined or unrelated → related)
  // ただし qty/note/✕/? の内部 button は stopPropagation して toggle を抑止
  return (
    <div
      onClick={onTap}
      data-row-index={index}
      style={{
        padding: '8px 10px', marginBottom: 4,
        background: isRelated ? 'rgba(40, 167, 69, 0.08)'
                  : isUnrelated ? '#f6f7f8' : '#fff',
        border: '1px solid ' + (isRelated ? 'rgba(40, 167, 69, 0.5)'
                  : isUnrelated ? 'var(--border)' : 'var(--border)'),
        borderRadius: 6,
        opacity: isUnrelated ? 0.45 : 1,
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          width: 18, flexShrink: 0, textAlign: 'center', fontSize: 13,
          color: isRelated ? '#28a745' : (isUnrelated ? '#bbb' : 'transparent'),
          fontWeight: 700,
        }}>
          {isRelated ? '✓' : isUnrelated ? '—' : ''}
        </span>
        <span style={{
          flex: 1, minWidth: 0,
          fontWeight: isRelated ? 600 : 500, fontSize: 14, lineHeight: 1.3,
          wordBreak: 'normal', overflowWrap: 'anywhere',
        }}>
          {ui.product.name}
          {packStr && !isRelated && (
            <span className="muted" style={{ fontSize: 11, marginLeft: 6, fontWeight: 400 }}>
              ({packStr})
            </span>
          )}
          {packStr && isRelated && (
            <button type="button"
              onClick={(e) => { e.stopPropagation(); onQtyChange(trimDecimal(pack!)) }}
              title={packTapped ? `数量に "${trimDecimal(pack!)}" 設定済み`
                                : `タップで数量を入り数 ${trimDecimal(pack!)} に揃える`}
              style={{
                marginLeft: 6, padding: '1px 6px',
                fontSize: 11, fontWeight: 600,
                background: packTapped ? 'rgba(40, 167, 69, 0.18)' : 'rgba(26, 115, 232, 0.1)',
                color: packTapped ? '#28a745' : 'var(--primary, #1a73e8)',
                border: '1px solid ' + (packTapped ? '#28a745' : 'var(--primary, #1a73e8)'),
                borderRadius: 3, cursor: 'pointer', boxShadow: 'none',
                verticalAlign: 'middle',
              }}
            >
              {packTapped ? '✓ ' : '→ '}{packStr}
            </button>
          )}
        </span>
        {isRelated && (
          <>
            <button type="button"
              onClick={(e) => { e.stopPropagation(); const v = Number(ui.qty) || 0; onQtyChange(String(Math.max(0, v - step))) }}
              disabled={ui.uncertain}
              style={{
                width: 26, height: 28, padding: 0, fontSize: 14,
                background: '#f3f4f6', color: '#333',
                border: '1px solid #d1d5db', borderRadius: 4,
                boxShadow: 'none', flexShrink: 0,
                opacity: ui.uncertain ? 0.4 : 1,
              }}
            >−</button>
            <input
              type="number" step={String(step)} min="0"
              value={ui.uncertain ? '' : ui.qty}
              onChange={(e) => onQtyChange(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder={ui.uncertain ? '?' : '1'}
              disabled={ui.uncertain}
              style={{
                width: 44, height: 28, padding: '0 2px',
                textAlign: 'center', fontSize: 14, fontWeight: 600,
                flexShrink: 0,
                background: ui.uncertain ? 'rgba(245,166,35,0.1)' : '#fff',
              }}
            />
            <button type="button"
              onClick={(e) => { e.stopPropagation(); const v = Number(ui.qty) || 0; onQtyChange(String(v + step)) }}
              disabled={ui.uncertain}
              style={{
                width: 26, height: 28, padding: 0, fontSize: 14,
                background: '#f3f4f6', color: '#333',
                border: '1px solid #d1d5db', borderRadius: 4,
                boxShadow: 'none', flexShrink: 0,
                opacity: ui.uncertain ? 0.4 : 1,
              }}
            >+</button>
            {unitLabel && (
              <span className="muted" style={{ fontSize: 10, flexShrink: 0 }}>{unitLabel}</span>
            )}
            <button type="button"
              onClick={(e) => { e.stopPropagation(); onUncertain(!ui.uncertain) }}
              title="数量不明 (管理者に確認してもらう)"
              style={{
                width: 26, height: 28, padding: 0, fontSize: 12,
                background: ui.uncertain ? 'rgba(245,166,35,0.2)' : 'transparent',
                color: ui.uncertain ? 'var(--warning, #f5a623)' : 'var(--muted)',
                border: '1px solid ' + (ui.uncertain ? 'var(--warning, #f5a623)' : 'var(--border)'),
                borderRadius: 4, boxShadow: 'none', flexShrink: 0,
              }}
            >?</button>
            <button type="button"
              onClick={(e) => { e.stopPropagation(); onTap() }}
              title="関連を解除 (未判定に戻す)"
              style={{
                width: 26, height: 28, padding: 0, fontSize: 12,
                background: 'transparent', color: 'var(--muted)',
                border: '1px solid var(--border)', borderRadius: 4,
                boxShadow: 'none', flexShrink: 0,
              }}
            >✕</button>
          </>
        )}
      </div>
      {/* samecat セクションで related 化された行は備考欄を表示 */}
      {isRelated && ui.section === 'samecat' && (
        <div style={{ marginTop: 6, marginLeft: 22 }}>
          <input
            type="text"
            value={ui.note}
            onChange={(e) => onNoteChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            placeholder="備考 (例: A様専用仕様、 大箱対応のみ など)"
            maxLength={200}
            style={{ width: '100%', fontSize: 12, padding: '4px 6px' }}
          />
        </div>
      )}
    </div>
  )
}

/** 確認モーダル: 関連付け済みの商品一覧 (qty 編集可) + 保存して次へ */
function ConfirmModal({
  related, unitLabel, step, submitting, submitError,
  matIdx, total,
  onQtyChange, onNoteChange, onUncertain, onRemove,
  onBack, onSave,
}: {
  related: UIProduct[]
  unitLabel: string
  step: number
  submitting: boolean
  submitError: string | null
  matIdx: number
  total: number
  onQtyChange: (productId: number, v: string) => void
  onNoteChange: (productId: number, v: string) => void
  onUncertain: (productId: number, v: boolean) => void
  onRemove: (productId: number) => void
  onBack: () => void
  onSave: () => void
}) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.4)', zIndex: 1000,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
      onClick={onBack}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 720, maxHeight: '90vh',
          background: '#fff', borderRadius: '12px 12px 0 0',
          padding: 16, overflowY: 'auto',
          boxShadow: '0 -2px 12px rgba(0,0,0,0.15)',
        }}
      >
        <h3 style={{ marginTop: 0, marginBottom: 4 }}>関連付け確認</h3>
        <p className="muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 12 }}>
          下記 {related.length} 件を関連付けて保存します。 修正したいものはここで直して、
          「保存して次へ」 を押してください。
        </p>
        {related.length === 0 && (
          <div className="muted" style={{
            padding: 16, textAlign: 'center', fontSize: 13,
            background: '#f8f9fa', borderRadius: 4, marginBottom: 12,
          }}>
            関連付けた商品はありません。 そのまま「保存して次へ」 を押すと、 この資材は
            「データなし」 として 次の資材へ進みます (送信はされません)。
          </div>
        )}
        {related.map((u) => {
          const isSamecat = u.section === 'samecat'
          return (
            <div key={u.product.id}
              style={{
                padding: '8px 10px', marginBottom: 6,
                background: 'rgba(40, 167, 69, 0.06)',
                border: '1px solid rgba(40, 167, 69, 0.4)',
                borderRadius: 6,
              }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>
                  {u.product.name}
                  {isSamecat && (
                    <span style={{
                      marginLeft: 6, fontSize: 10, fontWeight: 500,
                      padding: '1px 5px', borderRadius: 3,
                      background: 'rgba(168, 90, 0, 0.12)', color: '#a85a00',
                    }}>同カテゴリ別資材兼用</span>
                  )}
                </span>
                <button type="button"
                  onClick={() => { const v = Number(u.qty) || 0; onQtyChange(u.product.id, String(Math.max(0, v - step))) }}
                  disabled={u.uncertain}
                  style={{ width: 26, height: 28, padding: 0, fontSize: 14,
                    background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 4 }}
                >−</button>
                <input type="number" step={String(step)} min="0"
                  value={u.uncertain ? '' : u.qty}
                  onChange={(e) => onQtyChange(u.product.id, e.target.value)}
                  placeholder={u.uncertain ? '?' : '1'}
                  disabled={u.uncertain}
                  style={{ width: 50, height: 28, padding: '0 2px',
                    textAlign: 'center', fontSize: 13, fontWeight: 600 }}
                />
                <button type="button"
                  onClick={() => { const v = Number(u.qty) || 0; onQtyChange(u.product.id, String(v + step)) }}
                  disabled={u.uncertain}
                  style={{ width: 26, height: 28, padding: 0, fontSize: 14,
                    background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 4 }}
                >+</button>
                {unitLabel && (
                  <span className="muted" style={{ fontSize: 10 }}>{unitLabel}</span>
                )}
                <button type="button"
                  onClick={() => onUncertain(u.product.id, !u.uncertain)}
                  title="数量不明"
                  style={{
                    width: 26, height: 28, padding: 0, fontSize: 12,
                    background: u.uncertain ? 'rgba(245,166,35,0.2)' : 'transparent',
                    color: u.uncertain ? 'var(--warning, #f5a623)' : 'var(--muted)',
                    border: '1px solid ' + (u.uncertain ? 'var(--warning, #f5a623)' : 'var(--border)'),
                    borderRadius: 4,
                  }}
                >?</button>
                <button type="button"
                  onClick={() => onRemove(u.product.id)}
                  title="関連を取り消す"
                  style={{
                    width: 26, height: 28, padding: 0, fontSize: 12,
                    background: 'transparent', color: 'var(--danger, #dc3545)',
                    border: '1px solid var(--border)', borderRadius: 4,
                  }}
                >✕</button>
              </div>
              {isSamecat && (
                <input type="text"
                  value={u.note}
                  onChange={(e) => onNoteChange(u.product.id, e.target.value)}
                  placeholder="備考 (例: A様専用仕様)"
                  maxLength={200}
                  style={{ width: '100%', fontSize: 12, padding: '4px 6px', marginTop: 6 }}
                />
              )}
            </div>
          )
        })}
        {submitError && <div className="alert error" style={{ marginTop: 8 }}>{submitError}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="button" onClick={onBack} disabled={submitting}
            style={{
              flex: 1, padding: '12px',
              background: 'transparent', color: 'var(--muted)',
              border: '1px solid var(--border)',
            }}>
            戻って修正
          </button>
          <button type="button" onClick={onSave} disabled={submitting}
            style={{
              flex: 2, padding: '12px', fontSize: 15, fontWeight: 700,
              background: 'var(--primary, #1a73e8)', color: '#fff',
            }}>
            {submitting ? '保存中…' : `💾 保存して次へ (${matIdx + 1}/${total})`}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 公開ページ用シェル */
function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: '#f5f7fa',
      overflowY: 'auto',
      WebkitOverflowScrolling: 'touch',
      touchAction: 'pan-y',
      padding: 12,
      paddingBottom: 'max(40px, env(safe-area-inset-bottom, 40px))',
      boxSizing: 'border-box',
    }}>
      <div style={{
        maxWidth: 720, margin: '0 auto',
        background: '#fff', padding: 16, borderRadius: 8,
        boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      }}>
        {children}
      </div>
    </div>
  )
}
