# Sistema de Reservas IDRD — Documentación Completa

## ¿Qué es?

Bot autónomo de reservas de canchas deportivas del IDRD (Instituto Distrital de Recreación y Deporte). Reemplaza un workflow anterior en n8n. Usa 18 cuentas IDRD simultáneamente para reservar canchas automáticamente, controlado por Telegram.

---

## Arquitectura general

```
USUARIO TELEGRAM
      │
      ▼
  /empieza → ingresa 3 IDs de canchas
      │
      ▼
  COMMANDER valida + refresca 18 tokens
      │
      ▼
  MISSIONPLANNER genera 18 misiones (6 por cancha)
      │
      ├── [Cuentas 1-6]  → Cancha A (Tue, Wed, Thu, Fri, Sat, Mon)
      ├── [Cuentas 7-12] → Cancha B (misma rotación de días)
      └── [Cuentas 13-18]→ Cancha C (misma rotación de días)
                │
                ▼ (18 en paralelo, Promise.allSettled)
         SOLDIERBOT por misión
         ─────────────────────
         • Loop cada 600-1200ms
         • llama getSchedules() al IDRD
         • corre algoritmo Tetris (AvailabilityEngine)
         • Si hay slot: reserva → pide link PSE → notifica Telegram
         • Si hay 401: refresca token y reintenta
         • 10 errores seguidos: circuit breaker (pausa 60s)
```

---

## Flujo completo paso a paso

### 1. Inicio — `/empieza`
- `src/index.ts` maneja el comando
- Limpia cualquier sesión activa del chat
- Cambia el estado a `"configuring"`
- Le pide al usuario que escriba 3 IDs de canchas en formato `ID` o `ID:Nombre`

### 2. El usuario escribe los IDs
- Se validan con **Zod** (regex `^\d+(:.+)?$`)
- Se guardan en sesión (`SessionManager`)
- El estado pasa a `"awaiting_confirmation"`
- Se llama a `Commander.validateCourts()`:
  - `TokenManager.refreshAllTokens()` — inicia sesión en las 18 cuentas secuencialmente (throttle de 2s entre cada una ≈ 36 segundos), guarda en `data/tokens.json`
  - `CourtCatalog.resolveAll()` — hace una petición de prueba al IDRD por cada cancha: `GET /parks/schedules/{id}` con el próximo martes; si devuelve 200 es válida
  - Muestra en Telegram los nombres reales de las canchas

### 3. Confirmación — `/si`
- El usuario confirma
- El estado pasa a `"searching"`
- Se llama a `Commander.deploy()`

### 4. Deploy — las 18 misiones

**Fase 1** — Refresca tokens (usa caché si < 5 min, si no vuelve a loguear las 18 cuentas)

**Fase 2** — `MissionPlanner.createMissions()`:
- Genera 18 objetos `Mission`
- Cuentas 1-6 → Cancha A, cada cuenta apunta a un día diferente: Mar, Mié, Jue, Vie, Sáb, Lun
- Cuentas 7-12 → Cancha B, misma rotación de días
- Cuentas 13-18 → Cancha C, misma rotación
- Cada misión lleva: `{ missionId, account, targetCourtId, court, targetDate, token }`

**Fase 3** — Lanza 18 `SoldierBot.execute()` en paralelo

---

## El SoldierBot — corazón del sistema

`src/services/SoldierBot.ts` — cada uno de los 18 bots corre en un loop independiente:

