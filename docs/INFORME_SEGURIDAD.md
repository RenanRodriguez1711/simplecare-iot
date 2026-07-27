# Informe de Seguridad — SimpleCare IoT

**Fecha:** 26 de julio de 2026
**Alcance:** revisión de código y diseño de `server/server.js`, `server/dashboard.html`, documentación del repositorio e infraestructura descrita.
**Método:** lectura de código fuente y revisión del historial de Git. **No se ejecutaron pruebas ni ataques contra el servidor en producción.**
**Versión auditada:** commit `99a68da` (multi-tenant `db14675` incluido).

> **Cómo leer este informe.** Cada hallazgo indica su **estado**:
> - **Confirmado** — verificado leyendo el código de este repositorio.
> - **Probable** — se deduce del código y la documentación, pero depende de la configuración real del VPS, que no se inspeccionó.
> - **Preventivo** — no es una falla actual; es un riesgo que se materializa con lo que se va a construir.

---

## 1. Resumen ejecutivo

SimpleCare IoT es un sistema bien construido para lo que es: un prototipo que funciona de punta a punta. El código es limpio, las consultas a la base de datos están correctamente parametrizadas (**no se encontró ninguna inyección SQL**), y la documentación es inusualmente honesta sobre sus propias brechas. El trabajo multi-tenant de hoy va en la dirección correcta.

Dicho eso: **el sistema no está en condiciones de recibir a un primer municipio real.** No por descuido, sino porque las piezas de seguridad que faltan son justamente las que importan cuando los datos dejan de ser simulados.

Hay cuatro problemas que conviene entender bien, porque no son "tareas pendientes de checklist" sino riesgos con consecuencias concretas:

**Primero: la promesa de anonimización, tal como está implementada hoy, no se sostiene.**
La documentación afirma que el identificador del dispositivo es irreversible. No lo es. El código no aplica el hash sobre el IMEI, sino sobre el ID interno de Traccar, que es un número correlativo pequeño (1, 2, 3...). Cualquier persona con acceso a la base de datos puede recorrer todos los números posibles, calcular su hash y reconstruir la tabla completa de correspondencias en menos de un segundo, con un computador común. La anonimización, en la práctica, es una etiqueta, no una barrera. Esto importa mucho porque toda la propuesta comercial y legal ante el municipio ("le entregamos datos anonimizados, por lo tanto la Ley 21.719 no aplica") descansa sobre esa afirmación. Ver la sección 4 completa.

**Segundo: la parte del sistema que sí tiene datos personales está más expuesta que la que no los tiene.**
Se puso mucho cuidado en anonimizar la base de datos del dashboard. Pero en el mismo servidor, en el puerto 8082 y accesible desde internet sin cifrado, está el panel de Traccar, que contiene los nombres reales de las personas, sus coordenadas GPS exactas y los teléfonos de sus familiares. Está protegido por un usuario `admin` y una contraseña. Esa contraseña es, hoy, la única cosa que separa los datos identificados de las personas mayores del internet abierto. Anonimizar bien el dashboard mientras la puerta de al lado está así es como poner una caja fuerte en una casa sin puerta.

**Tercero: cualquier persona en internet puede escribir en la base de datos.**
El endpoint que recibe los eventos (`/webhook`) no verifica quién le está hablando. Eso es conocido y está documentado. Lo que no estaba documentado es que ese mismo agujero permite algo peor que inventar alarmas falsas: permite inyectar código malicioso que se ejecuta después en el navegador del funcionario municipal cuando abre el dashboard, y robarle su token de acceso. Es una cadena completa, desde un atacante anónimo hasta el acceso permanente a los datos de un municipio. Ver hallazgo S03.

**Cuarto: el trabajo multi-tenant de hoy tiene un defecto que reasigna dispositivos de un municipio real al cliente de prueba.**
Cada vez que el servidor se reinicia, ejecuta una instrucción que toma todos los dispositivos que aún no están asignados a nadie y se los entrega al cliente `demo`. Como los dispositivos nuevos que llegan por el webhook no se registran automáticamente, los dispositivos de un municipio real terminarían dentro del cliente `demo` en el próximo reinicio. Y el token de `demo` está escrito en el código fuente, en el repositorio de GitHub y en el CHANGELOG. Ver hallazgo S04.

**Qué se hizo bien, y conviene decirlo:** no hay inyección SQL en ninguna de las 8 consultas (revisadas una por una); no hay ningún secreto real filtrado en el historial de Git (se revisó completo); el filtro por `client_id` está correctamente aplicado en los 8 endpoints de datos; y `SEGURIDAD.md` ya identifica correctamente 9 de los problemas de este informe. La brecha no está en el diagnóstico, está en la ejecución.

**Recomendación de fondo:** antes del primer municipio real, cerrar los 5 puntos del bloque "Bloqueante" de la sección 6. Son aproximadamente entre una y dos semanas de trabajo. No incorporar clientes reales antes de eso, y no encender la funcionalidad de guardar teléfonos de familiares (punto 1 del roadmap) hasta que esté cerrado el bloqueante completo, porque esa función convierte al sistema en un tratamiento de datos personales sin ninguna ambigüedad.

---

## 2. Tabla de hallazgos

| ID | Título | Severidad | Estado |
|---|---|---|---|
| **S01** | Panel Traccar con datos identificados expuesto a internet sin TLS | **Crítico** | Probable |
| **S02** | Ausencia total de HTTPS: token y datos viajan en texto plano | **Crítico** | Confirmado |
| **S03** | XSS almacenado vía `/webhook` sin autenticar → robo del token municipal | **Crítico** | Confirmado |
| **S04** | Reasignación automática de dispositivos al cliente `demo` en cada arranque | **Crítico** | Confirmado |
| **S05** | Anonimización reversible: hash sin sal sobre un espacio de IDs trivial | **Crítico** | Confirmado |
| **S06** | `/webhook` sin autenticación: inyección de eventos falsos | **Alto** | Confirmado |
| **S07** | Token de sesión transportado en la query string de la URL | **Alto** | Confirmado |
| **S08** | Token `demo-token-dev-only` hardcodeado y publicado en el repositorio | **Alto** | Confirmado |
| **S09** | Librerías de terceros cargadas desde CDN sin SRI ni CSP | **Alto** | Confirmado |
| **S10** | Sin rate limiting; `/export` sin límite bloquea el hilo de eventos | **Alto** | Confirmado |
| **S11** | Token de WhatsApp en texto plano y con caducidad silenciosa de 24 h | **Alto** | Probable |
| **S12** | Base de datos sin cifrar, sin backups, servidor único, SSH como root | **Medio** | Probable |
| **S13** | `/events` devuelve el `device_hash` completo, contradiciendo `PRIVACIDAD.md` | **Medio** | Confirmado |
| **S14** | Sin registro de auditoría ni capacidad de detectar un acceso indebido | **Medio** | Confirmado |
| **S15** | Retención indefinida sin política ni mecanismo de borrado | **Medio** | Confirmado |
| **S16** | Cumplimiento Ley 21.719: falta base documental completa | **Medio** | Confirmado |
| **S17** | `/dashboard` se sirve sin token (no expone datos) | **Bajo** | Confirmado |
| **S18** | Pérdida silenciosa de eventos si Node.js está caído | **Medio** | Probable |

**Verificado y sin hallazgos:** inyección SQL (sección 3.19), secretos en el historial de Git (sección 3.20).

---

## 3. Detalle de los hallazgos

### S01 — Panel Traccar con datos identificados expuesto a internet sin TLS
**Severidad: Crítico · Estado: Probable** (depende de la contraseña real configurada, que no se inspeccionó)

**Descripción.**
Todo el esfuerzo de anonimización ocurre en la capa Node.js. Pero los datos *sin anonimizar* viven en Traccar, en el mismo servidor: nombres reales de las personas (`ONBOARDING_MUNICIPIO.md` paso 5: *"Nombre: nombre de la persona (ej: Juan Pérez)"*), coordenadas GPS con precisión de metros, IMEI de cada dispositivo, y los números de teléfono de los contactos de emergencia (paso 7). Ese panel está publicado en `http://2.24.196.49:8082` (`ARQUITECTURA.md`, regla UFW `ufw allow 8082/tcp` en `DEPLOY.md` §10), sin HTTPS y con el usuario `admin`.

`DEPLOY.md` §3 documenta que la contraseña por defecto de Traccar es `admin`, y tanto `SEGURIDAD.md` (punto 4) como `CREDENCIALES.md` dicen *"cambiar contraseña por defecto **si no se ha hecho**"* — es decir, el propio equipo no tiene certeza de si se cambió. Ese es el hallazgo real: la incertidumbre.

**Ubicación.** `docs/ARQUITECTURA.md` (tabla de puertos abiertos), `docs/DEPLOY.md:10` (regla UFW), `docs/CREDENCIALES.md` (sección Traccar).

**Escenario de explotación.**
Traccar es software conocido; los escáneres automáticos de internet (Shodan, Censys) indexan servidores con el puerto 8082 abierto de forma continua y los publican de manera indexable. Un atacante encuentra la instancia, prueba `admin`/`admin`, y si funciona obtiene: la lista completa de adultos mayores con nombre, su ubicación en tiempo real con precisión de metros, su historial de recorridos, y los teléfonos de sus familiares. Aunque la contraseña se haya cambiado, al no haber HTTPS (S02) esa contraseña viaja en claro cada vez que alguien de SimpleCare inicia sesión desde una red no confiable.

**Impacto.**
Este es el peor escenario del sistema completo. Los afectados son personas mayores en situación de vulnerabilidad, y la información permite saber dónde vive cada una, cuándo está sola en casa y cuándo no está. Es información directamente utilizable para delitos contra personas de un grupo especialmente frágil. Para el negocio: fin de la relación con cualquier municipio, denuncia obligatoria ante la Agencia de Protección de Datos Personales, exposición a sanciones y prácticamente ninguna posibilidad de vender el producto después.

**Remediación (prioridad máxima, se puede hacer hoy).**
1. Cerrar el puerto 8082 al internet de inmediato. Traccar solo necesita ser accesible por el equipo de SimpleCare:
   ```bash
   ufw delete allow 8082/tcp
   # acceder mediante túnel SSH cuando se necesite:
   #   ssh -L 8082:localhost:8082 root@2.24.196.49
   #   luego abrir http://localhost:8082 en el navegador local
   ```
   El puerto 5187 (dispositivos EV07B) debe seguir abierto: es el que usan los dispositivos.
