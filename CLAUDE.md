# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Management system for **WAGY helados** (an ice cream business): a Next.js 16 (App Router) dashboard for staff to manage orders/expenses/pricing, **plus** a WhatsApp bot that takes customer orders conversationally over the Meta WhatsApp Cloud API, extracts structured order data with an LLM, and writes it into the same `pedidos` table the dashboard reads.

Everything is in Spanish (code comments, DB columns, customer-facing messages). Keep new strings in Spanish (rioplatense/Argentine register — "vos", informal) to match.

## Commands

```bash
npm run dev          # dev server (localhost:3000)
npm run build        # production build
npm run lint         # eslint
npm test             # vitest — unit tests of the bot's PURE functions (no LLM, no network)
npm run eval         # prompt eval suite against the real LLM (needs `npm run dev` running)
npm run update-types # regenerate src/types/supabase.ts from the remote Supabase project
```

Testing is split in two, because the bot has a deterministic half and a non-deterministic half:

- **`npm test`** (vitest, [procesar.test.ts](src/lib/bot/procesar.test.ts)) covers the **pure functions**: `aplicarOperacionCantidad` / `aplicarOperacionAclaracion` / `aplicarOperacionObs`, `leerSlots`, `reconstruirObservaciones`, `normalizarTextoShortCircuit`, `intentarShortCircuit`. Fast, no server, no Groq. [vitest.config.mts](vitest.config.mts) injects dummy Supabase env vars so importing `procesar.ts` (which builds a service-role client at module load) doesn't throw.
- **`npm run eval`** ([scripts/prompts.eval.mjs](scripts/prompts.eval.mjs)) drives the **LLM extraction** end-to-end by POSTing cases to `/api/dev/test-ia`. That endpoint (dev-only, blocked when `NODE_ENV==='production'`) reuses the real `buildSystemPrompt` + all `aplicarOperacion*`, so results reflect what the DB would store. Matching is tolerant (literal or RegExp) because the model is non-deterministic; `EVAL_REPEAT` measures flakiness, `EVAL_FILTER` runs a subset, `EVAL_DELAY_MS` paces calls to dodge Groq's free-tier TPM limit (the suite also auto-retries on rate-limit). See the file header in [test-ia/route.ts](src/app/api/dev/test-ia/route.ts) for PowerShell examples.

## The bot pipeline (the important part)

A customer message travels through this path. The two webhook entrypoints and `procesar.ts` are where almost all the complexity lives.

1. **`POST /api/webhook`** ([route.ts](src/app/api/webhook/route.ts)) — Meta delivers messages here. Three branches by `message.type`:
   - **`text`**: insert into `mensajes_chat` with `rol='cliente'` (idempotent via unique index on `wa_message_id` — Meta retries surface as Postgres `23505` and are dropped), then schedule a QStash wake-up `+8s` (`DEBOUNCE_SECONDS`). All real work is deferred.
   - **`interactive`** (button click): the intent is encoded in `button_id`, so we **skip QStash and the LLM entirely** — insert with `procesado=true` and run the action inline via `ejecutarBoton`. Instant reply, 0 tokens.
   - **anything else** (audio/image/sticker/…): reply "solo leo texto" and do nothing else (don't insert, don't schedule).
2. **`POST /api/procesar-pendientes`** ([route.ts](src/app/api/procesar-pendientes/route.ts)) — QStash calls this 8s later. Protected by `verifySignatureAppRouter` (QStash signing keys). Just delegates to `procesarMensajesDeCliente`. Returns 500 on error on purpose so QStash retries.
3. **`procesarMensajesDeCliente`** ([procesar.ts](src/lib/bot/procesar.ts)) — the core. See below.

### Debounce + atomic claim (why messages aren't double-processed)

