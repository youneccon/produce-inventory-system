"""
tools/seed_demo.py
==================
デモ／ポートフォリオ用の **包括的な合成サンプルデータ** を一括投入する。

特徴:
  * 実在の社内データは一切含まない（架空の作物・取引先・数量）。
  * 日付は **実行時点を基準に相対生成**（先々月=M2 / 先月=M1 / 今月=M0）。
    いつ開いても「今月」にデータがあり、先月末の棚卸が当月へ繰り越される。
  * 冪等: 業務テーブルを TRUNCATE RESTART IDENTITY CASCADE してから再構築する。
    （users / audit_log / client_logs は温存 = 登録済みデバイスを壊さない）

対象: 5作物(生姜/大蒜/長芋/牛蒡/薩摩芋)の入荷・在庫・出庫・月次台帳、
      資材(5部門)、出荷商品＋レシピ、振替ルール、選別＋半製品(大蒜)、
      資産管理、倉庫レイアウト。

使い方:
    # 事前に DB を作成し schema.sql を流し込んでおくこと (README 参照)
    python tools/seed_demo.py
"""

from __future__ import annotations

import calendar
import os
from datetime import date, timedelta
from decimal import Decimal

import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row


# ---------------------------------------------------------------------------
# 相対日付ユーティリティ
# ---------------------------------------------------------------------------
TODAY = date.today()


def _month_start(d: date) -> date:
    return d.replace(day=1)


M0 = _month_start(TODAY)                       # 今月
M1 = _month_start(M0 - timedelta(days=1))      # 先月
M2 = _month_start(M1 - timedelta(days=1))      # 先々月


def _day(month_start: date, day: int) -> date:
    """月初 + 指定日(月末を超えないようクランプ)。"""
    last = calendar.monthrange(month_start.year, month_start.month)[1]
    return month_start.replace(day=min(day, last))


def _period(month_start: date) -> str:
    return month_start.strftime("%Y-%m")


def _month_end(month_start: date) -> date:
    last = calendar.monthrange(month_start.year, month_start.month)[1]
    return month_start.replace(day=last)


# 今月の「活動日」は未来日を避けるため TODAY を上限にする
M0_ACT = TODAY
M1_END = _month_end(M1)


# ---------------------------------------------------------------------------
# マスタ定義
# ---------------------------------------------------------------------------
# 作物: (code, name, division, origin名(末尾'産'禁止), region)
CROPS = [
    ("01", "生姜",   1, "高知県",   "四国"),
    ("02", "大蒜",   2, "青森県",   "東北"),
    ("03", "長芋",   3, "北海道",   "北海道"),
    ("04", "牛蒡",   4, "宮崎県",   "九州"),
    ("05", "薩摩芋", 5, "鹿児島県", "九州"),
]

# 各作物共通の規格 (spec_type, grade_level, size_label)
GRADES = [
    ("選別済", "A", "L"),
    ("選別済", "A", "M"),
    ("選別済", "B", "L"),
    ("選別済", "B", "M"),
    ("選別済", "C", "M"),
    ("土付",   "-", "L"),   # 原料(未選別)
]

# 資材: 部門ごとに使う共通的な梱包資材 (suffix を部門で変える)
MATERIAL_TEMPLATES = [
    ("段ボール箱(10kg用)", "枚", "段ボール", 250, Decimal("120.00")),
    ("食品用ポリ袋(大)",   "枚", "包装",     800, Decimal("8.50")),
    ("商品ラベル",         "枚", "印刷",     1500, Decimal("3.20")),
    ("結束バンド",         "本", "包装",     500, Decimal("2.10")),
]

SUPPLIERS = ["みどり物産", "包装資材A社", "印刷C社", "物流D社", "東部農産"]

# 出荷商品テンプレ: (商品名suffix, unit)
SHIPPED_TEMPLATES = [
    ("パック500g", "個"),
    ("業務用10kg箱", "箱"),
    ("加工用ペースト", "個"),
]