2. Verificar y cambiar la contraseña de `admin` por una generada aleatoriamente, guardada en el gestor de contraseñas.
3. Revisar el historial de accesos de Traccar (`docker logs traccar | grep -i login`) buscando inicios de sesión desde IP desconocidas.
4. A mediano plazo: dejar de usar el nombre real de la persona como nombre del dispositivo en Traccar. Usar un código interno (`SC-0042`) y mantener la correspondencia código ↔ persona en un sistema separado y cifrado. Esto reduce el daño de un compromiso de Traccar de "identidad completa" a "un código".

---

### S02 — Ausencia total de HTTPS
**Severidad: Crítico · Estado: Confirmado**

**Descripción.**
Todo el sistema opera sobre HTTP sin cifrar: el dashboard municipal (`http://2.24.196.49:3000/dashboard`), la API de datos, el panel de Traccar y el webhook. Está reconocido en `SEGURIDAD.md` punto 2. Combinado con S07 (token en la URL), significa que el token de acceso de un municipio viaja legible por la red en cada petición.

**Ubicación.** `server/server.js:292` (`app.listen(3000)` sin TLS), `docs/ARQUITECTURA.md`, `docs/RUNBOOK.md` (tabla de recursos).

**Escenario de explotación.**
Un funcionario municipal abre el dashboard desde el WiFi de la municipalidad o desde un café. Cualquier persona en esa misma red — o cualquier operador de red intermedio — ve la URL completa, incluido `?token=...`. Con ese token accede a todos los datos del municipio de forma indefinida, sin dejar rastro (S14). No hace falta ninguna habilidad especial: es el ataque de red más elemental que existe.

Un segundo vector, más grave: sin HTTPS un atacante en la ruta puede *modificar* la respuesta, no solo leerla. Puede inyectar código en el dashboard mientras carga y obtener control total de la sesión del funcionario.

**Impacto.**
Fuga completa de los datos de un municipio, y pérdida de la capacidad de afirmar ante el cliente que la comunicación es segura. Para un servicio contratado por una entidad pública chilena, la ausencia de TLS es prácticamente descalificante en cualquier revisión técnica.

**Remediación.**
Es el punto 4 del roadmap y debe adelantarse a antes del primer cliente, no después. Nginx + Certbot sobre `panel.simplecare.cl`, con el puerto 3000 cerrado al exterior:

```nginx
server {
    listen 443 ssl http2;
    server_name panel.simplecare.cl;
    # certificados gestionados por certbot

    # No registrar la query string: contiene el token (ver S07)
    log_format sin_token '$remote_addr - [$time_local] "$request_method $uri" '
                         '$status $body_bytes_sent';
    access_log /var/log/nginx/simplecare.log sin_token;

    add_header Strict-Transport-Security "max-age=31536000" always;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
server {
    listen 80;
    server_name panel.simplecare.cl;
    return 301 https://$host$request_uri;
}
```
```bash
ufw delete allow 3000/tcp     # cerrar el acceso directo a Node.js
ufw allow 443/tcp
ufw allow 80/tcp              # solo para la renovación de Certbot
```

> **Advertencia importante sobre el paso 3 del roadmap.** La configuración por defecto de Nginx (`log_format combined`) **registra la URL completa con su query string** en `/var/log/nginx/access.log`. Instalar Nginx sin cambiar eso crea un archivo en texto plano con todos los tokens de todos los municipios, rotado y respaldado durante meses. El bloque `log_format` de arriba lo evita. Esto es un caso donde una mejora de seguridad, mal aplicada, empeora la situación.

---

### S03 — XSS almacenado vía `/webhook` sin autenticar → robo del token municipal
**Severidad: Crítico · Estado: Confirmado**

**Descripción.**
Este hallazgo no aparece en `SEGURIDAD.md` y es, técnicamente, el más grave del código actual. Encadena tres debilidades separadas en un ataque completo desde internet.

El endpoint `/webhook` no valida el origen (S06) y guarda el campo `attributes.alarm` sin ninguna restricción de contenido. La función `normalizeAlarm()` aplica una transformación de mayúsculas a guion bajo y convierte a minúsculas, pero **no filtra ni valida caracteres**, y `alarm_type` no se contrasta contra una lista blanca al momento de insertar:

`server/server.js:67-71`
```js
function normalizeAlarm(alarm) {
  if (!alarm) return null;
  if (ALARM_ALIASES[alarm]) return ALARM_ALIASES[alarm];
  return alarm.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}
```

Nótese que `event.type` **sí** está restringido por la lista `relevantes` en la línea 109, pero `attributes.alarm` no pasa por ninguna validación equivalente.

Después, el dashboard inserta ese valor directamente en el HTML mediante `innerHTML`, sin escapar, y además dentro de un atributo `class`:

`server/dashboard.html:243`
```js
tbody.innerHTML += `<tr><td><span class="badge ${e.alarm_type || e.event_type || ''}">${tipo}</span></td>...`;
```

Y el token del municipio está disponible para cualquier código que se ejecute en esa página, porque vive en la URL (`dashboard.html:189-190`).

**Ubicación.** `server/server.js:67-71` y `server/server.js:104-119` (entrada sin validar) → `server/dashboard.html:243` (salida sin escapar) → `server/dashboard.html:189-190` (token accesible).

**Escenario de explotación.**
1. El atacante localiza el puerto 3000 abierto (escaneo trivial, o simplemente porque la URL circula por correo entre funcionarios municipales).
2. Envía una única petición POST a `/webhook`, sin credenciales de ningún tipo, con un `attributes.alarm` que contiene una etiqueta HTML en minúsculas (`normalizeAlarm` conserva íntegramente los caracteres `<`, `>`, `=` y comillas, y las etiquetas HTML en minúscula funcionan sin problema). El payload queda almacenado permanentemente en `events.db`.
3. Días después, un funcionario del municipio abre su dashboard con su token en la URL. La tabla "Últimas alertas" renderiza la fila envenenada y el código del atacante se ejecuta en el navegador del funcionario.
4. Ese código lee `window.location.search`, que contiene el token, y lo envía a un servidor del atacante.
5. El atacante ya tiene acceso permanente a todos los datos de ese municipio, incluida la exportación CSV completa. Nada en el sistema registra que esto ocurrió (S14).

Vale la pena notar que el payload llega al dashboard de *todos* los municipios cuyo `device_hash` coincida, y que gracias a S04 los eventos sin asignar terminan en `demo`.

**Impacto.**
Compromiso completo de la cuenta de un municipio por parte de un atacante anónimo, sin credenciales previas y sin dejar rastro. Además contamina permanentemente la base de datos con alertas falsas que distorsionan el panel de riesgo (S06).

**Remediación (dos correcciones, ambas necesarias).**

*1. Validar en la entrada* — `server/server.js`, dentro del webhook:
```js
const ALARMAS_VALIDAS = new Set(['sos', 'fall', 'low_battery', 'power_off',
                                 'power_on', 'geofence_enter', 'geofence_exit']);

function normalizeAlarm(alarm) {
  if (!alarm || typeof alarm !== 'string') return null;
  const base = ALARM_ALIASES[alarm]
    || alarm.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return ALARMAS_VALIDAS.has(base) ? base : null;   // descartar lo desconocido
}
```
Conviene registrar en el log los valores descartados: un valor inesperado es señal de alarma o de un firmware nuevo.

*2. Escapar en la salida* — `server/dashboard.html`, reemplazar la construcción por `innerHTML` con creación de nodos, que es inmune por diseño:
```js
function actualizarTabla(eventos) {
  const tbody = document.getElementById('tabla');
  tbody.replaceChildren();
  eventos.forEach(e => {
    const tipo  = e.alarm_type || e.event_type || '';
    const tr    = document.createElement('tr');
    const tdT   = document.createElement('td');
    const span  = document.createElement('span');
    span.className = 'badge ' + (['sos','fall','low_battery','alarm',
        'deviceOnline','deviceOffline'].includes(tipo) ? tipo : '');
    span.textContent = tipo;                     // textContent nunca interpreta HTML
    tdT.appendChild(span); tr.appendChild(tdT);

    const tdZ = document.createElement('td');
    tdZ.textContent = e.lat_zone ? `${e.lat_zone}, ${e.lon_zone}` : '—';
    const tdF = document.createElement('td');
    tdF.textContent = new Date(e.created_at + ' UTC').toLocaleString('es-CL');
    tr.appendChild(tdZ); tr.appendChild(tdF);
    tbody.appendChild(tr);
  });
}
```
La misma corrección aplica a `actualizarRiesgo()` (`dashboard.html:285-292`). Ese caso hoy es seguro porque `id_anonimo` es hexadecimal derivado de un hash, pero depender de eso es frágil: si mañana se agrega una columna con texto libre, el agujero reaparece. Conviene corregir ambas funciones a la vez.

*3. Defensa en profundidad:* una CSP (ver S09) impediría que el código inyectado envíe el token a un servidor externo, aunque logre ejecutarse.

---

### S04 — Reasignación automática de dispositivos al cliente `demo` en cada arranque
**Severidad: Crítico · Estado: Confirmado**

**Descripción.**
Es un defecto en el código multi-tenant construido hoy. Estas líneas se ejecutan **en cada arranque del proceso**, no una sola vez:

`server/server.js:41-44`
```js
db.exec(`
  INSERT OR IGNORE INTO device_clients (device_hash, client_id)
  SELECT DISTINCT device_hash, 'demo' FROM events
`);
```

La intención era migrar los datos simulados existentes. El efecto real es una regla permanente: *cualquier dispositivo que aparezca en `events` y no esté asignado, pasa a ser del cliente `demo` en el próximo reinicio*.

El problema se cierra con una segunda observación: el webhook (`server.js:104-119`) inserta eventos en `events` pero **nunca registra el dispositivo en `device_clients`**. Y el panel admin que haría esa asignación manualmente todavía no existe (es el punto 2 del roadmap).

**Ubicación.** `server/server.js:41-44` (reasignación) en combinación con `server/server.js:104-119` (el webhook no registra el dispositivo) y `server/server.js:36-37` (token `demo` público).

