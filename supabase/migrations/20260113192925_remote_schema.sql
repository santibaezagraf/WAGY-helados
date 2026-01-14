


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


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."calcular_ganancia_compleja"() RETURNS "trigger"
    LANGUAGE "plpgsql"
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


ALTER FUNCTION "public"."calcular_ganancia_compleja"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."procesar_pedido_final"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  -- Variables para calcular lo que "debería" costar (Precio Oficial)
  lista_activa_id bigint;
  precio_teorico_unit_agua numeric;
  precio_teorico_total_agua numeric;
  precio_teorico_unit_crema numeric;
  precio_teorico_total_crema numeric;
  
  es_diferente boolean := false;
begin
  -- 1. Buscamos la lista activa
  select id into lista_activa_id from public.listas_precios where activa = true limit 1;

  -- =======================================================
  -- CÁLCULO TEÓRICO AGUA (Lo que dice la lista)
  -- =======================================================
  select precio_unitario into precio_teorico_unit_agua 
  from public.reglas_precios
  where lista_id = lista_activa_id and tipo_producto = 'agua' and min_cantidad <= NEW.cantidad_agua
  order by min_cantidad desc limit 1;

  -- Fallback (Mínimo)
  if precio_teorico_unit_agua is null and NEW.cantidad_agua > 0 then
      select precio_unitario into precio_teorico_unit_agua from public.reglas_precios 
      where lista_id = lista_activa_id and tipo_producto = 'agua' order by min_cantidad asc limit 1;
  end if;
  
  if NEW.cantidad_agua = 0 then precio_teorico_unit_agua := 0; end if;
  
  -- Calculamos el total teórico
  precio_teorico_total_agua := COALESCE(precio_teorico_unit_agua, 0) * NEW.cantidad_agua;


  -- =======================================================
  -- CÁLCULO TEÓRICO CREMA (Lo que dice la lista)
  -- =======================================================
  select precio_unitario into precio_teorico_unit_crema 
  from public.reglas_precios
  where lista_id = lista_activa_id and tipo_producto = 'crema' and min_cantidad <= NEW.cantidad_crema
  order by min_cantidad desc limit 1;

  -- Fallback (Mínimo)
  if precio_teorico_unit_crema is null and NEW.cantidad_crema > 0 then
      select precio_unitario into precio_teorico_unit_crema from public.reglas_precios 
      where lista_id = lista_activa_id and tipo_producto = 'crema' order by min_cantidad asc limit 1;
  end if;

  if NEW.cantidad_crema = 0 then precio_teorico_unit_crema := 0; end if;

  -- Calculamos el total teórico
  precio_teorico_total_crema := COALESCE(precio_teorico_unit_crema, 0) * NEW.cantidad_crema;


  -- =======================================================
  -- COMPARACIÓN Y ASIGNACIÓN FINAL
  -- =======================================================
  
  -- En caso de no haberse introducido un monto total y este ser nulo,
  -- se inserta el teorico, calculado a partir de la lista de precisios
  -- y la cantidad de helados
  IF NEW.monto_total_agua IS NULL THEN -- COALESCE(NEW.monto_total_agua, 0) = 0
    NEW.monto_total_agua := precio_teorico_total_agua;
  END IF;

  IF NEW.monto_total_crema IS NULL THEN-- COALESCE(NEW.monto_total_crema, 0) = 0
    NEW.monto_total_crema := precio_teorico_total_crema;
  END IF;
 


  -- A. Detectar si hubo cambio manual
  -- Comparamos lo que mandó el Frontend (NEW.monto...) vs Lo Teórico
  -- Usamos ABS < 0.01 para evitar errores de redondeo en decimales
  IF abs(COALESCE(NEW.monto_total_agua, 0) - precio_teorico_total_agua) > 0.01 OR 
     abs(COALESCE(NEW.monto_total_crema, 0) - precio_teorico_total_crema) > 0.01 THEN
     es_diferente := true;
  END IF;

  NEW.es_cambio_manual := es_diferente;

  -- B. Calcular Unitarios Reales (Implícitos)
  -- Esto sirve para que tu historial tenga el valor real por unidad al que se vendió
  IF NEW.cantidad_agua > 0 THEN
      NEW.precio_unitario_agua := NEW.monto_total_agua / NEW.cantidad_agua;
  ELSE
      NEW.precio_unitario_agua := 0;
  END IF;

  IF NEW.cantidad_crema > 0 THEN
      NEW.precio_unitario_crema := NEW.monto_total_crema / NEW.cantidad_crema;
  ELSE
      NEW.precio_unitario_crema := 0;
  END IF;

  -- C. Calcular Ganancia Final
  NEW.ganancia := COALESCE(NEW.monto_total_agua, 0) + COALESCE(NEW.monto_total_crema, 0);

  RETURN NEW;
end;
$$;


ALTER FUNCTION "public"."procesar_pedido_final"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_modified_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_modified_column"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."listas_precios" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "nombre" "text",
    "activa" boolean DEFAULT false
);


ALTER TABLE "public"."listas_precios" OWNER TO "postgres";


