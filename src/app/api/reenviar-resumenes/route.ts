import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Database } from '@/types/supabase';
import { enviarResumenYPedirConfirmacion } from '@/lib/whatsapp';
import { cronAutorizado } from '@/lib/auth-cron';

/**
 * Reenvío de resúmenes que no llegaron al cliente (mitigación de cortes largos
 * de Meta).
 *
 * Cuando `enviarResumenYPedirConfirmacion` agota el budget de retry de postAMeta
 * (Meta caído más de ~20s), marca el pedido con `resumen_pendiente=true`. El
 * consumer de QStash ya devolvió 200, así que NO reintenta. Este endpoint cierra
 * ese hueco: un pg_cron lo llama cada par de minutos y reintenta los resúmenes
 * pendientes. El resumen es reconstruible desde la fila de `pedidos`, por eso se
 * puede reenviar (otros mensajes sueltos del bot no).
 *
 * Auth: header `Authorization: Bearer <CRON_SECRET>` (ver auth-cron.ts).
 *
 * Programación (pg_cron + pg_net en Supabase):
 *   select cron.schedule(
 *     'reenviar-resumenes-pendientes', '* / 2 * * * *',
 *     $$ select net.http_post(
 *          url := 'https://TU-APP/api/reenviar-resumenes',
 *          headers := '{"Content-Type":"application/json","Authorization":"Bearer EL_CRON_SECRET"}'::jsonb,
 *          body := '{}'::jsonb) $$
 *   );
 */

const supabaseAdmin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Solo reintentamos resúmenes de borradores RECIENTES. Más viejos que esto ya
// fueron auto-confirmados por el otro pg_cron o quedaron stale; no tiene sentido
// mandarles un "¿confirmás?" horas tarde. Acota los reintentos sin un contador.
const VENTANA_HORAS = 2;

async function reenviarPendientes() {
  const desde = new Date(Date.now() - VENTANA_HORAS * 60 * 60 * 1000).toISOString();

  const { data: pendientes, error } = await supabaseAdmin
    .from('pedidos')
    .select('id, telefono, cantidad_crema, cantidad_agua, observaciones, direccion, aclaracion, metodo_pago, precio_total')
    .eq('estado', 'borrador')
    .eq('resumen_pendiente', true)
    .gte('created_at', desde);

  if (error) {
    console.error('❌ Error consultando resúmenes pendientes:', error);
    return NextResponse.json({ error: 'Error interno' }, { status: 500 });
  }

  if (!pendientes || pendientes.length === 0) {
    return NextResponse.json({ status: 'ok', reenviados: 0, pendientes: 0 });
  }

  // enviarResumenYPedirConfirmacion limpia resumen_pendiente cuando el envío
  // sale bien, o lo deja en true si Meta sigue caído (próximo tick reintenta).
  let reenviados = 0;
  for (const p of pendientes) {
    const ok = await enviarResumenYPedirConfirmacion(p.telefono, p, false);
    if (ok) reenviados++;
  }

  console.log(`🔁 Reenvío de resúmenes: ${reenviados}/${pendientes.length} enviados.`);
  return NextResponse.json({ status: 'ok', reenviados, pendientes: pendientes.length });
}

export async function POST(request: Request) {
  if (!cronAutorizado(request)) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  return reenviarPendientes();
}
