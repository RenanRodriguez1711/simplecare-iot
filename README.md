# SimpleCare IoT — Sistema de Alertas GPS Municipal

Sistema que recibe eventos de alarma desde dispositivos GPS personales (Eview EV07B) y entrega:
- Alertas por WhatsApp a contactos de emergencia
- Dashboard anonimizado para municipios con análisis de uso y riesgo

## Stack

- **Dispositivo:** Eview EV07B (protocolo minifinder2)
- **Servidor GPS:** Traccar (Docker)
- **Backend:** Node.js + Express + SQLite (better-sqlite3)
- **Notificaciones:** WhatsApp Cloud API (Meta)
- **Dashboard:** HTML + Leaflet.js + Chart.js
- **Infraestructura:** VPS Linux, PM2

## Documentación

- [Arquitectura](docs/ARQUITECTURA.md)
- [API](docs/API.md)
- [Privacidad y anonimización](docs/PRIVACIDAD.md)
- [Seguridad](docs/SEGURIDAD.md)
- [Runbook](docs/RUNBOOK.md)
- [Deploy](docs/DEPLOY.md)
- [Changelog](docs/CHANGELOG.md)
- [Decisiones de diseño](docs/DECISIONES.md)
- [Aprendizajes](docs/APRENDIZAJES.md)
- [Onboarding municipio](docs/ONBOARDING_MUNICIPIO.md)
- [Credenciales](docs/CREDENCIALES.md)