**Escenario de explotación.**
No hace falta un atacante; basta la operación normal:

1. Se incorpora la Municipalidad de Maipú. Se asignan sus 50 dispositivos a `maipu` en `device_clients` según el paso 6 de `ONBOARDING_MUNICIPIO.md`.
2. Llegan dispositivos nuevos (reposición, ampliación del programa, un IMEI que se registró en Traccar antes de asignarlo). Sus eventos entran a `events`, pero no a `device_clients`.
3. Se reinicia el servidor — cosa que pasa de forma rutinaria: `pm2 restart` tras un cambio de código, un reinicio del VPS, o un crash con auto-restart de PM2. `APRENDIZAJES.md` A008 documenta un caso con **más de mil reinicios**.
4. Esos dispositivos quedan asignados a `demo`.
5. El token de `demo` es `demo-token-dev-only`, escrito en el código fuente, en el repositorio de GitHub y en el CHANGELOG. Cualquiera que lo tenga ve los eventos, el mapa de calor y el panel de riesgo de personas reales de Maipú.

El efecto secundario es igual de dañino en el otro sentido: Maipú **deja de ver** a esas mismas personas en su dashboard. Un adulto mayor con caídas repetidas desaparece silenciosamente del panel de seguimiento del municipio. Es una falla que perjudica al servicio, no solo a la privacidad.

**Impacto.**
Fuga de datos entre municipios y hacia cualquier tenedor de un token público, sin ninguna señal de que ocurrió. Combinado con el hecho de que el sistema se vende como multi-tenant aislado, es exactamente la clase de incidente que termina un contrato con una entidad pública.

**Remediación.**

1. **Convertir la migración en una operación única.** Debe correr una sola vez y no volver a ejecutarse nunca:
```js
// Migración única de datos de prueba. Se ejecuta solo si device_clients está vacía.
const yaMigrado = db.prepare('SELECT COUNT(*) AS n FROM device_clients').get().n > 0;
if (!yaMigrado) {
  db.exec(`INSERT OR IGNORE INTO device_clients (device_hash, client_id)
           SELECT DISTINCT device_hash, 'demo' FROM events`);
  console.log('Migración inicial: dispositivos existentes asignados a demo');
}
```

2. **Que un dispositivo sin asignar sea visible, no invisible.** El estado "no asignado" debe ser un estado explícito que alguien pueda ver y resolver, no un silencio. Agregar en el webhook:
```js
const asignado = db.prepare('SELECT client_id FROM device_clients WHERE device_hash = ?')
                   .get(anon.device_hash);
if (!asignado) {
  console.warn(`[SIN ASIGNAR] device_hash=${anon.device_hash} — requiere asignación a un cliente`);
  // El evento igual se guarda; queda pendiente de asignación en el panel admin.
}
```
Cuando exista el panel admin, esa lista de pendientes debe ser su pantalla principal.

3. **Eliminar el cliente `demo` antes de tener un cliente real** (ver S08). Mientras exista, su token debe generarse aleatoriamente en el primer arranque en lugar de estar escrito en el código.

---

### S05 — Anonimización reversible: hash sin sal sobre un espacio de IDs trivial
**Severidad: Crítico · Estado: Confirmado**

Este hallazgo es el eje del informe y se desarrolla completo en la **sección 4**. Resumen: `server.js:86` aplica SHA256 sobre `event.deviceId`, que es el identificador interno correlativo de Traccar, no el IMEI. El espacio de valores posibles es de unos pocos miles de enteros y se puede recorrer completo en menos de un segundo. La afirmación de `DECISIONES.md` D002 y `PRIVACIDAD.md` ("*irreversible*", "*no se puede recuperar el IMEI original desde el hash*") es incorrecta tal como está implementado.

**Ubicación.** `server/server.js:86`; documentación afectada: `docs/PRIVACIDAD.md` (sección "Por qué SHA256 es suficiente"), `docs/DECISIONES.md` D002.

---

### S06 — `/webhook` sin autenticación: inyección de eventos falsos
**Severidad: Alto · Estado: Confirmado**

**Descripción.**
`app.post('/webhook', ...)` (`server.js:104`) no tiene el middleware `requireClient` ni ninguna otra validación de origen. Es el único endpoint de escritura del sistema y es el único que quedó sin proteger. Reconocido en `SEGURIDAD.md` punto 3, pero sin implementar. La regla UFW `ufw allow 3000/tcp` (`DEPLOY.md` §10) abre el puerto a todo internet, no solo a la subred Docker — la regla específica `from 172.17.0.0/16` se agrega *además* de la general, no en lugar de ella.

**Ubicación.** `server/server.js:104-119`; regla de firewall en `docs/DEPLOY.md` §10.

**Escenario de explotación.**
Aparte de la cadena XSS de S03, un atacante puede:
- **Envenenar el panel de riesgo.** El puntaje de riesgo (`server.js:224-241`) decide qué personas mayores el municipio prioriza para visitas domiciliarias. Inyectando caídas falsas asociadas a un `deviceId` cualquiera, un atacante puede colocar identidades inventadas en los primeros lugares del panel y desplazar a personas que sí necesitan atención. El daño aquí no es a los datos: es que alguien que necesitaba una visita no la recibe.
- **Falsear las estadísticas** que sustentan el contrato y la rendición de cuentas del programa social.
- **Llenar el disco.** Sin límite de peticiones (S10), un atacante puede escribir millones de filas hasta agotar los 44 GB disponibles, con lo que el sistema deja de registrar alertas reales.

**Impacto.**
Pérdida de integridad de la única fuente de verdad del servicio. Si un municipio descubre que sus estadísticas contienen datos inyectados desde afuera, no hay explicación técnica que recupere la confianza.

**Remediación.**
Dos capas, ambas fáciles:

1. **Firewall** — el webhook solo debe ser alcanzable desde el contenedor de Traccar:
```bash
ufw delete allow 3000/tcp                        # quitar el acceso público
ufw allow from 172.17.0.0/16 to any port 3000    # solo Docker (esta regla ya existe)
```
Node.js queda accesible desde internet únicamente a través de Nginx (S02). Conviene además hacer que Express escuche solo en localhost y en la interfaz de Docker.

2. **Secreto compartido** — defensa en profundidad, por si el firewall falla o cambia la topología de red:
```js
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;   // nunca en el código fuente
app.post('/webhook', (req, res) => {
  const recibido = req.get('X-Webhook-Secret') || '';
  const esperado = WEBHOOK_SECRET || '';
  if (recibido.length !== esperado.length ||
      !crypto.timingSafeEqual(Buffer.from(recibido), Buffer.from(esperado))) {
    return res.status(403).send('Forbidden');
  }
  /* ... resto del handler ... */
});
```
Traccar permite agregar cabeceras al reenvío de eventos mediante `event.forward.header` en `traccar.xml`. Conviene verificar la sintaxis exacta contra la versión de Traccar instalada antes de aplicarlo — si esa clave no estuviera disponible en la versión en uso, la restricción por firewall del punto 1 es suficiente por sí sola.

---

### S07 — Token de sesión transportado en la query string de la URL
**Severidad: Alto · Estado: Confirmado**

**Descripción.**
El modelo de autenticación (decisión D011) coloca el token en la URL: `/dashboard/maipu?token=abc123...`. El middleware lo lee de `req.query.token` (`server.js:49`) y el frontend lo reenvía en cada llamada (`dashboard.html:219`).

La decisión de usar un token en lugar de un login es defendible para este perfil de usuario. El problema no es el token: es **dónde viaja**. Las URL se guardan y se comparten de maneras que las credenciales no.

**Ubicación.** `server/server.js:48-55`; `server/dashboard.html:189-190, 211-221, 316, 341`.

**Escenario de explotación.**
El token queda registrado en el historial del navegador y en los marcadores de un computador municipal compartido entre turnos; se filtra cuando un funcionario reenvía "el link del panel" por correo o WhatsApp a un colega (es lo natural con una URL, y `DECISIONES.md` D011 lo menciona como una *ventaja*: *"el municipio puede compartir fácilmente el acceso con sus funcionarios"*); queda a la vista de cualquiera durante una presentación con proyector; y — el caso más probable de todos — quedará escrito en el log de acceso de Nginx en cuanto se implemente el punto 3 del roadmap (ver la advertencia en S02).

Un agravante: el token no caduca nunca, no se puede revocar sin cambiarlo para todo el municipio, y no hay forma de saber cuántas copias circulan.

**Impacto.**
Acceso permanente a los datos de un municipio para cualquiera que obtenga la URL, sin posibilidad de detectarlo (S14) ni de revocar accesos individuales.

**Remediación.**
No hace falta abandonar el modelo de token, que es razonable. Basta con que la URL sea un *canje*, no una credencial permanente:

```js
const cookieParser = require('cookie-parser');
app.use(cookieParser());

// La URL con token se usa una vez y se convierte en una cookie de sesión.
app.get('/dashboard/:clientId', (req, res) => {
  if (req.query.token) {
    const cliente = db.prepare('SELECT client_id FROM clients WHERE token = ?')
                      .get(req.query.token);
    if (cliente) {
      res.cookie('sc_session', req.query.token, {
        httpOnly: true,      // inaccesible desde JavaScript: mitiga también S03
        secure:   true,      // solo por HTTPS (requiere S02 resuelto)
        sameSite: 'lax',
        maxAge:   12 * 60 * 60 * 1000,
      });
      // Redirigir sin el token: desaparece de la barra, del historial y de los logs
      return res.redirect(`/dashboard/${req.params.clientId}`);
    }
  }
  res.set('Content-Type', 'text/html')
     .send(fs.readFileSync('/opt/simplecare/public/dashboard.html', 'utf8'));
});

function requireClient(req, res, next) {
  const token = req.cookies?.sc_session || req.query.token;   // cookie primero
  if (!token) return res.status(401).json({ error: 'Falta token' });
  const client = db.prepare('SELECT client_id, nombre FROM clients WHERE token = ?').get(token);
  if (!client) return res.status(403).json({ error: 'Token inválido' });
  req.clientId = client.client_id;
  next();
}
```
Con esto el frontend deja de manejar el token (se pueden eliminar las líneas 190, 219, 316 y 341 de `dashboard.html`), y `httpOnly` hace que ni siquiera un XSS exitoso pueda leerlo. Complemento recomendado: fecha de expiración por token en la tabla `clients`, y rotación anual.

