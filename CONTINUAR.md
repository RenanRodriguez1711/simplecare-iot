# Cómo continuar este proyecto

Este archivo es el punto de entrada para retomar el desarrollo de SimpleCare IoT en una nueva sesión de Claude. Léelo completo antes de hacer cualquier cambio.

---

## Estado actual (al 26 julio 2026)

El sistema está **funcionando en producción** en el VPS `2.24.196.49`.

| Componente | Estado |
|---|---|
| Traccar (Docker) | ✅ Corriendo — recibe eventos del dispositivo EV07B |
| Node.js (PM2) | ✅ Corriendo — puerto 3000 |
| Dashboard municipal | ✅ `http://2.24.196.49:3000/dashboard` |
| Plantilla WhatsApp | ✅ `simplecare_test2` activa en Meta (Spanish CHL) |
| Token WhatsApp | ✅ Renovado el 26 jul 2026 — en `/root/write_config.py` del VPS |
| Config Traccar | ✅ Actualizado con nuevo token + `templateName=simplecare_test2` + `templateLanguage=es` |
| Prueba WhatsApp | ⏳ **PENDIENTE** — falta verificar número de contacto en Traccar |
| Multi-tenant | ❌ No implementado |
| Autenticación dashboard | ❌ No implementada |

---

## Lo primero que hay que hacer — Prueba de WhatsApp

La configuración de Traccar ya está lista. Solo falta verificar que el dispositivo EV07B tenga un número de teléfono configurado en sus notificaciones de Traccar.

**Paso 1 — Abrir panel Traccar:**
```
http://2.24.196.49:8082
```

**Paso 2 — Verificar notificaciones del dispositivo:**
- Ir a **Notificaciones** en el panel
- Verificar que el dispositivo EV07B tiene una notificación de tipo "Alarma" con canal WhatsApp
- El campo de teléfono debe tener el número del contacto con código de país (ej: `56912345678`)
- Si no tiene número configurado → agregar uno

**Paso 3 — Activar alarma SOS** en el dispositivo físico y verificar:
- [ ] El contacto recibe el WhatsApp con el texto: *"Alerta SimpleCare: SOS. Por favor verifique el estado del dispositivo."*
- [ ] El evento aparece en el dashboard

**Si falla con error de plantilla:**
- Probar cambiando `templateLanguage` de `es` a `en_US` (y usar la plantilla en inglés "cancelado")
- Ver instrucciones de actualización de config más abajo

---

## Cómo actualizar la config de Traccar

```bash
ssh root@2.24.196.49
nano /root/write_config.py   # editar token o templateLanguage
python3 /root/write_config.py
docker cp /root/traccar.xml traccar:/opt/traccar/conf/traccar.xml
docker restart traccar
```

Config actual en `/root/write_config.py`:
```
templateName     = simplecare_test2
templateLanguage = es
phoneNumberId    = 1294512040418742
token            = renovado el 26 jul 2026 (caduca ~24h en modo desarrollo)
```

**El token de Meta caduca.** Si WhatsApp deja de funcionar, ir a:
Meta Developer Portal → SimpleCare_WS → WhatsApp → Paso 1. Pruébalo → Generar token

---

## Próximas tareas (en orden)

### 1. Completar prueba WhatsApp ← AHORA
Ver sección anterior.

### 2. Multi-tenant backend
Cada municipio debe ver solo sus propios datos. El frontend ya está preparado — la URL `/dashboard/:clientId?token=xxx` ya lee `clientId` y `token`, pero el backend no los valida ni filtra.

**Qué implementar en `server.js`:**
- Tabla `clients` en SQLite: `client_id, nombre, token`
- Tabla `device_clients`: `device_hash, client_id`
- Middleware que valide el token en todos los endpoints
- Filtro por `client_id` en todas las queries

### 3. Panel admin SimpleCare (interno)
Interfaz para asignar dispositivos a municipios al entregar el hardware.

### 4. Autenticación del dashboard
Validar el token secreto en el backend antes de servir datos.

### 5. HTTPS + subdominio `panel.simplecare.cl`
- Crear registro DNS tipo A: `panel` → `2.24.196.49` (en panel de Benza Hosting)
- Instalar Nginx + Certbot en el VPS
- Configurar reverse proxy

### 6. Verificación Meta Business
Requisito para salir del sandbox de WhatsApp y enviar a cualquier número.

---

## Acceso al servidor

```bash
ssh root@2.24.196.49
```

Si se corta la conexión, verificar `~/.ssh/config` en el PC local:
```
Host 2.24.196.49
    HostName 2.24.196.49
    User root
    ServerAliveInterval 60
    ServerAliveCountMax 10
```

---

## Comandos útiles en el VPS

```bash
pm2 status                          # estado del servidor Node.js
pm2 logs simplecare                 # logs en tiempo real
pm2 restart simplecare              # reiniciar servidor
docker logs traccar --tail 50       # logs de Traccar
docker restart traccar              # reiniciar Traccar
docker ps                           # ver contenedores corriendo
```

---

## Archivos clave

| Archivo | Ubicación en VPS |
|---|---|
| Backend Node.js | `/opt/simplecare/server.js` |
| Dashboard HTML | `/opt/simplecare/public/dashboard.html` |
| Base de datos | `/opt/simplecare/events.db` |
| Config Traccar (script) | `/root/write_config.py` |
| Config Traccar (XML) | `/root/traccar.xml` |

---

## Repositorio GitHub

`https://github.com/RenanRodriguez1711/simplecare-iot` (privado)

```
├── CONTINUAR.md          ← este archivo
├── README.md
├── docs/                 ← documentación completa
└── server/
    ├── server.js
    └── dashboard.html
```

**Importante:** cada vez que se modifique `server.js` o `dashboard.html` en el VPS, copiar los cambios a `server/` y hacer commit.

---

## Datos de prueba

La base de datos tiene ~7.000–9.000 eventos **simulados** para 100 dispositivos del 25 mar al 25 jun 2026. Para borrarlos cuando haya datos reales:

```bash
cd /opt/simplecare && node -e "
const db = require('better-sqlite3')('/opt/simplecare/events.db');
db.prepare('DELETE FROM events').run();
console.log('DB limpia');
"
```

---

## Contexto de negocio

- **Producto:** dispositivo físico EV07B (botón SOS GPS) + suscripción mensual
- **Clientes objetivo:** municipios de Chile para programas de adultos mayores
- **Propuesta al municipio:** datos anonimizados de uso y alertas para planificación social
- **Marco legal:** Ley 21.719 Chile — los datos anonimizados no son datos personales
- **WhatsApp:** canal de alertas directas a la familia del adulto mayor
- **App Meta:** `SimpleCare_WS` — Phone Number ID: `1294512040418742`
