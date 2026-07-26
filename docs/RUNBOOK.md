# Runbook — SimpleCare IoT

Guía de diagnóstico y solución de problemas operacionales.

---

## Acceso al servidor

```bash
ssh root@2.24.196.49
```

Si la conexión se corta frecuentemente, verificar `~/.ssh/config`:
```
Host 2.24.196.49
    HostName 2.24.196.49
    User root
    ServerAliveInterval 60
    ServerAliveCountMax 10
```

---

## 1. El dashboard no carga / "Cannot connect"

**Diagnóstico:**
```bash
pm2 status
```

**Caso A — Estado `errored` o `stopped`:**
```bash
pm2 logs simplecare --lines 30 --nostream
pm2 restart simplecare
```

**Caso B — Estado `online` pero no responde:**
```bash
# Verificar si el puerto está ocupado por otro proceso
lsof -i :3000

# Si hay un proceso node suelto (no de PM2), matarlo
kill -9 <PID>
pm2 restart simplecare
```

**Caso C — PM2 con >100 reinicios (`↺` muy alto):**
El servidor está crasheando en loop. Casi siempre es porque un proceso `node` manual anterior sigue ocupando el puerto 3000.
```bash
lsof -i :3000
kill -9 <PID del proceso manual>
pm2 restart simplecare
```

---

## 2. WhatsApp no envía mensajes

**Paso 1 — Verificar si el token expiró**

El token de Meta dura 24 horas en modo desarrollo o 60 días con token de sistema.

Señal: en los logs de Traccar aparece `Authentication Error (code 190)` o similar.

**Renovar el token:**
1. Ir a Meta Developer Portal → tu app → WhatsApp → API Setup
2. Copiar el token temporal generado (Step 1)
3. En el VPS, actualizar el XML:

```bash
python3 /root/write_config.py
docker cp /root/traccar.xml traccar:/opt/traccar/conf/traccar.xml
docker restart traccar
```

(Editar `/root/write_config.py` con el nuevo token antes de ejecutar)

**Paso 2 — Verificar que la plantilla esté aprobada**

Ir a Meta Developer Portal → WhatsApp → Manage Templates → verificar que `simplecare_test2` esté en estado **Aprobada**.

**Paso 3 — Verificar logs de Traccar**
```bash
docker logs traccar --tail 50
```

---

## 3. Traccar no recibe eventos del dispositivo

**Diagnóstico — verificar que el contenedor esté corriendo:**
```bash
docker ps | grep traccar
```

**Si el contenedor está detenido:**
```bash
docker start traccar
```

**Verificar que el puerto 5187 está abierto:**
```bash
ufw status | grep 5187
```

**Si el puerto no está abierto:**
```bash
ufw allow 5187/tcp
```

**Verificar que el dispositivo está registrado en Traccar:**
- Abrir `http://2.24.196.49:8082`
- Verificar que el dispositivo aparece con estado "Online" o con última posición reciente

---

## 4. Los eventos no llegan a Node.js (webhook no funciona)

**Diagnóstico — verificar la regla UFW para Docker:**
```bash
ufw status | grep 172
```

Debe aparecer algo como:
```
3000       ALLOW   172.17.0.0/16
```

**Si no está:**
```bash
ufw allow from 172.17.0.0/16 to any port 3000
```

**Verificar que el webhook URL en traccar.xml es correcto:**
```bash
grep "forward.url" /root/traccar.xml
```
Debe ser: `http://172.17.0.1:3000/webhook` (NO `localhost`)

**Test manual del webhook:**
```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"event":{"type":"alarm","deviceId":1,"attributes":{"alarm":"sos"}},"position":{"latitude":-33.45,"longitude":-70.65}}'
```

---

## 5. La base de datos está vacía o con datos incorrectos

**Ver últimos eventos registrados:**
```bash
cd /opt/simplecare && node -e "
const db = require('better-sqlite3')('/opt/simplecare/events.db');
console.log(db.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT 10').all());
"
```

**Contar eventos por tipo:**
```bash
cd /opt/simplecare && node -e "
const db = require('better-sqlite3')('/opt/simplecare/events.db');
console.log(db.prepare('SELECT alarm_type, event_type, COUNT(*) as n FROM events GROUP BY alarm_type, event_type').all());
"
```

---

## 6. Espacio en disco

**Verificar uso de disco:**
```bash
df -h /
du -sh /opt/* /var/log /var/lib 2>/dev/null | sort -rh
```

**Limpiar logs antiguos de PM2:**
```bash
pm2 flush
```

**Limpiar logs del sistema:**
```bash
journalctl --vacuum-time=7d
```

---

## 7. Reiniciar todo el stack desde cero

Si nada funciona y se necesita reiniciar todo:

```bash
# 1. Reiniciar Traccar
docker restart traccar

# 2. Reiniciar Node.js
pm2 restart simplecare

# 3. Verificar estados
docker ps
pm2 status

# 4. Verificar logs
docker logs traccar --tail 20
pm2 logs simplecare --lines 20 --nostream
```

---

## Contactos y recursos

| Recurso | URL |
|---|---|
| Panel Traccar | http://2.24.196.49:8082 |
| Dashboard municipal | http://2.24.196.49:3000/dashboard |
| Meta Developer Portal | https://developers.facebook.com |
| Documentación Traccar | https://www.traccar.org/documentation |