---

### S08 — Token `demo-token-dev-only` hardcodeado y publicado en el repositorio
**Severidad: Alto · Estado: Confirmado**

**Descripción.**
`server/server.js:36-37` crea un cliente con un token literal en el código:
```js
db.prepare(`INSERT OR IGNORE INTO clients (client_id, nombre, token) VALUES (?, ?, ?)`)
  .run('demo', 'Municipio Demo', 'demo-token-dev-only');
```
El valor está además en `docs/CHANGELOG.md` (*"La URL de prueba ahora es `http://2.24.196.49:3000/dashboard/demo?token=demo-token-dev-only`"*) y en dos commits del historial (`db14675`, `99a68da`).

**Ubicación.** `server/server.js:36-37`, `docs/CHANGELOG.md` (sección 0.3.0).

**Escenario de explotación.**
Hoy el riesgo es acotado: el cliente `demo` solo contiene datos simulados y el repositorio es privado. Pero eso cambia por dos vías: si el repositorio se hace público, o si un colaborador o contratista futuro obtiene acceso de lectura; y sobre todo por S04, que hace que dispositivos reales terminen dentro de `demo`. En ese momento un token público pasa a dar acceso a datos de personas reales.

**Impacto.** Directo cuando se combina con S04. Además establece un patrón peligroso: es exactamente así como se filtran los tokens de los municipios reales cuando alguien "solo por hoy" los escribe en el código para probar.

**Remediación.**
1. Antes del primer cliente real, eliminar el cliente `demo` de la base de datos y las líneas 36-37 de `server.js`.
2. Mientras exista, generar su token aleatoriamente en el primer arranque y mostrarlo por consola:
```js
const existeDemo = db.prepare('SELECT 1 FROM clients WHERE client_id = ?').get('demo');
if (!existeDemo && process.env.NODE_ENV !== 'production') {
  const tokenDemo = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO clients (client_id, nombre, token) VALUES (?,?,?)')
    .run('demo', 'Municipio Demo', tokenDemo);
  console.log(`Cliente demo creado. Token: ${tokenDemo}`);
}
```
3. Los tokens reales deben insertarse manualmente en la base de datos (`ONBOARDING_MUNICIPIO.md` paso 3) y **nunca** aparecer en el repositorio, el CHANGELOG ni un commit. La disciplina que ya se aplica bien con el token de Meta (que no está en Git — ver sección 3.20) debe extenderse a los tokens municipales.

---

### S09 — Librerías de terceros cargadas desde CDN sin SRI ni CSP
**Severidad: Alto · Estado: Confirmado**

**Descripción.**
El dashboard carga cuatro recursos externos, sin verificación de integridad:

`server/dashboard.html:7-10`
```html
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://leaflet.github.io/Leaflet.heat/dist/leaflet-heat.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
```

Tres observaciones concretas:
- Ningún `<script>` tiene atributo `integrity` (SRI), así que el navegador ejecuta lo que llegue, sea lo que sea.
- `https://cdn.jsdelivr.net/npm/chart.js` **no fija versión**: entrega siempre la última publicada. Cualquier cambio en Chart.js — incluido uno malicioso o simplemente uno que rompa la compatibilidad — entra automáticamente en producción sin que nadie lo apruebe.
- `leaflet.github.io` es un sitio de GitHub Pages, no un CDN con las garantías operacionales de unpkg o jsDelivr. Es el eslabón más débil de los cuatro.

No hay Content-Security-Policy en ninguna respuesta del servidor.

**Ubicación.** `server/dashboard.html:7-10`; ausencia de cabeceras en `server/server.js:97-100`.

**Escenario de explotación.**
Cualquiera de esos cuatro orígenes que se vea comprometido puede entregar JavaScript que se ejecuta con todos los permisos de la página del dashboard: leer el token de la URL (S07), extraer los datos completos del municipio y enviarlos a donde sea. Sin HTTPS (S02), el ataque ni siquiera requiere comprometer el CDN: basta con estar en la ruta de red del funcionario y sustituir el archivo al vuelo. No hay ninguna capa que lo impida ni que lo registre.

**Impacto.**
Compromiso total del dashboard por una vía que no está bajo control de SimpleCare. Este es también el tipo de hallazgo que aparece en cualquier revisión técnica seria de una municipalidad.

**Remediación.**
1. **Alojar las librerías localmente.** Son cuatro archivos estáticos y esto elimina la dependencia externa por completo, además de hacer que el dashboard funcione si un CDN se cae:
```bash
mkdir -p /opt/simplecare/public/vendor
cd /opt/simplecare/public/vendor
curl -O https://unpkg.com/leaflet@1.9.4/dist/leaflet.js
curl -O https://unpkg.com/leaflet@1.9.4/dist/leaflet.css
curl -O https://leaflet.github.io/Leaflet.heat/dist/leaflet-heat.js
curl -o chart.js https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js
```
Y en `server.js`: `app.use('/vendor', express.static('/opt/simplecare/public/vendor'));`

2. **Agregar una CSP.** Es la mitigación que corta el ataque de S03 aunque el XSS se ejecute, porque impide enviar datos a un destino externo:
```js
app.use((req, res, next) => {
  res.set('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https://*.tile.openstreetmap.org; " +
    "connect-src 'self'; " +          // impide exfiltrar el token a otro dominio
    "frame-ancestors 'none'");
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});
```
Requiere mover los `onclick` en línea del HTML (`dashboard.html:114-117, 123, 172`) a `addEventListener`, ya que `script-src 'self'` los bloquea. Es un cambio mecánico y vale la pena: los manejadores en línea son precisamente el vector que la CSP está diseñada para cerrar.

Nota: los mosaicos del mapa siguen viniendo de OpenStreetMap, lo que es aceptable — son imágenes, no código, y el `img-src` lo permite explícitamente.

---

### S10 — Sin rate limiting; `/export` sin límite bloquea el hilo de eventos
**Severidad: Alto · Estado: Confirmado**

**Descripción.**
No hay ningún control de frecuencia de peticiones en el sistema (confirmado: no existe `express-rate-limit` ni equivalente en el repositorio). `SEGURIDAD.md` lo identifica como prioridad media; en un sistema de alertas de emergencia corresponde subirlo.

Hay además un problema específico y más sutil. `better-sqlite3` es **síncrono por diseño**: mientras ejecuta una consulta, el proceso Node.js completo queda bloqueado y no atiende nada más. Y `/export` es la única consulta del sistema sin `LIMIT`:

`server/server.js:273-279`
```js
const rows = db.prepare(`
  SELECT created_at, alarm_type, event_type, lat_zone, lon_zone
  FROM events
  WHERE alarm_type IN (${tiposQ})${and}
    AND device_hash IN (SELECT device_hash FROM device_clients WHERE client_id = ?)
  ORDER BY created_at DESC
`).all(...tipos, ...p, req.clientId);
```
Sin `desde`/`hasta` devuelve el histórico completo, lo materializa entero en memoria y después construye el CSV concatenando strings.

**Ubicación.** `server/server.js:261-288` (`/export`); ausencia global de rate limiting.

**Escenario de explotación.**
Aquí el impacto no es la fuga de datos, es que **el sistema deja de recibir alertas**:

1. Con la escala objetivo de 1.000 usuarios y varios eventos diarios por dispositivo, en dos años la tabla `events` tendrá millones de filas.
2. Un atacante — o simplemente un funcionario impaciente haciendo clic repetido en "Exportar CSV" sin filtro de fechas — lanza varias exportaciones simultáneas.
3. Cada una bloquea el hilo. Node.js deja de aceptar conexiones.
4. **Durante esos segundos, los eventos SOS que Traccar reenvía al webhook no se atienden y se pierden** (ver S18).

Un sistema cuyo propósito es registrar emergencias de personas mayores no debería tener una función de reportería capaz de detenerlo.

**Impacto.**
Pérdida de eventos de emergencia y caída del servicio, provocable de forma trivial y también de forma accidental por un usuario legítimo.

