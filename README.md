# Sistema de Reservas IDRD — Bot 901

Bot autónomo que reserva canchas del **IDRD** (Bogotá) de forma automática, controlado por **Telegram**. Lanza 18 misiones en paralelo (una por cuenta) que vigilan la disponibilidad y reservan apenas aparece un cupo en el horario objetivo.

---

## ¿Por qué existe? (el problema)

El IDRD libera los cupos de las canchas los **lunes en la mañana**, y no a una hora exacta: los horarios "van subiendo" de forma escalonada durante varias horas, en orden cronológico (primero martes, luego miércoles, etc.). En ese momento **toda Bogotá** entra a pelear los mismos cupos, el servidor se satura y ganarlos a mano —refrescando la página— es prácticamente imposible.

Este bot automatiza esa carrera: detecta el instante en que un cupo se libera y dispara la reserva **sin reacción humana**, con el token de sesión ya listo. Esa es su ventaja estructural sobre una persona haciendo clic.

---

## ¿Qué hace?

- Controla **18 cuentas** IDRD, cada una como una "misión" independiente.
- Cada misión = **1 cuenta + 1 cancha + 1 día objetivo**, buscando en la ventana **8:00 PM – 10:00 PM** con al menos **24 h de anticipación**.
- Reparte las 18 cuentas en **3 canchas × 6 días** (rotación Mar–Lun, sin domingo).
- Al encontrar un cupo: **crea la reserva**, genera el **link de pago PSE** y lo **envía por Telegram**.
- **No se detiene** al reservar: si el IDRD libera el cupo por falta de pago, lo vuelve a tomar en segundos (re-búsqueda activa).

---

## ¿Cómo funciona? (visión general)

```
Telegram (/empieza + 3 IDs)
        │
        ▼
   Commander ──► valida las canchas contra el catálogo IDRD
        │
        ▼
 MissionPlanner ──► arma las 18 misiones (6 por cancha, rotando días)
        │
        ▼
 18× SoldierBot en paralelo (Promise.allSettled)
        │  cada uno: login propio → sondea disponibilidad → reserva → link PSE
        ▼
   Notificación por Telegram con el link de pago
```

### Componentes clave

| Archivo | Rol |
|---|---|
| `src/index.ts` | Handler de comandos de Telegram y arranque. |
| `src/services/Commander.ts` | Orquesta validación (`validateCourts`) y despliegue (`deploy`). |
| `src/services/SoldierBot.ts` | El loop de cada misión: búsqueda, reserva, manejo de errores. |
| `src/core/MissionPlanner.ts` | Arma las 18 misiones (6 por cancha, rotando días). |
| `src/core/AvailabilityEngine.ts` | Algoritmo "Tetris" que encuentra el mejor bloque de 2 h (o 1 h) en la ventana. |
| `src/services/TokenManager.ts` | Login por cuenta y caché de tokens en disco. |
| `src/services/SessionManager.ts` | Estado por chat (`configuring → searching → stopped`), persistido en disco. |
| `src/services/IdrdApiClient.ts` | Cliente HTTP hacia IDRD (con keep-alive y reintentos). |

---

## Decisiones de diseño (el porqué)

- **Login independiente por misión.** Si una cuenta falla, solo esa vuelve a loguearse; las otras 17 siguen sin interrupción. Nunca hay un re-login global que frene a toda la flota.
- **Validación liviana (sin login masivo).** Validar las canchas usa **un solo token cacheado**, no las 18 cuentas — el login masivo disparaba el rate-limit (429) del IDRD.
- **Timezone forzado a Bogotá.** Todo se calcula en hora de Bogotá (`America/Bogota`); así el bot funciona igual en un servidor UTC sin que las fechas objetivo se corran un día.
- **Cadencia reactiva con "sprint" global.** La mayor parte del tiempo sondea suave; apenas **una** misión detecta que el IDRD empezó a subir cupos, **todas** pasan a modo rápido para cazar la cascada del lunes, sin machacar la conexión el resto del tiempo.
- **Keep-alive.** Reutiliza la conexión TCP/TLS con el IDRD para bajar y estabilizar la latencia justo cuando el servidor está saturado.
- **Persistencia del claim.** Si la reserva falla por saturación (5xx/timeout), reintenta el POST rápido varias veces antes de rendirse — convierte un "casi" en un "ganado".
- **Re-búsqueda activa.** El bot no se detiene tras reservar: reacciona en segundos si el cupo se libera de nuevo.

