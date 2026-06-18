# CLAUDE.md — Sistema de Reservas IDRD (bot 901)

Instrucciones para Claude Code. Lee este archivo completo antes de tocar código.

## Contexto del proyecto

Bot autónomo de reservas de canchas del IDRD, controlado por Telegram. Stack: TypeScript + Node.js, Axios, Zod, PM2. Lanza 18 misiones en paralelo (18 cuentas IDRD), cada una buscando disponibilidad 8PM–10PM en una cancha/día asignado, vía `Promise.allSettled`.

### Archivos clave

- `src/index.ts` — handler de comandos de Telegram y arranque de la máquina de estados.
- `src/services/Commander.ts` — orquesta validación (`validateCourts`) y despliegue (`deploy`).
- `src/services/SoldierBot.ts` — el loop de cada misión (búsqueda, reserva, manejo de errores).
- `src/services/TokenManager.ts` — `refreshAllTokens()` (todas), `refreshSingleToken()` (una sola), `ensureToken()` (cache-o-login por cuenta).
- `src/core/MissionPlanner.ts` — arma las 18 misiones (6 por cancha, rotando días).
- `src/services/SessionManager.ts` — estados: `configuring → searching → stopped`.

## Reglas de trabajo

1. **Lee primero, edita después.** Abre los archivos involucrados y confirma firmas y flujo real antes de cambiar nada. La doc puede estar desactualizada; el código manda.
2. **Cambios mínimos.** Toca solo lo necesario. No refactorices de más ni cambies comportamiento fuera de alcance.
3. **Plan corto antes de aplicar edits** (qué archivos y qué cambia).
4. **Corre los tests después de cada tarea:** `__tests__/AvailabilityEngine.test.ts`, `__tests__/MissionPlanner.test.ts`, y el harness de `__tests__/stress/`. No rompas ninguno.
5. **TypeScript estricto, sin `any`.** Respeta el estilo existente. No toques `.env` ni metas secretos al repo.

Comandos:

- `npm test` — jest (AvailabilityEngine + MissionPlanner).
- `npm run stress` — harness de estrés contra un MockIdrd en proceso (sin tráfico al IDRD real). Variables: `STRESS_SCENARIO` (baseline | monday-9am | chaos | slot-rush), `STRESS_DURATION_MS`, `STRESS_PORT`.
- `npm run build` — `tsc`.

## Tarea 1 — Quitar la confirmación de canchas — HECHO

**Qué:** Antes, tras escribir los 3 IDs, el bot mostraba `✅ Canchas registradas… ¿Iniciar búsqueda? /si /cancelar` y esperaba el `/si`. Se eliminó ese paso: la búsqueda arranca automáticamente apenas las 3 canchas resuelven.

**Cómo quedó:**

- El estado `awaiting_confirmation` ya no se usa como estado de reposo. Apenas `Commander.validateCourts()` resuelve bien las 3 canchas, el handler de texto libre llama directo a `runDeployment()` (que pone el estado en `searching`).
- Una sola línea de feedback: `✅ Canchas registradas — iniciando búsqueda:` con la lista, horario objetivo y recordatorio de `/estado` y `/termina`.
- `/empieza` con una búsqueda activa ya no pide `/si`/`/no`: indica usar `/cambiar` (otras canchas) o `/termina` (detener).
- `/si` quedó como no-op informativo (compatibilidad con la memoria muscular). `/no` se eliminó.

## Tarea 2 — Login independiente por misión — HECHO

**Problema:** Cuando la plataforma fallaba, `Commander.deploy()` disparaba un re-login completo secuencial (`refreshAllTokens()`, ~36s) de las 18 cuentas como barrera previa. Un solo login caído bloqueaba/retrasaba a toda la flota.

**Qué queremos:** Cada misión 100% autónoma. Si una cuenta falla, SOLO esa cuenta vuelve a loguear; las otras 17 siguen buscando sin interrupción.

**Cómo quedó:**

