# Changelog

## [0.3.0] — 2026-07-26

### Implementado — Multi-tenant
- Tablas `clients` (`client_id`, `nombre`, `token`) y `device_clients` (`device_hash` → `client_id`)
- Middleware `requireClient`: valida el token de la query string, resuelve el `client_id` y lo inyecta en el request. 401 si falta token, 403 si es inválido.
- Filtro por `client_id` en los 8 endpoints de datos: `/summary`, `/heatmap`, `/events`, `/stats`, `/utilization`, `/riesgo`, `/dispositivo/:id`, `/export`
- Ruta `/dashboard/:clientId` además de `/dashboard`
- Cliente `demo` autocreado, con todos los dispositivos existentes asignados — preserva el dashboard de prueba
- `dashboard.html`: se agregó el token a los fetches de `/stats` y `/dispositivo/:id` que no lo enviaban
- Decisión de diseño registrada en [DECISIONES.md D012](DECISIONES.md)

**Verificado en producción:** cliente `demo` ve sus 192 alertas / 102 dispositivos; un segundo cliente vacío recibe `0` en todos los KPIs, `[]` en riesgo/eventos y CSV solo con cabecera. El acceso directo a un `device_hash` ajeno vía `/dispositivo/:id` devuelve `[]`.

**Cambio que rompe el acceso anterior:** `http://2.24.196.49:3000/dashboard` ya no muestra datos sin token. La URL de prueba ahora es `http://2.24.196.49:3000/dashboard/demo?token=demo-token-dev-only`.

### Corregido — Normalización de tipos de alarma
- Las alarmas reales de Traccar llegan en camelCase (`lowBattery`, `fallDown`, `powerOn`) pero todas las queries filtran por snake_case (`low_battery`, `fall`). Las alarmas reales no se contaban en ningún KPI, filtro ni exportación — el bug estaba oculto porque los datos simulados sí usaban snake_case.
- Se agregó `normalizeAlarm()` en el webhook (camelCase → snake_case genérico + alias semánticos `fallDown`→`fall`, `lowPower`→`low_battery`) y una migración idempotente al arranque que normaliza las filas ya guardadas.
- Ver [APRENDIZAJES.md A015](APRENDIZAJES.md).

---

## [0.2.1] — 2026-07-26

### Corregido — WhatsApp funcionando end-to-end
- **Prueba de WhatsApp exitosa**: alarma SOS del dispositivo "Prueba_RR" llegó correctamente por WhatsApp al número de contacto.
- Causa raíz #1: el token de acceso en `/root/write_config.py` nunca se había actualizado correctamente en intentos previos — el script tiene el XML hardcodeado (no variables Python), así que un `sed` con patrón `token = '...'` no coincidía con la línea real `<entry key='notificator.whatsapp.token'>...</entry>` y fallaba en silencio. Ver [APRENDIZAJES.md A014](APRENDIZAJES.md).
- Causa raíz #2: `templateLanguage` estaba en `es_MX`, código no reconocido para la plantilla `simplecare_test2` (registrada como "Spanish (CHL)" en Meta). El código correcto es **`es_CL`** — nunca se había probado antes porque se asumía que no existía. Ver [APRENDIZAJES.md A006](APRENDIZAJES.md).
- Confirmado además: los tokens temporales de Meta (modo desarrollo) expiran cada ~24h y el fallo es silencioso en los logs de Traccar — hay que verificar el token directamente contra la API de Meta cuando WhatsApp no envía nada. Ver [APRENDIZAJES.md A013](APRENDIZAJES.md).
- Config final validada en Traccar:
  - `notificator.whatsapp.templateName` → `simplecare_test2`
  - `notificator.whatsapp.templateLanguage` → `es_CL`
  - `notificator.whatsapp.phoneNumberId` → `1294512040418742` (Test WhatsApp Business Account)
  - Notificación de tipo Alarma (SOS + caída) configurada, número de contacto en `user.phone` del usuario Traccar

## [0.2.0] — 2026-07-26

### Implementado
- Repositorio GitHub creado: `RenanRodriguez1711/simplecare-iot` (privado)
- Documentación completa: ARQUITECTURA, API, PRIVACIDAD, SEGURIDAD, RUNBOOK, DEPLOY, DECISIONES, APRENDIZAJES, ONBOARDING_MUNICIPIO, CREDENCIALES
- Token WhatsApp renovado en Meta Developer Portal
- Prueba de WhatsApp iniciada — completada en [0.2.1]

---

## [0.1.0] — 2026-07-26

### Implementado
- Configuración Traccar en Docker con protocolo minifinder2 (puerto 5187)
- Reenvío de eventos Traccar → Node.js via `event.forward.url`
- Servidor Node.js con webhook, anonimización SHA256 y almacenamiento SQLite
- Dashboard municipal con mapa de calor, KPIs, filtros y rango de fechas
- Panel de riesgo por persona anónima (puntaje: caída=3pts, SOS=2pts)
- Modal de historial individual por ID anónimo
- Exportación CSV compatible con Excel (BOM UTF-8)
- Endpoint `/utilization` para tracking de dispositivos activos por día
- Gestión de procesos con PM2

### Pendiente
- ~~Aprobación plantilla WhatsApp (`simplecare_test2`)~~ → Activa
- Implementación multi-tenant
- Panel admin para asignación IMEI → municipio
- Autenticación por token en backend
