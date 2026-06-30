import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    // Solo testeamos las funciones puras del bot (sin red ni LLM). Las evals
    // del prompt contra Groq viven aparte en scripts/prompts.eval.mjs.
    include: ['src/**/*.test.ts'],
    // procesar.ts / whatsapp.ts crean un cliente de Supabase a nivel de módulo
    // con `createClient(url!, key!)`. En tests no hay .env.local cargado, así que
    // damos valores dummy: el cliente se construye sin hacer red (lo que importa
    // es que el import no tire). Las funciones bajo test no tocan Supabase.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    },
  },
  resolve: {
    // Replica el alias "@/*" -> "src/*" de tsconfig para que vitest resuelva imports.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
