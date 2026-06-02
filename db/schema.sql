--
-- PostgreSQL database dump
--

\restrict 0G4gauRzfrfb0MqYnaMUeTtMWKZ77tBUjVcthMF4l9iz7oHd73vbDwjiphcqoQK

-- Dumped from database version 16.13
-- Dumped by pg_dump version 16.13

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: unaccent; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;


--
-- Name: check_stock_before_outbound(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_stock_before_outbound() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_remaining   NUMERIC;
    v_inbound_dt  DATE;
    v_lot_info    RECORD;
BEGIN
    -- 0) 入荷日を取得 (time-travel 防止用)
    SELECT inbound_date
    INTO   v_inbound_dt
    FROM   inbound_lots
    WHERE  id = NEW.lot_id;

    IF v_inbound_dt IS NULL THEN
        RAISE EXCEPTION '入庫ロット(id=%)が存在しません', NEW.lot_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- 1) 出庫日 >= 入荷日 でなければ拒否 (C-2 修正)
    --    入荷より前の日付で出庫することはありえない。
    IF NEW.outbound_date < v_inbound_dt THEN
        RAISE EXCEPTION
            '出庫日(%)が入荷日(%)より過去です。ロットID=%',
            NEW.outbound_date, v_inbound_dt, NEW.lot_id
            USING ERRCODE = 'check_violation';
    END IF;

    -- 2) 累積残在庫の確認 (既存ロジック)
    --    lot_stock は非マテビューなので呼び出し毎に再評価される。
    --    同一 INSERT 文中の先行行も反映済み (multi-row 安全)。
    SELECT remaining_kg
    INTO   v_remaining
    FROM   lot_stock
    WHERE  lot_id = NEW.lot_id;

    IF v_remaining < NEW.quantity_kg THEN
        SELECT il.id, il.total_kg, g.spec_type, g.grade_level, o.name AS origin
        INTO   v_lot_info
        FROM   inbound_lots il
        JOIN   products     p  ON p.id = il.product_id
        JOIN   grades       g  ON g.id = p.grade_id
        JOIN   origins      o  ON o.id = p.origin_id
        WHERE  il.id = NEW.lot_id;

        RAISE EXCEPTION
            '在庫不足: ロットID=% [%-%（%）] 残在庫=%.4fkg, 出庫要求=%.4fkg',
            NEW.lot_id,
            v_lot_info.spec_type,
            v_lot_info.grade_level,
            v_lot_info.origin,
            v_remaining,
            NEW.quantity_kg
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: next_lot_code(text, character); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_lot_code(p_crop_code text, p_kind character) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_prefix TEXT := p_crop_code || p_kind;
    v_next   INTEGER;
BEGIN
    IF p_kind NOT IN ('G', 'S') THEN
        RAISE EXCEPTION 'kind must be G or S, got %', p_kind;
    END IF;
    SELECT COALESCE(MAX(seq), 0) + 1
    INTO v_next
    FROM (
        SELECT substring(code FROM 4)::integer AS seq
        FROM inbound_lots
        WHERE code LIKE v_prefix || '%'
        UNION ALL
        SELECT substring(code FROM 4)::integer AS seq
        FROM lot_reservations
        WHERE code LIKE v_prefix || '%'
    ) AS combined;
    RETURN v_prefix || lpad(v_next::text, 5, '0');
END;
$$;


--
-- Name: next_selection_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_selection_code() RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_year  TEXT := to_char(now(), 'YYYY');
    v_next  INTEGER;
BEGIN
    SELECT COALESCE(MAX(
        substring(code FROM 10)::integer  -- 'SEL-YYYY-NNNN' の末尾4桁
    ), 0) + 1
    INTO v_next
    FROM selection_operations
    WHERE code LIKE 'SEL-' || v_year || '-%';

    RETURN 'SEL-' || v_year || '-' || lpad(v_next::text, 4, '0');
END;
$$;


