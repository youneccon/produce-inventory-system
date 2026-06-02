"""
api/services/substitution.py
=============================
振替ロジック付き 出庫サービス。

Excel 「0520大蒜出庫数計算レポート機能付き.xlsm」 の VBA MainLogic を Python 移植:
  ・(crop, origin, from_grade) ごと の 振替ルール を 優先順位 1→2→3 で 順番に評価
  ・各 priority で 該当 to_grade の 在庫 lot を FIFO で 消化
  ・必要 raw kg = 残 product kg / yield (端数 切上、 割り切れる時 切捨)
  ・lot ごと に outbound_records を INSERT (order_id, priority_used,
    yield_applied, product_qty_covered をセット)
  ・全 priority 回って 残 > 0 なら InsufficientSubstitutionStockError

注意:
  ・lot は inbound_lots の archived_at IS NULL かつ FIFO 順
  ・在庫量 は fifo_eligible_lots ビュー の remaining_kg を 参照 (= 既存
    allocation.py と 同じ ソース)
  ・トランザクション ロック は SELECT FOR UPDATE OF inbound_lots
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import psycopg

logger = logging.getLogger(__name__)


# =============================================================================
# 例外
# =============================================================================
class SubstitutionError(Exception):
    """振替処理の基底例外。"""


class NoSubstitutionRulesError(SubstitutionError):
    """対応する 振替ルール が 1 件も無い (= マスタ未設定)。"""
    def __init__(self, crop_id: int, origin_id: int, from_grade_id: int) -> None:
        self.crop_id = crop_id
        self.origin_id = origin_id
        self.from_grade_id = from_grade_id
        super().__init__(
            f"振替ルール 未設定: crop={crop_id} origin={origin_id} from_grade={from_grade_id}"
        )


class InsufficientSubstitutionStockError(SubstitutionError):
    """
    全 priority を 回っても 在庫不足 で 残量 > 0。
    UI は どの priority まで 試した か / どの lot で 不足したか を表示。
    """
    def __init__(
        self,
        crop_id: int,
        origin_id: int,
        from_grade_id: int,
        requested_kg: Decimal,
        covered_kg: Decimal,
        attempted_priorities: list[int],
    ) -> None:
        self.crop_id = crop_id
        self.origin_id = origin_id
        self.from_grade_id = from_grade_id
        self.requested_kg = requested_kg
        self.covered_kg = covered_kg
        self.remaining_kg = requested_kg - covered_kg
        self.attempted_priorities = attempted_priorities
        super().__init__(
            f"振替在庫不足: 要求={requested_kg}kg 充足={covered_kg}kg "
            f"残={requested_kg - covered_kg}kg 試行P={attempted_priorities}"
        )


# =============================================================================
# データ クラス
# =============================================================================
@dataclass(frozen=True)
class SubstitutionRule:
    priority: int            # 1=A, 2=B, 3=C
    to_grade_id: int
    yield_factor: Decimal    # 0 < yield <= 1


@dataclass(frozen=True)
class EligibleLot:
    lot_id: int
    lot_code: str
    product_id: int
    inbound_date: date
    remaining_kg: Decimal
    unit_price: Decimal | None
    fifo_rank: int


@dataclass
class ConsumptionLine:
    """1 lot から の 消化 結果 (= 1 outbound_records 行)"""
    lot_id: int
    lot_code: str
    priority_used: int
    to_grade_id: int
    yield_applied: Decimal
    raw_qty_kg: Decimal               # lot から 引いた kg
    product_qty_covered_kg: Decimal   # = raw_qty_kg × yield (商品換算)
    outbound_record_id: int | None = None   # execute() の あと に セット


@dataclass
class SubstitutionResult:
    order_id: int | None              # preview = None / execute = order PK
    crop_id: int
    origin_id: int
    from_grade_id: int
    outbound_date: date
    requested_product_kg: Decimal
    covered_product_kg: Decimal       # sum of lines' product_qty_covered_kg
    lines: list[ConsumptionLine] = field(default_factory=list)

    @property
    def is_complete(self) -> bool:
        return self.covered_product_kg >= self.requested_product_kg


# =============================================================================
# サービス
# =============================================================================
def _calc_raw_needed(remaining_product_kg: Decimal, yield_factor: Decimal) -> Decimal:
    """
    必要 raw kg = remaining_product / yield。
    端数処理: 割り切れる時は そのまま、 そうでなければ 切上 (= VBA の -Int(-raw) 相当)。

    例: remaining=100, yield=0.95 → raw=105.2631...→ 105.263... → 切上 → 105.27 (精度に依る)
        remaining=95,  yield=0.95 → raw=100.000... → そのまま 100
    """
    if yield_factor <= 0:
        raise ValueError(f"yield_factor must be > 0, got {yield_factor}")
    raw = remaining_product_kg / yield_factor
    # 0.001 kg 単位 で 計算。 割り切れる場合 (= 商品換算 で 元の値に戻る) は 切捨、
    # そうでなければ 切上。
    floor_kg = raw.quantize(Decimal('0.001'), rounding=ROUND_FLOOR)
    if floor_kg * yield_factor == remaining_product_kg:
        return floor_kg
    return raw.quantize(Decimal('0.001'), rounding=ROUND_CEILING)


class SubstitutionService:
    """振替ロジック付き 出庫サービス。"""

    def __init__(self, conn: "psycopg.AsyncConnection") -> None:
        self._conn = conn

    # ------------------------------------------------------------------
    # 公開 API
    # ------------------------------------------------------------------
    async def preview(
        self,
        *,
        crop_id: int,
        origin_id: int,
        from_grade_id: int,
        outbound_date: date,
        product_qty_kg: Decimal,
    ) -> SubstitutionResult:
        """
        振替計算 を 行うが DB 書込みはしない。 UI のプレビュー表示用。
        """
        rules = await self._fetch_rules(crop_id, origin_id, from_grade_id)
        if not rules:
            raise NoSubstitutionRulesError(crop_id, origin_id, from_grade_id)
        return await self._compute(
            rules=rules,
            crop_id=crop_id,
            origin_id=origin_id,
            from_grade_id=from_grade_id,
            outbound_date=outbound_date,
            product_qty_kg=product_qty_kg,
            lock_lots=False,
            allow_partial=False,
        )

    async def execute(
        self,
        *,
        crop_id: int,
        origin_id: int,
        from_grade_id: int,
        outbound_date: date,
        product_qty_kg: Decimal,
        note: str | None,
        actor_id: str,
    ) -> SubstitutionResult:
        """
        振替計算 を 行い、 outbound_orders + outbound_records を 作成 する。
        在庫不足 の 場合 InsufficientSubstitutionStockError を raise (transaction
        は ロールバックされ DB は 変更されない)。
        """
        rules = await self._fetch_rules(crop_id, origin_id, from_grade_id)
        if not rules:
            raise NoSubstitutionRulesError(crop_id, origin_id, from_grade_id)

        result = await self._compute(
            rules=rules,
            crop_id=crop_id,
            origin_id=origin_id,
            from_grade_id=from_grade_id,
            outbound_date=outbound_date,
            product_qty_kg=product_qty_kg,
            lock_lots=True,
            allow_partial=False,
        )

        # outbound_order + outbound_records 作成
        cur = await self._conn.execute("""
            INSERT INTO outbound_orders
                (crop_id, outbound_date, origin_id, from_grade_id, product_qty_kg, note, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s::UUID)
            RETURNING id
        """, (crop_id, outbound_date, origin_id, from_grade_id, product_qty_kg, note, actor_id))
        row = await cur.fetchone()
        result.order_id = row["id"]

        for line in result.lines:
            cur = await self._conn.execute("""
                INSERT INTO outbound_records
                    (lot_id, outbound_date, quantity_kg, note, created_by,
                     order_id, priority_used, yield_applied, product_qty_covered)
                VALUES (%s, %s, %s, %s, %s::UUID, %s, %s, %s, %s)
                RETURNING id
            """, (
                line.lot_id, outbound_date, line.raw_qty_kg,
                note, actor_id,
                result.order_id, line.priority_used, line.yield_applied, line.product_qty_covered_kg,
            ))
            r = await cur.fetchone()
            line.outbound_record_id = r["id"]

        return result

    # ------------------------------------------------------------------
    # 内部
    # ------------------------------------------------------------------
    async def _fetch_rules(
        self, crop_id: int, origin_id: int, from_grade_id: int,
    ) -> list[SubstitutionRule]:
        cur = await self._conn.execute("""
            SELECT priority, to_grade_id, yield_factor
            FROM substitution_rules
            WHERE crop_id = %s
              AND origin_id = %s
              AND from_grade_id = %s
              AND is_active = true
            ORDER BY priority
        """, (crop_id, origin_id, from_grade_id))
        rows = await cur.fetchall()
        return [
            SubstitutionRule(
                priority=r["priority"],
                to_grade_id=r["to_grade_id"],
                yield_factor=Decimal(r["yield_factor"]),
            )
            for r in rows
        ]

    async def _fetch_eligible_lots(
        self,
        crop_id: int,
        origin_id: int,
        to_grade_id: int,
        outbound_date: date,
        lock: bool,
    ) -> list[EligibleLot]:
        """
        (origin, grade) が マッチ する 出庫可能 lot を FIFO 順で 取得。
        lock=True で SELECT FOR UPDATE OF inbound_lots。

        在庫量 は fifo_eligible_lots ビュー の remaining_kg を 使う。
        ただし fifo_eligible_lots は outbound_date を 考慮しない (= 「いま現在 の
        残量」)。 振替ロジック で outbound_date 過去日 を 扱う際は 厳密には
        time-travel が 必要だが、 当面 「最新時点 の 残量」 で OK と する。
        """
        for_update = "FOR UPDATE OF il" if lock else ""
        cur = await self._conn.execute(f"""
            SELECT
                fel.lot_id,
                il.code AS lot_code,
                fel.product_id,
                fel.inbound_date,
                fel.remaining_kg,
                fel.unit_price,
                fel.fifo_rank
            FROM fifo_eligible_lots fel
            JOIN inbound_lots il ON il.id = fel.lot_id
            JOIN products     p  ON p.id  = fel.product_id
            WHERE p.crop_id     = %(crop_id)s
              AND p.origin_id   = %(origin_id)s
              AND p.grade_id    = %(to_grade_id)s
              AND fel.remaining_kg > 0
            ORDER BY fel.fifo_rank
            {for_update}
        """, {
            "crop_id":     crop_id,
            "origin_id":   origin_id,
            "to_grade_id": to_grade_id,
        })
        rows = await cur.fetchall()
        return [
            EligibleLot(
                lot_id       = r["lot_id"],
                lot_code     = r["lot_code"],
                product_id   = r["product_id"],
                inbound_date = r["inbound_date"],
                remaining_kg = Decimal(r["remaining_kg"]),
                unit_price   = r["unit_price"],
                fifo_rank    = r["fifo_rank"],
            )
            for r in rows
        ]

    async def _compute(
        self,
        *,
        rules: list[SubstitutionRule],
        crop_id: int,
        origin_id: int,
        from_grade_id: int,
        outbound_date: date,
        product_qty_kg: Decimal,
        lock_lots: bool,
        allow_partial: bool,
    ) -> SubstitutionResult:
        result = SubstitutionResult(
            order_id=None,
            crop_id=crop_id,
            origin_id=origin_id,
            from_grade_id=from_grade_id,
            outbound_date=outbound_date,
            requested_product_kg=product_qty_kg,
            covered_product_kg=Decimal(0),
        )

        remaining = Decimal(product_qty_kg)
        attempted: list[int] = []
        # 同じ to_grade を 複数 priority で 参照 する 場合 (Excel 設定の よくあるパターン)
        # は すでに 消化済み の lot を 二度 引かない よう に lot_id を 記録。
        consumed_in_lot: dict[int, Decimal] = {}

        for rule in rules:
            if remaining <= 0:
                break
            attempted.append(rule.priority)

            lots = await self._fetch_eligible_lots(
                crop_id=crop_id,
                origin_id=origin_id,
                to_grade_id=rule.to_grade_id,
                outbound_date=outbound_date,
                lock=lock_lots,
            )
            for lot in lots:
                if remaining <= 0:
                    break
                # この priority で すでに 同じ lot を 消化したなら 残りを 引く
                already = consumed_in_lot.get(lot.lot_id, Decimal(0))
                available = lot.remaining_kg - already
                if available <= 0:
                    continue

                raw_needed = _calc_raw_needed(remaining, rule.yield_factor)
                consume = min(available, raw_needed)
                if consume <= 0:
                    continue
                product_covered = (consume * rule.yield_factor).quantize(Decimal('0.001'), rounding=ROUND_FLOOR)
                # product_covered が remaining を 上回らない よう に
                if product_covered > remaining:
                    product_covered = remaining

                result.lines.append(ConsumptionLine(
                    lot_id=lot.lot_id,
                    lot_code=lot.lot_code,
                    priority_used=rule.priority,
                    to_grade_id=rule.to_grade_id,
                    yield_applied=rule.yield_factor,
                    raw_qty_kg=consume,
                    product_qty_covered_kg=product_covered,
                ))
                consumed_in_lot[lot.lot_id] = already + consume
                remaining -= product_covered
                result.covered_product_kg += product_covered

        if remaining > 0 and not allow_partial:
            raise InsufficientSubstitutionStockError(
                crop_id=crop_id,
                origin_id=origin_id,
                from_grade_id=from_grade_id,
                requested_kg=product_qty_kg,
                covered_kg=result.covered_product_kg,
                attempted_priorities=attempted,
            )

        return result
