# Aprendizajes — SimpleCare IoT

Errores encontrados, soluciones descubiertas y cosas no obvias del sistema.  
Este documento existe para no cometer dos veces el mismo error.

---

## A001 — La IP de Docker hacia el host NO es localhost

**Problema:** Traccar corre en Docker y necesita hacer POST al servidor Node.js. Configurar `http://localhost:3000/webhook` no funcionaba — el contenedor no puede llegar al host por `localhost`.

**Solución:** usar la IP del gateway de Docker: `http://172.17.0.1:3000/webhook`

La IP `172.17.0.1` es la IP del host visto desde dentro de cualquier contenedor Docker en la red bridge por defecto.

---

## A002 — UFW bloqueaba la comunicación Docker → host

**Problema:** aunque Traccar enviaba el webhook a `172.17.0.1:3000`, Node.js nunca lo recibía. Firewall silenciosamente bloqueaba.

**Solución:** agregar regla UFW específica para la subred Docker:
```bash
ufw allow from 172.17.0.0/16 to any port 3000
```

No basta con abrir el puerto 3000 genéricamente — UFW procesa las reglas en orden y la política por defecto denegaba el tráfico de la subred interna de Docker.

---

## A003 — El carácter `!` en bash rompe el XML de Traccar

**Problema:** al intentar escribir `traccar.xml` con un heredoc bash, el token de WhatsApp contenía `!` que bash expandía en modo interactivo, corrompiendo el XML. Traccar fallaba al arrancar con `SAXParseException`.

**Solución:** escribir el XML con un script Python:
```python
open('/root/traccar.xml','w').write(xml_string)
```
Python escribe el string literal sin interpretar caracteres especiales.

---

## A004 — La clave de configuración de Traccar es `event.forward.url`, no `event.forwarder.url`

**Problema:** la documentación de Traccar no es siempre clara en los nombres exactos de las claves de configuración. Se intentó `event.forwarder.url` (con `r`) que no funcionaba.

**Solución:** la clave correcta es `event.forward.url` (sin `r` al final).

---

## A005 — Traccar envuelve el evento en un objeto, no lo envía directamente

**Problema:** el servidor Node.js leía `body.type` esperando el tipo de evento, pero siempre era `undefined`.

**Causa:** Traccar no envía el evento directamente — lo envuelve en un objeto con esta estructura:
```json
{
  "event": { "type": "alarm", "deviceId": 45, ... },
  "position": { "latitude": -33.45, ... },
  "device": { "name": "Miguel", ... }
}
```

**Solución:** leer `body.event.type` y `body.event.attributes.alarm` en lugar de `body.type`.

---

## A006 — WhatsApp API no tiene código de idioma para "Spanish (Chile)"

**Problema:** se intentó crear una plantilla en español para Chile y al configurar Traccar con códigos `es`, `es_AR`, `es_ES`, `es_MX` siempre daba error "Template does not exist" a pesar de que la plantilla estaba creada.

**Causa:** WhatsApp Cloud API no tiene código estándar `es_CL`. La plantilla creada como "Spanish (CHL)" en Meta no tiene un código de idioma compatible con los que acepta la API.

**Solución:** crear la plantilla en inglés (`en_US`) que sí tiene código estándar reconocido, o esperar que Meta agregue soporte para `es_CL`.

**Estado actual:** plantilla `simplecare_test2` en Spanish (CHL) está activa ("calidad pendiente") — se está probando con código `es`.

---

## A007 — better-sqlite3 requiere `build-essential` para compilar

**Problema:** al instalar `npm install better-sqlite3` en el VPS daba error: `make: not found`.

**Causa:** `better-sqlite3` es una extensión nativa de Node.js que compila código C++ durante la instalación.

**Solución:** instalar las herramientas de compilación primero:
```bash
apt install -y build-essential python3
npm install better-sqlite3
```

---

## A008 — PM2 con 1000+ reinicios: puerto ocupado por proceso manual

**Problema:** PM2 mostraba el proceso con `↺ 1041` (más de mil reinicios) y el dashboard no respondía, aunque `node --check server.js` decía OK y `node server.js` funcionaba directamente.

**Causa:** se había ejecutado `node server.js` manualmente en el terminal para diagnosticar, y ese proceso quedó corriendo en primer plano ocupando el puerto 3000. Cuando PM2 intentaba reiniciar, fallaba porque el puerto ya estaba ocupado.

**Solución:** matar el proceso manual (`Ctrl+C` en el terminal donde corría, o `kill -9 <PID>` si ya no había terminal) y luego `pm2 restart simplecare`.

---

## A009 — `res.sendFile` no funcionaba para servir el dashboard

**Problema:** se usó `res.sendFile('/opt/simplecare/public/dashboard.html')` y daba error `Cannot GET /dashboard`.

**Causa:** incompatibilidad con la versión de Express o la ruta relativa no estaba bien resuelta.

**Solución:** reemplazar con lectura directa del archivo:
```javascript
res.set('Content-Type', 'text/html');
res.send(fs.readFileSync('/opt/simplecare/public/dashboard.html', 'utf8'));
```

---

## A010 — La clave SSH necesita permisos correctos en Windows

**Problema:** al configurar SSH en Windows, daba error de permisos sobre el archivo de clave privada.

**Solución:** ajustar permisos con `icacls` en PowerShell:
```powershell
icacls "C:\Users\Mirna Arenas\.ssh\id_rsa" /inheritance:r /grant "DESKTOP-35L876P\Popi:R"
```

---

## A011 — El dashboard calculaba KPIs solo sobre los últimos 100 eventos

**Problema:** los KPI cards del dashboard mostraban todo en cero con datos simulados.

**Causa:** el endpoint `/events` tenía `LIMIT 100` y el dashboard calculaba todos los totales desde ese array en memoria. Con 7.000+ eventos, los primeros 100 eran casi todos conexiones (deviceOnline/deviceOffline), no alarmas.

**Solución:** separar las responsabilidades en endpoints específicos:
- `/summary` → conteos totales (sin LIMIT, consulta SQL directa)
- `/heatmap` → solo coordenadas para el mapa
- `/events` → últimos 30 para la tabla
- `/stats` → agrupación mensual para el gráfico

---

## A012 — El CSV para Excel requiere BOM UTF-8

**Problema:** al descargar el CSV y abrirlo en Excel, los caracteres con tilde y ñ aparecían mal codificados.

**Solución:** agregar el Byte Order Mark (BOM) al inicio del archivo:
```javascript
res.send('\uFEFF' + lines.join('\n'));
```
El `\uFEFF` le indica a Excel que el archivo está en UTF-8.