def _ins(cur, sql: str, params: tuple):
    cur.execute(sql, params)
    return cur.fetchone()


# ---------------------------------------------------------------------------
# リセット（業務データを全消去。users/監査系は温存）
# ---------------------------------------------------------------------------
def reset_demo_data(cur) -> None:
    cur.execute(
        """
        TRUNCATE
          crops, grades, origins, counterparties, suppliers,
          products, inbound_lots, stock_counts, outbound_records, outbound_orders,
          selection_operations, selection_sources,
          semifinished_lots, semifinished_outbound_records, lot_reservations,
          materials, material_counts, material_movements,
          products_shipped, product_material_usage, shipment_records,
          substitution_rules, product_bom,
          factory_areas, storage_layouts, storage_objects, storage_walls,
          storage_object_items, storage_object_inventory_entries, storage_layout_sheet_meta,
          asset_types, asset_categories, asset_logos, asset_purchase_records,
          asset_movements, asset_stocktakes, asset_loans, area_stocktakes,
          calendar_cell_comments, correction_records
        RESTART IDENTITY CASCADE
        """
    )


def ensure_admin_user(cur) -> str:
    """created_by 用のシステムユーザーを確保（device_token は持たせない）。"""
    cur.execute("SELECT id FROM users WHERE display_name=%s", ("データ移行",))
    row = cur.fetchone()
    if row:
        return row["id"]
    row = _ins(
        cur,
        "INSERT INTO users (display_name, role, is_active) VALUES (%s,'admin',true) RETURNING id",
        ("データ移行",),
    )
    return row["id"]


# ---------------------------------------------------------------------------
# 1) マスタ + 在庫(入荷/棚卸/出庫) — 5作物
# ---------------------------------------------------------------------------
def seed_inventory(cur, actor) -> dict:
    # suppliers
    supplier_ids = {}
    for name in SUPPLIERS:
        r = _ins(cur, "INSERT INTO suppliers (name) VALUES (%s) RETURNING id", (name,))
        supplier_ids[name] = r["id"]
    main_supplier = supplier_ids["みどり物産"]

    # grades (全作物共通)
    grade_ids = {}
    for spec, gl, sz in GRADES:
        r = _ins(
            cur,
            "INSERT INTO grades (spec_type, grade_level, size_label) VALUES (%s,%s,%s) RETURNING id",
            (spec, gl, sz),
        )
        grade_ids[(spec, gl, sz)] = r["id"]

    crop_ids, origin_ids = {}, {}
    lots_by_crop: dict[int, list] = {}

    for code, name, div, origin_name, region in CROPS:
        crop = _ins(cur, "INSERT INTO crops (code, name) VALUES (%s,%s) RETURNING id", (code, name))
        crop_id = crop["id"]
        crop_ids[code] = crop_id

        origin = _ins(
            cur,
            "INSERT INTO origins (name, region) VALUES (%s,%s) RETURNING id",
            (origin_name, region),
        )
        origin_id = origin["id"]
        origin_ids[code] = origin_id

        # products (作物 × 各規格 × 産地)
        product_ids = {}
        for key, gid in grade_ids.items():
            p = _ins(
                cur,
                "INSERT INTO products (crop_id, grade_id, origin_id) VALUES (%s,%s,%s) RETURNING id",
                (crop_id, gid, origin_id),
            )
            product_ids[key] = p["id"]

        # 入荷ロット: 先々月(M2)と先月(M1)に各1本
        lots = []
        plan = [
            (("土付", "-", "L"), _day(M2, 10), Decimal("50"), Decimal("20"), Decimal("1500")),
            (("選別済", "A", "L"), _day(M1, 12), Decimal("40"), Decimal("20"), Decimal("3200")),
        ]
        for gkey, d, cases, kgpc, price in plan:
            cur.execute("SELECT next_lot_code(%s,'G') AS c", (code,))
            lot_code = cur.fetchone()["c"]
            total_kg = cases * kgpc
            lot = _ins(
                cur,
                """INSERT INTO inbound_lots
                     (code, product_id, supplier_id, inbound_date, cases, kg_per_case,
                      total_kg, unit_price, price_confirmed_at, price_confirmed_by,
                      note, created_by)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s, now(), %s, %s, %s)
                   RETURNING id, total_kg""",
                (lot_code, product_ids[gkey], main_supplier, d, cases, kgpc,
                 total_kg, price, actor, "サンプル入荷", actor),
            )
            lots.append({"id": lot["id"], "total_kg": total_kg, "date": d})

        # 先月末の棚卸(締め) → 当月への繰越の基準
        for lot in lots:
            counted = (lot["total_kg"] * Decimal("0.8")).quantize(Decimal("0.0001"))
            _ins(
                cur,
                """INSERT INTO stock_counts
                     (lot_id, period, count_date, counted_kg, theoretical_kg, source, note, confirmed_by)
                   VALUES (%s,%s,%s,%s,%s,'migration','先月末 棚卸(サンプル)',%s)
                   RETURNING id""",
                (lot["id"], _period(M1), M1_END, counted, lot["total_kg"], actor),
            )

        # 出庫: 先月(締め前)と今月。今月分が「当月の動き」、残りが繰越在庫として見える
        first_lot = lots[0]
        _ins(
            cur,
            """INSERT INTO outbound_records (lot_id, outbound_date, quantity_kg, note, created_by)
               VALUES (%s,%s,%s,'通常出庫(サンプル)',%s) RETURNING id""",
            (first_lot["id"], _day(M1, 20), Decimal("100"), actor),
        )
        _ins(
            cur,
            """INSERT INTO outbound_records (lot_id, outbound_date, quantity_kg, note, created_by)
               VALUES (%s,%s,%s,'当月出庫(サンプル)',%s) RETURNING id""",
            (first_lot["id"], M0_ACT, Decimal("60"), actor),
        )

        lots_by_crop[crop_id] = lots

    return {
        "crop_ids": crop_ids,
        "origin_ids": origin_ids,
        "grade_ids": grade_ids,
        "supplier_ids": supplier_ids,
        "lots_by_crop": lots_by_crop,
    }