--
-- Name: next_semifinished_code(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_semifinished_code(p_crop_code text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_prefix TEXT := p_crop_code || 'H';
    v_next   INTEGER;
BEGIN
    SELECT COALESCE(MAX(substring(code FROM 4)::integer), 0) + 1
    INTO v_next FROM semifinished_lots WHERE code LIKE v_prefix || '%';
    RETURN v_prefix || lpad(v_next::text, 5, '0');
END;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;


--
-- Name: trg_calendar_cell_comments_set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_calendar_cell_comments_set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END $$;


--
-- Name: validate_alt_material_ids(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_alt_material_ids() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    bad_id INTEGER;
BEGIN
    IF NEW.alternative_material_ids IS NOT NULL
       AND array_length(NEW.alternative_material_ids, 1) > 0 THEN
        SELECT unnest INTO bad_id
        FROM unnest(NEW.alternative_material_ids) AS unnest
        WHERE unnest NOT IN (SELECT id FROM materials)
        LIMIT 1;
        IF bad_id IS NOT NULL THEN
            RAISE EXCEPTION
                '代替資材 id % が materials に存在しません', bad_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: area_stocktakes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.area_stocktakes (
    id bigint NOT NULL,
    area_id integer NOT NULL,
    count_date date NOT NULL,
    asset_type_id integer NOT NULL,
    logo_id integer NOT NULL,
    category_id integer NOT NULL,
    counted_qty integer NOT NULL,
    note text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: area_stocktakes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.area_stocktakes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: area_stocktakes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.area_stocktakes_id_seq OWNED BY public.area_stocktakes.id;


--
-- Name: asset_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_categories (
    id integer NOT NULL,
    asset_type_id integer NOT NULL,
    name text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: asset_categories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.asset_categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: asset_categories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.asset_categories_id_seq OWNED BY public.asset_categories.id;


--
-- Name: asset_loans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_loans (
    id bigint NOT NULL,
    asset_type_id integer NOT NULL,
    logo_id integer NOT NULL,
    category_id integer NOT NULL,
    counterparty_id integer NOT NULL,
    division_code integer,
    qty integer NOT NULL,
    lent_at date NOT NULL,
    returned_at date,
    return_movement_id bigint,
    out_movement_id bigint NOT NULL,
    note text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: asset_loans_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.asset_loans_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: asset_loans_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.asset_loans_id_seq OWNED BY public.asset_loans.id;


--
-- Name: asset_logos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_logos (
    id integer NOT NULL,
    asset_type_id integer NOT NULL,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: asset_logos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.asset_logos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: asset_logos_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.asset_logos_id_seq OWNED BY public.asset_logos.id;


--
-- Name: asset_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_movements (
    id bigint NOT NULL,
    asset_type_id integer NOT NULL,
    logo_id integer NOT NULL,
    category_id integer NOT NULL,
    movement_date date NOT NULL,
    kind text NOT NULL,
    qty integer NOT NULL,
    counterparty_id integer,
    division_code integer,
    loan_id bigint,
    note text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asset_movements_check CHECK ((((kind = ANY (ARRAY['loan_out'::text, 'loan_in'::text])) AND (counterparty_id IS NOT NULL)) OR (kind <> ALL (ARRAY['loan_out'::text, 'loan_in'::text])))),
    CONSTRAINT asset_movements_kind_check CHECK ((kind = ANY (ARRAY['stocktake'::text, 'loan_out'::text, 'loan_in'::text, 'in'::text, 'out'::text, 'adjust'::text])))
);


--
-- Name: asset_movements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.asset_movements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: asset_movements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.asset_movements_id_seq OWNED BY public.asset_movements.id;


--
-- Name: asset_purchase_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_purchase_records (
    id bigint NOT NULL,
    movement_id bigint,
    asset_type_id integer NOT NULL,
    logo_id integer NOT NULL,
    category_id integer NOT NULL,
    purchase_date date NOT NULL,
    qty integer NOT NULL,
    unit_price numeric(12,2),
    total_amount numeric(14,2),
    supplier_name text,
    storage_factory_id integer,
    receipt_no text,
    note text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asset_purchase_records_qty_check CHECK ((qty > 0))
);


--
-- Name: asset_purchase_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.asset_purchase_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: asset_purchase_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.asset_purchase_records_id_seq OWNED BY public.asset_purchase_records.id;


--
-- Name: asset_stocktakes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_stocktakes (
    id bigint NOT NULL,
    asset_type_id integer NOT NULL,
    logo_id integer NOT NULL,
    category_id integer NOT NULL,
    count_date date NOT NULL,
    counted_qty integer NOT NULL,
    theoretical_qty integer,
    variance integer GENERATED ALWAYS AS ((counted_qty - COALESCE(theoretical_qty, 0))) STORED,
    variance_note text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: asset_stocktakes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.asset_stocktakes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: asset_stocktakes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.asset_stocktakes_id_seq OWNED BY public.asset_stocktakes.id;


--
-- Name: asset_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_types (
    id integer NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: asset_types_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.asset_types_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: asset_types_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.asset_types_id_seq OWNED BY public.asset_types.id;


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    event_type text NOT NULL,
    table_name text,
    record_id text,
    payload jsonb,
    actor_id uuid,
    actor_device text,
    ip_address inet,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;


--
-- Name: calendar_cell_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_cell_comments (
    id bigint NOT NULL,
    lot_id bigint NOT NULL,
    comment_date date NOT NULL,
    comment text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT calendar_cell_comments_comment_check CHECK ((length(TRIM(BOTH FROM comment)) > 0))
);


--
-- Name: calendar_cell_comments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.calendar_cell_comments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: calendar_cell_comments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.calendar_cell_comments_id_seq OWNED BY public.calendar_cell_comments.id;


--
-- Name: client_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_logs (
    id bigint NOT NULL,
    user_id uuid,
    ua text,
    url text,
    level text NOT NULL,
    message text NOT NULL,
    stack text,
    ctx jsonb,
    ip text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT client_logs_level_check CHECK ((level = ANY (ARRAY['error'::text, 'warn'::text, 'info'::text, 'debug'::text, 'trace'::text])))
);


--
-- Name: client_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.client_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.client_logs_id_seq OWNED BY public.client_logs.id;


--
-- Name: correction_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.correction_records (
    id bigint NOT NULL,
    target_table text NOT NULL,
    target_id bigint NOT NULL,
    field_name text NOT NULL,
    old_value text,
    new_value text,
    reason text NOT NULL,
    corrected_by uuid NOT NULL,
    corrected_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: correction_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.correction_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: correction_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.correction_records_id_seq OWNED BY public.correction_records.id;


--
-- Name: counterparties; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.counterparties (
    id integer NOT NULL,
    code text,
    name text NOT NULL,
    kind text DEFAULT 'vendor'::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT counterparties_kind_check CHECK ((kind = ANY (ARRAY['external_factory'::text, 'vendor'::text])))
);


--
-- Name: counterparties_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.counterparties_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: counterparties_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.counterparties_id_seq OWNED BY public.counterparties.id;


--
-- Name: crops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crops (
    id integer NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: crops_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crops_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crops_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crops_id_seq OWNED BY public.crops.id;


--
-- Name: factory_areas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.factory_areas (
    id integer NOT NULL,
    code text,
    name text NOT NULL,
    polygons jsonb DEFAULT '[]'::jsonb NOT NULL,
    manager_user_id uuid,
    color text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: factory_areas_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.factory_areas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: factory_areas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.factory_areas_id_seq OWNED BY public.factory_areas.id;


--
-- Name: inbound_lots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbound_lots (
    id bigint NOT NULL,
    product_id integer NOT NULL,
    supplier_id integer NOT NULL,
    inbound_date date NOT NULL,
    cases numeric(10,2) NOT NULL,
    kg_per_case numeric(10,4) NOT NULL,
    total_kg numeric(12,4) NOT NULL,
    unit_price numeric(15,5),
    price_confirmed_at timestamp with time zone,
    price_confirmed_by uuid,
    note text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    code text NOT NULL,
    selection_id bigint,
    archived_at timestamp with time zone,
    archived_by uuid,
    archive_note text,
    brokerage_fee numeric(12,2),
    freight_fee numeric(12,2),
    prepay_date date,
    prepay_amount numeric(12,2),
    postpay_date date,
    postpay_amount numeric(12,2),
    CONSTRAINT inbound_lots_cases_check CHECK ((cases > (0)::numeric)),
    CONSTRAINT inbound_lots_kg_per_case_check CHECK ((kg_per_case > (0)::numeric)),
    CONSTRAINT inbound_lots_total_kg_check CHECK ((total_kg > (0)::numeric))
);


--
-- Name: outbound_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbound_records (
    id bigint NOT NULL,
    lot_id bigint NOT NULL,
    outbound_date date NOT NULL,
    quantity_kg numeric(12,4) NOT NULL,
    note text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    selection_id bigint,
    purpose text,
    kind text,
    order_id bigint,
    priority_used smallint,
    yield_applied numeric(5,4),
    product_qty_covered numeric(10,3),
    CONSTRAINT outbound_records_kind_check CHECK (((kind IS NULL) OR (kind = ANY (ARRAY['selection_consume'::text, 'selection_disposal'::text])))),
    CONSTRAINT outbound_records_priority_used_check CHECK (((priority_used IS NULL) OR ((priority_used >= 1) AND (priority_used <= 3)))),
    CONSTRAINT outbound_records_product_qty_covered_check CHECK (((product_qty_covered IS NULL) OR (product_qty_covered >= (0)::numeric))),
    CONSTRAINT outbound_records_purpose_check CHECK (((purpose IS NULL) OR (purpose = ANY (ARRAY['normal'::text, 'selection'::text])))),
    CONSTRAINT outbound_records_quantity_kg_check CHECK ((quantity_kg <> (0)::numeric)),
    CONSTRAINT outbound_records_yield_applied_check CHECK (((yield_applied IS NULL) OR ((yield_applied > (0)::numeric) AND (yield_applied <= (1)::numeric))))
);


--
-- Name: stock_counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_counts (
    id bigint NOT NULL,
    lot_id bigint NOT NULL,
    period text NOT NULL,
    count_date date NOT NULL,
    counted_kg numeric(12,4) NOT NULL,
    source text DEFAULT 'physical_count'::text NOT NULL,
    note text,
    confirmed_by uuid NOT NULL,
    confirmed_at timestamp with time zone DEFAULT now() NOT NULL,
    theoretical_kg numeric(12,4),
    CONSTRAINT stock_counts_counted_kg_check CHECK ((counted_kg >= (0)::numeric)),
    CONSTRAINT stock_counts_source_check CHECK ((source = ANY (ARRAY['physical_count'::text, 'migration'::text])))
);


--
-- Name: lot_stock; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.lot_stock AS
 WITH latest_count AS (
         SELECT DISTINCT ON (stock_counts.lot_id) stock_counts.lot_id,
            stock_counts.count_date,
            stock_counts.counted_kg
           FROM public.stock_counts
          ORDER BY stock_counts.lot_id, stock_counts.count_date DESC, stock_counts.id DESC
        ), lot_base AS (
         SELECT il.id,
            il.product_id,
            il.supplier_id,
            il.inbound_date,
            il.cases,
            il.kg_per_case,
            il.total_kg,
            il.unit_price,
            il.price_confirmed_at,
            COALESCE(lc.counted_kg, il.total_kg) AS base_kg,
            lc.count_date AS base_date
           FROM (public.inbound_lots il
             LEFT JOIN latest_count lc ON ((lc.lot_id = il.id)))
        ), lot_out AS (
         SELECT lb_1.id,
            COALESCE(sum(ob.quantity_kg) FILTER (WHERE ((lb_1.base_date IS NULL) OR (ob.outbound_date > lb_1.base_date))), (0)::numeric) AS period_outbound_kg
           FROM (lot_base lb_1
             LEFT JOIN public.outbound_records ob ON ((ob.lot_id = lb_1.id)))
          GROUP BY lb_1.id
        )
 SELECT lb.id AS lot_id,
    lb.product_id,
    lb.supplier_id,
    lb.inbound_date,
    lb.cases,
    lb.kg_per_case,
    lb.total_kg,
    lb.unit_price,
    lb.price_confirmed_at,
    lo.period_outbound_kg AS total_outbound_kg,
    (lb.base_kg - lo.period_outbound_kg) AS remaining_kg,
        CASE
            WHEN ((lb.base_kg - lo.period_outbound_kg) <= (0)::numeric) THEN 'depleted'::text
            WHEN ((lb.base_kg - lo.period_outbound_kg) < (lb.base_kg * 0.1)) THEN 'low'::text
            ELSE 'available'::text
        END AS stock_status,
        CASE
            WHEN (lb.unit_price IS NOT NULL) THEN ((lb.base_kg - lo.period_outbound_kg) * lb.unit_price)
            ELSE NULL::numeric
        END AS stock_value,
    (lb.unit_price IS NULL) AS is_price_pending,
    lb.base_kg,
    lb.base_date
   FROM (lot_base lb
     JOIN lot_out lo ON ((lo.id = lb.id)));


--
-- Name: fifo_eligible_lots; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.fifo_eligible_lots AS
 SELECT lot_id,
    product_id,
    supplier_id,
    inbound_date,
    remaining_kg,
    unit_price,
    is_price_pending,
    row_number() OVER (PARTITION BY product_id ORDER BY inbound_date, lot_id) AS fifo_rank
   FROM public.lot_stock ls
  WHERE (remaining_kg > (0)::numeric);


--
-- Name: grades; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grades (
    id integer NOT NULL,
    spec_type text NOT NULL,
    grade_level text NOT NULL,
    size_label text NOT NULL,
    size_mm integer,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: grades_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.grades_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: grades_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.grades_id_seq OWNED BY public.grades.id;


--
-- Name: inbound_lots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.inbound_lots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inbound_lots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.inbound_lots_id_seq OWNED BY public.inbound_lots.id;


--
-- Name: lot_reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lot_reservations (
    id bigint NOT NULL,
    code text NOT NULL,
    crop_id integer NOT NULL,
    code_kind character(1) DEFAULT 'G'::bpchar NOT NULL,
    note text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_at timestamp with time zone,
    consumed_inbound_id bigint,
    CONSTRAINT lot_reservations_consumed_chk CHECK ((((consumed_at IS NULL) AND (consumed_inbound_id IS NULL)) OR (consumed_at IS NOT NULL))),
    CONSTRAINT lot_reservations_kind_chk CHECK ((code_kind = ANY (ARRAY['G'::bpchar, 'S'::bpchar])))
);


--
-- Name: lot_reservations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.lot_reservations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lot_reservations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.lot_reservations_id_seq OWNED BY public.lot_reservations.id;


--
-- Name: material_counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.material_counts (
    id bigint NOT NULL,
    material_id integer NOT NULL,
    period text NOT NULL,
    count_date date NOT NULL,
    counted_qty numeric(12,4) NOT NULL,
    theoretical_qty numeric(12,4),
    source text DEFAULT 'physical_count'::text NOT NULL,
    note text,
    confirmed_by uuid NOT NULL,
    confirmed_at timestamp with time zone DEFAULT now() NOT NULL,
    object_id integer,
    CONSTRAINT material_counts_counted_qty_check CHECK ((counted_qty >= (0)::numeric)),
    CONSTRAINT material_counts_source_check CHECK ((source = ANY (ARRAY['physical_count'::text, 'migration'::text, 'layout'::text])))
);


--
-- Name: material_counts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.material_counts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: material_counts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.material_counts_id_seq OWNED BY public.material_counts.id;


--
-- Name: material_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.material_movements (
    id bigint NOT NULL,
    material_id integer NOT NULL,
    movement_date date NOT NULL,
    quantity numeric(12,4) NOT NULL,
    note text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT material_movements_quantity_check CHECK ((quantity <> (0)::numeric))
);


--
-- Name: material_movements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.material_movements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: material_movements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.material_movements_id_seq OWNED BY public.material_movements.id;


--
-- Name: materials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.materials (
    id integer NOT NULL,
    code text NOT NULL,
    division integer NOT NULL,
    supplier_name text NOT NULL,
    item_name text NOT NULL,
    unit text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    unit_price numeric(12,4),
    category text,
    length_per_roll_cm numeric(12,2),
    pack_size numeric(12,4),
    supplier_id integer NOT NULL,
    is_general_supply boolean DEFAULT false NOT NULL
);


--
-- Name: product_material_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_material_usage (
    id integer NOT NULL,
    product_id integer NOT NULL,
    material_id integer NOT NULL,
    quantity_per_unit numeric(12,4) NOT NULL,
    note text,
    is_estimated boolean DEFAULT false NOT NULL,
    estimation_weight numeric(10,4) DEFAULT 1.0 NOT NULL,
    estimated_at timestamp with time zone,
    alternative_material_ids integer[] DEFAULT '{}'::integer[] NOT NULL,
    department_code text,
    CONSTRAINT product_material_usage_quantity_per_unit_check CHECK ((quantity_per_unit >= (0)::numeric))
);


--
-- Name: shipment_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipment_records (
    id bigint NOT NULL,
    product_id integer NOT NULL,
    ship_date date NOT NULL,
    quantity numeric(12,4) NOT NULL,
    note text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    dispatch_from text,
    department_code text,
    sales_amount numeric(14,2),
    weight_kg numeric(10,4),
    pack_count numeric(12,2),
    CONSTRAINT shipment_records_quantity_check CHECK ((quantity > (0)::numeric))
);


--
-- Name: storage_object_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_object_items (
    id integer NOT NULL,
    object_id integer NOT NULL,
    material_id integer,
    inbound_lot_id bigint,
    capacity numeric(12,4),
    priority integer DEFAULT 50 NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    semifinished_lot_id bigint,
    pallet_details jsonb,
    pallet_index integer,
    tier_count integer,
    case_count integer,
    CONSTRAINT storage_object_items_case_count_check CHECK (((case_count IS NULL) OR ((case_count >= 0) AND (case_count <= 6)))),
    CONSTRAINT storage_object_items_priority_check CHECK (((priority >= 0) AND (priority <= 100))),
    CONSTRAINT storage_object_items_tier_count_check CHECK (((tier_count IS NULL) OR ((tier_count >= 0) AND (tier_count <= 7)))),
    CONSTRAINT zero_or_one_target CHECK ((((((material_id IS NOT NULL))::integer + ((inbound_lot_id IS NOT NULL))::integer) + (COALESCE((semifinished_lot_id IS NOT NULL), false))::integer) <= 1))
);


--
-- Name: material_stock; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.material_stock AS
 WITH material_link_count AS (
         SELECT storage_object_items.material_id,
            count(DISTINCT storage_object_items.object_id) AS linked_n
           FROM public.storage_object_items
          WHERE (storage_object_items.material_id IS NOT NULL)
          GROUP BY storage_object_items.material_id
        ), daily_counts AS (
         SELECT material_counts.material_id,
            material_counts.count_date,
            COALESCE(sum(material_counts.counted_qty) FILTER (WHERE (material_counts.object_id IS NULL)), (0)::numeric) AS total_only_qty,
            COALESCE(sum(material_counts.counted_qty) FILTER (WHERE (material_counts.object_id IS NOT NULL)), (0)::numeric) AS object_only_qty,
            count(*) FILTER (WHERE (material_counts.object_id IS NOT NULL)) AS object_count_n,
            bool_or((material_counts.object_id IS NULL)) AS has_total_entry
           FROM public.material_counts
          GROUP BY material_counts.material_id, material_counts.count_date
        ), daily_counts_valid AS (
         SELECT dc.material_id,
            dc.count_date,
            dc.total_only_qty,
            dc.object_only_qty,
            dc.object_count_n,
            dc.has_total_entry,
            COALESCE(mlc.linked_n, (0)::bigint) AS linked_n,
                CASE
                    WHEN dc.has_total_entry THEN true
                    WHEN (COALESCE(mlc.linked_n, (0)::bigint) = 0) THEN false
                    ELSE (dc.object_count_n >= mlc.linked_n)
                END AS is_complete,
                CASE
                    WHEN dc.has_total_entry THEN dc.total_only_qty
                    ELSE dc.object_only_qty
                END AS effective_qty
           FROM (daily_counts dc
             LEFT JOIN material_link_count mlc USING (material_id))
        ), ranked_valid AS (
         SELECT daily_counts_valid.material_id,
            daily_counts_valid.count_date,
            daily_counts_valid.effective_qty AS total_qty,
            row_number() OVER (PARTITION BY daily_counts_valid.material_id ORDER BY daily_counts_valid.count_date DESC) AS rn
           FROM daily_counts_valid
          WHERE daily_counts_valid.is_complete
        ), latest_valid_count AS (
         SELECT ranked_valid.material_id,
            ranked_valid.count_date,
            ranked_valid.total_qty
           FROM ranked_valid
          WHERE (ranked_valid.rn = 1)
        ), previous_valid_count AS (
         SELECT ranked_valid.material_id,
            ranked_valid.count_date AS prev_date,
            ranked_valid.total_qty AS prev_qty
           FROM ranked_valid
          WHERE (ranked_valid.rn = 2)
        ), latest_count_any AS (
         SELECT DISTINCT ON (daily_counts_valid.material_id) daily_counts_valid.material_id,
            daily_counts_valid.count_date,
            daily_counts_valid.effective_qty AS total_qty,
            daily_counts_valid.object_count_n,
            daily_counts_valid.linked_n,
            daily_counts_valid.is_complete
           FROM daily_counts_valid
          ORDER BY daily_counts_valid.material_id, daily_counts_valid.count_date DESC
        ), material_base AS (
         SELECT m_1.id AS material_id,
            COALESCE(lvc.count_date, '1900-01-01'::date) AS base_date,
            COALESCE(lvc.total_qty, (0)::numeric) AS base_qty,
            lvc.count_date AS real_base_date
           FROM (public.materials m_1
             LEFT JOIN latest_valid_count lvc ON ((lvc.material_id = m_1.id)))
        ), manual_since AS (
         SELECT mb_1.material_id,
            COALESCE(sum(mm.quantity), (0)::numeric) AS qty
           FROM (material_base mb_1
             LEFT JOIN public.material_movements mm ON (((mm.material_id = mb_1.material_id) AND (mm.movement_date > mb_1.base_date))))
          GROUP BY mb_1.material_id
        ), pmu_pick AS (
         SELECT DISTINCT ON (sr.id, pmu.material_id) sr.id AS sr_id,
            sr.ship_date,
            sr.quantity AS sr_qty,
            pmu.material_id,
            pmu.quantity_per_unit
           FROM (public.shipment_records sr
             JOIN public.product_material_usage pmu ON (((pmu.product_id = sr.product_id) AND ((pmu.department_code IS NULL) OR (pmu.department_code = sr.department_code)))))
          ORDER BY sr.id, pmu.material_id, pmu.department_code
        ), auto_raw AS (
         SELECT mb_1.material_id,
            COALESCE(sum((pp.sr_qty * pp.quantity_per_unit)), (0)::numeric) AS qty
           FROM (material_base mb_1
             LEFT JOIN pmu_pick pp ON (((pp.material_id = mb_1.material_id) AND (pp.ship_date > mb_1.base_date))))
          GROUP BY mb_1.material_id
        ), movements_between AS (
         SELECT pvc.material_id,
            COALESCE(sum(mm.quantity), (0)::numeric) AS net_qty
           FROM ((previous_valid_count pvc
             JOIN latest_valid_count lvc USING (material_id))
             LEFT JOIN public.material_movements mm ON (((mm.material_id = pvc.material_id) AND (mm.movement_date > pvc.prev_date) AND (mm.movement_date <= lvc.count_date))))
          GROUP BY pvc.material_id
        ), auto_between AS (
         SELECT pvc.material_id,
            COALESCE(sum((pp.sr_qty * pp.quantity_per_unit)), (0)::numeric) AS qty
           FROM ((previous_valid_count pvc
             JOIN latest_valid_count lvc USING (material_id))
             LEFT JOIN pmu_pick pp ON (((pp.material_id = pvc.material_id) AND (pp.ship_date > pvc.prev_date) AND (pp.ship_date <= lvc.count_date))))
          GROUP BY pvc.material_id
        ), theoretical_at_count AS (
         SELECT pvc.material_id,
            ((pvc.prev_qty + COALESCE(mb_1.net_qty, (0)::numeric)) - COALESCE(ab.qty, (0)::numeric)) AS theory_at_count
           FROM ((previous_valid_count pvc
             LEFT JOIN movements_between mb_1 USING (material_id))
             LEFT JOIN auto_between ab USING (material_id))
        ), recipe_counts AS (
         SELECT product_material_usage.material_id,
            count(DISTINCT product_material_usage.product_id) AS recipe_product_count,
            count(*) FILTER (WHERE product_material_usage.is_estimated) AS estimated_count
           FROM public.product_material_usage
          GROUP BY product_material_usage.material_id
        )
 SELECT m.id AS material_id,
    m.code,
    m.division,
    m.supplier_id,
    m.supplier_name,
    m.item_name,
    m.unit,
    m.is_active,
    m.unit_price,
    m.category,
    m.length_per_roll_cm,
    m.pack_size,
    mb.base_qty,
    mb.real_base_date AS base_date,
    ms.qty AS manual_movements_qty,
        CASE
            WHEN ((m.length_per_roll_cm IS NOT NULL) AND (m.length_per_roll_cm > (0)::numeric)) THEN (ar.qty / m.length_per_roll_cm)
            ELSE ar.qty
        END AS auto_consumption_qty,
    ar.qty AS auto_consumption_cm,
    (ms.qty -
        CASE
            WHEN ((m.length_per_roll_cm IS NOT NULL) AND (m.length_per_roll_cm > (0)::numeric)) THEN (ar.qty / m.length_per_roll_cm)
            ELSE ar.qty
        END) AS movements_since_base,
    ((mb.base_qty + ms.qty) -
        CASE
            WHEN ((m.length_per_roll_cm IS NOT NULL) AND (m.length_per_roll_cm > (0)::numeric)) THEN (ar.qty / m.length_per_roll_cm)
            ELSE ar.qty
        END) AS remaining_qty,
    lca.count_date AS latest_count_date,
    lca.total_qty AS latest_count_total,
    lca.is_complete AS latest_count_complete,
    lca.linked_n AS linked_object_count,
    lca.object_count_n AS counted_object_n,
        CASE
            WHEN lca.is_complete THEN lca.total_qty
            ELSE NULL::numeric
        END AS actual_qty,
    tac.theory_at_count AS theoretical_at_count_date,
        CASE
            WHEN (m.unit_price IS NOT NULL) THEN (((mb.base_qty + ms.qty) -
            CASE
                WHEN ((m.length_per_roll_cm IS NOT NULL) AND (m.length_per_roll_cm > (0)::numeric)) THEN (ar.qty / m.length_per_roll_cm)
                ELSE ar.qty
            END) * m.unit_price)
            ELSE NULL::numeric
        END AS stock_value,
    COALESCE(rc.recipe_product_count, (0)::bigint) AS recipe_product_count,
    COALESCE(rc.estimated_count, (0)::bigint) AS recipe_estimated_count,
    m.is_general_supply
   FROM ((((((public.materials m
     JOIN material_base mb ON ((mb.material_id = m.id)))
     JOIN manual_since ms ON ((ms.material_id = m.id)))
     JOIN auto_raw ar ON ((ar.material_id = m.id)))
     LEFT JOIN latest_count_any lca ON ((lca.material_id = m.id)))
     LEFT JOIN theoretical_at_count tac ON ((tac.material_id = m.id)))
     LEFT JOIN recipe_counts rc ON ((rc.material_id = m.id)));


--
-- Name: materials_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.materials_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: materials_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.materials_id_seq OWNED BY public.materials.id;


--
-- Name: migration_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.migration_log (
    id integer NOT NULL,
    migration_name text NOT NULL,
    description text,
    executed_at timestamp with time zone DEFAULT now() NOT NULL,
    executed_by text
);


--
-- Name: migration_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.migration_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: migration_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.migration_log_id_seq OWNED BY public.migration_log.id;


--
-- Name: origins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.origins (
    id integer NOT NULL,
    name text NOT NULL,
    name_kana text,
    region text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT origins_name_no_san_suffix_chk CHECK ((name !~~ '%産'::text))
);


--
-- Name: origins_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.origins_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: origins_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.origins_id_seq OWNED BY public.origins.id;


--
-- Name: outbound_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbound_orders (
    id bigint NOT NULL,
    crop_id integer NOT NULL,
    outbound_date date NOT NULL,
    origin_id integer NOT NULL,
    from_grade_id integer NOT NULL,
    product_qty_kg numeric(10,3) NOT NULL,
    note text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    batch_id uuid,
    CONSTRAINT outbound_orders_product_qty_kg_check CHECK ((product_qty_kg > (0)::numeric))
);


--
-- Name: outbound_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.outbound_orders_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: outbound_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.outbound_orders_id_seq OWNED BY public.outbound_orders.id;


--
-- Name: outbound_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.outbound_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: outbound_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.outbound_records_id_seq OWNED BY public.outbound_records.id;


--
-- Name: product_bom; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_bom (
    product_code text NOT NULL,
    product_name text NOT NULL,
    crop_id integer DEFAULT 2 NOT NULL,
    origin_text text,
    origin_id integer,
    grade_text_1 text,
    grade_id_1 integer,
    ratio_1 numeric(5,2) DEFAULT 100 NOT NULL,
    grade_text_2 text,
    grade_id_2 integer,
    ratio_2 numeric(5,2),
    note text,
    is_resolved boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_bom_ratio_1_check CHECK (((ratio_1 >= (0)::numeric) AND (ratio_1 <= (100)::numeric))),
    CONSTRAINT product_bom_ratio_2_check CHECK (((ratio_2 IS NULL) OR ((ratio_2 >= (0)::numeric) AND (ratio_2 <= (100)::numeric))))
);


--
-- Name: product_material_usage_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_material_usage_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_material_usage_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_material_usage_id_seq OWNED BY public.product_material_usage.id;


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id integer NOT NULL,
    grade_id integer NOT NULL,
    origin_id integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    crop_id integer NOT NULL,
    sub_kind text,
    CONSTRAINT products_sub_kind_check CHECK (((sub_kind IS NULL) OR (sub_kind = ANY (ARRAY['black'::text, 'semifinished'::text]))))
);


--
-- Name: product_stock_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.product_stock_summary AS
 SELECT p.id AS product_id,
    g.spec_type,
    g.grade_level,
    g.size_label,
    g.size_mm,
    o.name AS origin_name,
    o.region,
    count(ls.lot_id) FILTER (WHERE (ls.stock_status <> 'depleted'::text)) AS active_lot_count,
    COALESCE(sum(ls.remaining_kg) FILTER (WHERE (ls.stock_status <> 'depleted'::text)), (0)::numeric) AS total_remaining_kg,
    sum(ls.stock_value) AS total_stock_value,
    count(ls.lot_id) FILTER (WHERE (ls.is_price_pending AND (ls.stock_status <> 'depleted'::text))) AS pending_price_lot_count,
    min(ls.inbound_date) FILTER (WHERE (ls.stock_status <> 'depleted'::text)) AS oldest_lot_date
   FROM (((public.products p
     JOIN public.grades g ON ((g.id = p.grade_id)))
     JOIN public.origins o ON ((o.id = p.origin_id)))
     LEFT JOIN public.lot_stock ls ON ((ls.product_id = p.id)))
  WHERE (p.is_active = true)
  GROUP BY p.id, g.spec_type, g.grade_level, g.size_label, g.size_mm, o.name, o.region;


--
-- Name: products_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.products_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: products_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.products_id_seq OWNED BY public.products.id;


--
-- Name: products_shipped; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products_shipped (
    id integer NOT NULL,
    division integer NOT NULL,
    name text NOT NULL,
    unit text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    product_code text,
    classification_code text,
    classification_name text,
    pack_size numeric(10,2)
);


--
-- Name: products_shipped_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.products_shipped_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: products_shipped_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.products_shipped_id_seq OWNED BY public.products_shipped.id;


--
-- Name: recipe_submission_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recipe_submission_lines (
    id bigint NOT NULL,
    submission_id bigint NOT NULL,
    product_id integer,
    product_text text,
    material_id integer,
    material_text text,
    quantity_per_unit numeric(12,4) NOT NULL,
    unit_note text,
    line_note text,
    is_uncertain boolean DEFAULT false NOT NULL,
    line_status text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT recipe_submission_lines_check CHECK (((product_id IS NOT NULL) OR ((product_text IS NOT NULL) AND (TRIM(BOTH FROM product_text) <> ''::text)))),
    CONSTRAINT recipe_submission_lines_check1 CHECK (((material_id IS NOT NULL) OR ((material_text IS NOT NULL) AND (TRIM(BOTH FROM material_text) <> ''::text)))),
    CONSTRAINT recipe_submission_lines_line_status_check CHECK ((line_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT recipe_submission_lines_quantity_per_unit_check CHECK ((quantity_per_unit >= (0)::numeric))
);


--
-- Name: recipe_submission_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.recipe_submission_lines_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: recipe_submission_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.recipe_submission_lines_id_seq OWNED BY public.recipe_submission_lines.id;


--
-- Name: recipe_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recipe_submissions (
    id bigint NOT NULL,
    division_code integer NOT NULL,
    submitter_name text,
    submitter_note text,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    reviewed_at timestamp with time zone,
    reviewed_by uuid,
    review_note text,
    client_ip text,
    user_agent text,
    CONSTRAINT recipe_submissions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: recipe_submissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.recipe_submissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: recipe_submissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.recipe_submissions_id_seq OWNED BY public.recipe_submissions.id;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version text NOT NULL,
    filename text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    checksum text
);


--
-- Name: selection_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.selection_operations (
    id bigint NOT NULL,
    code text NOT NULL,
    crop_id integer NOT NULL,
    operation_date date NOT NULL,
    source_lot_id bigint,
    source_kg numeric(12,4),
    source_unit_price numeric(12,2),
    total_cost numeric(14,2),
    note text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    weighted_unit_price numeric(12,2),
    CONSTRAINT selection_operations_source_kg_check CHECK ((source_kg > (0)::numeric))
);


--
-- Name: selection_operations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.selection_operations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: selection_operations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.selection_operations_id_seq OWNED BY public.selection_operations.id;


--
-- Name: selection_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.selection_sources (
    id bigint NOT NULL,
    selection_id bigint NOT NULL,
    lot_id bigint NOT NULL,
    source_kg numeric(12,4) NOT NULL,
    consume_kg numeric(12,4) NOT NULL,
    disposal_kg numeric(12,4) NOT NULL,
    consume_outbound_id bigint,
    disposal_outbound_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT selection_sources_consume_kg_check CHECK ((consume_kg >= (0)::numeric)),
    CONSTRAINT selection_sources_disposal_kg_check CHECK ((disposal_kg >= (0)::numeric)),
    CONSTRAINT selection_sources_kg_chk CHECK (((consume_kg + disposal_kg) = source_kg)),
    CONSTRAINT selection_sources_source_kg_check CHECK ((source_kg > (0)::numeric))
);


--
-- Name: selection_sources_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.selection_sources_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: selection_sources_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.selection_sources_id_seq OWNED BY public.selection_sources.id;


--
-- Name: semifinished_lots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.semifinished_lots (
    id bigint NOT NULL,
    code text NOT NULL,
    source_outbound_id bigint,
    product_id integer NOT NULL,
    inbound_date date NOT NULL,
    cases numeric(10,2) NOT NULL,
    kg_per_case numeric(10,4) NOT NULL,
    total_kg numeric(12,4) NOT NULL,
    unit_price numeric(12,2),
    price_confirmed_at timestamp with time zone,
    price_confirmed_by uuid,
    note text,
    archived_at timestamp with time zone,
    archived_by uuid,
    archive_note text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    selection_id bigint,
    CONSTRAINT semifinished_lots_cases_check CHECK ((cases > (0)::numeric)),
    CONSTRAINT semifinished_lots_kg_per_case_check CHECK ((kg_per_case > (0)::numeric)),
    CONSTRAINT semifinished_lots_origin_chk CHECK (((source_outbound_id IS NOT NULL) OR (selection_id IS NOT NULL))),
    CONSTRAINT semifinished_lots_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sorting'::text, 'soaking'::text, 'washing'::text]))),
    CONSTRAINT semifinished_lots_total_kg_check CHECK ((total_kg > (0)::numeric))
);


--
-- Name: semifinished_lots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.semifinished_lots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: semifinished_lots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.semifinished_lots_id_seq OWNED BY public.semifinished_lots.id;


--
-- Name: semifinished_outbound_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.semifinished_outbound_records (
    id bigint NOT NULL,
    semifinished_lot_id bigint NOT NULL,
    outbound_date date NOT NULL,
    quantity_kg numeric(12,4) NOT NULL,
    cases numeric(10,2),
    purpose text,
    customer text,
    note text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT semifinished_outbound_records_quantity_kg_check CHECK ((quantity_kg > (0)::numeric))
);


--
-- Name: semifinished_outbound_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.semifinished_outbound_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: semifinished_outbound_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.semifinished_outbound_records_id_seq OWNED BY public.semifinished_outbound_records.id;


--
-- Name: semifinished_stock; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.semifinished_stock AS
 SELECT sl.id AS lot_id,
    sl.code,
    sl.source_outbound_id,
    sl.selection_id,
    sl.product_id,
    p.crop_id,
    cr.code AS crop_code,
    cr.name AS crop_name,
    g.id AS grade_id,
    g.spec_type,
    g.grade_level,
    g.size_label,
    g.size_mm,
    o.id AS origin_id,
    o.name AS origin_name,
    src_lot.id AS source_lot_id,
    src_lot.code AS source_lot_code,
    src.outbound_date AS source_outbound_date,
    src.note AS source_outbound_note,
    sel.code AS selection_code,
    sl.inbound_date,
    sl.cases AS base_cases,
    sl.kg_per_case,
    sl.total_kg AS base_kg,
    sl.unit_price,
    sl.price_confirmed_at,
    COALESCE(so.consumed, (0)::numeric) AS consumed_kg,
    (sl.total_kg - COALESCE(so.consumed, (0)::numeric)) AS remaining_kg,
        CASE
            WHEN (sl.unit_price IS NOT NULL) THEN ((sl.total_kg - COALESCE(so.consumed, (0)::numeric)) * sl.unit_price)
            ELSE NULL::numeric
        END AS stock_value,
    sl.note,
    sl.archived_at,
    sl.archived_by,
    sl.archive_note,
    sl.created_by,
    sl.created_at,
    sl.updated_at
   FROM ((((((((public.semifinished_lots sl
     JOIN public.products p ON ((p.id = sl.product_id)))
     JOIN public.crops cr ON ((cr.id = p.crop_id)))
     JOIN public.grades g ON ((g.id = p.grade_id)))
     JOIN public.origins o ON ((o.id = p.origin_id)))
     LEFT JOIN public.outbound_records src ON ((src.id = sl.source_outbound_id)))
     LEFT JOIN public.inbound_lots src_lot ON ((src_lot.id = src.lot_id)))
     LEFT JOIN public.selection_operations sel ON ((sel.id = sl.selection_id)))
     LEFT JOIN ( SELECT semifinished_outbound_records.semifinished_lot_id,
            sum(semifinished_outbound_records.quantity_kg) AS consumed
           FROM public.semifinished_outbound_records
          GROUP BY semifinished_outbound_records.semifinished_lot_id) so ON ((so.semifinished_lot_id = sl.id)));


--
-- Name: shipment_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shipment_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shipment_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shipment_records_id_seq OWNED BY public.shipment_records.id;


--
-- Name: stock_counts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_counts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_counts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_counts_id_seq OWNED BY public.stock_counts.id;


--
-- Name: storage_layout_sheet_meta; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_layout_sheet_meta (
    layout_id integer NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);


--
-- Name: storage_layouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_layouts (
    id integer NOT NULL,
    name text NOT NULL,
    division integer,
    target_kind text NOT NULL,
    image_url text,
    image_width integer,
    image_height integer,
    note text,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    floor_outline jsonb,
    default_link_kind text DEFAULT 'ingredient'::text NOT NULL,
    CONSTRAINT storage_layouts_default_link_kind_check CHECK ((default_link_kind = ANY (ARRAY['ingredient'::text, 'semifinished'::text]))),
    CONSTRAINT storage_layouts_target_kind_check CHECK ((target_kind = ANY (ARRAY['material'::text, 'ingredient'::text])))
);


--
-- Name: storage_layouts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.storage_layouts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: storage_layouts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.storage_layouts_id_seq OWNED BY public.storage_layouts.id;


--
-- Name: storage_object_inventory_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_object_inventory_entries (
    id integer NOT NULL,
    object_id integer NOT NULL,
    inventory_date date DEFAULT CURRENT_DATE NOT NULL,
    inbound_lot_id bigint,
    material_id integer,
    semifinished_lot_id bigint,
    outbound_id bigint,
    crop_id integer,
    origin_text text,
    spec_text text,
    sub_spec_text text,
    category_major text,
    category_minor text,
    name text,
    cases numeric(12,4),
    kg_per_case numeric(12,4),
    total_kg numeric(14,4),
    process_state text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    supplier_text text,
    CONSTRAINT storage_object_inventory_entries_process_state_check CHECK (((process_state IS NULL) OR (process_state = ANY (ARRAY['洗'::text, '選'::text]))))
);


--
-- Name: storage_object_inventory_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.storage_object_inventory_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: storage_object_inventory_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.storage_object_inventory_entries_id_seq OWNED BY public.storage_object_inventory_entries.id;


--
-- Name: storage_object_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.storage_object_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: storage_object_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.storage_object_items_id_seq OWNED BY public.storage_object_items.id;


--
-- Name: storage_objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_objects (
    id integer NOT NULL,
    layout_id integer NOT NULL,
    label text,
    x numeric(10,2) NOT NULL,
    y numeric(10,2) NOT NULL,
    width numeric(10,2) DEFAULT 80 NOT NULL,
    height numeric(10,2) DEFAULT 60 NOT NULL,
    color text DEFAULT '#3b82f6'::text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    orientation integer DEFAULT 0 NOT NULL,
    pallet_tiers integer DEFAULT 7 NOT NULL,
    object_type text DEFAULT 'pallet'::text NOT NULL,
    CONSTRAINT storage_objects_object_type_check CHECK ((object_type = ANY (ARRAY['pallet'::text, 'steel_container'::text]))),
    CONSTRAINT storage_objects_orientation_check CHECK ((orientation = ANY (ARRAY[0, 90]))),
    CONSTRAINT storage_objects_pallet_tiers_check CHECK ((pallet_tiers = ANY (ARRAY[6, 7])))
);


--
-- Name: storage_objects_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.storage_objects_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: storage_objects_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.storage_objects_id_seq OWNED BY public.storage_objects.id;


--
-- Name: storage_walls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_walls (
    id bigint NOT NULL,
    layout_id integer NOT NULL,
    x1 numeric(10,2) NOT NULL,
    y1 numeric(10,2) NOT NULL,
    x2 numeric(10,2) NOT NULL,
    y2 numeric(10,2) NOT NULL,
    thickness numeric(6,2) DEFAULT 8 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: storage_walls_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.storage_walls_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: storage_walls_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.storage_walls_id_seq OWNED BY public.storage_walls.id;


--
-- Name: substitution_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.substitution_rules (
    id integer NOT NULL,
    crop_id integer NOT NULL,
    origin_id integer NOT NULL,
    from_grade_id integer NOT NULL,
    priority smallint NOT NULL,
    to_grade_id integer NOT NULL,
    yield_factor numeric(5,4) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT substitution_rules_priority_check CHECK (((priority >= 1) AND (priority <= 3))),
    CONSTRAINT substitution_rules_yield_factor_check CHECK (((yield_factor > (0)::numeric) AND (yield_factor <= (1)::numeric)))
);


--
-- Name: substitution_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.substitution_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: substitution_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.substitution_rules_id_seq OWNED BY public.substitution_rules.id;


--
-- Name: suppliers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suppliers (
    id integer NOT NULL,
    name text NOT NULL,
    name_kana text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: suppliers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.suppliers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: suppliers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.suppliers_id_seq OWNED BY public.suppliers.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    display_name text NOT NULL,
    device_token text,
    role text DEFAULT 'operator'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    divisions integer[] DEFAULT '{}'::integer[] NOT NULL,
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['viewer'::text, 'operator'::text, 'admin'::text, 'recipe_editor'::text])))
);


--
-- Name: area_stocktakes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.area_stocktakes ALTER COLUMN id SET DEFAULT nextval('public.area_stocktakes_id_seq'::regclass);


--
-- Name: asset_categories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_categories ALTER COLUMN id SET DEFAULT nextval('public.asset_categories_id_seq'::regclass);


--
-- Name: asset_loans id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_loans ALTER COLUMN id SET DEFAULT nextval('public.asset_loans_id_seq'::regclass);


--
-- Name: asset_logos id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_logos ALTER COLUMN id SET DEFAULT nextval('public.asset_logos_id_seq'::regclass);


--
-- Name: asset_movements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_movements ALTER COLUMN id SET DEFAULT nextval('public.asset_movements_id_seq'::regclass);


--
-- Name: asset_purchase_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_purchase_records ALTER COLUMN id SET DEFAULT nextval('public.asset_purchase_records_id_seq'::regclass);


--
-- Name: asset_stocktakes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_stocktakes ALTER COLUMN id SET DEFAULT nextval('public.asset_stocktakes_id_seq'::regclass);


--
-- Name: asset_types id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_types ALTER COLUMN id SET DEFAULT nextval('public.asset_types_id_seq'::regclass);


--
-- Name: audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);


--
-- Name: calendar_cell_comments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_cell_comments ALTER COLUMN id SET DEFAULT nextval('public.calendar_cell_comments_id_seq'::regclass);


--
-- Name: client_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_logs ALTER COLUMN id SET DEFAULT nextval('public.client_logs_id_seq'::regclass);


--
-- Name: correction_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correction_records ALTER COLUMN id SET DEFAULT nextval('public.correction_records_id_seq'::regclass);


--
-- Name: counterparties id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterparties ALTER COLUMN id SET DEFAULT nextval('public.counterparties_id_seq'::regclass);


--
-- Name: crops id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crops ALTER COLUMN id SET DEFAULT nextval('public.crops_id_seq'::regclass);


--
-- Name: factory_areas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_areas ALTER COLUMN id SET DEFAULT nextval('public.factory_areas_id_seq'::regclass);


--
-- Name: grades id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grades ALTER COLUMN id SET DEFAULT nextval('public.grades_id_seq'::regclass);


--
-- Name: inbound_lots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_lots ALTER COLUMN id SET DEFAULT nextval('public.inbound_lots_id_seq'::regclass);


--
-- Name: lot_reservations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lot_reservations ALTER COLUMN id SET DEFAULT nextval('public.lot_reservations_id_seq'::regclass);


--
-- Name: material_counts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_counts ALTER COLUMN id SET DEFAULT nextval('public.material_counts_id_seq'::regclass);


--
-- Name: material_movements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_movements ALTER COLUMN id SET DEFAULT nextval('public.material_movements_id_seq'::regclass);


--
-- Name: materials id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.materials ALTER COLUMN id SET DEFAULT nextval('public.materials_id_seq'::regclass);


--
-- Name: migration_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migration_log ALTER COLUMN id SET DEFAULT nextval('public.migration_log_id_seq'::regclass);


--
-- Name: origins id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.origins ALTER COLUMN id SET DEFAULT nextval('public.origins_id_seq'::regclass);


--
-- Name: outbound_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_orders ALTER COLUMN id SET DEFAULT nextval('public.outbound_orders_id_seq'::regclass);


--
-- Name: outbound_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_records ALTER COLUMN id SET DEFAULT nextval('public.outbound_records_id_seq'::regclass);


--
-- Name: product_material_usage id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_material_usage ALTER COLUMN id SET DEFAULT nextval('public.product_material_usage_id_seq'::regclass);


--
-- Name: products id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products ALTER COLUMN id SET DEFAULT nextval('public.products_id_seq'::regclass);


--
-- Name: products_shipped id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products_shipped ALTER COLUMN id SET DEFAULT nextval('public.products_shipped_id_seq'::regclass);


--
-- Name: recipe_submission_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_submission_lines ALTER COLUMN id SET DEFAULT nextval('public.recipe_submission_lines_id_seq'::regclass);


--
-- Name: recipe_submissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_submissions ALTER COLUMN id SET DEFAULT nextval('public.recipe_submissions_id_seq'::regclass);


--
-- Name: selection_operations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_operations ALTER COLUMN id SET DEFAULT nextval('public.selection_operations_id_seq'::regclass);


--
-- Name: selection_sources id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_sources ALTER COLUMN id SET DEFAULT nextval('public.selection_sources_id_seq'::regclass);


--
-- Name: semifinished_lots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semifinished_lots ALTER COLUMN id SET DEFAULT nextval('public.semifinished_lots_id_seq'::regclass);


--
-- Name: semifinished_outbound_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semifinished_outbound_records ALTER COLUMN id SET DEFAULT nextval('public.semifinished_outbound_records_id_seq'::regclass);


--
-- Name: shipment_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_records ALTER COLUMN id SET DEFAULT nextval('public.shipment_records_id_seq'::regclass);


--
-- Name: stock_counts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_counts ALTER COLUMN id SET DEFAULT nextval('public.stock_counts_id_seq'::regclass);


--
-- Name: storage_layouts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_layouts ALTER COLUMN id SET DEFAULT nextval('public.storage_layouts_id_seq'::regclass);


--
-- Name: storage_object_inventory_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_object_inventory_entries ALTER COLUMN id SET DEFAULT nextval('public.storage_object_inventory_entries_id_seq'::regclass);


--
-- Name: storage_object_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_object_items ALTER COLUMN id SET DEFAULT nextval('public.storage_object_items_id_seq'::regclass);


--
-- Name: storage_objects id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_objects ALTER COLUMN id SET DEFAULT nextval('public.storage_objects_id_seq'::regclass);


--
-- Name: storage_walls id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_walls ALTER COLUMN id SET DEFAULT nextval('public.storage_walls_id_seq'::regclass);


--
-- Name: substitution_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitution_rules ALTER COLUMN id SET DEFAULT nextval('public.substitution_rules_id_seq'::regclass);


--
-- Name: suppliers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers ALTER COLUMN id SET DEFAULT nextval('public.suppliers_id_seq'::regclass);


--
-- Name: area_stocktakes area_stocktakes_area_id_count_date_asset_type_id_logo_id_ca_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.area_stocktakes
    ADD CONSTRAINT area_stocktakes_area_id_count_date_asset_type_id_logo_id_ca_key UNIQUE (area_id, count_date, asset_type_id, logo_id, category_id);


--
-- Name: area_stocktakes area_stocktakes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.area_stocktakes
    ADD CONSTRAINT area_stocktakes_pkey PRIMARY KEY (id);


--
-- Name: asset_categories asset_categories_asset_type_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_categories
    ADD CONSTRAINT asset_categories_asset_type_id_name_key UNIQUE (asset_type_id, name);


--
-- Name: asset_categories asset_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_categories
    ADD CONSTRAINT asset_categories_pkey PRIMARY KEY (id);


--
-- Name: asset_loans asset_loans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_loans
    ADD CONSTRAINT asset_loans_pkey PRIMARY KEY (id);


--
-- Name: asset_logos asset_logos_asset_type_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_logos
    ADD CONSTRAINT asset_logos_asset_type_id_name_key UNIQUE (asset_type_id, name);


--
-- Name: asset_logos asset_logos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_logos
    ADD CONSTRAINT asset_logos_pkey PRIMARY KEY (id);


--
-- Name: asset_movements asset_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_movements
    ADD CONSTRAINT asset_movements_pkey PRIMARY KEY (id);


--
-- Name: asset_purchase_records asset_purchase_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_purchase_records
    ADD CONSTRAINT asset_purchase_records_pkey PRIMARY KEY (id);


--
-- Name: asset_stocktakes asset_stocktakes_asset_type_id_logo_id_category_id_count_da_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_stocktakes
    ADD CONSTRAINT asset_stocktakes_asset_type_id_logo_id_category_id_count_da_key UNIQUE (asset_type_id, logo_id, category_id, count_date);


--
-- Name: asset_stocktakes asset_stocktakes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_stocktakes
    ADD CONSTRAINT asset_stocktakes_pkey PRIMARY KEY (id);


--
-- Name: asset_types asset_types_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_types
    ADD CONSTRAINT asset_types_code_key UNIQUE (code);


--
-- Name: asset_types asset_types_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_types
    ADD CONSTRAINT asset_types_name_key UNIQUE (name);


--
-- Name: asset_types asset_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_types
    ADD CONSTRAINT asset_types_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: calendar_cell_comments calendar_cell_comments_lot_id_comment_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_cell_comments
    ADD CONSTRAINT calendar_cell_comments_lot_id_comment_date_key UNIQUE (lot_id, comment_date);


--
-- Name: calendar_cell_comments calendar_cell_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_cell_comments
    ADD CONSTRAINT calendar_cell_comments_pkey PRIMARY KEY (id);


--
-- Name: client_logs client_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_logs
    ADD CONSTRAINT client_logs_pkey PRIMARY KEY (id);


--
-- Name: correction_records correction_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correction_records
    ADD CONSTRAINT correction_records_pkey PRIMARY KEY (id);


--
-- Name: counterparties counterparties_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterparties
    ADD CONSTRAINT counterparties_name_key UNIQUE (name);


--
-- Name: counterparties counterparties_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterparties
    ADD CONSTRAINT counterparties_pkey PRIMARY KEY (id);


--
-- Name: crops crops_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crops
    ADD CONSTRAINT crops_code_key UNIQUE (code);


--
-- Name: crops crops_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crops
    ADD CONSTRAINT crops_name_key UNIQUE (name);


--
-- Name: crops crops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crops
    ADD CONSTRAINT crops_pkey PRIMARY KEY (id);


--
-- Name: factory_areas factory_areas_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_areas
    ADD CONSTRAINT factory_areas_name_key UNIQUE (name);


--
-- Name: factory_areas factory_areas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_areas
    ADD CONSTRAINT factory_areas_pkey PRIMARY KEY (id);


--
-- Name: grades grades_business_key_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grades
    ADD CONSTRAINT grades_business_key_uq UNIQUE (spec_type, grade_level, size_label);


--
-- Name: grades grades_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grades
    ADD CONSTRAINT grades_pkey PRIMARY KEY (id);


--
-- Name: inbound_lots inbound_lots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_lots
    ADD CONSTRAINT inbound_lots_pkey PRIMARY KEY (id);


--
-- Name: lot_reservations lot_reservations_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lot_reservations
    ADD CONSTRAINT lot_reservations_code_key UNIQUE (code);


--
-- Name: lot_reservations lot_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lot_reservations
    ADD CONSTRAINT lot_reservations_pkey PRIMARY KEY (id);


--
-- Name: material_counts material_counts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_counts
    ADD CONSTRAINT material_counts_pkey PRIMARY KEY (id);


--
-- Name: material_movements material_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_movements
    ADD CONSTRAINT material_movements_pkey PRIMARY KEY (id);


--
-- Name: materials materials_business_key_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.materials
    ADD CONSTRAINT materials_business_key_uq UNIQUE (division, supplier_id, item_name);


--
-- Name: materials materials_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.materials
    ADD CONSTRAINT materials_code_key UNIQUE (code);


--
-- Name: materials materials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.materials
    ADD CONSTRAINT materials_pkey PRIMARY KEY (id);


--
-- Name: migration_log migration_log_migration_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migration_log
    ADD CONSTRAINT migration_log_migration_name_key UNIQUE (migration_name);


--
-- Name: migration_log migration_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migration_log
    ADD CONSTRAINT migration_log_pkey PRIMARY KEY (id);


--
-- Name: origins origins_name_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.origins
    ADD CONSTRAINT origins_name_uq UNIQUE (name);


--
-- Name: origins origins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.origins
    ADD CONSTRAINT origins_pkey PRIMARY KEY (id);


--
-- Name: outbound_orders outbound_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_orders
    ADD CONSTRAINT outbound_orders_pkey PRIMARY KEY (id);


--
-- Name: outbound_records outbound_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_records
    ADD CONSTRAINT outbound_records_pkey PRIMARY KEY (id);


--
-- Name: product_bom product_bom_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_bom
    ADD CONSTRAINT product_bom_pkey PRIMARY KEY (product_code);


--
-- Name: product_material_usage product_material_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_material_usage
    ADD CONSTRAINT product_material_usage_pkey PRIMARY KEY (id);


--
-- Name: products products_business_key_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_business_key_uq UNIQUE (grade_id, origin_id, crop_id);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: products_shipped products_shipped_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products_shipped
    ADD CONSTRAINT products_shipped_pkey PRIMARY KEY (id);


--
-- Name: recipe_submission_lines recipe_submission_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_submission_lines
    ADD CONSTRAINT recipe_submission_lines_pkey PRIMARY KEY (id);


--
-- Name: recipe_submissions recipe_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_submissions
    ADD CONSTRAINT recipe_submissions_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: selection_operations selection_operations_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_operations
    ADD CONSTRAINT selection_operations_code_key UNIQUE (code);


--
-- Name: selection_operations selection_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_operations
    ADD CONSTRAINT selection_operations_pkey PRIMARY KEY (id);


--
-- Name: selection_sources selection_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_sources
    ADD CONSTRAINT selection_sources_pkey PRIMARY KEY (id);


--
-- Name: semifinished_lots semifinished_lots_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semifinished_lots
    ADD CONSTRAINT semifinished_lots_code_key UNIQUE (code);


--
-- Name: semifinished_lots semifinished_lots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semifinished_lots
    ADD CONSTRAINT semifinished_lots_pkey PRIMARY KEY (id);


--
-- Name: semifinished_lots semifinished_lots_source_outbound_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semifinished_lots
    ADD CONSTRAINT semifinished_lots_source_outbound_id_key UNIQUE (source_outbound_id);


--
-- Name: semifinished_outbound_records semifinished_outbound_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semifinished_outbound_records
    ADD CONSTRAINT semifinished_outbound_records_pkey PRIMARY KEY (id);


--
-- Name: shipment_records shipment_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_records
    ADD CONSTRAINT shipment_records_pkey PRIMARY KEY (id);


--
-- Name: stock_counts stock_counts_lot_period_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_counts
    ADD CONSTRAINT stock_counts_lot_period_uq UNIQUE (lot_id, period);


--
-- Name: stock_counts stock_counts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_counts
    ADD CONSTRAINT stock_counts_pkey PRIMARY KEY (id);


--
-- Name: storage_layout_sheet_meta storage_layout_sheet_meta_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_layout_sheet_meta
    ADD CONSTRAINT storage_layout_sheet_meta_pkey PRIMARY KEY (layout_id);


--
-- Name: storage_layouts storage_layouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_layouts
    ADD CONSTRAINT storage_layouts_pkey PRIMARY KEY (id);


--
-- Name: storage_object_inventory_entries storage_object_inventory_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_object_inventory_entries
    ADD CONSTRAINT storage_object_inventory_entries_pkey PRIMARY KEY (id);


--
-- Name: storage_object_items storage_object_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_object_items
    ADD CONSTRAINT storage_object_items_pkey PRIMARY KEY (id);


--
-- Name: storage_objects storage_objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_objects
    ADD CONSTRAINT storage_objects_pkey PRIMARY KEY (id);


--
-- Name: storage_walls storage_walls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_walls
    ADD CONSTRAINT storage_walls_pkey PRIMARY KEY (id);


--
-- Name: substitution_rules substitution_rules_crop_id_origin_id_product_grade_id_prior_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitution_rules
    ADD CONSTRAINT substitution_rules_crop_id_origin_id_product_grade_id_prior_key UNIQUE (crop_id, origin_id, from_grade_id, priority);


--
-- Name: substitution_rules substitution_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitution_rules
    ADD CONSTRAINT substitution_rules_pkey PRIMARY KEY (id);


--
-- Name: suppliers suppliers_name_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_name_uq UNIQUE (name);


--
-- Name: suppliers suppliers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_pkey PRIMARY KEY (id);


--
-- Name: users users_device_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_device_token_key UNIQUE (device_token);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: area_stocktakes_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX area_stocktakes_date_idx ON public.area_stocktakes USING btree (count_date DESC);


--
-- Name: asset_categories_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_categories_type_idx ON public.asset_categories USING btree (asset_type_id);


--
-- Name: asset_loans_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_loans_open_idx ON public.asset_loans USING btree (counterparty_id, asset_type_id) WHERE (returned_at IS NULL);


--
-- Name: asset_logos_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_logos_type_idx ON public.asset_logos USING btree (asset_type_id);


--
-- Name: asset_movements_counterparty_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_movements_counterparty_idx ON public.asset_movements USING btree (counterparty_id);


--
-- Name: asset_movements_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_movements_kind_idx ON public.asset_movements USING btree (kind);


--
-- Name: asset_movements_type_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_movements_type_date_idx ON public.asset_movements USING btree (asset_type_id, movement_date DESC);


--
-- Name: asset_purchase_movement_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_purchase_movement_idx ON public.asset_purchase_records USING btree (movement_id) WHERE (movement_id IS NOT NULL);


--
-- Name: asset_purchase_type_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_purchase_type_date_idx ON public.asset_purchase_records USING btree (asset_type_id, purchase_date DESC);


--
-- Name: asset_stocktakes_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_stocktakes_date_idx ON public.asset_stocktakes USING btree (count_date DESC);


--
-- Name: audit_log_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_actor_idx ON public.audit_log USING btree (actor_id);


--
-- Name: audit_log_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_occurred_at_idx ON public.audit_log USING btree (occurred_at DESC);


--
-- Name: audit_log_record_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_record_idx ON public.audit_log USING btree (table_name, record_id);


--
-- Name: calendar_cell_comments_lot_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calendar_cell_comments_lot_date_idx ON public.calendar_cell_comments USING btree (lot_id, comment_date);


--
-- Name: counterparties_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX counterparties_kind_idx ON public.counterparties USING btree (kind, is_active);


--
-- Name: idx_client_logs_level_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_logs_level_time ON public.client_logs USING btree (level, occurred_at DESC);


--
-- Name: idx_client_logs_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_logs_time ON public.client_logs USING btree (occurred_at DESC);


--
-- Name: idx_client_logs_user_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_logs_user_time ON public.client_logs USING btree (user_id, occurred_at DESC);


--
-- Name: inbound_lots_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbound_lots_active_idx ON public.inbound_lots USING btree (id) WHERE (archived_at IS NULL);


--
-- Name: inbound_lots_archived_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbound_lots_archived_idx ON public.inbound_lots USING btree (archived_at) WHERE (archived_at IS NOT NULL);


--
-- Name: inbound_lots_code_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inbound_lots_code_uq ON public.inbound_lots USING btree (code);


--
-- Name: inbound_lots_price_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbound_lots_price_pending_idx ON public.inbound_lots USING btree (inbound_date DESC) WHERE (unit_price IS NULL);


--
-- Name: inbound_lots_product_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbound_lots_product_date_idx ON public.inbound_lots USING btree (product_id, inbound_date, id);


--
-- Name: inbound_lots_selection_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbound_lots_selection_idx ON public.inbound_lots USING btree (selection_id) WHERE (selection_id IS NOT NULL);


--
-- Name: lot_reservations_consumed_lot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lot_reservations_consumed_lot_idx ON public.lot_reservations USING btree (consumed_inbound_id) WHERE (consumed_inbound_id IS NOT NULL);


--
-- Name: lot_reservations_unused_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lot_reservations_unused_idx ON public.lot_reservations USING btree (crop_id, code_kind, created_at) WHERE (consumed_at IS NULL);


--
-- Name: material_counts_material_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX material_counts_material_idx ON public.material_counts USING btree (material_id, count_date DESC);


--
-- Name: material_counts_object_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX material_counts_object_date_idx ON public.material_counts USING btree (object_id, count_date DESC) WHERE (object_id IS NOT NULL);


--
-- Name: material_counts_uq_per_object; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX material_counts_uq_per_object ON public.material_counts USING btree (material_id, count_date, COALESCE(object_id, 0));


--
-- Name: material_movements_material_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX material_movements_material_date_idx ON public.material_movements USING btree (material_id, movement_date);


--
-- Name: materials_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX materials_category_idx ON public.materials USING btree (category) WHERE (category IS NOT NULL);


--
-- Name: materials_length_per_roll_cm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX materials_length_per_roll_cm_idx ON public.materials USING btree (length_per_roll_cm) WHERE (length_per_roll_cm IS NOT NULL);


--
-- Name: outbound_orders_batch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_orders_batch_idx ON public.outbound_orders USING btree (batch_id) WHERE (batch_id IS NOT NULL);


--
-- Name: outbound_orders_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_orders_date_idx ON public.outbound_orders USING btree (outbound_date);


--
-- Name: outbound_orders_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_orders_lookup_idx ON public.outbound_orders USING btree (crop_id, origin_id, from_grade_id);


--
-- Name: outbound_records_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_records_date_idx ON public.outbound_records USING btree (outbound_date DESC);


--
-- Name: outbound_records_lot_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_records_lot_date_idx ON public.outbound_records USING btree (lot_id, outbound_date);


--
-- Name: outbound_records_lot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_records_lot_idx ON public.outbound_records USING btree (lot_id);


--
-- Name: outbound_records_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_records_order_idx ON public.outbound_records USING btree (order_id) WHERE (order_id IS NOT NULL);


--
-- Name: outbound_records_purpose_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_records_purpose_idx ON public.outbound_records USING btree (purpose) WHERE (purpose IS NOT NULL);


--
-- Name: outbound_records_selection_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_records_selection_idx ON public.outbound_records USING btree (selection_id) WHERE (selection_id IS NOT NULL);


--
-- Name: product_bom_crop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_bom_crop_idx ON public.product_bom USING btree (crop_id);


--
-- Name: product_bom_grade_1_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_bom_grade_1_idx ON public.product_bom USING btree (grade_id_1) WHERE (grade_id_1 IS NOT NULL);


--
-- Name: product_bom_origin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_bom_origin_idx ON public.product_bom USING btree (origin_id) WHERE (origin_id IS NOT NULL);


--
-- Name: product_material_usage_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX product_material_usage_uq ON public.product_material_usage USING btree (product_id, material_id, COALESCE(department_code, '__DEFAULT__'::text));


--
-- Name: products_crop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX products_crop_idx ON public.products USING btree (crop_id);


--
-- Name: products_grade_origin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX products_grade_origin_idx ON public.products USING btree (grade_id, origin_id);


--
-- Name: products_shipped_product_code_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX products_shipped_product_code_uq ON public.products_shipped USING btree (product_code) WHERE (product_code IS NOT NULL);


--
-- Name: products_sub_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX products_sub_kind_idx ON public.products USING btree (sub_kind) WHERE (sub_kind IS NOT NULL);


--
-- Name: recipe_submission_lines_material_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recipe_submission_lines_material_idx ON public.recipe_submission_lines USING btree (material_id);


--
-- Name: recipe_submission_lines_product_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recipe_submission_lines_product_idx ON public.recipe_submission_lines USING btree (product_id);


--
-- Name: recipe_submission_lines_submission_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recipe_submission_lines_submission_idx ON public.recipe_submission_lines USING btree (submission_id);


--
-- Name: recipe_submissions_division_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recipe_submissions_division_idx ON public.recipe_submissions USING btree (division_code, status);


--
-- Name: recipe_submissions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recipe_submissions_status_idx ON public.recipe_submissions USING btree (status, submitted_at DESC);


--
-- Name: selection_operations_crop_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX selection_operations_crop_date_idx ON public.selection_operations USING btree (crop_id, operation_date DESC);


--
-- Name: selection_operations_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX selection_operations_source_idx ON public.selection_operations USING btree (source_lot_id);


--
-- Name: selection_sources_lot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX selection_sources_lot_idx ON public.selection_sources USING btree (lot_id);


--
-- Name: selection_sources_sel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX selection_sources_sel_idx ON public.selection_sources USING btree (selection_id);


--
-- Name: semifinished_lots_inbound_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX semifinished_lots_inbound_date_idx ON public.semifinished_lots USING btree (inbound_date);


--
-- Name: semifinished_lots_product_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX semifinished_lots_product_idx ON public.semifinished_lots USING btree (product_id);


--
-- Name: semifinished_lots_selection_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX semifinished_lots_selection_idx ON public.semifinished_lots USING btree (selection_id) WHERE (selection_id IS NOT NULL);


--
-- Name: semifinished_outbound_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX semifinished_outbound_date_idx ON public.semifinished_outbound_records USING btree (outbound_date);


--
-- Name: semifinished_outbound_lot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX semifinished_outbound_lot_idx ON public.semifinished_outbound_records USING btree (semifinished_lot_id);


--
-- Name: shipment_records_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shipment_records_date_idx ON public.shipment_records USING btree (ship_date);


--
-- Name: shipment_records_dispatch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shipment_records_dispatch_idx ON public.shipment_records USING btree (dispatch_from) WHERE (dispatch_from IS NOT NULL);


--
-- Name: shipment_records_product_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shipment_records_product_date_idx ON public.shipment_records USING btree (product_id, ship_date);


--
-- Name: stock_counts_lot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stock_counts_lot_idx ON public.stock_counts USING btree (lot_id, count_date DESC);


--
-- Name: storage_obj_inv_entries_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_obj_inv_entries_date_idx ON public.storage_object_inventory_entries USING btree (inventory_date);


--
-- Name: storage_obj_inv_entries_lot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_obj_inv_entries_lot_idx ON public.storage_object_inventory_entries USING btree (inbound_lot_id) WHERE (inbound_lot_id IS NOT NULL);


--
-- Name: storage_obj_inv_entries_object_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_obj_inv_entries_object_idx ON public.storage_object_inventory_entries USING btree (object_id);


--
-- Name: storage_obj_inv_entries_sl_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_obj_inv_entries_sl_idx ON public.storage_object_inventory_entries USING btree (semifinished_lot_id) WHERE (semifinished_lot_id IS NOT NULL);


--
-- Name: storage_obj_inv_entries_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX storage_obj_inv_entries_unique_idx ON public.storage_object_inventory_entries USING btree (object_id, inventory_date, COALESCE(name, ''::text));


--
-- Name: storage_object_items_lot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_object_items_lot_idx ON public.storage_object_items USING btree (inbound_lot_id) WHERE (inbound_lot_id IS NOT NULL);


--
-- Name: storage_object_items_material_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_object_items_material_idx ON public.storage_object_items USING btree (material_id) WHERE (material_id IS NOT NULL);


--
-- Name: storage_object_items_object_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_object_items_object_idx ON public.storage_object_items USING btree (object_id);


--
-- Name: storage_object_items_semifin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_object_items_semifin_idx ON public.storage_object_items USING btree (semifinished_lot_id) WHERE (semifinished_lot_id IS NOT NULL);


--
-- Name: storage_objects_layout_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_objects_layout_idx ON public.storage_objects USING btree (layout_id);


--
-- Name: storage_walls_layout_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_walls_layout_idx ON public.storage_walls USING btree (layout_id);


--
-- Name: substitution_rules_from_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX substitution_rules_from_lookup_idx ON public.substitution_rules USING btree (crop_id, origin_id, from_grade_id, priority) WHERE (is_active = true);


--
-- Name: users_divisions_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_divisions_idx ON public.users USING gin (divisions) WHERE (divisions <> '{}'::integer[]);


--
-- Name: calendar_cell_comments trg_calendar_cell_comments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_calendar_cell_comments_updated_at BEFORE UPDATE ON public.calendar_cell_comments FOR EACH ROW EXECUTE FUNCTION public.trg_calendar_cell_comments_set_updated_at();


--
-- Name: outbound_records trg_check_stock_before_outbound; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_check_stock_before_outbound BEFORE INSERT ON public.outbound_records FOR EACH ROW EXECUTE FUNCTION public.check_stock_before_outbound();


--
-- Name: grades trg_grades_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_grades_updated_at BEFORE UPDATE ON public.grades FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: inbound_lots trg_inbound_lots_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_inbound_lots_updated_at BEFORE UPDATE ON public.inbound_lots FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: origins trg_origins_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_origins_updated_at BEFORE UPDATE ON public.origins FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: products trg_products_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_products_updated_at BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: storage_layout_sheet_meta trg_storage_layout_sheet_meta_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_storage_layout_sheet_meta_updated_at BEFORE UPDATE ON public.storage_layout_sheet_meta FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: storage_layouts trg_storage_layouts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_storage_layouts_updated_at BEFORE UPDATE ON public.storage_layouts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: storage_object_inventory_entries trg_storage_obj_inv_entries_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_storage_obj_inv_entries_updated_at BEFORE UPDATE ON public.storage_object_inventory_entries FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: storage_objects trg_storage_objects_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_storage_objects_updated_at BEFORE UPDATE ON public.storage_objects FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: suppliers trg_suppliers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_suppliers_updated_at BEFORE UPDATE ON public.suppliers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: users trg_users_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: product_material_usage trg_validate_alt_material_ids; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_alt_material_ids BEFORE INSERT OR UPDATE ON public.product_material_usage FOR EACH ROW EXECUTE FUNCTION public.validate_alt_material_ids();


--
-- Name: area_stocktakes area_stocktakes_area_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.area_stocktakes
    ADD CONSTRAINT area_stocktakes_area_id_fkey FOREIGN KEY (area_id) REFERENCES public.factory_areas(id) ON DELETE CASCADE;


--
-- Name: area_stocktakes area_stocktakes_asset_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.area_stocktakes
    ADD CONSTRAINT area_stocktakes_asset_type_id_fkey FOREIGN KEY (asset_type_id) REFERENCES public.asset_types(id);


--
-- Name: area_stocktakes area_stocktakes_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.area_stocktakes
    ADD CONSTRAINT area_stocktakes_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.asset_categories(id);


--
-- Name: area_stocktakes area_stocktakes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.area_stocktakes
    ADD CONSTRAINT area_stocktakes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: area_stocktakes area_stocktakes_logo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.area_stocktakes
    ADD CONSTRAINT area_stocktakes_logo_id_fkey FOREIGN KEY (logo_id) REFERENCES public.asset_logos(id);


--
-- Name: asset_categories asset_categories_asset_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_categories
    ADD CONSTRAINT asset_categories_asset_type_id_fkey FOREIGN KEY (asset_type_id) REFERENCES public.asset_types(id) ON DELETE CASCADE;


--
-- Name: asset_loans asset_loans_asset_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_loans
    ADD CONSTRAINT asset_loans_asset_type_id_fkey FOREIGN KEY (asset_type_id) REFERENCES public.asset_types(id);


--
-- Name: asset_loans asset_loans_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_loans
    ADD CONSTRAINT asset_loans_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.asset_categories(id);


--
-- Name: asset_loans asset_loans_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_loans
    ADD CONSTRAINT asset_loans_counterparty_id_fkey FOREIGN KEY (counterparty_id) REFERENCES public.counterparties(id);


--
-- Name: asset_loans asset_loans_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_loans
    ADD CONSTRAINT asset_loans_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: asset_loans asset_loans_logo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_loans
    ADD CONSTRAINT asset_loans_logo_id_fkey FOREIGN KEY (logo_id) REFERENCES public.asset_logos(id);


--
-- Name: asset_loans asset_loans_out_movement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_loans
    ADD CONSTRAINT asset_loans_out_movement_id_fkey FOREIGN KEY (out_movement_id) REFERENCES public.asset_movements(id);


--
-- Name: asset_loans asset_loans_return_movement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_loans
    ADD CONSTRAINT asset_loans_return_movement_id_fkey FOREIGN KEY (return_movement_id) REFERENCES public.asset_movements(id);


--
-- Name: asset_logos asset_logos_asset_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_logos
    ADD CONSTRAINT asset_logos_asset_type_id_fkey FOREIGN KEY (asset_type_id) REFERENCES public.asset_types(id) ON DELETE CASCADE;


--
-- Name: asset_movements asset_movements_asset_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_movements
    ADD CONSTRAINT asset_movements_asset_type_id_fkey FOREIGN KEY (asset_type_id) REFERENCES public.asset_types(id);


--
-- Name: asset_movements asset_movements_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_movements
    ADD CONSTRAINT asset_movements_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.asset_categories(id);


--
-- Name: asset_movements asset_movements_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_movements
    ADD CONSTRAINT asset_movements_counterparty_id_fkey FOREIGN KEY (counterparty_id) REFERENCES public.counterparties(id);


--
-- Name: asset_movements asset_movements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_movements
    ADD CONSTRAINT asset_movements_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: asset_movements asset_movements_loan_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_movements
    ADD CONSTRAINT asset_movements_loan_fk FOREIGN KEY (loan_id) REFERENCES public.asset_loans(id);


--
-- Name: asset_movements asset_movements_logo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_movements
    ADD CONSTRAINT asset_movements_logo_id_fkey FOREIGN KEY (logo_id) REFERENCES public.asset_logos(id);


--
-- Name: asset_purchase_records asset_purchase_records_asset_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_purchase_records
    ADD CONSTRAINT asset_purchase_records_asset_type_id_fkey FOREIGN KEY (asset_type_id) REFERENCES public.asset_types(id);


--
-- Name: asset_purchase_records asset_purchase_records_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_purchase_records
    ADD CONSTRAINT asset_purchase_records_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.asset_categories(id);


--
-- Name: asset_purchase_records asset_purchase_records_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_purchase_records
    ADD CONSTRAINT asset_purchase_records_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: asset_purchase_records asset_purchase_records_logo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_purchase_records
    ADD CONSTRAINT asset_purchase_records_logo_id_fkey FOREIGN KEY (logo_id) REFERENCES public.asset_logos(id);


--
-- Name: asset_purchase_records asset_purchase_records_movement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_purchase_records
    ADD CONSTRAINT asset_purchase_records_movement_id_fkey FOREIGN KEY (movement_id) REFERENCES public.asset_movements(id) ON DELETE CASCADE;


--
-- Name: asset_purchase_records asset_purchase_records_storage_factory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_purchase_records
    ADD CONSTRAINT asset_purchase_records_storage_factory_id_fkey FOREIGN KEY (storage_factory_id) REFERENCES public.counterparties(id);


--
-- Name: asset_stocktakes asset_stocktakes_asset_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_stocktakes
    ADD CONSTRAINT asset_stocktakes_asset_type_id_fkey FOREIGN KEY (asset_type_id) REFERENCES public.asset_types(id);


--
-- Name: asset_stocktakes asset_stocktakes_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_stocktakes
    ADD CONSTRAINT asset_stocktakes_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.asset_categories(id);


--
-- Name: asset_stocktakes asset_stocktakes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_stocktakes
    ADD CONSTRAINT asset_stocktakes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: asset_stocktakes asset_stocktakes_logo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_stocktakes
    ADD CONSTRAINT asset_stocktakes_logo_id_fkey FOREIGN KEY (logo_id) REFERENCES public.asset_logos(id);


--
-- Name: audit_log audit_log_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id);


--
-- Name: calendar_cell_comments calendar_cell_comments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_cell_comments
    ADD CONSTRAINT calendar_cell_comments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: calendar_cell_comments calendar_cell_comments_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_cell_comments
    ADD CONSTRAINT calendar_cell_comments_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES public.inbound_lots(id) ON DELETE CASCADE;


--
-- Name: client_logs client_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_logs
    ADD CONSTRAINT client_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: correction_records correction_records_corrected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correction_records
    ADD CONSTRAINT correction_records_corrected_by_fkey FOREIGN KEY (corrected_by) REFERENCES public.users(id);


--
-- Name: factory_areas factory_areas_manager_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_areas
    ADD CONSTRAINT factory_areas_manager_user_id_fkey FOREIGN KEY (manager_user_id) REFERENCES public.users(id);


--
-- Name: inbound_lots inbound_lots_archived_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_lots
    ADD CONSTRAINT inbound_lots_archived_by_fkey FOREIGN KEY (archived_by) REFERENCES public.users(id);


--
-- Name: inbound_lots inbound_lots_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_lots
    ADD CONSTRAINT inbound_lots_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: inbound_lots inbound_lots_price_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_lots
    ADD CONSTRAINT inbound_lots_price_confirmed_by_fkey FOREIGN KEY (price_confirmed_by) REFERENCES public.users(id);


--
-- Name: inbound_lots inbound_lots_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_lots
    ADD CONSTRAINT inbound_lots_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: inbound_lots inbound_lots_selection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_lots
    ADD CONSTRAINT inbound_lots_selection_id_fkey FOREIGN KEY (selection_id) REFERENCES public.selection_operations(id);


--
-- Name: inbound_lots inbound_lots_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_lots
    ADD CONSTRAINT inbound_lots_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: lot_reservations lot_reservations_consumed_inbound_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lot_reservations
    ADD CONSTRAINT lot_reservations_consumed_inbound_id_fkey FOREIGN KEY (consumed_inbound_id) REFERENCES public.inbound_lots(id);


--
-- Name: lot_reservations lot_reservations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lot_reservations
    ADD CONSTRAINT lot_reservations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: lot_reservations lot_reservations_crop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lot_reservations
    ADD CONSTRAINT lot_reservations_crop_id_fkey FOREIGN KEY (crop_id) REFERENCES public.crops(id);


--
-- Name: material_counts material_counts_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_counts
    ADD CONSTRAINT material_counts_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.users(id);


--
-- Name: material_counts material_counts_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_counts
    ADD CONSTRAINT material_counts_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.materials(id);


--
-- Name: material_counts material_counts_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_counts
    ADD CONSTRAINT material_counts_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.storage_objects(id) ON DELETE SET NULL;


--
-- Name: material_movements material_movements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_movements
    ADD CONSTRAINT material_movements_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: material_movements material_movements_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_movements
    ADD CONSTRAINT material_movements_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.materials(id);


--
-- Name: materials materials_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.materials
    ADD CONSTRAINT materials_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: outbound_orders outbound_orders_crop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_orders
    ADD CONSTRAINT outbound_orders_crop_id_fkey FOREIGN KEY (crop_id) REFERENCES public.crops(id);


--
-- Name: outbound_orders outbound_orders_origin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_orders
    ADD CONSTRAINT outbound_orders_origin_id_fkey FOREIGN KEY (origin_id) REFERENCES public.origins(id);


--
-- Name: outbound_orders outbound_orders_product_grade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_orders
    ADD CONSTRAINT outbound_orders_product_grade_id_fkey FOREIGN KEY (from_grade_id) REFERENCES public.grades(id);


--
-- Name: outbound_records outbound_records_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_records
    ADD CONSTRAINT outbound_records_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: outbound_records outbound_records_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_records
    ADD CONSTRAINT outbound_records_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES public.inbound_lots(id);


--
-- Name: outbound_records outbound_records_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_records
    ADD CONSTRAINT outbound_records_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.outbound_orders(id) ON DELETE SET NULL;


--
-- Name: outbound_records outbound_records_selection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_records
    ADD CONSTRAINT outbound_records_selection_id_fkey FOREIGN KEY (selection_id) REFERENCES public.selection_operations(id);


--
-- Name: product_bom product_bom_crop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_bom
    ADD CONSTRAINT product_bom_crop_id_fkey FOREIGN KEY (crop_id) REFERENCES public.crops(id);


--
-- Name: product_bom product_bom_grade_id_1_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_bom
    ADD CONSTRAINT product_bom_grade_id_1_fkey FOREIGN KEY (grade_id_1) REFERENCES public.grades(id);


--
-- Name: product_bom product_bom_grade_id_2_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_bom
    ADD CONSTRAINT product_bom_grade_id_2_fkey FOREIGN KEY (grade_id_2) REFERENCES public.grades(id);


--
-- Name: product_bom product_bom_origin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_bom
    ADD CONSTRAINT product_bom_origin_id_fkey FOREIGN KEY (origin_id) REFERENCES public.origins(id);


--
-- Name: product_material_usage product_material_usage_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_material_usage
    ADD CONSTRAINT product_material_usage_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.materials(id);


--
-- Name: product_material_usage product_material_usage_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_material_usage
    ADD CONSTRAINT product_material_usage_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products_shipped(id);


--
-- Name: products products_crop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_crop_id_fkey FOREIGN KEY (crop_id) REFERENCES public.crops(id);


--
-- Name: products products_grade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_grade_id_fkey FOREIGN KEY (grade_id) REFERENCES public.grades(id);


--
-- Name: products products_origin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_origin_id_fkey FOREIGN KEY (origin_id) REFERENCES public.origins(id);


--
-- Name: recipe_submission_lines recipe_submission_lines_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_submission_lines
    ADD CONSTRAINT recipe_submission_lines_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.materials(id);


--
-- Name: recipe_submission_lines recipe_submission_lines_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_submission_lines
    ADD CONSTRAINT recipe_submission_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products_shipped(id);


--
-- Name: recipe_submission_lines recipe_submission_lines_submission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_submission_lines
    ADD CONSTRAINT recipe_submission_lines_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES public.recipe_submissions(id) ON DELETE CASCADE;


--
-- Name: recipe_submissions recipe_submissions_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_submissions
    ADD CONSTRAINT recipe_submissions_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);


--
-- Name: selection_operations selection_operations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_operations
    ADD CONSTRAINT selection_operations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: selection_operations selection_operations_crop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_operations
    ADD CONSTRAINT selection_operations_crop_id_fkey FOREIGN KEY (crop_id) REFERENCES public.crops(id);


--
-- Name: selection_operations selection_operations_source_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_operations
    ADD CONSTRAINT selection_operations_source_lot_id_fkey FOREIGN KEY (source_lot_id) REFERENCES public.inbound_lots(id);


--
-- Name: selection_sources selection_sources_consume_outbound_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_sources
    ADD CONSTRAINT selection_sources_consume_outbound_id_fkey FOREIGN KEY (consume_outbound_id) REFERENCES public.outbound_records(id) ON DELETE SET NULL;


--
-- Name: selection_sources selection_sources_disposal_outbound_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_sources
    ADD CONSTRAINT selection_sources_disposal_outbound_id_fkey FOREIGN KEY (disposal_outbound_id) REFERENCES public.outbound_records(id) ON DELETE SET NULL;


--
-- Name: selection_sources selection_sources_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_sources
    ADD CONSTRAINT selection_sources_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES public.inbound_lots(id);


--
-- Name: selection_sources selection_sources_selection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_sources
    ADD CONSTRAINT selection_sources_selection_id_fkey FOREIGN KEY (selection_id) REFERENCES public.selection_operations(id) ON DELETE CASCADE;


--
-- Name: semifinished_lots semifinished_lots_archived_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semifinished_lots
    ADD CONSTRAINT semifinished_lots_archived_by_fkey FOREIGN KEY (archived_by) REFERENCES public.users(id);


--
-- Name: semifinished_lots semifinished_lots_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semifinished_lots
    ADD CONSTRAINT semifinished_lots_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: semifinished_lots semifinished_lots_price_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semifinished_lots
    ADD CONSTRAINT semifinished_lots_price_confirmed_by_fkey FOREIGN KEY (price_confirmed_by) REFERENCES public.users(id);


--
-- Name: semifinished_lots semifinished_lots_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semifinished_lots
    ADD CONSTRAINT semifinished_lots_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: semifinished_lots semifinished_lots_selection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semifinished_lots
    ADD CONSTRAINT semifinished_lots_selection_id_fkey FOREIGN KEY (selection_id) REFERENCES public.selection_operations(id) ON DELETE SET NULL;


--
-- Name: semifinished_lots semifinished_lots_source_outbound_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semifinished_lots
    ADD CONSTRAINT semifinished_lots_source_outbound_id_fkey FOREIGN KEY (source_outbound_id) REFERENCES public.outbound_records(id);


--
-- Name: semifinished_outbound_records semifinished_outbound_records_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semifinished_outbound_records
    ADD CONSTRAINT semifinished_outbound_records_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: semifinished_outbound_records semifinished_outbound_records_semifinished_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semifinished_outbound_records
    ADD CONSTRAINT semifinished_outbound_records_semifinished_lot_id_fkey FOREIGN KEY (semifinished_lot_id) REFERENCES public.semifinished_lots(id);


--
-- Name: shipment_records shipment_records_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_records
    ADD CONSTRAINT shipment_records_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: shipment_records shipment_records_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_records
    ADD CONSTRAINT shipment_records_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products_shipped(id);


--
-- Name: stock_counts stock_counts_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_counts
    ADD CONSTRAINT stock_counts_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.users(id);


--
-- Name: stock_counts stock_counts_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_counts
    ADD CONSTRAINT stock_counts_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES public.inbound_lots(id);


--
-- Name: storage_layout_sheet_meta storage_layout_sheet_meta_layout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_layout_sheet_meta
    ADD CONSTRAINT storage_layout_sheet_meta_layout_id_fkey FOREIGN KEY (layout_id) REFERENCES public.storage_layouts(id) ON DELETE CASCADE;


--
-- Name: storage_layout_sheet_meta storage_layout_sheet_meta_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_layout_sheet_meta
    ADD CONSTRAINT storage_layout_sheet_meta_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: storage_layouts storage_layouts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_layouts
    ADD CONSTRAINT storage_layouts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: storage_object_inventory_entries storage_object_inventory_entries_crop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_object_inventory_entries
    ADD CONSTRAINT storage_object_inventory_entries_crop_id_fkey FOREIGN KEY (crop_id) REFERENCES public.crops(id) ON DELETE SET NULL;


--
-- Name: storage_object_inventory_entries storage_object_inventory_entries_inbound_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_object_inventory_entries
    ADD CONSTRAINT storage_object_inventory_entries_inbound_lot_id_fkey FOREIGN KEY (inbound_lot_id) REFERENCES public.inbound_lots(id) ON DELETE SET NULL;


--
-- Name: storage_object_inventory_entries storage_object_inventory_entries_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_object_inventory_entries
    ADD CONSTRAINT storage_object_inventory_entries_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.materials(id) ON DELETE SET NULL;


--
-- Name: storage_object_inventory_entries storage_object_inventory_entries_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_object_inventory_entries
    ADD CONSTRAINT storage_object_inventory_entries_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.storage_objects(id) ON DELETE CASCADE;


--
-- Name: storage_object_inventory_entries storage_object_inventory_entries_outbound_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_object_inventory_entries
    ADD CONSTRAINT storage_object_inventory_entries_outbound_id_fkey FOREIGN KEY (outbound_id) REFERENCES public.outbound_records(id) ON DELETE SET NULL;


--
-- Name: storage_object_inventory_entries storage_object_inventory_entries_semifinished_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_object_inventory_entries
    ADD CONSTRAINT storage_object_inventory_entries_semifinished_lot_id_fkey FOREIGN KEY (semifinished_lot_id) REFERENCES public.semifinished_lots(id) ON DELETE SET NULL;


--
-- Name: storage_object_items storage_object_items_inbound_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_object_items
    ADD CONSTRAINT storage_object_items_inbound_lot_id_fkey FOREIGN KEY (inbound_lot_id) REFERENCES public.inbound_lots(id) ON DELETE CASCADE;


--
-- Name: storage_object_items storage_object_items_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_object_items
    ADD CONSTRAINT storage_object_items_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.materials(id) ON DELETE CASCADE;


--
-- Name: storage_object_items storage_object_items_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_object_items
    ADD CONSTRAINT storage_object_items_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.storage_objects(id) ON DELETE CASCADE;


--
-- Name: storage_object_items storage_object_items_semifinished_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_object_items
    ADD CONSTRAINT storage_object_items_semifinished_lot_id_fkey FOREIGN KEY (semifinished_lot_id) REFERENCES public.semifinished_lots(id) ON DELETE CASCADE;


--
-- Name: storage_objects storage_objects_layout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_objects
    ADD CONSTRAINT storage_objects_layout_id_fkey FOREIGN KEY (layout_id) REFERENCES public.storage_layouts(id) ON DELETE CASCADE;


--
-- Name: storage_walls storage_walls_layout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_walls
    ADD CONSTRAINT storage_walls_layout_id_fkey FOREIGN KEY (layout_id) REFERENCES public.storage_layouts(id) ON DELETE CASCADE;


--
-- Name: substitution_rules substitution_rules_crop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitution_rules
    ADD CONSTRAINT substitution_rules_crop_id_fkey FOREIGN KEY (crop_id) REFERENCES public.crops(id) ON DELETE CASCADE;


--
-- Name: substitution_rules substitution_rules_origin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitution_rules
    ADD CONSTRAINT substitution_rules_origin_id_fkey FOREIGN KEY (origin_id) REFERENCES public.origins(id);


--
-- Name: substitution_rules substitution_rules_product_grade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitution_rules
    ADD CONSTRAINT substitution_rules_product_grade_id_fkey FOREIGN KEY (from_grade_id) REFERENCES public.grades(id);


--
-- Name: substitution_rules substitution_rules_raw_grade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitution_rules
    ADD CONSTRAINT substitution_rules_raw_grade_id_fkey FOREIGN KEY (to_grade_id) REFERENCES public.grades(id);


--
-- Name: audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log audit_log_insert_only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_log_insert_only ON public.audit_log FOR INSERT WITH CHECK (true);


--
-- Name: audit_log audit_log_select_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_log_select_all ON public.audit_log FOR SELECT USING (true);


--
-- PostgreSQL database dump complete
--

\unrestrict 0G4gauRzfrfb0MqYnaMUeTtMWKZ77tBUjVcthMF4l9iz7oHd73vbDwjiphcqoQK