```
LOOP (cada 600-1200ms aleatorio)
│
├── GET /parks/schedules/{parkId}?date={targetDate}&document={doc}
│   (con token Bearer)
│
├── AvailabilityEngine.findSlot()
│   ├── Filtra slots por courtId (scenary_id)
│   ├── Marca obstáculos (slots ya ocupados)
│   ├── Intenta encajar 2 horas en ventana 8PM-10PM
│   ├── Si no: intenta 1 hora
│   └── Requiere ≥24h de anticipación desde ahora
│
├── Si NO hay slot:
│   ├── Cada 10 intentos: loguea diagnóstico
│   └── Duerme 600-1200ms y vuelve al inicio
│
├── Si SÍ hay slot:
│   ├── [dry-run]: loguea y continúa
│   └── [producción]:
│       ├── POST /parks/schedules/{parkId}/payment  (crea reserva)
│       ├── POST /payment-gateway/transferBank       (genera link PSE, hasta 5 reintentos)
│       ├── Notifica a Telegram: usuario, cancha, parque, fecha, hora, precio, link PSE
│       └── Duerme ~4 minutos (tiempo de lock del slot) y sigue buscando más
│
├── Si 401 (token expirado):
│   ├── TokenManager.refreshSingleToken()
│   └── Reintenta la misma petición
│
└── 10 errores consecutivos → circuit breaker:
    └── Pausa 60s, resetea contador, continúa
```

---

## Algoritmo Tetris — `AvailabilityEngine`

`src/core/AvailabilityEngine.ts` — Réplica exacta del bot n8n original

- **Ventana objetivo**: 8PM – 10PM (configurable por `.env`)
- **Duraciones preferidas**: [2h, 1h] (intenta 2h primero)
- **Anticipación mínima**: 24h desde el momento actual
- **Lógica**: Para cada slot de IDRD, marca como obstáculo si está ocupado, luego busca el primer hueco donde cabe una duración completa sin colisión
- **Formato de hora**: estilo PHP `g:i A` → `"8:00 PM"`, `"9:00 PM"`

---

## Gestión de tokens — `TokenManager`

`src/services/TokenManager.ts`

- Caché en memoria (válida 5 min) + persistencia en disco `data/tokens.json`
- Al arrancar: lee del disco; si hay token reciente, no re-logea
- Si una cuenta falla al loguear: usa el token anterior del disco como fallback
- `refreshSingleToken()`: refresco JIT cuando un bot recibe 401 durante operación

---

## Cliente HTTP IDRD — `IdrdApiClient`

`src/services/IdrdApiClient.ts`

- Dos clientes Axios separados:
  - **ciudadano** (`portalciudadano-back.idrd.gov.co`) — login y schedules
  - **contratista** (`portalcontratista-back.idrd.gov.co`) — PSE/pagos
- Headers de navegador real (`User-Agent`, `Accept`, `Origin`)
- **Importante**: el cliente ciudadano NO envía `Accept-Encoding` — el endpoint `/login` del IDRD devuelve 405 si lo recibe
- axios-retry: 3 reintentos con backoff exponencial en errores de red
- PSE incluye campos dummy hardcodeados (teléfono, dirección) requeridos por IDRD

---

## Telegram — Control e interfaz de usuario

`src/index.ts`, `src/services/TelegramNotifier.ts`

### Comandos disponibles

| Comando | Función |
|---------|---------|
| `/empieza` | Inicia el flujo de configuración |
| `/canchas` / `/ids` | Muestra las canchas configuradas actualmente |
| `/cambiar` | Resetea la configuración |
| `/cancelar` | Aborta sin desplegar |
| `/si` | Confirma y despliega los 18 bots |
| `/no` | Rechaza reinicio |
| `/estado` | Muestra el estado actual del sistema |
| `/termina` | Detiene todos los bots activos |

### Usuarios autorizados (hardcodeados)
- `1406723103` — Admin
- `659132607` — Nicolas

### Notificación de reserva exitosa
```
🎯 ¡CANCHA ENCONTRADA Y RESERVADA!
Usuario: [nombre cuenta]
Cancha: [courtName] — [parkName]
Fecha: [día]
Hora: 8:00 PM – 10:00 PM
Precio: $XX.XXX
Link PSE: [url bancaria]
```

---

## Estado de sesión — `SessionManager`

`src/services/SessionManager.ts`

- Persiste en `data/user-session.json`
- Máquina de estados por chat:

```
configuring → awaiting_confirmation → searching → stopped
```

- Sesiones > 24h se limpian automáticamente al iniciar
- Sobrevive reinicios del bot (PM2 auto-restart)

---

## Configuración — `.env`

