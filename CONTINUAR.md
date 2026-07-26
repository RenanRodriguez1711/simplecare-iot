# Cómo continuar este proyecto

Este archivo es el punto de entrada para retomar el desarrollo de SimpleCare IoT en una nueva sesión de Claude. Léelo completo antes de hacer cualquier cambio.

---

## Estado actual (al 26 julio 2026)

El sistema está **funcionando en producción** en el VPS `2.24.196.49`.

| Componente | Estado |
|---|---|
| Traccar (Docker) | ✅ Corriendo — recibe eventos del dispositivo EV07B |
| Node.js (PM2) | ✅ Corriendo — puerto 3000 |
| Dashboard municipal | ✅ Disponible en `http://2.24.196.49:3000/dashboard` |
| WhatsApp | ⏳ Pendiente prueba — plantilla activa, token puede haber expirado |
| Multi-tenant | ❌ No implementado |
| Autenticación dashboard | ❌ No implementada |

---

## Lo primero que hay que hacer

### Prueba de WhatsApp (tarea inmediata)

La plantilla `simplecare_test2` está activa en Meta. Hay que:

**1. Renovar el token** (caduca cada 24h en modo desarrollo):
- Ir a [Meta Developer Portal](https://developers.facebook.com) → tu app → WhatsApp → API Setup
- Copiar el token del Step 1

**2. Actualizar el config de Traccar** con el nuevo token:
```bash
# Conectar al VPS
ssh root@2.24.196.49

# Editar el token en el script
nano /root/write_config.py
# Reemplazar el valor de notificator.whatsapp.token

# Aplicar
python3 /root/write_config.py
docker cp /root/traccar.xml traccar:/opt/traccar/conf/traccar.xml
docker restart traccar
```

Config actual de Traccar que debe quedar:
```
templateName     = simplecare_test2
templateLanguage = es
phoneNumberId    = 1294512040418742
event.forward.url = http://172.17.0.1:3000/webhook
```

**3. Activar alarma SOS en el dispositivo EV07B** y verificar:
- Que el contacto registrado en Traccar recibe el WhatsApp
- Que el evento aparece en `http://2.24.196.49:3000/dashboard`

---

## Próximas tareas (en orden)

### 1. Multi-tenant backend
Cada municipio debe ver solo sus propios datos. El frontend ya está preparado — la URL `/dashboard/:clientId?token=xxx` ya lee el `clientId` y el `token`, pero el backend aún no los valida ni filtra.

**Qué implementar en `server.js`:**
- Tabla `clients` en SQLite: `client_id, nombre, token`
- Tabla `device_clients`: `device_hash, client_id`
- Middleware que valide el token en todos los endpoints
- Filtro por `client_id` en todas las queries

### 2. Panel admin SimpleCare (interno)
Interfaz para asignar dispositivos a municipios al momento de la entrega. Sin esto, la asignación se hace a mano en la DB.

### 3. Autenticación del dashboard
Validar el token secreto en el backend antes de servir datos. El código frontend ya está listo — solo falta el backend.

### 4. HTTPS + subdominio
Cuando haya primer cliente real:
- Crear registro DNS: `panel.simplecare.cl` → `2.24.196.49`
- Instalar Nginx + Certbot en el VPS
- Configurar reverse proxy para `panel.simplecare.cl` → `localhost:3000`

### 5. Verificación Meta Business
Requisito de Meta para salir del sandbox de WhatsApp y enviar mensajes a cualquier número (no solo los registrados en la cuenta de prueba).

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
# Ver estado del servidor Node.js
pm2 status

# Ver logs en tiempo real
pm2 logs simplecare

# Reiniciar servidor
pm2 restart simplecare

# Ver logs de Traccar
docker logs traccar --tail 50

# Reiniciar Traccar
docker restart traccar

# Contar eventos en la DB
cd /opt/simplecare && node -e "
const db = require('better-sqlite3')('/opt/simplecare/events.db');
console.log(db.prepare('SELECT alarm_type, COUNT(*) as n FROM events GROUP BY alarm_type').all());
"
```

---

## Archivos clave

| Archivo | Ubicación |
|---|---|
| Backend Node.js | `/opt/simplecare/server.js` |
| Dashboard HTML | `/opt/simplecare/public/dashboard.html` |
| Base de datos | `/opt/simplecare/events.db` |
| Config Traccar (script) | `/root/write_config.py` |
| Config Traccar (XML) | `/root/traccar.xml` (se copia al contenedor) |

---

## Repositorio GitHub

`https://github.com/RenanRodriguez1711/simplecare-iot` (privado)

Estructura:
```
├── CONTINUAR.md          ← este archivo
├── README.md
├── docs/
│   ├── ARQUITECTURA.md
│   ├── API.md
│   ├── PRIVACIDAD.md
│   ├── SEGURIDAD.md
│   ├── RUNBOOK.md
│   ├── DEPLOY.md
│   ├── DECISIONES.md
│   ├── APRENDIZAJES.md
│   ├── ONBOARDING_MUNICIPIO.md
│   ├── CREDENCIALES.md
│   └── CHANGELOG.md
└── server/
    ├── server.js
    └── dashboard.html
```

**Importante:** cada vez que se modifique `server.js` o `dashboard.html` en el VPS, copiar los cambios a `server/` y hacer commit.

---

## Datos de prueba

La base de datos tiene ~7.000–9.000 eventos **simulados** para 100 dispositivos del 25 mar al 25 jun 2026. Son solo para demostración — cuando haya datos reales se pueden borrar con:

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

---

## Documentación completa

Ver carpeta `docs/` para arquitectura, decisiones de diseño, runbook, privacidad y más.