ALTER TABLE "public"."listas_precios" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."listas_precios_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."pedidos" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "direccion" "text" DEFAULT ''::"text" NOT NULL,
    "aclaracion" "text",
    "telefono" "text" NOT NULL,
    "observaciones" "text",
    "estado" "text" DEFAULT 'pendiente'::"text" NOT NULL,
    "metodo_pago" "text" NOT NULL,
    "cantidad_crema" integer DEFAULT 0 NOT NULL,
    "cantidad_agua" integer DEFAULT 0 NOT NULL,
    "precio_unitario_crema" numeric(10,2) DEFAULT NULL::numeric,
    "precio_unitario_agua" numeric(10,2) DEFAULT NULL::numeric,
    "costo_envio" numeric(10,2) DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "pagado" boolean DEFAULT false,
    "monto_total_agua" numeric,
    "monto_total_crema" numeric,
    "es_cambio_manual" boolean DEFAULT false,
    "ganancia" numeric(10,2) GENERATED ALWAYS AS ((("monto_total_crema" + "monto_total_agua") - "costo_envio")) STORED,
    "enviado" boolean DEFAULT false NOT NULL,
    CONSTRAINT "check_cantidades_positivas" CHECK ((("cantidad_crema" >= 0) AND ("cantidad_agua" >= 0))),
    CONSTRAINT "check_metodo_pago" CHECK (("metodo_pago" = ANY (ARRAY['efectivo'::"text", 'transferencia'::"text", 'mp'::"text", 'otro'::"text"]))),
    CONSTRAINT "pedidos_estado_check" CHECK (("estado" = ANY (ARRAY['pendiente'::"text", 'enviado'::"text", 'cancelado'::"text"])))
);


ALTER TABLE "public"."pedidos" OWNER TO "postgres";


ALTER TABLE "public"."pedidos" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."pedidos_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."reglas_precios" (
    "id" bigint NOT NULL,
    "lista_id" bigint,
    "tipo_producto" "text" NOT NULL,
    "min_cantidad" integer NOT NULL,
    "precio_unitario" numeric NOT NULL
);


ALTER TABLE "public"."reglas_precios" OWNER TO "postgres";


ALTER TABLE "public"."reglas_precios" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."reglas_precios_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



ALTER TABLE ONLY "public"."listas_precios"
    ADD CONSTRAINT "listas_precios_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pedidos"
    ADD CONSTRAINT "pedidos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reglas_precios"
    ADD CONSTRAINT "reglas_precios_lista_id_tipo_producto_min_cantidad_key" UNIQUE ("lista_id", "tipo_producto", "min_cantidad");



ALTER TABLE ONLY "public"."reglas_precios"
    ADD CONSTRAINT "reglas_precios_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "uniq_single_active_lista_precios" ON "public"."listas_precios" USING "btree" ((true)) WHERE ("activa" IS TRUE);



CREATE OR REPLACE TRIGGER "trigger_procesar_pedido" BEFORE INSERT OR UPDATE ON "public"."pedidos" FOR EACH ROW EXECUTE FUNCTION "public"."procesar_pedido_final"();



CREATE OR REPLACE TRIGGER "update_pedidos_modtime" BEFORE UPDATE ON "public"."pedidos" FOR EACH ROW EXECUTE FUNCTION "public"."update_modified_column"();



ALTER TABLE ONLY "public"."reglas_precios"
    ADD CONSTRAINT "reglas_precios_lista_id_fkey" FOREIGN KEY ("lista_id") REFERENCES "public"."listas_precios"("id");



CREATE POLICY "allow authenticated users to use listas_precios" ON "public"."listas_precios" TO "authenticated" USING (true);



CREATE POLICY "allow authenticated users to use pedidos" ON "public"."pedidos" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "allow authenticated users to use reglas_precios" ON "public"."reglas_precios" USING (true);



ALTER TABLE "public"."listas_precios" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pedidos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reglas_precios" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

























































































































































GRANT ALL ON FUNCTION "public"."calcular_ganancia_compleja"() TO "anon";
GRANT ALL ON FUNCTION "public"."calcular_ganancia_compleja"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."calcular_ganancia_compleja"() TO "service_role";



GRANT ALL ON FUNCTION "public"."procesar_pedido_final"() TO "anon";
GRANT ALL ON FUNCTION "public"."procesar_pedido_final"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."procesar_pedido_final"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_modified_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_modified_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_modified_column"() TO "service_role";


















GRANT ALL ON TABLE "public"."listas_precios" TO "anon";
GRANT ALL ON TABLE "public"."listas_precios" TO "authenticated";
GRANT ALL ON TABLE "public"."listas_precios" TO "service_role";



GRANT ALL ON SEQUENCE "public"."listas_precios_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."listas_precios_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."listas_precios_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."pedidos" TO "anon";
GRANT ALL ON TABLE "public"."pedidos" TO "authenticated";
GRANT ALL ON TABLE "public"."pedidos" TO "service_role";



GRANT ALL ON SEQUENCE "public"."pedidos_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."pedidos_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."pedidos_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."reglas_precios" TO "anon";
GRANT ALL ON TABLE "public"."reglas_precios" TO "authenticated";
GRANT ALL ON TABLE "public"."reglas_precios" TO "service_role";



GRANT ALL ON SEQUENCE "public"."reglas_precios_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."reglas_precios_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."reglas_precios_id_seq" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































drop extension if exists "pg_net";