Each incoming message schedules its **own** wake-up. The system relies on two mechanisms together:
- **Defer**: if the newest unprocessed message is younger than `DEFER_THRESHOLD_MS` (5s, intentionally `< 8s` debounce), the worker assumes the customer is still typing and bails — a later wake-up will catch the whole batch once there's silence.
- **Atomic claim**: `UPDATE ... SET procesado=true WHERE procesado=false AND rol='cliente' RETURNING ...`. The first wake-up to fire claims all pending rows; concurrent/later wake-ups get 0 rows and exit. This is what prevents two workers from each answering a subset of a split message. (The `rol='cliente'` filter is defensive — bot rows are already `procesado=true` — so the bot's own persisted replies can never be claimed as input.)

### LLM extraction

- Model: **Groq `openai/gpt-oss-20b`** via the Vercel AI SDK `generateObject` with a **Zod schema** (`PedidoIASchema`), `temperature: 0`. Validation failures are retried manually up to 3× (the SDK marks them non-retryable, but they're really model non-determinism, e.g. returning `"false"` as a string).
- **The model extracts a literal + an operation; TS does the merge.** This pattern is used for three fields, so the model never has to echo back a full merged value (which is where it used to drop/mangle data):
  - **Quantities**: `cantidad_*` (literal) + `cantidad_*_operacion` (`sumar`/`restar`/`reemplazar`/`mantener`) → `aplicarOperacionCantidad` against the current qty. The model never does arithmetic — *except* it sums a single-type flavor breakdown ("los de agua 20 de X y 40 de Y" → 60), the one allowed sum.
  - **Aclaración** (address detail): `aclaracion` (literal of *this* message) + `aclaracion_operacion` (`agregar`/`reemplazar`/`mantener`) → `aplicarOperacionAclaracion`. `agregar` sends only the new fragment and TS concatenates, so the existing text can't be lost.
  - **Observaciones** (flavors): see the slots note below — `obs_agua`/`obs_crema`/`obs_general` + per-slot operations.
  - `datos_completos` is also computed in TS, not by the model.
- **`intencion`** is a single enum (`cancelar`/`confirmar`/`confirmar_cancelacion`/`rechazar_cancelacion`/`saludo`/`modificar_sin_datos`/`datos_pedido`), not a set of booleans. The prompt only shows the intents valid for the current state. Two overrides in `procesarMensajesDeCliente` *reclassify* a model `saludo`/`modificar_sin_datos` to `datos_pedido` when the raw output actually carried changes.
- **Address sanity check (`pareceDireccion`)**: a deterministic TS guard backs up — doesn't replace — the model's address judgment. It requires a street name (≥3-letter word that isn't a unit keyword like "depto"/"piso") **and** a number; `"retira"` passes as a sentinel. If the model put a non-address (an aclaración like "depto 6", or a street with no number) into `direccion`, it's nulled. This runs **before** the greeting override (so junk doesn't count as "useful data") and **before** the historical-address injection (so a known-good saved address fills in instead).
- **Short-circuit**: before calling the LLM, `intentarShortCircuit` handles unambiguous single messages given the state ("sí" in `esperando_cancelacion`, "hola" with an active order) heuristically — tolerant of typos/accents/emoji/stretched vowels. Saves latency, cost and model errors on trivial cases. It runs only when the batch is one message and never on ambiguous input.
- The system prompt is built by **`buildSystemPrompt(pedidoActivo)`** and branches on order state: a "modification/extraction API" prompt when there's an active order (`borrador`/`pendiente`/`esperando_cancelacion`), vs. a "new order from scratch" prompt otherwise.

### Observaciones: keyed slots (flavors per ice-cream type)

`observaciones` is **not flat** — it's structured by type ("los de agua …", "los de crema …", plus type-agnostic notes). To let TS own the keyed merge (replace the agua segment, keep the crema one) without re-parsing free text:

- The DB has a `observaciones_detalle` **jsonb** column = `{ agua, crema, general }`. This is the **bot's internal source of truth**.
- `observaciones` (text) is the **projection** TS regenerates from the slots via `reconstruirObservaciones` on every bot write. It's what the kitchen, dashboard and customer summary read — **humans only ever see/edit the flat text**, never the slots.
- The model fills the slot(s) it's changing (`obs_agua`/`obs_crema`/`obs_general` + per-slot `reemplazar`/`agregar`/`mantener`/`limpiar`); `aplicarOperacionObs` applies each and `leerSlots` reads the current ones.
- **Manual dashboard edits collapse the slots**: `actualizarPedidoCompleto` sets `observaciones_detalle = null`. On the next bot turn, `leerSlots` re-seeds `general` from the flat text — so the bot loses per-type granularity for that order until the customer restates by type, but **never loses data**. Same fallback covers pre-migration rows.

### Bot responses are persisted too (so the LLM sees its own last turn)

Every successful send via `enviarMensajeWhatsApp` / `enviarMensajeConBotones` ([whatsapp.ts](src/lib/whatsapp.ts)) inserts a `mensajes_chat` row with `rol='bot'` and **`procesado=true`**. The `procesado=true` is what keeps these rows invisible to the atomic claim and the defer (both filter `procesado=false`), so persisting a bot reply mid-batch can't trigger phantom wake-ups or be claimed as input. The worker feeds the bot's last turn into the prompt so a bare "dale" after "¿confirmás?" is classified with context. Button messages persist the body + `[opciones: …]` so the model sees what choices were offered. Persistence runs **only on a successful send** — a send that failed never leaves a row claiming the bot said something the customer never got.

Both send helpers go through `postAMeta`, which adds an 8s per-attempt timeout (shorter than undici's 10s connect timeout) and **retries up to 3× on connection failure / timeout / 5xx**, but not on 4xx (our bad request — token, payload). This makes transient blips toward Meta self-heal.

For **longer Meta outages** (beyond the retry budget, where QStash won't retry because the consumer already returned 200), the **confirmation summary** has a re-send safety net: `enviarResumenYPedirConfirmacion` sets `pedidos.resumen_pendiente=true` when the send fails (and clears it on success). A pg_cron job (every ~2 min, via `pg_net`) hits **`/api/reenviar-resumenes`** ([route.ts](src/app/api/reenviar-resumenes/route.ts), auth `?token=VERIFY_TOKEN`), which re-sends summaries for `borrador` orders flagged pending within a 2h window (the window bounds retries without a counter; stale drafts get auto-confirmed by the other cron). Only the **summary** is covered — it's reconstructable from the `pedidos` row; arbitrary bot text replies still aren't, and a lost one is still lost silently.

### Order state machine (`pedidos.estado`)

`borrador` → `pendiente` → `enviado`, with `esperando_cancelacion` and `cancelado` as branches. Roughly:
- **`borrador`**: draft built by the bot; customer must confirm. A pg_cron job auto-confirms stale drafts (`auto_confirmado=true`) → fires the Supabase DB webhook at [/api/webhook/notificacion](src/app/api/webhook/notificacion/route.ts), which notifies the customer.
- **`pendiente`**: confirmed, in the kitchen.
- **`enviado`**: dispatched by the courier. **Terminal for the customer** — cancellation/modification is refused.
- **`esperando_cancelacion`**: bot asked "are you sure?" and awaits a yes/no.

### Two invariants that have caused real bugs (don't regress them)

1. **`estado` is the source of truth; the `enviado` boolean must stay coherent with it.** Dashboard server actions must mutate state through `patchConEnviadoCoherente(estado)` ([actions/pedidos.ts](src/lib/actions/pedidos.ts)): `estado='enviado'` forces `enviado=true`, `estado='cancelado'` forces `enviado=false`. A stale `enviado=true` on a cancelled order made the bot wrongly say "your order was dispatched." Lookups treat `estado` as truth (`.eq('estado','enviado')`), not the boolean.
2. **Order of overrides in `procesarMensajesDeCliente` matters.** The greeting override and "real changes" check run against the model's **raw** output, and the **historical-address injection runs *after* them**. If you inject the saved address first, a bare "hola" from a known customer ends up with `direccion` set → `trajoDatosUtiles=true` → the legitimate greeting is suppressed. Don't reorder these blocks casually. When that injection fills the address on a **new** order (no active order), the confirmation summary tells the customer it reused their last address so they can correct it (`direccionInyectadaDeHistorial` → a line in `enviarResumenYPedirConfirmacion`).

Every state-changing `UPDATE` in the cancellation/confirmation flows uses a **guard** (`.eq('estado', <expected>)` / `.neq('estado','enviado').neq('enviado',true)`) and checks affected-row count to detect races with the courier or the cron between read and write — if 0 rows, send a contextual fallback instead of assuming success. Button handlers in [botones.ts](src/lib/bot/botones.ts) additionally guard `.eq('telefono', numeroCliente)` (only the owner can act).

**`marcarHistorialDescartado`** is called whenever a conversation closes (confirmed/cancelled). It flags all of a customer's messages `descartado=true` so the next conversation's 15-min history window doesn't re-ingest stale fragments ("sumale 50 de agua" from a prior batch).

### Phone number normalization

Meta sends Argentine numbers as `549…`; we strip the `9` (`549` → `54`) in `normalizarNumero` so it matches what messaging apps display. Store/query the normalized form everywhere.

## Dashboard side

- Server Components fetch directly from Supabase ([app/page.tsx](src/app/page.tsx) — orders table with URL-param filters; `/balances`). Mutations go through `'use server'` actions in [src/lib/actions/](src/lib/actions/).
- Auth: Supabase SSR. `src/proxy.ts` is the **Next.js 16 middleware** (renamed from `middleware.ts`) — it refreshes the session on every request; unauthenticated users are redirected to `/login` by the page itself.
- Pricing is **quantity-tiered**: `listas_precios` (one `activa`) → `reglas_precios` (per `tipo_producto` `agua`/`crema`, `min_cantidad` threshold → `precio_unitario`). `calcularPreciosUnitarios` ([precio-utils.ts](src/lib/precio-utils.ts)) picks the highest applicable tier. `precio_total` and the `monto_total_*` columns are persisted on the row (the bot's `enviarResumenYPedirConfirmacion` reads `precio_total` straight from the DB — it's filled by DB-side logic/trigger, not by the bot).
- UI: Tailwind v4 + Radix UI + shadcn-style components in [src/components/ui/](src/components/ui/), TanStack Table for the orders grid.

## Supabase clients (pick the right one)

- **Service role** (`@supabase/supabase-js` with `SUPABASE_SERVICE_ROLE_KEY`): used **only server-side in the bot pipeline** (webhook, procesar, botones) to bypass RLS. Never expose this.
- **`@supabase/ssr` server client** ([supabase-server.ts](src/lib/supabase-server.ts)): Server Components / server actions, scoped to the user's cookies/session.
- **Browser client** ([supabase-client.ts](src/lib/supabase-client.ts)): client components.

## Key environment variables

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `VERIFY_TOKEN` (Meta handshake **and** Supabase DB-webhook auth), `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `GROQ_API_KEY` (read implicitly by `createGroq()`), `NEXT_PUBLIC_APP_URL` / `VERCEL_URL` (base URL for QStash callbacks). Stored in `.env.local`.
