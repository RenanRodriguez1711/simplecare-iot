# Decisiones de Diseño — SimpleCare IoT

Registro de las decisiones de arquitectura y diseño relevantes, con su justificación.

---

## D001 — SQLite en lugar de PostgreSQL

**Decisión:** usar SQLite como base de datos.

**Justificación:**
- El volumen de datos es muy bajo (~5 KB por dispositivo por mes)
- No hay consultas concurrentes significativas (el dashboard es de uso esporádico)
- No requiere servidor separado — simplifica enormemente el deploy y mantenimiento
- Sin costo operacional adicional
- Facilita backups: el archivo `events.db` se puede copiar directamente

**Cuándo migrar:** cuando el número de municipios concurrentes accediendo al dashboard simultáneamente genere lentitud, o cuando el archivo supere los 500 MB. En ese punto migrar a PostgreSQL.

---

## D002 — SHA256 para anonimizar el ID del dispositivo

**Decisión:** usar SHA256 del deviceId y tomar los primeros 16 caracteres hex.

**Justificación:**
- Irreversible: no se puede recuperar el IMEI original desde el hash
- Determinista: el mismo dispositivo siempre produce el mismo hash (permite correlacionar eventos del mismo individuo sin saber quién es)
- Cumple el modelo de anonimización requerido por Ley 21.719 Chile

**Alternativa descartada:** UUID aleatorio por evento — no permite correlacionar eventos del mismo individuo, lo que elimina la utilidad del panel de riesgo.

---

## D003 — GPS redondeado a 2 decimales (~200m)

**Decisión:** almacenar `lat_zone = Math.round(lat * 100) / 100`.

**Justificación:**
- 2 decimales = ~1.1 km de precisión → no identifica dirección ni edificio
- Suficiente para el mapa de calor por zonas que necesita el municipio
- Cumple el requisito de privacidad: no permite ubicar a la persona

**Alternativa considerada:** 3 decimales (~111m) — descartado porque en zonas residenciales permite identificar el edificio o manzana.

---

## D004 — Node.js en lugar de otro backend

**Decisión:** usar Node.js + Express.

**Justificación:**
- Ecosistema simple para un servidor de webhook + API REST
- `better-sqlite3` es una de las mejores librerías SQLite disponibles
- Sintaxis async/await clara y mantenible
- PM2 facilita la gestión del proceso

**Alternativa considerada:** Python (FastAPI) — también válido, pero Node.js tiene menor overhead y el mismo resultado para este caso de uso.

---

## D005 — PM2 para gestión del proceso

**Decisión:** usar PM2 en lugar de systemd o Docker para Node.js.

**Justificación:**
- Más simple de configurar que systemd para este caso
- Auto-restart inmediato ante crashes
- Logs integrados con `pm2 logs`
- `pm2 startup` genera el script de systemd automáticamente para inicio con el sistema

---

## D006 — Leaflet.js para los mapas del dashboard

**Decisión:** usar Leaflet.js + OpenStreetMap + Leaflet.heat.

**Justificación:**
- Open source, sin costo (Google Maps cobra por API calls)
- Leaflet.heat provee el mapa de calor que el dashboard requiere
- No necesita API key
- Ligero y suficiente para las funciones requeridas

---

## D007 — Dashboard como HTML estático servido por Node.js

**Decisión:** no usar React, Vue ni ningún framework frontend. HTML + JS vanilla.

**Justificación:**
- El dashboard es una sola página con funcionalidad acotada
- No hay estado complejo que justifique un framework
- Menos dependencias, menos puntos de falla
- Fácil de modificar sin proceso de build

---

## D008 — Traccar para recepción de GPS (en lugar de servidor propio)

**Decisión:** usar Traccar como plataforma GPS en lugar de implementar el protocolo `minifinder2` desde cero.

**Justificación:**
- Traccar ya implementa el protocolo `minifinder2` del EV07B nativamente
- Gestión de dispositivos, usuarios y notificaciones incluida
- Integración con WhatsApp Cloud API nativa
- Open source, se puede correr en Docker sin costo

**Costo:** añade complejidad (Docker + configuración XML) pero ahorra semanas de desarrollo del protocolo GPS.

---

## D009 — Python para escribir el XML de Traccar

**Decisión:** usar un script Python (`/root/write_config.py`) para escribir `traccar.xml` en lugar de bash heredoc.

**Justificación:** el token de WhatsApp contiene el carácter `!` que bash expande en modo interactivo dentro de heredocs, corrompiendo el XML y generando errores de parseo (`SAXParseException`).

Python escribe el string literal sin expandir ningún carácter especial.

---

## D010 — Puntaje de riesgo: caída=3, SOS=2

**Decisión:** en el panel de riesgo, una caída vale 3 puntos y un SOS vale 2 puntos.

**Justificación:** una caída detectada por el acelerómetro es un evento físico concreto y frecuente que indica fragilidad real. Un SOS puede ser activación accidental (botón presionado por error), por lo que tiene menor peso aunque sea más urgente en tiempo real.

El puntaje refleja **riesgo acumulado de fragilidad**, no urgencia del momento.

---

## D011 — URL con token secreto en lugar de login

**Decisión:** autenticar el acceso al dashboard mediante un token en la URL (`/dashboard/:clientId?token=xxx`) en lugar de formulario de login.

**Justificación:**
- Más simple de implementar y mantener
- Adecuado para el perfil de usuario (funcionario municipal que accede periódicamente)
- No requiere gestión de sesiones ni cookies
- El municipio puede compartir fácilmente el acceso con sus funcionarios

**Pendiente:** implementar la validación del token en el backend (actualmente el frontend está preparado pero el backend no valida).

---

## D012 — Multi-tenant se implementa antes de tener un segundo cliente confirmado

**Decisión:** construir el soporte multi-tenant (tablas `clients`/`device_clients`, middleware de validación de token, filtro por `client_id`) como preparación anticipada, sin tener todavía un segundo municipio contratado.

**Justificación:** una vez migrado el sistema a multi-tenant, el paso natural siguiente es ofrecer **notificación WhatsApp a contactos individuales por dispositivo** (hoy el mensaje llega a la cuenta administradora de Traccar, no a la familia del adulto mayor — ver limitación documentada en [CONTINUAR.md](../CONTINUAR.md)). Tener la base multi-tenant lista de antemano evita re-arquitecturar cuando se implemente esa función, porque el enrutamiento de contactos por dispositivo depende directamente de tener ya modelado `device → cliente`.

**Orden de trabajo:**
1. Multi-tenant backend (tablas, middleware, filtros) — en curso
2. Notificación WhatsApp por contacto individual (usando la tabla `device_clients` ya existente para enrutar el mensaje a un contacto específico en vez de al admin de Traccar)