# ---------------------------------------------------------------------------
# 2) 資材 (5部門)
# ---------------------------------------------------------------------------
def seed_materials(cur, actor, ctx) -> dict:
    sup = ctx["supplier_ids"]
    sup_cycle = ["包装資材A社", "包装資材A社", "印刷C社", "物流D社"]
    material_ids_by_div: dict[int, dict] = {}

    for _, _, div, _, _ in CROPS:
        mids = {}
        for i, (item, unit, cat, base_qty, price) in enumerate(MATERIAL_TEMPLATES):
            code = f"SZ{div:02d}{i+1:03d}"
            supplier_name = sup_cycle[i % len(sup_cycle)]
            r = _ins(
                cur,
                """INSERT INTO materials
                     (code, division, supplier_id, supplier_name, item_name, unit, category, unit_price)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                (code, div, sup[supplier_name], supplier_name, item, unit, cat, price),
            )
            mids[code] = r["id"]
            # 先月末 棚卸(繰越基準)
            _ins(
                cur,
                """INSERT INTO material_counts
                     (material_id, period, count_date, counted_qty, source, note, confirmed_by)
                   VALUES (%s,%s,%s,%s,'migration','先月末 棚卸(サンプル)',%s) RETURNING id""",
                (r["id"], _period(M1), M1_END, Decimal(base_qty), actor),
            )
            # 当月の入出庫
            _ins(
                cur,
                """INSERT INTO material_movements (material_id, movement_date, quantity, note, created_by)
                   VALUES (%s,%s,%s,'当月入荷(サンプル)',%s) RETURNING id""",
                (r["id"], M0_ACT, Decimal("100"), actor),
            )
            _ins(
                cur,
                """INSERT INTO material_movements (material_id, movement_date, quantity, note, created_by)
                   VALUES (%s,%s,%s,'当月出庫(サンプル)',%s) RETURNING id""",
                (r["id"], M0_ACT, Decimal("-30"), actor),
            )
        material_ids_by_div[div] = mids
    return material_ids_by_div


# ---------------------------------------------------------------------------
# 3) 出荷商品 + レシピ + 出荷記録 (5部門)
# ---------------------------------------------------------------------------
def seed_shipments(cur, actor, material_ids_by_div) -> None:
    for code, name, div, _, _ in CROPS:
        mids = material_ids_by_div[div]
        material_codes = list(mids.keys())
        pids = []
        for label, unit in SHIPPED_TEMPLATES:
            r = _ins(
                cur,
                "INSERT INTO products_shipped (division, name, unit) VALUES (%s,%s,%s) RETURNING id",
                (div, f"{name}{label}", unit),
            )
            pid = r["id"]
            pids.append(pid)
            # レシピ: 箱+ラベル+袋を消費
            for mcode, qty in (
                (material_codes[0], "1"),
                (material_codes[2], "1"),
                (material_codes[1], "1"),
            ):
                _ins(
                    cur,
                    """INSERT INTO product_material_usage
                         (product_id, material_id, quantity_per_unit, note)
                       VALUES (%s,%s,%s,'サンプルレシピ') RETURNING id""",
                    (pid, mids[mcode], Decimal(qty)),
                )
        # 出荷記録: 先月と今月
        ship_plan = [
            (_day(M1, 8), pids[0], Decimal("80")),
            (_day(M1, 18), pids[1], Decimal("5")),
            (M0_ACT, pids[0], Decimal("120")),
            (M0_ACT, pids[2], Decimal("40")),
        ]
        for d, pid, qty in ship_plan:
            _ins(
                cur,
                """INSERT INTO shipment_records (product_id, ship_date, quantity, note, created_by)
                   VALUES (%s,%s,%s,'サンプル出荷',%s) RETURNING id""",
                (pid, d, qty, actor),
            )


# ---------------------------------------------------------------------------
# 4) 振替ルール (大蒜)
# ---------------------------------------------------------------------------
def seed_substitution(cur, ctx) -> None:
    g = ctx["grade_ids"]
    crop_id = ctx["crop_ids"]["02"]
    origin_id = ctx["origin_ids"]["02"]
    rules = [
        (("選別済", "A", "L"), ("選別済", "A", "M"), 1, Decimal("0.9000")),
        (("選別済", "A", "L"), ("選別済", "B", "L"), 2, Decimal("0.8500")),
        (("選別済", "B", "M"), ("選別済", "C", "M"), 1, Decimal("0.8000")),
    ]
    for from_g, to_g, prio, yf in rules:
        _ins(
            cur,
            """INSERT INTO substitution_rules
                 (crop_id, origin_id, from_grade_id, priority, to_grade_id, yield_factor, note)
               VALUES (%s,%s,%s,%s,%s,%s,'サンプル振替ルール') RETURNING id""",
            (crop_id, origin_id, g[from_g], prio, g[to_g], yf),
        )


# ---------------------------------------------------------------------------
# 5) 選別 + 半製品 (大蒜)
# ---------------------------------------------------------------------------
def seed_selection_semifinished(cur, actor, ctx) -> None:
    crop_id = ctx["crop_ids"]["02"]
    g = ctx["grade_ids"]
    origin_id = ctx["origin_ids"]["02"]
    src_lot = ctx["lots_by_crop"][crop_id][0]  # 土付ロット

    cur.execute("SELECT next_selection_code() AS c")
    sel_code = cur.fetchone()["c"]
    sel = _ins(
        cur,
        """INSERT INTO selection_operations
             (code, crop_id, operation_date, source_lot_id, source_kg, source_unit_price, note, created_by)
           VALUES (%s,%s,%s,%s,%s,%s,'サンプル選別',%s) RETURNING id""",
        (sel_code, crop_id, _day(M1, 22), src_lot["id"], Decimal("200"), Decimal("1500"), actor),
    )
    sel_id = sel["id"]

    # 消費の出庫を選別に紐付け
    out = _ins(
        cur,
        """INSERT INTO outbound_records
             (lot_id, outbound_date, quantity_kg, note, created_by, selection_id, purpose, kind)
           VALUES (%s,%s,%s,'選別消費(サンプル)',%s,%s,'selection','selection_consume') RETURNING id""",
        (src_lot["id"], _day(M1, 22), Decimal("200"), actor, sel_id),
    )
    _ins(
        cur,
        """INSERT INTO selection_sources
             (selection_id, lot_id, source_kg, consume_kg, disposal_kg, consume_outbound_id)
           VALUES (%s,%s,%s,%s,%s,%s) RETURNING id""",
        (sel_id, src_lot["id"], Decimal("200"), Decimal("200"), Decimal("0"), out["id"]),
    )

    # 選別から半製品ロットを生成
    a_product = _ins(
        cur,
        """SELECT p.id FROM products p
           JOIN grades gr ON gr.id=p.grade_id
           WHERE p.crop_id=%s AND gr.spec_type='選別済' AND gr.grade_level='A' AND gr.size_label='L'
           LIMIT 1""",
        (crop_id,),
    )
    cur.execute("SELECT next_semifinished_code(%s) AS c", ("02",))
    sf_code = cur.fetchone()["c"]
    _ins(
        cur,
        """INSERT INTO semifinished_lots
             (code, product_id, inbound_date, cases, kg_per_case, total_kg,
              unit_price, note, created_by, status, selection_id)
           VALUES (%s,%s,%s,%s,%s,%s,%s,'サンプル半製品',%s,'sorting',%s) RETURNING id""",
        (sf_code, a_product["id"], _day(M1, 23), Decimal("8"), Decimal("20"),
         Decimal("160"), Decimal("1800"), actor, sel_id),
    )


# ---------------------------------------------------------------------------
# 6) 資産管理
# ---------------------------------------------------------------------------
def seed_assets(cur, actor) -> None:
    at = _ins(cur, "INSERT INTO asset_types (code, name) VALUES ('PLT','パレット') RETURNING id", ())
    at_id = at["id"]
    logos = {}
    for nm in ("自社ロゴ", "共用"):
        r = _ins(cur, "INSERT INTO asset_logos (asset_type_id, name) VALUES (%s,%s) RETURNING id", (at_id, nm))
        logos[nm] = r["id"]
    cats = {}
    for nm, is_def in (("木製", True), ("樹脂", False)):
        r = _ins(
            cur,
            "INSERT INTO asset_categories (asset_type_id, name, is_default) VALUES (%s,%s,%s) RETURNING id",
            (at_id, nm, is_def),
        )
        cats[nm] = r["id"]

    # 購入記録 + 入庫 movement
    _ins(
        cur,
        """INSERT INTO asset_purchase_records
             (asset_type_id, logo_id, category_id, purchase_date, qty, unit_price, total_amount,
              supplier_name, created_by)
           VALUES (%s,%s,%s,%s,%s,%s,%s,'物流D社',%s) RETURNING id""",
        (at_id, logos["自社ロゴ"], cats["木製"], _day(M2, 15), 100,
         Decimal("1800.00"), Decimal("180000.00"), actor),
    )
    _ins(
        cur,
        """INSERT INTO asset_movements
             (asset_type_id, logo_id, category_id, movement_date, kind, qty, note, created_by)
           VALUES (%s,%s,%s,%s,'in',%s,'購入入庫(サンプル)',%s) RETURNING id""",
        (at_id, logos["自社ロゴ"], cats["木製"], _day(M2, 15), 100, actor),
    )
    # 棚卸
    _ins(
        cur,
        """INSERT INTO asset_stocktakes
             (asset_type_id, logo_id, category_id, count_date, counted_qty, theoretical_qty, created_by)
           VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
        (at_id, logos["自社ロゴ"], cats["木製"], M1_END, 96, 100, actor),
    )


