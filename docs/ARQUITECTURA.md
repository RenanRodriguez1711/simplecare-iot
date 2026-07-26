# Arquitectura — SimpleCare IoT

## Visión general

```
[Dispositivo EV07B]
       │
       │ TCP protocolo minifinder2, puerto 5187
       ▼
[Traccar — Docker]
       │
       ├─── WhatsApp Cloud API (Meta) ──► contactos de emergencia
       │
       │ HTTP POST /webhook (event.forward.url)
       ▼
[Node.js — Puerto 3000]
       │
       ├─── Anonimización (SHA256 + GPS rounding)
       │
       ▼
[SQLite — events.db]
       │
       ▼
[Dashboard HTML — /dashboard]
```

---

## Componentes

### Dispositivo — Eview EV07B
- Botón SOS personal para adultos mayores
- GPS integrado, conexión celular
- Protocolo: `minifinder2`
- Puerto Traccar: `5187`
- Eventos que emite: SOS, caída detectada, batería baja, conexión/desconexión

### Traccar
- Plataforma open source de tracking GPS
- Corre en Docker en el VPS
- Panel de administración: `http://2.24.196.49:8082`
- Archivo de configuración: `/opt/traccar/conf/traccar.xml` (dentro del contenedor)
- Config local en VPS: `/root/traccar.xml` (se copia al contenedor con `docker cp`)
- Gestiona dispositivos, usuarios y notificaciones
- Reenvía eventos al backend Node.js via HTTP POST

### Node.js (Backend)
- Runtime: Node.js con Express
- Puerto: `3000`
- Ubicación: `/opt/simplecare/server.js`
- Proceso gestionado por PM2 (auto-restart, logs)
- Responsabilidades:
  - Recibir eventos de Traccar via webhook
  - Anonimizar los datos
  - Persistir en SQLite
  - Servir el dashboard HTML
  - Exponer API REST para el dashboard

### SQLite
- Base de datos ligera, sin servidor separado
- Archivo: `/opt/simplecare/events.db`
- Una sola tabla: `events`
- Apropiada para el volumen actual (~5 KB por dispositivo por mes)
- Migración a PostgreSQL recomendada cuando el número de municipios/dispositivos escale significativamente

### Dashboard HTML
- Archivo estático servido por Node.js: `/opt/simplecare/public/dashboard.html`
- Librerías client-side: Leaflet.js, Leaflet.heat, Chart.js
- Sin framework (HTML + JS vanilla)
- URL actual: `http://2.24.196.49:3000/dashboard`

### WhatsApp Cloud API (Meta)
- Mensajería mediante plantillas aprobadas por Meta
- Configurado en Traccar (notificator nativo)
- Requiere token de acceso (caduca periódicamente — renovar en Meta Developer Portal)
- Plantilla activa: `simplecare_test2` (Spanish CHL, "Activa: calidad pendiente")
- Phone Number ID: `1294512040418742`

---

## Infraestructura VPS

| Parámetro | Valor |
|---|---|
| Proveedor | Hostinger |
| IP pública | `2.24.196.49` |
| OS | Ubuntu Linux |
| Disco | 48 GB total / ~44 GB disponibles |
| Acceso | SSH como `root` |
| SSH keepalive | Configurado en `~/.ssh/config` del cliente |

### Puertos abiertos (UFW)
| Puerto | Protocolo | Servicio |
|---|---|---|
| 22 | TCP | SSH |
| 5187 | TCP | Traccar — dispositivos EV07B |
| 8082 | TCP | Traccar — panel web |
| 3000 | TCP | Node.js — dashboard y API |
| 172.17.0.0/16 → 3000 | TCP | Docker → host (Traccar → Node.js) |

---

## Red interna Docker

Docker asigna la red `172.17.0.0/16` internamente.  
La IP del host visto desde el contenedor Traccar es **`172.17.0.1`**.  

Por eso en `traccar.xml` el webhook apunta a:
```
http://172.17.0.1:3000/webhook
```
y **no** a `localhost:3000` (que no funciona desde dentro del contenedor).

---

## Estructura de archivos en el VPS

```
/opt/simplecare/
├── server.js          ← backend principal
├── events.db          ← base de datos SQLite
├── package.json
├── node_modules/
└── public/
    ├── dashboard.html ← dashboard municipal
    └── logos/         ← logos de municipios (ej: santiago.png)

/root/
└── traccar.xml        ← config Traccar (se escribe con Python, luego docker cp)
```

---

## Flujo de datos completo

1. Adulto mayor presiona botón SOS en EV07B
2. Dispositivo envía evento TCP al VPS puerto 5187 (protocolo minifinder2)
3. Traccar recibe el evento, lo procesa y lo asocia al dispositivo registrado
4. Traccar envía notificación WhatsApp al contacto configurado (plantilla `simplecare_test2`)
5. Traccar reenvía el evento vía HTTP POST a `http://172.17.0.1:3000/webhook`
6. Node.js recibe el evento, extrae datos relevantes y los anonimiza:
   - `device_hash`: SHA256 del deviceId, primeros 16 caracteres hex
   - `lat_zone` / `lon_zone`: GPS redondeado a 2 decimales (~200m precisión)
   - Nombre del dispositivo y datos personales **nunca** se almacenan
7. El evento anonimizado se guarda en `events.db`
8. El municipio consulta el dashboard con su URL token para ver los datos agregados

---

## Proceso PM2

```bash
# Ver estado
pm2 status

# Ver logs
pm2 logs simplecare --lines 50

# Reiniciar
pm2 restart simplecare

# Auto-start en reboot del VPS
pm2 startup
pm2 save
```