---

## Requisitos

- **Node.js** (v20 o superior) y **Git**.
- Un archivo **`.env`** con las credenciales (ver abajo). **No se versiona** (está en `.gitignore`).
- Para que el IDRD **no bloquee** las peticiones, ejecutar desde una **IP residencial colombiana** (los rangos de datacenter suelen estar bloqueados).

## Instalación

```bash
git clone https://github.com/jorgeduque-cell/ResevationSystem.BOT.git
cd ResevationSystem.BOT
npm install
# copiar el archivo .env a la raíz del proyecto (ver más abajo)
npm run build
node dist/index.js
```

## Configuración (`.env`)

El archivo `.env` (en la raíz, **nunca subir a GitHub**) define:

- `ACCOUNT_1_NAME`, `ACCOUNT_1_DOCUMENT`, `ACCOUNT_1_EMAIL`, `ACCOUNT_1_PASSWORD` … hasta `ACCOUNT_18_*` — las 18 cuentas IDRD.
- `TELEGRAM_BOT_TOKEN` — token del bot de Telegram que controla el sistema.
- `TELEGRAM_CHAT_ADMIN`, `TELEGRAM_CHAT_NICOLAS` — chats que reciben las notificaciones.
- `IDRD_CITIZEN_URL`, `IDRD_CONTRACTOR_URL` — endpoints del IDRD.
- `SLOT_START_HOUR` (20), `SLOT_END_HOUR` (22), `MIN_ANTICIPATION_HOURS` (24) — ventana y anticipación.

## Comandos (npm)

| Comando | Qué hace |
|---|---|
| `npm run build` | Compila TypeScript (`tsc`). |
| `npm start` | Arranca el bot (`node dist/index.js`). |
| `npm test` | Tests unitarios (AvailabilityEngine + MissionPlanner). |
| `npm run stress` | Harness de estrés contra un IDRD simulado (sin tráfico real). |
| `npm run recon:rate` | Mide el límite de peticiones por IP antes del 429. |
| `npm run recon:dribble` | Registra a qué hora y cada cuánto sube el IDRD los cupos. |

## Comandos de Telegram

| Comando | Qué hace |
|---|---|
| `/empieza` | Inicia el flujo: pide las 3 canchas y arranca la búsqueda. |
| `/estado` | Muestra el estado actual y las canchas activas. |
| `/cambiar` | Detiene la búsqueda y pide otras 3 canchas. |
| `/termina` | Detiene la búsqueda. |
| `/cancelar` | Cancela la configuración en curso. |
| `/canchas` · `/ids` | Muestra las canchas configuradas. |

---

## Notas de operación

- **Una sola instancia a la vez.** El bot usa un único bot de Telegram; si se corren dos instancias (p. ej. dos PCs) chocan con un error **409**. Apagar una antes de encender la otra.
- **On-demand.** No necesita estar 24/7: se enciende durante la ventana en que el IDRD libera los cupos (lunes por la mañana) y se apaga después.
- **IP residencial colombiana.** El IDRD bloquea IPs de datacenter/hosting; hay que ejecutar desde una conexión residencial de Colombia.

## Tests

```bash
npm test          # unitarios (jest)
npm run stress    # estrés contra un IDRD simulado en proceso
```

Los tests cubren el algoritmo de disponibilidad y la planificación de misiones; el harness de estrés valida el flujo completo de despliegue sin tocar el IDRD real.