# ---------------------------------------------------------------------------
# 7) 倉庫レイアウト
# ---------------------------------------------------------------------------
def seed_storage(cur, actor, ctx) -> None:
    _ins(
        cur,
        "INSERT INTO factory_areas (name, color, sort_order) VALUES ('第1倉庫','#60a5fa',1) RETURNING id",
        (),
    )
    layout = _ins(
        cur,
        """INSERT INTO storage_layouts (name, division, target_kind, default_link_kind, created_by)
           VALUES ('第1倉庫 レイアウト',2,'ingredient','ingredient',%s) RETURNING id""",
        (actor,),
    )
    layout_id = layout["id"]

    # 外周の壁(矩形)
    walls = [(20, 20, 520, 20), (520, 20, 520, 380), (520, 380, 20, 380), (20, 380, 20, 20)]
    for x1, y1, x2, y2 in walls:
        _ins(
            cur,
            """INSERT INTO storage_walls (layout_id, x1, y1, x2, y2) VALUES (%s,%s,%s,%s,%s) RETURNING id""",
            (layout_id, x1, y1, x2, y2),
        )

    # パレットを数個配置し、一部に大蒜ロットを紐付け
    garlic_lots = ctx["lots_by_crop"][ctx["crop_ids"]["02"]]
    positions = [(60, 60), (160, 60), (260, 60), (60, 160), (160, 160)]
    for i, (x, y) in enumerate(positions):
        obj = _ins(
            cur,
            """INSERT INTO storage_objects (layout_id, label, x, y) VALUES (%s,%s,%s,%s) RETURNING id""",
            (layout_id, f"P{i+1}", x, y),
        )
        if i < len(garlic_lots):
            _ins(
                cur,
                """INSERT INTO storage_object_items (object_id, inbound_lot_id, note)
                   VALUES (%s,%s,'サンプル配置') RETURNING id""",
                (obj["id"], garlic_lots[i]["id"]),
            )