- **`Commander.deploy()`** ya no llama `refreshAllTokens()` como barrera. Siembra el `tokenMap` desde el cache en disco (instantáneo, placeholder `''` si no hay) para que `MissionPlanner` genere las 18 misiones, y lanza todo de una con el `Promise.allSettled` existente.
- **`SoldierBot.execute()`** ahora, como primer paso, asegura su token: `tokenManager.ensureToken(account, staggerMs)`. Usa cache si sirve; si no, loguea SOLO su cuenta. El stagger (`(index-1) * 200ms`) evita 18 `POST /login` simultáneos al arranque y solo se aplica cuando realmente hay que loguear.
- **`TokenManager.refreshSingleToken()`** ahora persiste el token actualizado en `data/tokens.json` (vía `upsertToken`).
- **`TokenManager.ensureToken()`** (nuevo): reusa el token cacheado si tiene < 6h; si no, loguea esa cuenta (con stagger) y persiste.
- **`MissionPlanner`**: el gate de token cambió de `if (!token)` a `if (token === undefined)` para poder sembrar misiones con token cacheado o placeholder vacío. Mantiene el test "skips accounts without tokens" (las cuentas ausentes del map → `undefined` → se saltan).
- El loop ya hacía `refreshSingleToken()` ante 401 y tras el circuit breaker (por cuenta) — eso NO se tocó.

### Invariantes que NO se pueden romper

- **No login JIT en cada petición.** El login solo ocurre al arranque y en recuperación por error (401 / circuit breaker).
- **Nunca llamar `refreshAllTokens()` dentro del loop** ni en la ruta de recuperación.
- **Escalonar los logins iniciales** con stagger `index * ~200ms` (no barrera secuencial).
- **Mantener `Promise.allSettled`** (el fallo de un bot no mata a los demás).
- **Mantener el circuit breaker por bot** (10 errores → pausa 60s).
- **`refreshSingleToken()` persiste** el token actualizado en `data/tokens.json`.

**Listo cuando:** Con el harness de `__tests__/stress/` simulando una cuenta que falla (401/5xx/timeout), solo esa cuenta re-loguea y las otras 17 siguen buscando sin pausa. Todos los tests pasan.

## Tarea 3 — Re-búsqueda agresiva (no parar tras reservar) — HECHO

**Qué:** El bot no se detiene cuando reserva una cancha. Si IDRD libera ese slot por tiempo (p. ej. si no se completa el pago), el bot debe poder re-reservarlo a los pocos segundos (objetivo ≤ 10s).

**Cómo quedó** (solo `src/services/SoldierBot.ts`):

- El loop ya nunca salía con estado `completed`: tras reservar hace `continue` y sigue sondeando. Eso se mantuvo y se hizo explícito.
- Tras una reserva exitosa, el bot vuelve a sondear con cadencia `REPOLL_AFTER_RESERVE_MIN_MS`/`MAX_MS` (~0.8–1.5s). Mientras el slot sigue bloqueado, el branch "sin hueco" sondea cada ~0.6–1.2s. Ambas cadencias garantizan reacción muy por debajo de 10s cuando el slot reaparece.
- Logging observable: el mensaje de reserva indica "Re-búsqueda AGRESIVA"; el diagnóstico "sin hueco" muestra `🔁 re-búsqueda agresiva` cuando ya hubo ≥1 reserva.
- No se tocó el algoritmo Tetris (`AvailabilityEngine`) ni las constantes de ventana horaria/anticipación.

**Listo cuando:** Tras reservar, el bot sigue corriendo y vuelve a reservar el mismo slot apenas IDRD lo libera (verificado con el harness: cada bot hace múltiples reservas en una sola corrida).

## Tarea 4 — Fix timezone (links de domingo) — HECHO

**Problema:** En producción llegaban links de reservas para días incorrectos (p. ej. domingo, que no es día objetivo). Causa raíz: el VPS corre en **UTC**, pero todos los helpers de `src/utils/date.ts` (`nowBogota`, `getNextDateForDay`, `toIsoDate`) y la ventana horaria del `AvailabilityEngine` asumen que la hora local del proceso es Bogotá. En la máquina de desarrollo (UTC-5) eso se cumple → funciona y los tests pasan; en UTC se corre 5h y, en la madrugada de Bogotá, cada fecha objetivo retrocede un día (lunes → domingo).

**Cómo quedó** (sin tocar ninguna config de días ni horarios):

- Nuevo `src/config/timezone.ts` que hace `process.env.TZ = 'America/Bogota'`.
- Se importa **de primero** en `src/index.ts` (antes que cualquier módulo que use fechas), para que el servidor se comporte igual que local.
- `ecosystem.config.js`: `env.TZ = 'America/Bogota'` como refuerzo.
- Verificado: con `TZ=UTC` un objetivo de lunes cae en domingo; con `TZ=America/Bogota` cae en lunes. `TARGET_DAYS` y la ventana 8PM–10PM quedaron intactos.

**Listo cuando:** En el VPS, los días objetivo y los horarios coinciden con Bogotá; no llegan links de domingo. Tras `git pull && npm run build && pm2 restart idrd-bot`, el log de arranque muestra la fecha en hora de Bogotá.
