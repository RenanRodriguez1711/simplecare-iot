# Changelog

## [0.2.0] — 2026-07-26

### Implementado
- Repositorio GitHub creado: `RenanRodriguez1711/simplecare-iot` (privado)
- Documentación completa: ARQUITECTURA, API, PRIVACIDAD, SEGURIDAD, RUNBOOK, DEPLOY, DECISIONES, APRENDIZAJES, ONBOARDING_MUNICIPIO, CREDENCIALES
- Token WhatsApp renovado en Meta Developer Portal
- Traccar actualizado con plantilla `simplecare_test2` + `templateLanguage=es`
- Prueba de WhatsApp iniciada — **pendiente verificar número de contacto en Traccar**

### Pendiente inmediato
- Verificar/configurar número de teléfono en Notificaciones de Traccar para el dispositivo EV07B
- Activar alarma SOS y confirmar que llega el mensaje WhatsApp
- Si falla con `es`: probar con `en_US` y plantilla en inglés

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
