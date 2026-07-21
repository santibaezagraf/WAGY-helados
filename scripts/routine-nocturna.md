# Routine nocturna — testeo automático del bot (Opción B)

Guía para armar el **agente programado (routine)** que corre la suite guionada del
harness todas las noches contra la **Supabase de staging**, sin enviar WhatsApp
reales, y entrega un informe. Se configura en **`claude.ai/code/routines`** (o
`/schedule` en un Claude Code interactivo). Esta sesión no puede crearlo; acá está
todo listo para copiar/pegar.

## Prerrequisitos (una sola vez)

1. **Claude Code on the web** habilitado en tu plan Team (ajuste de la org).
2. **Repo conectado**: `santibaezagraf/WAGY-helados`, branch por defecto `main`
   (el harness ya está pusheado ahí).

## 1. Variables de entorno del entorno del routine

En la config del *environment* del routine, sección **Environment variables**
(formato `.env`). Son las de **staging** (no prod) + Groq:

```
NEXT_PUBLIC_SUPABASE_URL=https://oqrufwtuwvogdfhojips.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<ANON_KEY_DE_STAGING>
SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY_DE_STAGING>
GROQ_API_KEY=<TU_GROQ_API_KEY>
BOT_TEST_MODE=1
```

Notas:
- **`BOT_TEST_MODE=1` es la garantía de seguridad**: hace que `postAMeta` no toque
  Meta. Sin él, el endpoint da 403 y el prompt aborta (doble red).
- No hacen falta `WHATSAPP_TOKEN`/`QSTASH_*`: con el flag no se envía nada y el
  harness llama a `procesarMensajesDeCliente` directo (sin QStash).
- Estas variables son visibles para quien pueda editar el entorno. Por eso usamos
  **staging** (no las claves de prod). Si se filtran, rotás la staging sin drama.

## 2. Setup script

```
npm ci
```

(Instala dependencias. Mantenelo corto para que el cacheo del entorno funcione.)

## 3. Acceso de red (network access)

Modo **Custom**, agregando estos dominios (o poné **Full**):

```
oqrufwtuwvogdfhojips.supabase.co
api.groq.com
```

(El registry de npm ya está en el allowlist por defecto.)

## 4. Schedule

`2:07 AM` en tu zona horaria (America/Argentina/Buenos_Aires). En cron:

```
7 2 * * *
```

Si la UI de routines usa UTC, 02:07 ART = **05:07 UTC** (`7 5 * * *`). Usamos el
minuto 7 (no 0) para no caer en el pico de tareas de todo el mundo.

## 5. Prompt del routine (copiar tal cual)

```
Sos el agente de testeo nocturno del bot de WhatsApp de WAGY helados. El repo ya está
clonado (branch main). Objetivo: correr la suite GUIONADA del harness contra el bot real,
apuntando a la Supabase de STAGING y SIN enviar WhatsApp reales, y entregar un informe.

Contexto del harness: ver scripts/spec-bot.md (contrato del bot + rúbrica de juicio) y la
sección "npm run probar-bot" de CLAUDE.md.

PASOS:

1. Seguridad primero. Verificá las variables de entorno:
   - BOT_TEST_MODE debe ser exactamente "1". Si no, ABORTÁ y reportá (sin ese flag el bot
     mandaría WhatsApp reales).
   - NEXT_PUBLIC_SUPABASE_URL debe contener "oqrufwtuwvogdfhojips" (el proyecto de STAGING).
     Si apunta a otra cosa, ABORTÁ (no queremos tocar producción).

2. Asegurá dependencias: si no están, corré `npm ci`.

3. Levantá el dev server en segundo plano, con su salida a un log:
   `npm run dev > /tmp/devserver.log 2>&1 &`
   (Lee las env del entorno → apunta a staging con BOT_TEST_MODE=1.)

4. Esperá a que el endpoint esté listo (hasta ~90s). En un loop, hacé:
   POST http://localhost:3000/api/dev/simular-conversacion
   con header Content-Type: application/json y body {"accion":"estado","telefono":"540000000099"}
   - Si responde HTTP 200 con {"ok":true}: listo, seguí.
   - Si responde 403: BOT_TEST_MODE no está en 1 → ABORTÁ.
   - Si no conecta: esperá 3s y reintentá.

5. Corré los escenarios guionados (NO uses `npm run probar-bot`: ese usa
   --env-file=.env.local, que acá no existe). Ejecutá directo con node:
   `PROBAR_SOLO_GUIONADOS=1 PROBAR_DELAY_MS=6000 node scripts/probar-bot.mjs`
   Esto escribe informes-bot/corrida-<ts>/transcripts.{json,md}. El script pacea las
   llamadas a Groq y reintenta ante rate-limit; si igual falla algún turno, seguí y
   anotalo en el informe.

6. Bajá el dev server (matá el proceso de npm run dev).

7. JUZGÁ. Leé scripts/spec-bot.md y el transcripts.md de la corrida más reciente
   (informes-bot/corrida-*/). Escribí informes-bot/<esa-corrida>/informe.md siguiendo la
   rúbrica del spec: por cada escenario, veredicto ✅ bien / ⚠️ a mejorar / ❓ no contemplado,
   severidad, esperado-vs-real citando el transcript, y para los guionados usá el
   chequeoAutomatico. Arriba, un resumen con los conteos por bucket y los hallazgos más graves.

8. ENTREGÁ: tu mensaje final debe ser el resumen del informe (conteos ✅/⚠️/❓, tasa de
   verde, y los hallazgos más graves con su severidad). Además, commiteá el informe a una
   rama para que quede persistente:
     git checkout -b claude/nightly-informe
     git add -f informes-bot/*/informe.md informes-bot/*/transcripts.md
     git commit -m "informe nightly del bot"
     git push origin claude/nightly-informe
   (informes-bot está gitignoreado, por eso el `-f`. Si preferís no commitear, omití este
   paso y quedate solo con el resumen en el mensaje final.)

REGLAS:
- Si algo falla (server no levanta, 403, error del script), reportalo claro en el mensaje
  final; no simules éxito.
- No toques producción: la env es de staging. Los teléfonos de test (54000...) se limpian solos.
- Es un run de solo lectura sobre el negocio: no manda WhatsApp, no toca la DB de prod.
```

## 6. Primer run manual

Antes de dejarlo agendado, **corré el routine una vez a mano** desde la UI y revisá:
- que el dev server levante y el endpoint responda (no 403),
- que los guionados corran y aparezcan los transcripts,
- que el informe se genere con sentido,
- que (si activaste el commit) la rama `claude/nightly-informe` tenga el informe.

Si el primer run sale bien, dejá el cron y listo: cada noche a las 2 tenés el informe sin
gastar Groq en tu horario de uso.

## Limitaciones conocidas

- Corre **solo los guionados** (regresión barata + autopuntuada con `chequeoAutomatico`).
  Los exploratorios (bucket ❓) quedan para corridas a demanda: gastan bastante más Groq y
  su valor está en el juicio caso por caso.
- El routine testea **lo que esté en `main`** de GitHub, no tu working tree local.
- La entrega es el resumen en la sesión del routine (+ rama opcional). Para notificación
  push (Slack/email) habría que sumar un connector — mejora futura.