# ---------------------------------------------------------------------------
def main() -> None:
    load_dotenv()
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise SystemExit(
            "DATABASE_URL が未設定です。.env.example をコピーして .env を作成してください。"
        )

    print("=" * 60)
    print("デモ用 包括的 合成サンプルデータ 投入")
    print(f"  基準日(TODAY)={TODAY}  今月={_period(M0)} 先月={_period(M1)} 先々月={_period(M2)}")
    print("=" * 60)

    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        with conn.transaction():
            cur = conn.cursor()
            actor = ensure_admin_user(cur)
            reset_demo_data(cur)
            actor = ensure_admin_user(cur)  # TRUNCATE は users を含まないが順序安全のため再取得
            ctx = seed_inventory(cur, actor)
            print(f"  在庫: {len(CROPS)}作物 × 規格{len(GRADES)} + 入荷/棚卸/出庫")
            mids = seed_materials(cur, actor, ctx)
            print(f"  資材: {len(CROPS)}部門 × {len(MATERIAL_TEMPLATES)}品目")
            seed_shipments(cur, actor, mids)
            print(f"  出荷: {len(CROPS)}部門 × {len(SHIPPED_TEMPLATES)}商品 + レシピ + 出荷記録")
            seed_substitution(cur, ctx)
            seed_selection_semifinished(cur, actor, ctx)
            print("  振替ルール / 選別 / 半製品(大蒜)")
            seed_assets(cur, actor)
            print("  資産管理(パレット)")
            seed_storage(cur, actor, ctx)
            print("  倉庫レイアウト(第1倉庫)")

    print("\n" + "=" * 60)
    print("包括デモデータ投入 完了")
    print("  最初にフロントでデバイス登録すると自動承認されます (DEMO_MODE)。")
    print("=" * 60)


if __name__ == "__main__":
    main()
