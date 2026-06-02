"""
api/services/allocation.py
==========================
出庫FIFO引き当てサービス。

VBAの以下の関数を完全移植・改良:
  Process_Unregistered_Allocation()  → AllocationService.allocate()
  Execute_Allocation()               → AllocationService._execute_lot()
  Select_Stock_Row()                 → AllocationService._select_lot()
  Seek_Eligible_Stock()              → AllocationService._seek_eligible()
  IsStockSufficient()                → AllocationService._assert_sufficient()
  Backfill_OutboundAttributes()      → AllocationService._backfill()（DB外部キーで自動化）
  Build_StockCache()                 → lot_stock VIEW（DBが常に最新値を保証）

VBAからの主要改善点:
  - 在庫キャッシュが処理中に陳腐化する問題 → SELECT FOR UPDATE で行ロックし
    トランザクション内で常に最新値を参照
  - 行分割後の属性引き継ぎバグ → 新行には lot_id のみ書き込み、属性はFKで補完
  - 整理番号がセル値でレース条件あり → BIGSERIAL で原子的に採番
  - ERR_STOCK_INSUFFICIENT のハードコード → 型付き例外クラスで明示
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import psycopg

logger = logging.getLogger(__name__)


# =============================================================================
# 例外定義
# VBAの Err.Raise M99_Utils.ERR_STOCK_INSUFFICIENT を型付き例外に置き換える
# =============================================================================

class AllocationError(Exception):
    """引き当て処理の基底例外。"""


class StockInsufficientError(AllocationError):
    """
    在庫不足エラー。VBAの ERR_STOCK_INSUFFICIENT = 9999 に相当。
    必要数量・利用可能数量・候補ロット情報を保持する。
    """
    def __init__(
        self,
        product_id:     int,
        required_kg:    Decimal,
        available_kg:   Decimal,
        candidates:     list["EligibleLot"],
    ) -> None:
        self.product_id   = product_id
        self.required_kg  = required_kg
        self.available_kg = available_kg
        self.candidates   = candidates
        super().__init__(
            f"在庫不足: product_id={product_id} "
            f"必要={required_kg}kg 利用可能={available_kg}kg "
            f"候補ロット数={len(candidates)}"
        )


class LotNotFoundError(AllocationError):
    """指定されたロットが存在しないか、既に出庫済み。"""


class AmbiguousLotError(AllocationError):
    """
    複数ロットが候補として存在し、自動選択できない。
    フロントエンドが候補リストをユーザーに提示して選択させる必要がある。
    VBAの UI_SelectStock_Form 表示トリガーに相当。
    """
    def __init__(self, candidates: list["EligibleLot"]) -> None:
        self.candidates = candidates
        super().__init__(f"複数候補が存在します（{len(candidates)}件）。ロットを指定してください。")


# =============================================================================
# データクラス
# =============================================================================

@dataclass(frozen=True)
class EligibleLot:
    """
    FIFO引き当て候補ロット。
    VBAのSeek_Eligible_Stockが返すCollection要素に相当。
    """
    lot_id:       int
    lot_code:     str                # 表示用整理番号 (例: '01G00001')
    product_id:   int
    supplier_id:  int
    inbound_date: date
    remaining_kg: Decimal
    fifo_rank:    int
    unit_price:   Decimal | None
    spec_type:    str
    grade_level:  str
    size_label:   str
    origin_name:  str
    supplier_name: str


@dataclass
class AllocationLine:
    """
    1ロットへの引き当て結果。
    VBAのExecute_Allocationが1ループで確定する「行」に相当。
    splitOccurred=Trueのとき、このラインが分割元になる。
    """
    outbound_record_id: int
    lot_id:             int
    quantity_kg:        Decimal
    is_split:           bool = False    # このラインで在庫が枯渇したか（行分割相当）
    inbound_date:       date | None = None
    supplier_name:      str | None = None
    spec_type:          str | None = None
    grade_level:        str | None = None
    size_label:         str | None = None
    origin_name:        str | None = None
    lot_code:           str | None = None    # 表示用整理番号 (UI で「整理番号」として表示)


@dataclass
class AllocationResult:
    """
    allocate() の返り値。複数ロットにまたがった場合は lines が複数になる。
    VBAのProcess_Unregistered_Allocationの1出庫行処理完了に相当。
    """
    product_id:    int
    outbound_date: date
    total_kg:      Decimal
    lines:         list[AllocationLine] = field(default_factory=list)

    @property
    def is_split(self) -> bool:
        """複数ロットにまたがった引き当てか（VBAのsplitOccurred相当）。"""
        return len(self.lines) > 1

    @property
    def lot_ids(self) -> list[int]:
        return [l.lot_id for l in self.lines]


# =============================================================================
# AllocationService
# =============================================================================

class AllocationService:
    """
    出庫FIFO引き当てサービス。

    使い方:
        async with pool.acquire() as conn:
            svc = AllocationService(conn)
            result = await svc.allocate(
                product_id=1,
                outbound_date=date(2026, 5, 14),
                quantity_kg=Decimal("150.0"),
                actor_id=user_id,
            )
    """

    def __init__(self, conn: psycopg.AsyncConnection) -> None:
        self._conn = conn

    # -------------------------------------------------------------------------
    # Public API
    # -------------------------------------------------------------------------

    async def allocate(
        self,
        product_id:    int,
        outbound_date: date,
        quantity_kg:   Decimal,
        actor_id:      str,
        note:          str | None = None,
        # オプション: ロットを明示指定した場合は自動FIFO選択をスキップ
        preferred_lot_id: int | None = None,
        # オプション: 順序付き 複数ロット明示指定 (preferred → fallback1 → fallback2 ...)。
        # 不足分は この リスト の 順番で 補う。 リスト 末尾 の ロット で も 足り なければ
        # それ 以降 の 候補 は FIFO で 補う。 preferred_lot_id と 排他 (両方 指定 NG)。
        preferred_lot_ids: list[int] | None = None,
        # オプション: 仕入先・入荷日・ケース重量で絞り込む（VBAのSeek_Eligible_Stockのフィルタに相当）
        filter_supplier_id:  int | None = None,
        filter_inbound_date: date | None = None,
        filter_kg_per_case:  Decimal | None = None,
    ) -> AllocationResult:
        """
        FIFOで在庫を引き当て、outbound_records に INSERT する。

        在庫が複数ロットにまたがる場合（VBAの行分割相当）は
        ロット数分の AllocationLine を返す。

        候補が複数でかつ preferred_lot_id / preferred_lot_ids が未指定の場合は
        AmbiguousLotError を送出 → 呼び出し元（API層）がユーザーに選択させる。
        """
        if preferred_lot_id is not None and preferred_lot_ids is not None:
            raise ValueError(
                "preferred_lot_id と preferred_lot_ids は同時に指定できません",
            )
        # 単一指定を リスト形式 に 正規化 (内部処理 を 1 系統 に)
        explicit_lot_order: list[int] | None = preferred_lot_ids
        if preferred_lot_id is not None:
            explicit_lot_order = [preferred_lot_id]
        async with self._conn.transaction():
            # -----------------------------------------------------------------
            # Step 1: FIFO候補ロットを取得（SELECT FOR UPDATE で行ロック）
            # VBAのSeek_Eligible_Stock() + Build_StockCache() に相当。
            # ロックによりVBAの「キャッシュ陳腐化バグ」を構造的に解決。
            # -----------------------------------------------------------------
            candidates = await self._seek_eligible(
                product_id          = product_id,
                filter_supplier_id  = filter_supplier_id,
                filter_inbound_date = filter_inbound_date,
                filter_kg_per_case  = filter_kg_per_case,
            )

            logger.info(
                "allocation.seek: product_id=%d quantity=%.4f candidates=%d",
                product_id, quantity_kg, len(candidates),
            )

            # -----------------------------------------------------------------
            # Step 2: 在庫充足確認
            # VBAのIsStockSufficient() + ERR_STOCK_INSUFFICIENT に相当。
            # -----------------------------------------------------------------
            total_available = sum(c.remaining_kg for c in candidates)
            if total_available < quantity_kg:
                raise StockInsufficientError(
                    product_id   = product_id,
                    required_kg  = quantity_kg,
                    available_kg = total_available,
                    candidates   = candidates,
                )

            # -----------------------------------------------------------------
            # Step 3: 候補が複数のとき、引き当てロットを決定
            # VBAのSelect_Stock_Row() に相当。
            # explicit_lot_order が指定 → その順番で消費 (= preferred + fallback...)、
            #                              足り なければ 残り は FIFO
            # 候補1件                   → 自動選択
            # 複数で未指定              → AmbiguousLotError
            # -----------------------------------------------------------------
            if explicit_lot_order is not None and explicit_lot_order:
                # 重複除去 (同じ lot_id を 2 回書いても安全に)
                seen: set[int] = set()
                order_unique: list[int] = []
                for lid in explicit_lot_order:
                    if lid not in seen:
                        seen.add(lid)
                        order_unique.append(lid)
                # 指定された各ロットが候補に存在するかチェック (どれか 1 つでも 無ければ エラー)
                cand_by_id = {c.lot_id: c for c in candidates}
                missing = [lid for lid in order_unique if lid not in cand_by_id]
                if missing:
                    raise LotNotFoundError(
                        f"指定ロット {missing} は候補に存在しません"
                    )
                # 指定順 で 先頭に置き、 残り は FIFO で 末尾 (= 自動 fallback)
                ordered = [cand_by_id[lid] for lid in order_unique]
                ordered += [c for c in candidates if c.lot_id not in seen]
            else:
                ordered = self._select_lots(candidates, quantity_kg)

            # -----------------------------------------------------------------
            # Step 4: FIFO順にロットへ引き当て
            # VBAのExecute_Allocation() の行分割ロジックに相当。
            # -----------------------------------------------------------------
            result = AllocationResult(
                product_id    = product_id,
                outbound_date = outbound_date,
                total_kg      = quantity_kg,
            )

            remaining_to_allocate = quantity_kg
            for lot in ordered:
                if remaining_to_allocate <= 0:
                    break

                take_kg = min(lot.remaining_kg, remaining_to_allocate)
                is_split = take_kg < remaining_to_allocate  # このロットで在庫が枯渇

                record_id = await self._execute_lot(
                    lot           = lot,
                    outbound_date = outbound_date,
                    quantity_kg   = take_kg,
                    actor_id      = actor_id,
                    note          = note,
                )

                line = AllocationLine(
                    outbound_record_id = record_id,
                    lot_id             = lot.lot_id,
                    quantity_kg        = take_kg,
                    is_split           = is_split,
                    inbound_date       = lot.inbound_date,
                    supplier_name      = lot.supplier_name,
                    spec_type          = lot.spec_type,
                    grade_level        = lot.grade_level,
                    size_label         = lot.size_label,
                    origin_name        = lot.origin_name,
                    lot_code           = lot.lot_code,
                )
                result.lines.append(line)
                remaining_to_allocate -= take_kg

                logger.info(
                    "allocation.line: lot_id=%d take=%.4fkg split=%s record_id=%d",
                    lot.lot_id, take_kg, is_split, record_id,
                )

            logger.info(
                "allocation.done: product_id=%d lines=%d is_split=%s",
                product_id, len(result.lines), result.is_split,
            )
            return result

    async def preview(
        self,
        product_id:          int,
        quantity_kg:         Decimal,
        filter_supplier_id:  int | None = None,
        filter_inbound_date: date | None = None,
        filter_kg_per_case:  Decimal | None = None,
    ) -> dict:
        """
        引き当てをコミットせずに候補とシミュレーション結果を返す。
        フロントエンドの「プレビュー表示」用。トランザクションなし。
        """
        candidates = await self._seek_eligible(
            product_id          = product_id,
            filter_supplier_id  = filter_supplier_id,
            filter_inbound_date = filter_inbound_date,
            filter_kg_per_case  = filter_kg_per_case,
        )

        total_available = sum(c.remaining_kg for c in candidates)
        is_sufficient   = total_available >= quantity_kg
        auto_selectable = len(candidates) == 1

        # シミュレーション: 何ロットで充足するか
        sim_lines = []
        remaining = quantity_kg
        for lot in candidates:
            if remaining <= 0:
                break
            take = min(lot.remaining_kg, remaining)
            sim_lines.append({
                "lot_id":        lot.lot_id,
                "lot_code":      lot.lot_code,
                "inbound_date":  lot.inbound_date.isoformat(),
                "supplier_name": lot.supplier_name,
                "spec_type":     lot.spec_type,
                "grade_level":   lot.grade_level,
                "size_label":    lot.size_label,
                "origin_name":   lot.origin_name,
                "remaining_kg":  float(lot.remaining_kg),
                "take_kg":       float(take),
                "is_split":      take < remaining,
                "unit_price":    float(lot.unit_price) if lot.unit_price else None,
                "fifo_rank":     lot.fifo_rank,
            })
            remaining -= take

        return {
            "product_id":      product_id,
            "required_kg":     float(quantity_kg),
            "available_kg":    float(total_available),
            "is_sufficient":   is_sufficient,
            "auto_select":     auto_selectable,
            "candidate_count": len(candidates),
            "sim_lines":       sim_lines,
            "needs_user_select": not auto_selectable and is_sufficient,
        }

    # -------------------------------------------------------------------------
    # Private helpers
    # -------------------------------------------------------------------------

    async def _seek_eligible(
        self,
        product_id:          int,
        filter_supplier_id:  int | None,
        filter_inbound_date: date | None,
        filter_kg_per_case:  Decimal | None = None,
    ) -> list[EligibleLot]:
        """
        引き当て候補ロットをFIFO順で取得し、行ロックする。
        VBAのSeek_Eligible_Stock() に相当。
        SELECT FOR UPDATE により、並行リクエストによる二重引き当てを防ぐ。
        """
        cur = await self._conn.execute("""
            SELECT
                fel.lot_id,
                il.code AS lot_code,
                fel.product_id,
                fel.supplier_id,
                fel.inbound_date,
                fel.remaining_kg,
                fel.fifo_rank,
                fel.unit_price,
                g.spec_type,
                g.grade_level,
                g.size_label,
                o.name  AS origin_name,
                s.name  AS supplier_name
            FROM fifo_eligible_lots fel
            JOIN inbound_lots il ON il.id = fel.lot_id
            JOIN products     p  ON p.id  = fel.product_id
            JOIN grades       g  ON g.id  = p.grade_id
            JOIN origins      o  ON o.id  = p.origin_id
            JOIN suppliers    s  ON s.id  = fel.supplier_id
            WHERE fel.product_id = %(product_id)s
              AND (%(supplier_id)s::INTEGER IS NULL OR fel.supplier_id  = %(supplier_id)s)
              AND (%(inbound_date)s::DATE  IS NULL OR fel.inbound_date = %(inbound_date)s)
              AND (%(kg_per_case)s::NUMERIC IS NULL OR il.kg_per_case = %(kg_per_case)s)
            ORDER BY fel.fifo_rank
            FOR UPDATE OF il
        """, {
            "product_id":   product_id,
            "supplier_id":  filter_supplier_id,
            "inbound_date": filter_inbound_date,
            "kg_per_case":  filter_kg_per_case,
        })
        rows = await cur.fetchall()

        return [
            EligibleLot(
                lot_id        = r["lot_id"],
                lot_code      = r["lot_code"],
                product_id    = r["product_id"],
                supplier_id   = r["supplier_id"],
                inbound_date  = r["inbound_date"],
                remaining_kg  = r["remaining_kg"],
                fifo_rank     = r["fifo_rank"],
                unit_price    = r["unit_price"],
                spec_type     = r["spec_type"],
                grade_level   = r["grade_level"],
                size_label    = r["size_label"],
                origin_name   = r["origin_name"],
                supplier_name = r["supplier_name"],
            )
            for r in rows
        ]

    def _select_lots(
        self,
        candidates: list[EligibleLot],
        quantity_kg: Decimal,
    ) -> list[EligibleLot]:
        """
        自動選択ロジック (2026-05 仕様変更):
          - 1件のみ → 自動選択
          - 複数 → AmbiguousLotError (= ユーザーに選ばせる)

        以前は 「FIFO先頭で充足できるなら自動選択」 だったが、
        ユーザー要望で 「複数候補がある時は常に選ばせる」 に変更。
        理由: 仕入先/入荷日 等の細かい違いで意図したロットと違う引き当てが
        起きやすいため、 安全のため 明示選択を求める。
        """
        if len(candidates) == 1:
            return candidates
        # 複数候補: ユーザー選択を求める
        raise AmbiguousLotError(candidates)

    async def _execute_lot(
        self,
        lot:          EligibleLot,
        outbound_date: date,
        quantity_kg:  Decimal,
        actor_id:     str,
        note:         str | None,
    ) -> int:
        """
        1ロットへの出庫レコードをINSERTする。
        VBAのExecute_Allocation()の「整理番号書き込み」部分に相当。

        DBトリガー(check_stock_before_outbound)が在庫マイナスを防ぐため
        アプリ層での再確認は不要。
        """
        cur = await self._conn.execute("""
            INSERT INTO outbound_records
                (lot_id, outbound_date, quantity_kg, note, created_by)
            VALUES (%s, %s, %s, %s, %s::UUID)
            RETURNING id
        """, (lot.lot_id, outbound_date, quantity_kg, note, actor_id))
        row = await cur.fetchone()
        return row["id"]
