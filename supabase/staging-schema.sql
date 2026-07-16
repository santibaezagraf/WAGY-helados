--
-- PostgreSQL database dump
--

\restrict pxyDxcLls1dKb3dHkTITVYexeNvFrTb08aL6paojmgobPGUxIJbGMUSkPztzQQM

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.1

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: auto_confirmar_pedidos_expirados(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_confirmar_pedidos_expirados() RETURNS void
    LANGUAGE plpgsql
    AS $$
begin
  update pedidos
  set 
    estado = 'pendiente',
    auto_confirmado = true
  where estado = 'borrador'
    and updated_at < (now() - interval '20 minutes');
end;
$$;


--
-- Name: calcular_ganancia_compleja(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.calcular_ganancia_compleja() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  precio_agua numeric;
  precio_crema numeric;
  lista_activa_id bigint;
begin
  -- Si es UPDATE y nada cambió, devolver NEW sin hacer nada
  if TG_OP = 'UPDATE' then
    IF (NEW.cantidad_agua IS NOT DISTINCT FROM OLD.cantidad_agua)
       AND (NEW.cantidad_crema IS NOT DISTINCT FROM OLD.cantidad_crema)
       AND (NEW.precio_unitario_agua IS NOT DISTINCT FROM OLD.precio_unitario_agua)
       AND (NEW.precio_unitario_crema IS NOT DISTINCT FROM OLD.precio_unitario_crema)
    THEN
      RETURN NEW;
    END IF;
  END IF;

  -- 1. Buscamos la lista de precios activa actualmente
  select id into lista_activa_id from public.listas_precios where activa = true limit 1;
  
  if lista_activa_id is null then
    raise exception 'No hay una lista de precios activa.';
  end if;

  -- ======================
  -- LÓGICA PARA AGUA
  -- ======================
  -- A. Intentamos buscar el precio para el rango correspondiente (la lógica original)
  select precio_unitario into precio_agua 
  from public.reglas_precios
  where lista_id = lista_activa_id 
    and tipo_producto = 'agua' 
    and min_cantidad <= NEW.cantidad_agua
  order by min_cantidad desc 
  limit 1;

  -- B. Si precio es NULL y la cantidad es > 0, significa que pidió MENOS del mínimo.
  --    En lugar de error, buscamos el precio del escalón más bajo (min_cantidad ASC)
  if precio_agua is null and NEW.cantidad_agua > 0 then
      select precio_unitario into precio_agua
      from public.reglas_precios
      where lista_id = lista_activa_id
        and tipo_producto = 'agua'
      order by min_cantidad asc -- Buscamos el menor de todos
      limit 1;

      -- Si AÚN ASÍ es null, es porque no cargaste ninguna regla para 'agua' en la BD
      if precio_agua is null then
         raise exception 'No hay precios configurados para helados de agua en la lista activa.';
      end if;
  end if;

  -- Caso borde: Si cantidad es 0, precio es 0
  if NEW.cantidad_agua = 0 then precio_agua := 0; end if;


  -- ======================
  -- LÓGICA PARA CREMA
  -- ======================
  -- A. Intentamos buscar rango normal
  select precio_unitario into precio_crema 
  from public.reglas_precios
  where lista_id = lista_activa_id 
    and tipo_producto = 'crema' 
    and min_cantidad <= NEW.cantidad_crema
  order by min_cantidad desc 
  limit 1;

  -- B. Fallback: Si no alcanza el mínimo, usar el precio base
  if precio_crema is null and NEW.cantidad_crema > 0 then
      select precio_unitario into precio_crema
      from public.reglas_precios
      where lista_id = lista_activa_id
        and tipo_producto = 'crema'
      order by min_cantidad asc
      limit 1;

      if precio_crema is null then
         raise exception 'No hay precios configurados para helados de crema en la lista activa.';
      end if;
  end if;

  if NEW.cantidad_crema = 0 then precio_crema := 0; end if;


  -- 4. Guardamos los Snapshots
  NEW.precio_unitario_agua := precio_agua;
  NEW.precio_unitario_crema := precio_crema;

  -- 5. Calculamos la Ganancia Total
  NEW.ganancia := (NEW.cantidad_agua * precio_agua) + (NEW.cantidad_crema * precio_crema);

  return NEW;
end;
$$;


--
-- Name: manage_single_active_lista(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.manage_single_active_lista() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Si la nueva lista (o la editada) viene como activa
  IF NEW.activa IS TRUE THEN
    -- Desactivar todas las demas listas (excluyendo la actual si fuera un update)
    UPDATE public.listas_precios
    SET activa = false
    WHERE id <> NEW.id AND activa = true;
  END IF;
  
  RETURN NEW;
END;
$$;


--
-- Name: obtener_balance(timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.obtener_balance(fecha_inicio timestamp with time zone, fecha_fin timestamp with time zone) RETURNS TABLE(total_agua numeric, total_crema numeric, plata_transferencia numeric, plata_efectivo numeric, costo_envio_total numeric, cantidad_envios numeric, total_gastos numeric, cantidad_gastos numeric, efectivo_final numeric, ingreso_total numeric)
    LANGUAGE plpgsql
    AS $$
begin
  return query

  -- 1. Calculamos los totales de PEDIDOS
  with resumen_pedidos as (
    select
      -- 1. Suma de cantidades (excluyendo cancelados) 
      coalesce(sum(cantidad_agua), 0):: numeric as t_agua,
      coalesce(sum(cantidad_crema), 0):: numeric as t_crema,
      
      -- 2. Plata por Transferencia (Suma de montos donde metodo = transferencia)
      coalesce(sum(
        case when metodo_pago = 'transferencia' 
             then coalesce(precio_total,0)
             else 0 end
      ), 0) as p_transferencia,

      -- 3. Plata Efectivo (Ingreso Bruto)
      coalesce(sum(
        case when metodo_pago = 'efectivo' 
             then coalesce(precio_total,0)
             else 0 end
      ), 0) as p_efectivo,

      -- 4. Costo de envíos (Solo sumamos si hay costo > 0)
      coalesce(sum(costo_envio), 0) as c_envio,

      -- 5. Cantidad de envíos (Contamos cuántos pedidos tuvieron costo > 0)
      count(case when costo_envio > 0 then 1 else null end):: numeric as q_envios

    from public.pedidos
    where created_at >= fecha_inicio 
      and created_at <= fecha_fin
      and estado != 'cancelado'
      and pagado = 'true'
  ),

  -- 2. Calculamos los totales de GASTOS
  resumen_gastos as (
    select 
      coalesce(sum(monto), 0):: numeric as t_gastos,

      count(*):: numeric as q_gastos

    from public.gastos
    where created_at >= fecha_inicio 
      and created_at <= fecha_fin
      and activo != false
  )
  -- Ahora sí, seleccionamos y hacemos la resta simple
  select 
    p.t_agua,
    p.t_crema,
    p.p_transferencia,
    p.p_efectivo,
    p.c_envio,
    p.q_envios,
    g.t_gastos,
    g.q_gastos,
    (p.p_efectivo - p.c_envio - g.t_gastos) as efectivo_final,
    (p.p_efectivo + p.p_transferencia) as ingreso_total
  from resumen_pedidos p
  cross join resumen_gastos g;
end;
$$;


--
-- Name: procesar_pedido_final(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.procesar_pedido_final() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  lista_activa_id bigint;
  precio_teorico_unit_agua numeric;
  precio_teorico_total_agua numeric;
  precio_teorico_unit_crema numeric;
  precio_teorico_total_crema numeric;
  es_diferente boolean := false;
  cantidad_cambio boolean := false;
begin
  if TG_OP = 'UPDATE' then
    cantidad_cambio := (NEW.cantidad_agua IS DISTINCT FROM OLD.cantidad_agua)
      OR (NEW.cantidad_crema IS DISTINCT FROM OLD.cantidad_crema);
  end if;

  select id into lista_activa_id from public.listas_precios where activa = true limit 1;

  select precio_unitario into precio_teorico_unit_agua
  from public.reglas_precios
  where lista_id = lista_activa_id and tipo_producto = 'agua' and min_cantidad <= NEW.cantidad_agua
  order by min_cantidad desc limit 1;

  if precio_teorico_unit_agua is null and NEW.cantidad_agua > 0 then
      select precio_unitario into precio_teorico_unit_agua from public.reglas_precios
      where lista_id = lista_activa_id and tipo_producto = 'agua' order by min_cantidad asc limit 1;
  end if;

  if NEW.cantidad_agua = 0 then precio_teorico_unit_agua := 0; end if;

  precio_teorico_total_agua := COALESCE(precio_teorico_unit_agua, 0) * NEW.cantidad_agua;

  select precio_unitario into precio_teorico_unit_crema
  from public.reglas_precios
  where lista_id = lista_activa_id and tipo_producto = 'crema' and min_cantidad <= NEW.cantidad_crema
  order by min_cantidad desc limit 1;

  if precio_teorico_unit_crema is null and NEW.cantidad_crema > 0 then
      select precio_unitario into precio_teorico_unit_crema from public.reglas_precios
      where lista_id = lista_activa_id and tipo_producto = 'crema' order by min_cantidad asc limit 1;
  end if;

  if NEW.cantidad_crema = 0 then precio_teorico_unit_crema := 0; end if;

  precio_teorico_total_crema := COALESCE(precio_teorico_unit_crema, 0) * NEW.cantidad_crema;

  if cantidad_cambio then
    NEW.monto_total_agua := precio_teorico_total_agua;
    NEW.monto_total_crema := precio_teorico_total_crema;
  else
    if NEW.monto_total_agua IS NULL then
      NEW.monto_total_agua := precio_teorico_total_agua;
    end if;

    if NEW.monto_total_crema IS NULL then
      NEW.monto_total_crema := precio_teorico_total_crema;
    end if;
  end if;

  if abs(COALESCE(NEW.monto_total_agua, 0) - precio_teorico_total_agua) > 0.01 OR
     abs(COALESCE(NEW.monto_total_crema, 0) - precio_teorico_total_crema) > 0.01 then
     es_diferente := true;
  end if;

  NEW.es_cambio_manual := es_diferente;

  if NEW.cantidad_agua > 0 then
      NEW.precio_unitario_agua := NEW.monto_total_agua / NEW.cantidad_agua;
  else
      NEW.precio_unitario_agua := 0;
  end if;

  if NEW.cantidad_crema > 0 then
      NEW.precio_unitario_crema := NEW.monto_total_crema / NEW.cantidad_crema;
  else
      NEW.precio_unitario_crema := 0;
  end if;

  RETURN NEW;
end;
$$;


--
-- Name: update_modified_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_modified_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: atencion_humana; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.atencion_humana (
    telefono text NOT NULL,
    activa boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    requiere_atencion boolean DEFAULT false NOT NULL,
    requiere_atencion_at timestamp with time zone
);


--
-- Name: gastos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gastos (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    monto numeric NOT NULL,
    activo boolean DEFAULT true NOT NULL
);


--
-- Name: gastos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.gastos ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.gastos_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: listas_precios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listas_precios (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    nombre text,
    activa boolean DEFAULT false
);


--
-- Name: listas_precios_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.listas_precios ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.listas_precios_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: mensajes_chat; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mensajes_chat (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    texto text,
    telefono text,
    wa_message_id text,
    procesado boolean DEFAULT false NOT NULL,
    descartado boolean DEFAULT false NOT NULL,
    rol text DEFAULT 'cliente'::text NOT NULL,
    tipo text DEFAULT 'text'::text NOT NULL,
    media_path text,
    media_mime text,
    media_caption text,
    media_filename text,
    media_lat double precision,
    media_lng double precision,
    CONSTRAINT mensajes_chat_rol_check CHECK ((rol = ANY (ARRAY['cliente'::text, 'bot'::text, 'operador'::text])))
);


--
-- Name: COLUMN mensajes_chat.tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mensajes_chat.tipo IS 'text | image | audio | video | document | sticker | location';


--
-- Name: COLUMN mensajes_chat.media_path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mensajes_chat.media_path IS 'Ruta del archivo en el bucket whatsapp-media (null para text/location)';


--
-- Name: pedidos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pedidos (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    direccion text DEFAULT ''::text NOT NULL,
    aclaracion text,
    telefono text NOT NULL,
    observaciones text,
    estado text DEFAULT 'pendiente'::text NOT NULL,
    metodo_pago text NOT NULL,
    cantidad_crema integer DEFAULT 0 NOT NULL,
    cantidad_agua integer DEFAULT 0 NOT NULL,
    precio_unitario_crema numeric(10,2) DEFAULT NULL::numeric,
    precio_unitario_agua numeric(10,2) DEFAULT NULL::numeric,
    costo_envio numeric(10,2) DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    pagado boolean DEFAULT false,
    monto_total_agua numeric,
    monto_total_crema numeric,
    es_cambio_manual boolean DEFAULT false,
    enviado boolean DEFAULT false NOT NULL,
    precio_total numeric GENERATED ALWAYS AS ((COALESCE(monto_total_agua, (0)::numeric) + COALESCE(monto_total_crema, (0)::numeric))) STORED,
    observaciones_detalle jsonb,
    resumen_pendiente boolean DEFAULT false NOT NULL,
    recordatorio_enviado boolean DEFAULT false NOT NULL,
    auto_rechazado boolean DEFAULT false NOT NULL,
    direccion_de_historial boolean DEFAULT false NOT NULL,
    esperando_respuesta_boton boolean DEFAULT false NOT NULL,
    CONSTRAINT check_cantidades_positivas CHECK (((cantidad_crema >= 0) AND (cantidad_agua >= 0))),
    CONSTRAINT check_metodo_pago CHECK ((metodo_pago = ANY (ARRAY['efectivo'::text, 'transferencia'::text, 'mp'::text, 'otro'::text, ''::text]))),
    CONSTRAINT pedidos_estado_check CHECK ((estado = ANY (ARRAY['pendiente'::text, 'enviado'::text, 'cancelado'::text, 'borrador'::text, 'esperando_cancelacion'::text])))
);


--
-- Name: pedidos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.pedidos ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.pedidos_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: reglas_precios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reglas_precios (
    id bigint NOT NULL,
    lista_id bigint NOT NULL,
    tipo_producto text NOT NULL,
    min_cantidad integer NOT NULL,
    precio_unitario numeric NOT NULL
);


--
-- Name: reglas_precios_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.reglas_precios ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.reglas_precios_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: atencion_humana atencion_humana_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.atencion_humana
    ADD CONSTRAINT atencion_humana_pkey PRIMARY KEY (telefono);


--
-- Name: gastos gastos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gastos
    ADD CONSTRAINT gastos_pkey PRIMARY KEY (id);


--
-- Name: listas_precios listas_precios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listas_precios
    ADD CONSTRAINT listas_precios_pkey PRIMARY KEY (id);


--
-- Name: mensajes_chat mensajes_chat_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mensajes_chat
    ADD CONSTRAINT mensajes_chat_pkey PRIMARY KEY (id);


--
-- Name: pedidos pedidos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedidos
    ADD CONSTRAINT pedidos_pkey PRIMARY KEY (id);


--
-- Name: reglas_precios reglas_precios_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reglas_precios
    ADD CONSTRAINT reglas_precios_id_key UNIQUE (id);


--
-- Name: reglas_precios reglas_precios_lista_id_tipo_producto_min_cantidad_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reglas_precios
    ADD CONSTRAINT reglas_precios_lista_id_tipo_producto_min_cantidad_key UNIQUE (lista_id, tipo_producto, min_cantidad);


--
-- Name: reglas_precios reglas_precios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reglas_precios
    ADD CONSTRAINT reglas_precios_pkey PRIMARY KEY (id);


--
-- Name: atencion_humana_requiere_atencion_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX atencion_humana_requiere_atencion_idx ON public.atencion_humana USING btree (telefono) WHERE requiere_atencion;


--
-- Name: idx_mensajes_chat_rol_tel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mensajes_chat_rol_tel ON public.mensajes_chat USING btree (telefono, rol, created_at DESC);


--
-- Name: mensajes_chat_historial_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mensajes_chat_historial_idx ON public.mensajes_chat USING btree (telefono, created_at) WHERE (descartado = false);


--
-- Name: mensajes_chat_pendientes_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mensajes_chat_pendientes_idx ON public.mensajes_chat USING btree (telefono, created_at) WHERE (procesado = false);


--
-- Name: mensajes_chat_wa_message_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mensajes_chat_wa_message_id_key ON public.mensajes_chat USING btree (wa_message_id) WHERE (wa_message_id IS NOT NULL);


--
-- Name: pedidos_un_borrador_por_telefono; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pedidos_un_borrador_por_telefono ON public.pedidos USING btree (telefono) WHERE (estado = 'borrador'::text);


--
-- Name: uniq_single_active_lista_precios; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_single_active_lista_precios ON public.listas_precios USING btree ((true)) WHERE (activa IS TRUE);


--
-- Name: listas_precios trigger_manage_active_lista; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_manage_active_lista BEFORE INSERT OR UPDATE ON public.listas_precios FOR EACH ROW EXECUTE FUNCTION public.manage_single_active_lista();


--
-- Name: pedidos trigger_procesar_pedido; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_procesar_pedido BEFORE INSERT OR UPDATE ON public.pedidos FOR EACH ROW EXECUTE FUNCTION public.procesar_pedido_final();


--
-- Name: pedidos update_pedidos_modtime; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_pedidos_modtime BEFORE UPDATE ON public.pedidos FOR EACH ROW EXECUTE FUNCTION public.update_modified_column();


--
-- Name: reglas_precios reglas_precios_lista_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reglas_precios
    ADD CONSTRAINT reglas_precios_lista_id_fkey FOREIGN KEY (lista_id) REFERENCES public.listas_precios(id);


--
-- Name: gastos Usuarios pueden ver y crear gastos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Usuarios pueden ver y crear gastos" ON public.gastos TO authenticated USING (true) WITH CHECK (true);


--
-- Name: listas_precios allow authenticated users to use listas_precios; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "allow authenticated users to use listas_precios" ON public.listas_precios TO authenticated USING (true);


--
-- Name: pedidos allow authenticated users to use pedidos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "allow authenticated users to use pedidos" ON public.pedidos TO authenticated USING (true) WITH CHECK (true);


--
-- Name: mensajes_chat allow everyone to everything; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "allow everyone to everything" ON public.mensajes_chat USING (true) WITH CHECK (true);


--
-- Name: atencion_humana; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.atencion_humana ENABLE ROW LEVEL SECURITY;

--
-- Name: atencion_humana auth atencion_humana; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "auth atencion_humana" ON public.atencion_humana TO authenticated USING (true) WITH CHECK (true);


--
-- Name: mensajes_chat auth read mensajes_chat; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "auth read mensajes_chat" ON public.mensajes_chat FOR SELECT TO authenticated USING (true);


--
-- Name: gastos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gastos ENABLE ROW LEVEL SECURITY;

--
-- Name: listas_precios; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.listas_precios ENABLE ROW LEVEL SECURITY;

--
-- Name: mensajes_chat; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mensajes_chat ENABLE ROW LEVEL SECURITY;

--
-- Name: pedidos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pedidos ENABLE ROW LEVEL SECURITY;

--
-- Name: reglas_precios; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reglas_precios ENABLE ROW LEVEL SECURITY;

--
-- Name: reglas_precios reglas_precios solo authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "reglas_precios solo authenticated" ON public.reglas_precios TO authenticated USING (true) WITH CHECK (true);


--
-- PostgreSQL database dump complete
--

\unrestrict pxyDxcLls1dKb3dHkTITVYexeNvFrTb08aL6paojmgobPGUxIJbGMUSkPztzQQM

