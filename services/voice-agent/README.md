# UNIK voice agent

Worker de LiveKit Agents que atiende llamadas telefónicas en nombre de UNIK con
OpenAI Realtime (voz a voz). Se despliega como **un servicio aparte** del web;
UNIK lo despacha por llamada y mantiene el control (pausa, transferencia,
cierre, reglas y herramientas).

## Cómo funciona

1. UNIK registra la llamada entrante, crea la sala `call-_{id}` y, si la cuenta
   está marcada como "IA atiende", despacha este agente (`AgentDispatch`) con
   `{ callId }` en los metadatos del job.
2. El worker pide su *brief* a UNIK (`GET /api/internal/voice/agent/context`):
   instrucciones, saludo, voz, modelo, llave de OpenAI y herramientas.
3. Espera al participante telefónico (SIP), arranca la sesión de voz y saluda.
4. Cada frase transcrita (cliente e IA) se envía a UNIK; cada herramienta que
   el modelo invoca la ejecuta UNIK con el ejecutor común (solo lectura).
5. Cada 1.5 s consulta el estado: si un operador **pausa la IA** el worker se
   calla y sale (UNIK vuelve a despacharlo al reanudar); si hay **transferencia**
   se despide y sale; si el cliente se despide, el worker pide a UNIK colgar.

## Variables de entorno

| Variable | Uso |
| --- | --- |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Mismo proyecto LiveKit que UNIK. |
| `UNIK_BASE_URL` | URL pública de UNIK, p. ej. `https://unik-system-production.up.railway.app`. |
| `UNIK_INTERNAL_API_KEY` | Misma llave interna que en UNIK. |
| `VOICE_AGENT_NAME` | Nombre con el que se registra (por defecto `unik-voice`); debe coincidir con UNIK. |
| `VOICE_AGENT_POLL_MS` | Intervalo de consulta de estado (1500). |
| `VOICE_AGENT_WAIT_CALLER_MS` | Máximo de espera al teléfono antes de salir (60000). |

La llave de OpenAI **no** se configura aquí: viene del panel Asistente IA de
UNIK a través del brief.

## Desarrollo

```bash
npm install
npm run typecheck
npm run dev   # registra el worker contra LiveKit con las variables del entorno
```

## Despliegue en Railway

Nuevo servicio desde el mismo repositorio con *Root Directory* =
`services/voice-agent` (usa el Dockerfile). No expone puerto. Escalar a más de
una réplica es seguro: LiveKit reparte los jobs entre workers.