**Remediación.**
1. **Acotar `/export`** con un tope de filas y un rango máximo de fechas:
```js
const MAX_FILAS = 50000;
// ... añadir al final de la consulta:  ORDER BY created_at DESC LIMIT ${MAX_FILAS}
if (rows.length === MAX_FILAS) {
  lines.push(`# Resultado truncado en ${MAX_FILAS} filas. Acote el rango de fechas.`);
}
```
Adicionalmente, aplicar un rango por defecto de 12 meses cuando no se envíen `desde`/`hasta`.

2. **Rate limiting**, más estricto en el endpoint costoso:
```js
const rateLimit = require('express-rate-limit');
app.use('/webhook', rateLimit({ windowMs: 60_000, max: 300 }));   // holgado: es tráfico legítimo
app.use(['/export'], rateLimit({ windowMs: 60_000, max: 3  }));   // caro
app.use(rateLimit({ windowMs: 60_000, max: 120 }));               // resto de la API
```
El límite en `/webhook` debe calcularse con margen sobre el volumen real esperado (1.000 dispositivos reportando conexión/desconexión), para no descartar eventos legítimos.

3. **Índices**, que hoy no existen. Sin ellos, cada consulta recorre la tabla completa y el problema empeora con el crecimiento:
```sql
CREATE INDEX IF NOT EXISTS idx_events_hash_fecha ON events(device_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_events_alarm      ON events(alarm_type, created_at);
```
Con millones de filas esto es la diferencia entre una respuesta instantánea y varios segundos de bloqueo.

---

### S11 — Token de WhatsApp en texto plano y con caducidad silenciosa
**Severidad: Alto · Estado: Probable** (documentado; no se inspeccionó el VPS)

**Descripción.**
El token de acceso de Meta está escrito en texto plano en `/root/write_config.py` y en `/root/traccar.xml`, y se copia dentro del contenedor (`CREDENCIALES.md`, `DEPLOY.md` §11). Reconocido en `SEGURIDAD.md` punto 5.

El aspecto más grave, sin embargo, es de **disponibilidad**, y está bien documentado en `CONTINUAR.md`: el token temporal caduca cada ~24 horas y **el fallo es silencioso** — no aparece error en `pm2 logs` ni en `docker logs traccar`. Es decir: el canal de alertas a la familia puede llevar días caído sin que nadie lo note.

**Ubicación.** `docs/CREDENCIALES.md` (sección Meta/WhatsApp), `docs/DEPLOY.md` §11, `CONTINUAR.md` (nota sobre el token).

**Escenario.**
Un adulto mayor se cae. El dispositivo detecta la caída, Traccar la registra y el dashboard la muestra correctamente. Pero el token expiró la noche anterior y el WhatsApp a la familia nunca sale. Nadie se entera hasta que alguien pregunta. **Esto no es un riesgo hipotético: es el modo de falla normal del sistema tal como está configurado hoy**, y ocurre cada 24 horas si no se renueva manualmente.

Este es el hallazgo con mayor potencial de daño físico real del informe, y no es un problema de seguridad clásico sino de operación.

**Impacto.**
Falla del propósito central del producto en el momento exacto en que se necesita, sin ninguna señal de alerta. Consecuencias humanas directas y responsabilidad civil evidente.

**Remediación.**
1. **Migrar a un token de sistema de Meta Business** (60 días o permanente), lo que exige completar la verificación de Meta Business — punto 4 del roadmap, que debe adelantarse a antes del primer cliente real.
2. **Sacar el token del disco en texto plano** hacia una variable de entorno cargada por PM2 (`pm2 set` o un archivo `.env` con permisos `600`), y quitarlo de `/root/write_config.py`.
3. **Monitoreo activo, que es lo más importante.** Un chequeo automático cada hora que verifique el token y avise por otro canal si falla:
```bash
# /root/check_token.sh  — ejecutar por cron cada hora
RESP=$(curl -s "https://graph.facebook.com/v20.0/1294512040418742?access_token=$META_TOKEN")
echo "$RESP" | grep -q '"error"' && echo "ALERTA: token WhatsApp caído — $RESP" \
  | mail -s "SimpleCare: WhatsApp caído" renan.rodriguez@simplecare.cl
```
4. **Prueba diaria de extremo a extremo:** un evento sintético que confirme que el mensaje efectivamente sale. Un sistema de emergencias necesita saber que funciona *antes* de la emergencia, no durante.

---

### S12 — Base de datos sin cifrar, sin backups, servidor único, SSH como root
**Severidad: Medio · Estado: Probable**

**Descripción.**
Cuatro debilidades de infraestructura que se refuerzan entre sí:
- `events.db` es un archivo SQLite sin cifrar en `/opt/simplecare/` (`ARQUITECTURA.md`).
- **No hay backups.** Reconocido en `SEGURIDAD.md` punto 8. El histórico completo del servicio depende de un archivo en un disco.
- Servidor único, sin redundancia. Si el VPS de Hostinger falla, el servicio de alertas cae por completo.
- Acceso SSH como `root` con contraseña (`CREDENCIALES.md`, `SEGURIDAD.md` punto 9, que reconoce no saber si hay clave SSH configurada).

**Ubicación.** `docs/ARQUITECTURA.md`, `docs/CREDENCIALES.md`, `docs/SEGURIDAD.md` puntos 8 y 9.

**Escenario.**
`root` con contraseña sobre el puerto 22 abierto a internet recibe ataques de fuerza bruta automatizados de forma permanente — es tráfico de fondo constante en cualquier VPS público. Un compromiso de `root` entrega todo simultáneamente: `events.db`, la base de Traccar con los datos identificados, el token de Meta en texto plano (S11) y los tokens de todos los municipios. Sin backups, además, un ransomware o un simple fallo de disco significa pérdida definitiva del histórico.

**Remediación.**
1. **SSH:** deshabilitar contraseña y root. En `/etc/ssh/sshd_config`: `PermitRootLogin prohibit-password`, `PasswordAuthentication no`. **Verificar que la clave pública funcione antes de reiniciar `sshd`**, para no quedar fuera del servidor. Instalar `fail2ban`.
2. **Backups** — resuelve también el requisito de disponibilidad de la Ley 21.719:
```bash
# /root/backup.sh — cron diario
FECHA=$(date +%F)
sqlite3 /opt/simplecare/events.db ".backup /tmp/events-$FECHA.db"   # backup consistente
docker exec traccar tar czf - /opt/traccar/data > /tmp/traccar-$FECHA.tgz
gpg --encrypt --recipient backup@simplecare.cl /tmp/events-$FECHA.db
# subir el .gpg a almacenamiento externo y borrar los temporales
```
Los backups **deben ir cifrados** y estar fuera del mismo VPS. Un backup en el mismo servidor no protege de nada relevante. Probar la restauración al menos una vez.
3. **Cifrado en reposo:** SQLCipher es una opción, aunque agrega complejidad. Alternativa más simple y de mejor relación esfuerzo/beneficio: cifrado de disco a nivel del VPS, si Hostinger lo ofrece, más el cifrado de los backups.

---

### S13 — `/events` devuelve el `device_hash` completo, contradiciendo `PRIVACIDAD.md`
**Severidad: Medio · Estado: Confirmado**

**Descripción.**
`PRIVACIDAD.md` afirma: *"El ID anónimo se trunca a **8 caracteres** en el dashboard"*. El endpoint `/riesgo` cumple (`server.js:226`: `substr(device_hash, 1, 8)`), pero `/events` usa `SELECT *`:

`server/server.js:150`
```js
res.json(db.prepare(`SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT 30`).all(...params));
```
Eso entrega al cliente el `device_hash` de 16 caracteres, más `id` y `timestamp` interno, campos que el dashboard no usa.

**Ubicación.** `server/server.js:150`; afirmación contradicha en `docs/PRIVACIDAD.md`.

**Impacto.**
Bajo por sí solo — el hash de 16 caracteres no es más reversible que el de 8, y de hecho el problema real es que **ambos son reversibles** (S05). El motivo para corregirlo es distinto: una discrepancia entre lo que el documento de privacidad promete y lo que el sistema hace es exactamente el tipo de hallazgo que destruye la credibilidad del resto del documento en una revisión municipal o ante una fiscalización.

**Remediación.** Devolver solo lo que el dashboard consume:
```js
res.json(db.prepare(`
  SELECT substr(device_hash,1,8) AS id_anonimo, alarm_type, event_type,
         lat_zone, lon_zone, created_at
  FROM events ${where} ORDER BY created_at DESC LIMIT 30
`).all(...params));
```
Regla general que conviene adoptar: **ningún endpoint debe usar `SELECT *`** en un sistema que promete minimización de datos. Es la forma más común de exponer campos sin querer al agregar una columna nueva.

---

### S14 — Sin registro de auditoría ni capacidad de detección
**Severidad: Medio · Estado: Confirmado**

**Descripción.**
No existe ningún middleware de logging de accesos (verificado: no hay `morgan` ni equivalente en `server.js`). Los únicos `console.log` son de eventos del webhook (líneas 108 y 116). Reconocido en `SEGURIDAD.md` punto 7.

Consecuencia práctica: **ninguno de los ataques descritos en este informe dejaría rastro.** Si el token de un municipio se filtra y alguien descarga el CSV completo todos los días durante seis meses, no hay forma de saberlo, ni de reconstruirlo después.

Un detalle a favor que conviene preservar: como no hay logging de peticiones, hoy los tokens **no** quedan escritos en los logs de PM2. Al agregar auditoría hay que asegurarse de no introducir ese problema (ver el ejemplo de código, que omite la query string).

**Ubicación.** `server/server.js` (ausencia de middleware entre las líneas 7 y 48).

**Impacto.**
Imposibilidad de detectar, investigar o acreditar un incidente. La Ley 21.719 obliga a notificar las vulneraciones de seguridad a la Agencia de Protección de Datos Personales: sin logs no se puede determinar si hubo una brecha, qué datos se vieron afectados ni a quiénes notificar. Se pasa de "tuvimos un incidente acotado" a "no podemos descartar nada".

**Remediación.**
```js
const accesos = fs.createWriteStream('/opt/simplecare/access.log', { flags: 'a' });
app.use((req, res, next) => {
  res.on('finish', () => {
    // Nunca registrar req.originalUrl: contiene el token (ver S07)
    accesos.write(JSON.stringify({
      ts: new Date().toISOString(),
      ip: req.ip,
      metodo: req.method,
      ruta: req.path,
      cliente: req.clientId || null,
      status: res.statusCode,
    }) + '\n');
  });
  next();
});
```
Con esto se puede detectar: intentos de token inválido (403 repetidos = fuerza bruta), exportaciones masivas, y accesos desde IP inesperadas. Configurar `pm2 install pm2-logrotate` y definir una retención de logs (12 meses es razonable).

---

### S15 — Retención indefinida sin política ni mecanismo de borrado
**Severidad: Medio · Estado: Confirmado**

**Descripción.**
No hay ningún mecanismo de eliminación de datos antiguos en el código. `PRIVACIDAD.md` lo reconoce: *"Los datos anonimizados se almacenan indefinidamente por defecto"*, con la política formal y el borrado automático marcados como pendientes.

Esto tiene un agravante: como los datos **no están realmente anonimizados** (S05), la retención indefinida no es "conservar estadísticas", es conservar el historial de ubicación y salud de personas identificables, para siempre. Y cada año que pasa acumula más datos que perder en una brecha.

**Ubicación.** `server/server.js` (sin lógica de purga); `docs/PRIVACIDAD.md` (sección Retención).

**Remediación.**
1. Definir y documentar la política. La recomendación de 2 años que ya aparece en `PRIVACIDAD.md` es razonable; conviene acordarla con el municipio y dejarla escrita en el contrato.
2. Implementar el borrado automático:
```js
// Purga diaria de eventos anteriores a la retención definida.
const RETENCION_DIAS = 730;
setInterval(() => {
  const { changes } = db.prepare(
    `DELETE FROM events WHERE created_at < date('now', ?)`
  ).run(`-${RETENCION_DIAS} days`);
  if (changes) console.log(`Purga de retención: ${changes} eventos eliminados`);
}, 24 * 60 * 60 * 1000);
```
3. Si se quieren conservar tendencias históricas más allá de ese plazo, agregar previamente los datos en una tabla de totales mensuales por comuna, sin `device_hash`. Eso sí es información verdaderamente anónima y se puede conservar de forma indefinida sin problema.

---

### S16 — Cumplimiento Ley 21.719: falta base documental completa
**Severidad: Medio · Estado: Confirmado (respecto de los documentos ausentes)**

> **Nota:** este informe es una revisión técnica, no una asesoría legal. Las obligaciones concretas y su fecha exacta de exigibilidad deben confirmarse con un abogado especializado. `PRIVACIDAD.md` afirma que la ley está "vigente desde 2025"; ese dato conviene verificarlo, ya que la entrada en vigencia plena y la puesta en marcha de la Agencia de Protección de Datos Personales tienen plazos propios. **Requiere verificación.**

**Lo que está bien planteado.** El diseño parte del principio correcto: minimizar datos, no almacenar nombre, RUT ni dirección, y entregar al municipio solo agregados. `PRIVACIDAD.md` es un documento mejor que el de muchas empresas más grandes. La estructura de responsabilidades (SimpleCare responsable, municipio receptor) está pensada.

**Las brechas concretas:**

**a) La premisa central del modelo no se cumple.** `PRIVACIDAD.md` construye todo sobre: *"los datos verdaderamente anonimizados — donde es técnicamente imposible reidentificar a la persona — no se consideran datos personales"*. La premisa jurídica es correcta; el problema es que la anonimización implementada no alcanza ese estándar (S05 y sección 4). Mientras eso siga así, **todo el sistema trata datos personales** y le aplican las obligaciones completas de la ley.

**b) Datos sensibles.** Un historial de caídas es información sobre el estado de salud de una persona. Los datos relativos a la salud tienen protección reforzada y exigen una base de licitud más estricta. El sistema los trata desde el primer día.

**c) Consentimiento.** `PRIVACIDAD.md` lo marca como pendiente: *"documento formal de consentimiento informado para firmar al entregar el dispositivo"*. Hay una dificultad específica de este producto que conviene resolver con asesoría: el titular de los datos es un adulto mayor que en algunos casos puede tener capacidad disminuida, mientras que quien contrata es el municipio y quien recibe las alertas es la familia. Quién consiente, cómo se acredita y cómo se revoca necesita un procedimiento explícito y documentado.

**d) Contrato de encargado de tratamiento.** Aunque el municipio reciba datos agregados, la relación debe estar formalizada por escrito, con finalidades, plazos y medidas de seguridad. No existe hoy.

**e) Derechos del titular.** No hay ningún procedimiento ni mecanismo técnico para atender solicitudes de acceso, rectificación, cancelación, oposición o portabilidad. Si un familiar pide "borren todos los datos de mi madre", hoy no hay forma de identificar cuáles son sus filas sin recurrir a Traccar y calcular el hash manualmente. Conviene notar que este mecanismo de borrado *requiere* poder mapear persona → `device_hash`, lo que confirma que el sistema nunca fue realmente anónimo.

**f) Notificación de brechas.** La ley obliga a notificar a la Agencia y, en casos de alto riesgo, a los titulares. Sin logs (S14) no se puede cumplir en la práctica.

**g) Registro de actividades de tratamiento.** No existe.

**Remediación.**
1. Asesoría legal especializada en Ley 21.719 antes del primer contrato municipal. Es un costo acotado frente al riesgo.
2. Elaborar: consentimiento informado, contrato de encargado con el municipio, registro de actividades de tratamiento, procedimiento de derechos ARCOP y protocolo de notificación de brechas.
3. **Corregir `PRIVACIDAD.md` y `DECISIONES.md` D002 en el corto plazo.** Hoy afirman que la anonimización es irreversible. Presentar eso a un municipio y que después se demuestre lo contrario es peor que no haberlo dicho: convierte un problema técnico en un problema de buena fe. Mientras la implementación no cambie, la redacción honesta es *"seudonimización con reducción de precisión geográfica"*, no *"anonimización irreversible"*.
4. Evaluar una Evaluación de Impacto en Protección de Datos: hay tratamiento sistemático de datos de salud y ubicación de un grupo vulnerable, que es justamente el perfil que la suele hacer aconsejable.

---

### S17 — `/dashboard` se sirve sin token
**Severidad: Bajo · Estado: Confirmado**

`server.js:97-100` sirve el HTML sin pasar por `requireClient`. No expone datos: el HTML es una carcasa vacía y todas las llamadas a la API sí exigen token. El riesgo real es menor — divulga la existencia y estructura del sistema a quien escanee el puerto. Se resuelve solo al implementar la remediación de S07, que agrega validación en esa ruta. Se documenta por completitud, no como acción prioritaria.

---

### S18 — Pérdida silenciosa de eventos si Node.js está caído
**Severidad: Medio · Estado: Probable** (depende del comportamiento de reintento de Traccar, no verificado)

**Descripción.**
El flujo es Traccar → HTTP POST → Node.js → SQLite, sin cola intermedia ni confirmación persistente. Si Node.js está caído, reiniciándose o bloqueado (S10), el POST falla y el evento **se pierde de forma definitiva** en la base del dashboard. `APRENDIZAJES.md` A008 documenta un episodio real con más de mil reinicios en cadena: todos los eventos de esa ventana se perdieron.

Nótese además que el webhook responde `200 OK` incluso cuando descarta el evento por no estar en la lista `relevantes` (`server.js:106` y `118`), de modo que Traccar nunca distingue entre "procesado" y "descartado".

**Ubicación.** `server/server.js:104-119`; contexto en `docs/APRENDIZAJES.md` A008.

**Impacto.**
Vacíos silenciosos en el registro de alertas. En un sistema de emergencias, un evento SOS que no queda registrado es un problema de trazabilidad ante un incidente real: no se puede acreditar qué pasó ni cuándo.

Es importante aclarar el alcance: el WhatsApp a la familia lo envía Traccar directamente, no Node.js, así que hoy la alerta a la familia **no** depende de este componente. Pero eso cambia con el punto 1 del roadmap, que traslada el envío de WhatsApp a `server.js`. A partir de ese momento, una caída de Node.js deja de ser "perdemos estadísticas" y pasa a ser "**no se avisa a la familia**". Ver sección 5.

**Remediación.**
1. Verificar si la versión de Traccar en uso reintenta los reenvíos fallidos (`event.forward.retry.enable` existe en versiones recientes) y activarlo si está disponible.
2. Monitoreo de disponibilidad de Node.js con alerta a un canal externo (`pm2` con un chequeo periódico contra un endpoint `/health`).
3. Antes de mover el envío de WhatsApp a `server.js`, introducir una cola persistente: escribir el evento a disco primero, procesarlo después, y reintentar los fallidos. Con SQLite basta una tabla `pendientes`.

---

### 3.19 — Inyección SQL: revisado, sin hallazgos

Se revisaron **las 8 consultas** de los endpoints de datos más las del arranque. **No se encontró ninguna inyección SQL.** Este es un resultado positivo y merece destacarse, porque el código construye fragmentos de SQL dinámicamente, que es justamente donde suelen aparecer.

Lo que se verificó específicamente:

- **Ningún dato de usuario se concatena nunca al SQL.** Todo interpolado en las plantillas es texto generado por el propio servidor. Los fragmentos `${and}`, `${where}`, `${clientCond}` son cadenas fijas construidas a partir de literales del código (`server.js:147-149, 159-162, 182-185, 200-202, 221-223, 269-272`); los valores van siempre por `?`.
- **Las listas `IN` se construyen correctamente.** El patrón `tipos.map(() => '?').join(',')` (`server.js:144, 184, 271`) genera solo signos de interrogación — la cantidad depende del input, pero el contenido nunca. Es la forma correcta de hacer una lista `IN` parametrizada.
- **`tipos` está además restringido por lista blanca** antes de llegar al SQL (`server.js:139, 178, 265`): `.filter(t => ['sos','fall','low_battery'].includes(t))`. Doble protección.
- **El orden de los parámetros es correcto en todos los casos**, incluidos los tres endpoints donde el `client_id` va al final en lugar del principio (`/heatmap:190`, `/utilization:211`, `/riesgo:239`, `/export:279`). Se verificó uno por uno que la secuencia de `?` en el SQL coincida con el orden de los argumentos de `.all()`. Un desalineamiento aquí habría producido un fallo de aislamiento entre municipios; no lo hay.
- **`/dispositivo/:id`** sanea el parámetro de ruta (`server.js:246`) y además lo pasa parametrizado.
- **`better-sqlite3` no permite múltiples sentencias** en `.prepare()`, lo que descarta el ataque de encadenar una segunda consulta.

Observación menor, sin impacto de seguridad: en `server.js:246` el saneado usa la bandera `/gi`, que conserva las letras `A`-`F` mayúsculas, pero los hashes almacenados son minúsculas. Un `id` en mayúsculas simplemente no encontraría resultados. Es un detalle funcional, no un riesgo.

---

### 3.20 — Secretos en el historial de Git: revisado, sin hallazgos

Se revisó **el historial completo** de los 8 commits (`git log --all -p`) buscando patrones de tokens de Meta, claves de API, contraseñas y cadenas de credenciales.

**No se encontró ningún secreto real filtrado.** En particular:
- El token de Meta **nunca fue commiteado**. `DEPLOY.md` usa el marcador `TOKEN_META_AQUI` en lugar del valor real, que es exactamente la práctica correcta.
- `CREDENCIALES.md` documenta *dónde vive* cada secreto sin incluir ninguno. Es un patrón bien ejecutado y conviene mantenerlo.
- El `.gitignore` cubre `.env`, `*.env`, `credenciales-reales.md` y `*.db`, evitando que la base de datos llegue al repositorio.

La única excepción es `demo-token-dev-only` (S08), que es un token de desarrollo, no un secreto real, pero que debe eliminarse antes de producción por lo explicado en S04.

Se identifica sí un dato interno expuesto en el repositorio: la IP del VPS `2.24.196.49` aparece en varios documentos. No es un secreto en sentido estricto, pero al estar el repositorio privado no conviene relajarse: si alguna vez se hace público, esa IP más la documentación de puertos y rutas es un mapa completo de la infraestructura. Al migrar a `panel.simplecare.cl` (roadmap 3), conviene reemplazar las referencias a la IP por el nombre de dominio.

---

## 4. Análisis de la anonimización

Esta sección merece tratamiento aparte porque de ella depende la propuesta comercial completa hacia los municipios y el argumento legal frente a la Ley 21.719.

### 4.1 Lo que hace el código

`server/server.js:82-93`
```js
function anonymize(body) {
  const event    = body.event;
  const position = body.position;
  return {
    device_hash: crypto.createHash('sha256').update(String(event.deviceId)).digest('hex').slice(0, 16),
    alarm_type:  normalizeAlarm(event.attributes?.alarm),
    event_type:  event.type,
    timestamp:   event.eventTime,
    lat_zone:    position?.latitude  ? Math.round(position.latitude  * 100) / 100 : null,
    lon_zone:    position?.longitude ? Math.round(position.longitude * 100) / 100 : null,
  };
}
```

### 4.2 El identificador no es irreversible

**Primer problema, y es decisivo: el hash no se aplica al IMEI.**

`PRIVACIDAD.md` y `DECISIONES.md` D002 hablan del IMEI. Pero el código usa `event.deviceId`, que según `docs/API.md` es el identificador interno de Traccar (`"deviceId": 45`, `"device": {"id": 45, "name": "Miguel"}`). Es un entero autoincremental que empieza en 1.

Con la escala objetivo de 1.000 usuarios, `deviceId` recorre aproximadamente el rango 1–2.000. Reconstruir la tabla completa de correspondencias requiere calcular 2.000 hashes SHA256, lo que en un computador común toma **menos de un milisegundo**:

```js
// Reconstrucción completa del mapa hash → deviceId
const mapa = {};
for (let i = 1; i <= 5000; i++) {
  mapa[crypto.createHash('sha256').update(String(i)).digest('hex').slice(0,16)] = i;
}
// mapa['d4735e3a265e16ee'] devuelve el deviceId original
```

Con el `deviceId` en mano, quien tenga acceso a Traccar obtiene el nombre real de la persona de inmediato. Y `device_hash` es el único campo que separa "estadística agregada" de "el historial de esta señora".

**Segundo problema: aunque el hash fuera del IMEI, tampoco sería irreversible.** Un IMEI son 15 dígitos, pero los primeros 8 (el TAC) identifican al modelo de dispositivo. Como todos los dispositivos son Eview EV07B, el TAC es el mismo para todos y solo quedan ~7 dígitos variables: unos 10 millones de candidatos. Un hardware modesto calcula miles de millones de SHA256 por segundo. La búsqueda completa toma **segundos**.

La afirmación de D002 (*"Irreversible: no se puede recuperar el IMEI original desde el hash"*) confunde dos propiedades distintas de una función hash. SHA256 es resistente a preimagen en el sentido de que no se puede *invertir* matemáticamente. Pero cuando el conjunto de entradas posibles es pequeño y conocido, no hace falta invertir nada: se prueban todas. Un hash sin sal sobre un espacio pequeño no anonimiza; simplemente cambia el nombre del identificador. Técnicamente esto es **seudonimización**, no anonimización, y la diferencia es precisamente la que la Ley 21.719 usa para decidir si algo es o no un dato personal.

### 4.3 La ubicación tampoco protege tanto como el documento afirma

`PRIVACIDAD.md` sostiene que 2 decimales equivalen a ~1,1 km y que *"es imposible determinar en qué casa o edificio vive"*. Dos matices importantes:

**El redondeo no es una zona de 1,1 km.** `Math.round(lat*100)/100` es una **grilla fija**, no un desplazamiento aleatorio. Todos los puntos caen en intersecciones de una cuadrícula de ~1,1 km. En Santiago (`ARQUITECTURA.md` centra el mapa en -33.45, -70.65), una celda de 1,1 × 0,9 km contiene del orden de 10.000 a 40.000 habitantes, según la densidad. Como zona de ocultamiento es razonable — para un punto aislado.

**El problema es que no hay un punto aislado, hay un patrón.** El sistema almacena, por cada `device_hash`, la secuencia completa de eventos con su celda y su hora exacta (`timestamp` sin ninguna transformación). Y `/dispositivo/:id` (`server.js:245-257`) está diseñado justamente para mostrar esa secuencia en un mapa.

La celda donde una persona genera eventos de `deviceOnline` todas las noches es su casa. Ese es el resultado clásico de los estudios sobre datos de movilidad: cuatro puntos espacio-temporales bastan para identificar de manera única a la gran mayoría de las personas en un conjunto de datos de este tipo. Aquí hay muchos más de cuatro.

Y en el contexto concreto de este producto la re-identificación es aún más fácil, porque el conjunto es pequeño y muy específico: en una celda de 1,1 km, los participantes de un programa municipal de adultos mayores con botón SOS pueden ser dos o tres personas. El municipio — que es quien recibe los datos — **tiene la lista de beneficiarios de su propio programa**. Cruzar "el ID `d4735e3a` genera eventos en esta celda y tuvo 8 caídas" con esa lista no requiere ninguna técnica: requiere leer dos planillas.

Ese es el punto crítico, porque contradice directamente la afirmación de `PRIVACIDAD.md` de que el municipio *"no puede reidentificar individuos"*. **El municipio es, de hecho, el actor con mayor capacidad de re-identificación de todo el sistema**, porque tiene el dato externo que falta.

### 4.4 Qué expone el panel de riesgo

`/riesgo` (`server.js:217-241`) entrega al municipio, por persona: número de caídas, número de SOS, fecha de la última alerta y un puntaje de fragilidad. Combinado con lo anterior, el municipio puede construir una lista de personas identificadas con su nivel de deterioro físico. Eso es un dato de salud sobre una persona identificable, presentado bajo una etiqueta que dice "🔒 Datos anonimizados · Sin información personal" (`dashboard.html:106`).

No es un problema de mala fe: es un panel útil y bien diseñado, y probablemente sea la función más valiosa del producto para el municipio. Pero su utilidad viene precisamente de que permite actuar sobre individuos, y eso es incompatible con llamarlo anónimo.

### 4.5 Veredicto

**La anonimización no resiste un intento de re-identificación.** Ni siquiera uno sofisticado: el vector principal (fuerza bruta sobre el `deviceId`) es cuestión de segundos, y el secundario (cruce con la lista de beneficiarios) no requiere conocimientos técnicos.

Bajo el criterio de la Ley 21.719, los datos almacenados en `events.db` **son datos personales**, y en la parte relativa a caídas y salud, datos sensibles. La exención del artículo sobre datos anonimizados no aplica.

### 4.6 Qué haría falta para que resistiera

Hay dos caminos posibles, y conviene elegir conscientemente.

**Camino A — asumir que es seudonimización y protegerla como tal (recomendado).**
Es lo honesto y lo que mejor calza con el producto real, porque el panel de riesgo *necesita* identificar individuos para ser útil.
1. Cambiar el discurso: "seudonimización con reducción de precisión geográfica y controles de acceso", no "anonimización irreversible". Actualizar `PRIVACIDAD.md`, `DECISIONES.md` D002 y el pie del dashboard.
2. **Agregar una sal secreta al hash**, que es la corrección técnica de fondo. Elimina el ataque de fuerza bruta por completo:
```js
// La sal vive solo en una variable de entorno, nunca en el código ni en la base de datos.
const SALT = process.env.DEVICE_SALT;   // 32 bytes aleatorios, generados una vez
if (!SALT) throw new Error('Falta DEVICE_SALT');

device_hash: crypto.createHmac('sha256', SALT)
                   .update(String(event.deviceId))
                   .digest('hex').slice(0, 16)
```
Con HMAC y una sal secreta de 32 bytes, recorrer los `deviceId` posibles ya no sirve: sin la sal no se pueden calcular los hashes. **Nota de migración:** esto invalida todos los hashes existentes. Se debe hacer antes de tener datos reales, o con un script de migración que recalcule las filas.
3. Tratar el sistema como tratamiento de datos personales: consentimiento, contrato de encargado, derechos ARCOP, retención, notificación de brechas (S16).
4. Reducir el detalle temporal en lo que ve el municipio: entregar `timestamp` truncado a la hora o al día en lugar de al segundo, salvo donde el detalle sea imprescindible.

**Camino B — anonimización real, solo para la parte agregada.**
Aplicable a lo que se comparte con el municipio en el dashboard, manteniendo los datos seudonimizados en el backend:
1. Reemplazar la grilla fija por agregación por unidad geográfica reconocida (comuna o unidad vecinal), no por coordenadas.
2. Suprimir celdas con pocos individuos: si una zona tiene menos de un umbral de personas (5 es un valor habitual), no mostrarla. Sin esto, el mapa de calor de una zona rural apunta directamente a una casa.
3. Entregar solo conteos por período, sin `device_hash` ni secuencias individuales.
4. **Esto implica eliminar el panel de riesgo individual y el modal de historial por persona**, que son datos personales por definición.

**La recomendación práctica es el Camino A para el sistema, con elementos del Camino B en las funciones donde la agregación no le quita valor al municipio** (el mapa de calor gana poco con la precisión actual y con el umbral mínimo de individuos queda mucho más defendible). El panel de riesgo puede mantenerse, pero reconociendo lo que es: una herramienta de gestión sobre personas identificables, con la base legal y los controles de acceso que eso exige.

Independiente del camino elegido, **la sal en el hash (punto A.2) debe implementarse antes del primer dato real.** Es un cambio de tres líneas que cierra el vector de re-identificación más grave, y hacerlo después obliga a migrar toda la base.

---

## 5. Riesgos que introduce el roadmap

### 5.1 Guardar números de teléfono de familiares (punto 1) — el cambio más significativo

Esta función es necesaria para el producto: hoy el WhatsApp llega a la cuenta administradora de Traccar y no a la familia (`CONTINUAR.md`), lo que es una limitación real. Pero **cambia la naturaleza legal del sistema completo**, y conviene entender por qué antes de construirla.

**Qué se rompe exactamente.** Hoy existe una separación, aunque imperfecta: los datos identificados están en Traccar, los seudonimizados en `events.db`. Al guardar `device_hash → teléfono del familiar` en la misma base de datos, se coloca **la clave de re-identificación junto a los datos que pretendía proteger**. Un número de teléfono es un dato personal directo y no admite discusión: es único, verificable, y está asociado a una persona identificada. Con esa tabla, cualquiera que obtenga `events.db` obtiene simultáneamente el historial de caídas de una persona y el teléfono de su hija.

Después de este cambio, ningún argumento de anonimización se sostiene, ni siquiera con la sal del punto 4.6.

**Riesgos concretos que se agravan:**

| Hallazgo | Cómo empeora |
|---|---|
| **S12** (DB sin cifrar, sin backups) | El archivo pasa a contener PII directa. El cifrado en reposo deja de ser recomendable y pasa a ser exigible. |
| **S03** (XSS) / **S07** (token en URL) | Si algún endpoint futuro expone los contactos, un token robado entrega la agenda de familiares. |
| **S06** (webhook abierto) | Si el webhook dispara el envío de WhatsApp, un atacante puede provocar mensajes de emergencia falsos a familias reales — pánico dirigido y agotamiento de la cuota de Meta. |
| **S18** (sin cola persistente) | Deja de ser "perdemos estadísticas" y pasa a ser "**no se avisa a la familia**". Este es el cambio más grave del roadmap. |
| **S11** (token de Meta) | El token pasa a estar en `server.js`, que está en Git. Riesgo alto de que termine commiteado. |
| **S16** (cumplimiento) | El familiar pasa a ser un titular de datos adicional, con sus propios derechos y su propio consentimiento. |

**Recomendaciones antes de implementarlo:**
1. **Tabla separada y con acceso restringido.** `device_contacts (device_hash, telefono, nombre_contacto, parentesco)` en una base de datos distinta, cifrada, sin ningún endpoint del dashboard que la consulte. El municipio no debe poder acceder a ella nunca, por ninguna vía.
2. **Ningún endpoint autenticado con token municipal debe leer contactos.** Solo el proceso interno de envío.
3. **Cola persistente antes de mover el envío de WhatsApp a Node.js.** Un evento SOS debe escribirse a disco antes de intentar enviarlo, y reintentarse si falla. Y debe existir una alerta que avise cuando un envío no se logró.
4. **El token de Meta va en variable de entorno**, verificado antes del primer commit.
5. **Consentimiento del familiar**, que es un titular distinto del adulto mayor.
6. **Minimización en el mensaje:** el WhatsApp no debería incluir información de salud detallada ni coordenadas exactas si basta con "alerta activada, contacte a [nombre]". El contenido del mensaje también es tratamiento de datos, y viaja por infraestructura de Meta (transferencia internacional).

### 5.2 Panel admin interno (punto 2)

Concentra lo más sensible del sistema: la correspondencia IMEI → municipio → persona → contactos. Es decir, exactamente el mapa que reconstruye la identidad de todos.

**Riesgo principal:** que se construya con el mismo patrón de autenticación por token en la query string (S07). Para un panel administrativo sería una decisión difícil de defender.

**Recomendaciones:** autenticación real con usuario y contraseña más segundo factor; sin acceso desde internet (solo por túnel SSH o VPN, igual que S01); registro de auditoría de toda acción administrativa; y separación de roles si en el futuro hay más de una persona operando.

### 5.3 HTTPS + subdominio (punto 3)

Es la mejora más valiosa del roadmap. Dos advertencias ya señaladas:
- **El log de Nginx registra la query string por defecto**, lo que crearía un archivo con todos los tokens en texto plano (ver S02). Debe configurarse el `log_format` antes de poner el servicio en marcha.
- Al terminar, hay que **cerrar el puerto 3000** al exterior. Si queda abierto, el acceso HTTP directo sigue disponible y el HTTPS se vuelve decorativo.

### 5.4 Verificación de Meta Business (punto 4)

Debería adelantarse. Hoy el token caduca cada 24 horas y falla en silencio (S11): eso es incompatible con un servicio de emergencias en producción. Es un requisito de fiabilidad, no solo un trámite para salir del sandbox.

### 5.5 PWA para familias (punto 5)

Amplía significativamente la superficie de ataque: nuevos usuarios finales, autenticación desde dispositivos personales, y probablemente notificaciones push. El modelo de token en URL no escala a este caso — hará falta autenticación real con sesiones, y decidir con cuidado qué ve exactamente un familiar (¿la ubicación en tiempo real de su madre? ¿con qué consentimiento de ella?). Conviene diseñarlo cuando el resto esté estabilizado.

### 5.6 Escala a 1.000 usuarios

- **SQLite** sigue siendo viable en volumen (`DECISIONES.md` D001 lo estima bien), pero su carácter síncrono con consultas lentas es el problema real (S10). Los índices de S10 son necesarios antes de escalar.
- **Un solo VPS sin redundancia ni backups** para 1.000 personas mayores dependientes de un botón de emergencia es un riesgo operacional que conviene revisar. Un fallo de disco significa pérdida total del histórico y caída del servicio.
- **La re-identificación empeora con la escala**, no mejora: más dispositivos por celda geográfica ayudarían, pero el `deviceId` correlativo sigue siendo trivial de recorrer y el cruce con las listas municipales sigue funcionando igual.

---

## 6. Plan de remediación priorizado

### Bloqueante — antes del primer municipio real

| # | Acción | Hallazgos | Esfuerzo |
|---|---|---|---|
| 1 | Cerrar el puerto 8082 al internet (acceso solo por túnel SSH) y verificar la contraseña de Traccar | S01 | 30 min |
| 2 | Cerrar el puerto 3000 al internet; dejar el webhook accesible solo desde `172.17.0.0/16` | S06 | 15 min |
| 3 | HTTPS con Nginx + Certbot sobre `panel.simplecare.cl`, **con `log_format` sin query string** | S02 | 2-4 h |
| 4 | Corregir el XSS: lista blanca en `normalizeAlarm()` + `textContent` en el dashboard | S03 | 2 h |
| 5 | Corregir la reasignación a `demo`: migración única + registro de dispositivos sin asignar | S04 | 1 h |
| 6 | Agregar sal secreta al hash (HMAC con `DEVICE_SALT` en variable de entorno) | S05 | 30 min |
| 7 | Eliminar el cliente `demo` y su token del código y del CHANGELOG | S08 | 15 min |
| 8 | Migrar el token de Meta a variable de entorno + monitoreo horario de caducidad | S11 | 2 h |
| 9 | Deshabilitar SSH por contraseña y login de root; instalar `fail2ban` | S12 | 1 h |
| 10 | Backups diarios cifrados y fuera del VPS, con una restauración probada | S12 | 2 h |
| 11 | Corregir `PRIVACIDAD.md` y `DECISIONES.md` D002: seudonimización, no anonimización | S05, S16 | 1 h |
| 12 | Consentimiento informado y contrato de encargado, con asesoría legal | S16 | externo |

Los puntos 1, 2, 5 y 7 se pueden hacer hoy mismo y eliminan los riesgos de mayor impacto inmediato. Los puntos 1 y 2 son los de mejor relación esfuerzo/beneficio de todo el informe: 45 minutos de trabajo que cierran la exposición más grave del sistema.

**El punto 6 tiene una restricción de plazo:** debe hacerse antes de que existan datos reales, o exigirá migrar toda la base.

### Antes de escalar — antes del segundo municipio o de superar ~100 dispositivos

| # | Acción | Hallazgos | Esfuerzo |
|---|---|---|---|
| 13 | Token de sesión por cookie `httpOnly` en lugar de query string | S07 | 3 h |
| 14 | Alojar Leaflet y Chart.js localmente; agregar CSP y cabeceras de seguridad | S09 | 3 h |
| 15 | Rate limiting; límite de filas en `/export`; índices en `events` | S10 | 2 h |
| 16 | Registro de auditoría de accesos, sin query string, con rotación | S14 | 2 h |
| 17 | Política de retención de 2 años con purga automática | S15 | 1 h |
| 18 | Eliminar `SELECT *` de `/events`; devolver solo los campos que el dashboard usa | S13 | 30 min |
| 19 | Cola persistente de eventos y monitoreo de disponibilidad de Node.js | S18 | 4 h |
| 20 | Dejar de usar el nombre real de la persona como nombre del dispositivo en Traccar | S01 | 2 h |
| 21 | Procedimiento documentado de derechos ARCOP y de notificación de brechas | S16 | externo |

### Deseable — mejora continua

| # | Acción | Hallazgos |
|---|---|---|
| 22 | Umbral mínimo de individuos por celda en el mapa de calor (suprimir zonas con < 5) | Sección 4.6 |
| 23 | Cifrado en reposo de la base de datos (SQLCipher o cifrado de disco) | S12 |
| 24 | Reducir el detalle temporal entregado al municipio (hora en vez de segundo) | Sección 4.6 |
| 25 | Evaluación de Impacto en Protección de Datos | S16 |
| 26 | Migración a PostgreSQL con redundancia | Sección 5.6 |
| 27 | Revisión de seguridad externa antes de un contrato municipal de volumen | — |

### Antes de construir cada punto del roadmap

- **Contactos WhatsApp:** completar el bloque Bloqueante, más los puntos 13, 19 y las recomendaciones específicas de la sección 5.1.
- **Panel admin:** autenticación real con segundo factor y sin exposición a internet (sección 5.2).
- **PWA familias:** rediseño del modelo de autenticación; no extender el token en URL (sección 5.5).

---

## 7. Nota final

El equilibrio de este informe conviene dejarlo explícito, porque una lista de hallazgos siempre se lee peor de lo que la realidad amerita.

Este es un prototipo funcional que hace algo difícil y lo hace bien: recibe eventos de un dispositivo físico, los procesa, avisa a una familia y presenta información útil a un municipio. Está construido con criterio, el código está limpio y parametrizado, y la documentación es más honesta sobre sus propias brechas que la de muchos sistemas en producción. `SEGURIDAD.md` ya identificaba correctamente 9 de los 18 hallazgos de este informe antes de que la auditoría empezara. Eso dice algo bueno sobre cómo se está llevando el proyecto.

Los hallazgos nuevos son básicamente tres: la cadena de XSS (S03), el defecto de reasignación a `demo` (S04), y sobre todo la evaluación de la anonimización (S05 y sección 4), que es donde conviene poner la atención. No porque el resto no importe, sino porque de ahí depende lo que SimpleCare le puede prometer a un municipio y lo que la ley le va a exigir. Corregir el hash es un cambio de tres líneas; corregir el discurso construido encima cuesta más si se hace tarde.

La brecha entre este prototipo y un sistema listo para datos reales es de una a dos semanas de trabajo enfocado. Es una brecha perfectamente cerrable, y vale la pena cerrarla antes del primer cliente y no después.