```env
# 18 cuentas IDRD (x4 campos cada una)
ACCOUNT_1_NAME=...
ACCOUNT_1_DOCUMENT=...
ACCOUNT_1_EMAIL=...
ACCOUNT_1_PASSWORD=...
# ... (hasta ACCOUNT_18)

# URLs IDRD
IDRD_CITIZEN_URL=https://portalciudadano-back.idrd.gov.co
IDRD_CONTRACTOR_URL=https://portalcontratista-back.idrd.gov.co

# Horario de búsqueda
SLOT_START_HOUR=20        # 8PM
SLOT_END_HOUR=22          # 10PM
MIN_ANTICIPATION_HOURS=24

# Telegram
TELEGRAM_BOT_TOKEN_901=...
TELEGRAM_CHAT_ID_ADMIN=1406723103
TELEGRAM_CHAT_ID_NICOLAS=659132607
```

---

## Archivos de datos en tiempo de ejecución

### `data/tokens.json`
```json
{
  "tokens": [
    { "accountIndex": 1, "email": "...", "accessToken": "...", "updatedAt": "2026-05-04T..." }
  ],
  "lastFullRefresh": "2026-05-04T..."
}
```

### `data/user-session.json`
```json
{
  "sessions": [
    {
      "chatId": 659132607,
      "status": "searching",
      "courtIds": ["15982", "15981", "15980"],
      "courtInfos": [
        { "courtId": "15982", "parkId": 15982, "parkName": "San Andres", "courtName": "San Andres" }
      ],
      "updatedAt": "2026-04-20T..."
    }
  ]
}
```

---

## Despliegue — PM2

`ecosystem.config.js`

- 1 instancia (no clustering)
- Límite de memoria: 500MB
- Máximo 5 reinicios automáticos
- Delay entre reinicios: 5 segundos
- Logs: `./logs/error.log` y `./logs/output.log`

---

## Tests

| Archivo | Cobertura |
|---------|-----------|
| `__tests__/AvailabilityEngine.test.ts` | 8 pruebas: slots 2h, 1h, obstáculos, ventana horaria, formato PHP |
| `__tests__/MissionPlanner.test.ts` | 9 pruebas: 18 misiones, distribución 6 por cancha, rotación de días |
| `__tests__/stress/` | Harness completo con servidor IDRD falso: 409, 401, 5xx, timeouts; mide latencia, tasa de éxito, memoria |

---

## Decisiones de diseño clave

| Decisión | Razón |
|----------|-------|
| **No login JIT en ruta crítica** | Evita saturar `/login` del IDRD en horas pico (lunes por la mañana) |
| **Circuit breaker (10 errores → 60s pausa)** | Previene cascada de fallos si el IDRD tiene problemas |
| **PSE con 5 reintentos + fallback manual** | El gateway de pago del IDRD es inestable; el fallback permite que el usuario igual pague |
| **Caché de tokens 5 min** | Validación (`/empieza`) y despliegue (`/si`) pueden ocurrir con segundos de diferencia |
| **18 cuentas × 6 días = cobertura total semanal** | Cada cuenta va a un día diferente; si abre cualquier slot de la semana, alguien lo captura |
| **`--dry-run` mode** | Permite probar sin hacer pagos reales al IDRD |

---

## Puntos de latencia críticos

| Operación | Tiempo aproximado |
|-----------|------------------|
| Refresco completo de 18 tokens | ~36 segundos (2s throttle × 18) |
| Validación de una cancha | ~1-2 segundos (1 petición HTTP) |
| Ciclo de detección de slot | 600-1200ms por intento |
| Reserva + link PSE | < 2 segundos (crítico, slot se libera si demora) |
| Lock de slot tras reserva | ~4 minutos |

---

## Resumen ejecutivo

Cuando mandas `/empieza` y confirmas con `/si`, se lanzan **18 bots en paralelo**. Cada bot revisa su día asignado en su cancha asignada, haciendo ~10 peticiones por minuto al IDRD, hasta encontrar disponibilidad en el horario **8PM-10PM**. Al encontrar un slot: reserva automáticamente, genera el link de pago PSE, y te notifica por Telegram. Puedes detener todo con `/termina`.
