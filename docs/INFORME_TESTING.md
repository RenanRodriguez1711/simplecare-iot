# Informe de estrategia de pruebas — SimpleCare IoT

**Fecha:** 26 de julio de 2026
**Alcance:** backend Node.js (`server/server.js`) y su contrato con el dashboard municipal.
**Estado del proyecto antes de este trabajo:** cero tests.

---

## 1. Resumen ejecutivo

SimpleCare IoT es un sistema de alarmas de vida. Cuando falla, la consecuencia no es un dato mal graficado: es un adulto mayor que se cayó y cuya alerta no llegó a nadie. Esa asimetría define toda la estrategia de pruebas que se describe acá.

Se construyó una suite de **189 tests** sobre el runner nativo de Node (`node:test` + `node:assert`), sin frameworks externos, que corre contra una base SQLite temporal y desechable. La suite se ejecuta con `npm test` en Windows en unos 10 segundos.

**Resultado de la ejecución real:** 183 pasan, 0 fallan, 6 quedan marcados como `skip` porque documentan bugs abiertos que no corresponde corregir sin aprobación explícita del usuario.

Los cuatro riesgos que la suite protege, en orden de gravedad:

1. **La alerta se pierde en la ingesta.** Un payload inesperado de Traccar tumba el proceso o descarta el evento. Cubierto por 25 tests de webhook, incluidos 12 payloads basura distintos.
2. **La alerta se guarda pero es invisible.** Es exactamente lo que ocurrió con A015: Traccar entrega `fallDown` y las queries buscaban `fall`. Estuvo roto meses. Cubierto por 14 tests de normalización, incluida la idempotencia de la migración de arranque.
3. **Un municipio ve los datos de otro.** Cubierto por 26 tests de aislamiento, endpoint por endpoint, más el acceso directo por `device_hash` ajeno.
4. **Los KPI mienten.** A011 (KPI sobre una muestra truncada) y el puntaje de riesgo. Cubierto por 16 tests de agregación.

Además se dejaron **6 tests que documentan bugs abiertos** —S03 (XSS almacenado), S04 (reasignación a `demo`) y un defecto menor no catalogado (T01)— escritos en su forma correcta y desactivados con `skip`. Cada uno viene acompañado de un test activo que fija el comportamiento defectuoso actual: si alguien corrige el bug, ese test empieza a fallar y avisa que hay que quitar el `skip`. El bug queda registrado en la suite en vez de vivir solo en un informe.

**Recomendación principal:** antes de onboardear el primer municipio real, corregir S04. La suite ya demuestra, de forma ejecutable, que un dispositivo de reposición de un municipio real termina siendo propiedad del cliente `demo` —cuyo token está publicado en el repositorio— en el siguiente `pm2 restart`, y que ese municipio deja de ver a esa persona en su panel de riesgo.

---

## 2. Qué se testea y qué deliberadamente no

### 2.1 Dentro del alcance

| Área | Por qué |
|---|---|
| Webhook e ingesta | Es el único camino por el que entra una alarma. Cero tolerancia a caídas del proceso. |
| Anonimización | Es la promesa legal y comercial del producto (Ley 21.719). |
| Normalización de alarmas | Ya falló una vez en producción y fue invisible durante meses (A015). |
| Aislamiento multi-tenant | Un fallo acá termina un contrato con una entidad pública. |
| Autenticación por token | Única barrera entre internet y los datos de un municipio. |
| Agregaciones y puntaje de riesgo | Ya fallaron una vez (A011) y alimentan decisiones de asistencia social. |
| Contrato de la API con el dashboard | Formato CSV, BOM, encabezados, forma de las respuestas. |

### 2.2 Fuera del alcance, con justificación

| Área | Por qué no se testea |
|---|---|
| **Integración real con Traccar** | Requiere Docker, un contenedor Traccar y un dispositivo real. La suite modela el contrato con payloads con la forma exacta documentada en A005. Si Traccar cambia esa forma, ningún test unitario lo detecta: eso necesita una prueba de integración con el contenedor real (ver sección 6). |
| **Envío real de WhatsApp por Meta** | Hoy lo hace Traccar, no `server.js`. No hay código propio que testear. Además tiene un modo de falla silenciosa (A013) que solo se detecta consultando la API de Meta. |
| **Hardware EV07B** | No es software. La detección de caída, la duración de la batería y la fijación de GPS solo se validan en terreno. |
| **Dashboard en navegador (Leaflet, Chart.js, renderizado)** | Requiere Playwright. Se propone como fase 2 opcional (sección 6). La suite base cubre el contrato de datos que el dashboard consume, que es donde han estado los bugs reales. |
| **Rendimiento y carga** | H07, H08 y S10 (falta de índices, `/export` sin límite, sin rate limiting) son problemas de rendimiento reales, pero medirlos con SQLite en un directorio temporal de Windows no diría nada útil sobre un VPS. Requieren pruebas de carga contra un entorno de staging. |
| **Infraestructura del VPS** | UFW, PM2, Docker, permisos SSH (A001, A002, A008, A010). Son configuración, no código. Se verifican con el runbook, no con tests. |
| **HTTPS / TLS** | No existe hoy (S02, H05). No hay nada que testear hasta que se implemente. |
| **Reversibilidad del hash (S05/H01)** | La suite verifica que el hash sea determinista y que no filtre datos personales, pero **no** afirma que sea irreversible, porque no lo es. Testear "es irreversible" sería codificar una falsedad. Hay un test que documenta explícitamente que el hash se calcula sobre el `deviceId` correlativo de Traccar y no sobre el IMEI. |

### 2.3 Principio de diseño de la suite

Ningún test toca la base de producción ni el VPS. Cada archivo de test levanta el servidor sobre una base SQLite creada con `fs.mkdtempSync` y la borra al terminar. La ruta se inyecta por la variable de entorno `SIMPLECARE_DB`, cuyo valor por defecto sigue siendo `/opt/simplecare/events.db`.

---

## 3. Refactor mínimo de testabilidad aplicado a `server.js`

Tres cambios, todos con comportamiento de producción idéntico al anterior. **No se corrigió ningún bug de los informes.**

| # | Cambio | Motivo | Riesgo en producción |
|---|---|---|---|
| 1 | `const DB_PATH = process.env.SIMPLECARE_DB \|\| '/opt/simplecare/events.db'` | La ruta estaba hardcodeada; sin esto todo test escribiría en la base real. | Nulo: sin la variable, el valor es el de siempre. |
| 2 | `const DASHBOARD_PATH = process.env.SIMPLECARE_DASHBOARD \|\| '/opt/simplecare/public/dashboard.html'` y `PORT = Number(process.env.PORT) \|\| 3000` | Igual que el anterior, para `/dashboard` y para levantar el servidor en un puerto libre (`0`) durante los tests. | Nulo: mismos valores por defecto. |
| 3 | `if (require.main === module) { app.listen(...) }` + `module.exports = { app, db, normalizeAlarm, anonymize, ALARM_ALIASES, DB_PATH }` | El módulo llamaba a `listen()` al cargarse: importarlo en un test ocupaba el puerto 3000. Ahora solo escucha cuando se ejecuta con `node server.js`, que es exactamente como lo lanza PM2. | Nulo: PM2 ejecuta el archivo directamente, así que `require.main === module` es verdadero. |

Lo que **no** se tocó, a propósito: la reasignación a `demo` (S04), la falta de lista blanca en `normalizeAlarm` (S03), el `innerHTML` del dashboard, la ausencia de índices, el `LIMIT` de `/export`. Todo eso requiere aprobación explícita del usuario.

**Nota de despliegue:** `server/server.js` es un espejo de `/opt/simplecare/server.js`. Este refactor debe copiarse al VPS junto con el resto de los cambios, siguiendo el procedimiento de `CONTINUAR.md`. Mientras no se copie, el VPS sigue funcionando igual —el archivo anterior es funcionalmente equivalente—, pero el espejo queda desincronizado.

---

## 4. Mapa de cobertura por camino crítico

| # | Camino crítico | Archivo de test | Qué verifica |
|---|---|---|---|
| C1 | Dispositivo → Traccar → webhook → SQLite (camino feliz de una alarma) | `webhook.test.js` → "Webhook — eventos válidos" | Que un SOS con la forma exacta de Traccar (A005) se persista con hash, tipo, timestamp y zona correctos. |
| C2 | Traccar envía basura y el proceso debe sobrevivir | `webhook.test.js` → "payloads malformados" | 12 payloads distintos (objeto vacío, array, `event` como string/número, JSON roto, sin cuerpo). Cada caso incluye una prueba de vida posterior. |
| C3 | Evento relevante con campos faltantes | `webhook.test.js` → "campos faltantes" | Sin `position`, sin `attributes`, sin `deviceId`, sin `eventTime`, sin `longitude`. **La alarma nunca se descarta por falta de GPS.** |
| C4 | Solo se persiste lo relevante | `webhook.test.js` | Los 5 tipos relevantes se guardan; `deviceMoving`, `commandResult`, `maintenance`, `textMessage` no ensucian la tabla. |
| C5 | Anonimización determinista | `anonimizacion.test.js` | Mismo `deviceId` → mismo hash; hash = SHA256 truncado a 16 hex; ids distintos → hashes distintos; estabilidad entre reinicios. |
| C6 | Degradación del GPS a zona | `anonimizacion.test.js` | 5 coordenadas chilenas reales redondeadas a 2 decimales; ninguna fila almacenada supera esa precisión; la coordenada exacta nunca aparece en la base. |
| C7 | Ningún dato personal en la base | `anonimizacion.test.js` | Nombre, teléfono, IMEI, dirección y velocidad del payload no se persisten. El esquema de `events` se congela con un `deepEqual` de columnas: agregar un campo personal rompe el test. |
| C8 | Normalización de alarmas (A015) | `normalizacion-alarmas.test.js` | Cada alias de `ALARM_ALIASES`, conversión genérica camelCase→snake_case (7 casos), valores nulos/vacíos/no-string, mayúsculas y dígitos. |
| C9 | Normalización en el camino real de ingesta | `normalizacion-alarmas.test.js` | `fallDown` que entra por el webhook queda contabilizado por las queries que filtran `'fall'`. Ningún valor camelCase sobrevive en la base. |
| C10 | Migración idempotente de filas históricas | `normalizacion-alarmas.test.js` | Se siembran filas en camelCase antes de arrancar; se verifica el primer arranque y luego dos reinicios más sobre la misma base: `deepEqual` fila por fila, sin duplicados ni pérdidas. |
| C11 | Aislamiento en los 8 endpoints | `aislamiento-multitenant.test.js` | Dos municipios en regiones distintas del país. Se verifica en `/stats`, `/events`, `/summary`, `/heatmap`, `/utilization`, `/riesgo`, `/dispositivo/:id` y `/export` que A nunca vea un dato de B, ni por conteo, ni por coordenada, ni por identificador. |
| C12 | Acceso directo por `device_hash` ajeno | `aislamiento-multitenant.test.js` | A pide el dispositivo de B por prefijo de 8 y por hash completo: lista vacía. También al revés. Y `:id` con inyección SQL, comodines y path traversal. |
| C13 | Aislamiento estructural | `aislamiento-multitenant.test.js` | Un cliente sin dispositivos asignados recibe listas vacías y ceros, no error ni datos de otros. `demo` no ve dispositivos ya asignados a un municipio real. |
| C14 | Autenticación en los 8 endpoints | `autenticacion.test.js` | 8 endpoints × (sin token → 401; 7 variantes de token inválido → 401/403; token válido → 200) = 72 tests. Incluye prefijo del token válido, token con sufijo, inyección SQL y comodín `%`. |
| C15 | KPI sobre el total, no sobre una muestra (A011) | `agregaciones.test.js` | 400 conexiones recientes + 360 alarmas antiguas. `/summary` reporta 360; `/events` devuelve 30 filas que son puras conexiones. Si alguien vuelve a calcular los KPI desde `/events`, el test lo detecta. |
| C16 | `/heatmap` y `/export` tampoco truncados | `agregaciones.test.js` | 270 coordenadas y 360 filas de CSV sobre el mismo escenario de volumen. |
| C17 | Puntaje de riesgo: caída=3, SOS=2, batería excluida | `agregaciones.test.js` | Puntaje exacto, un dispositivo con 90 alarmas de batería que **no** aparece en el panel, orden descendente, límite 15, `ultima_alerta`. |
| C18 | Utilización diaria | `agregaciones.test.js` | Cuenta dispositivos únicos y no eventos; ignora los días que solo tienen alarmas. |
| C19 | Contrato del CSV (A012) | `aislamiento-multitenant.test.js` | BOM UTF-8 verificado a nivel de **bytes** (`EF BB BF`), encabezado exacto de `API.md`, `Content-Type` y `Content-Disposition`. |
| C20 | Bugs abiertos | `bugs-abiertos.test.js` | S03 y S04, en su forma correcta (`skip`) y en su forma actual (activa). |

---

## 5. Trazabilidad: hallazgos y aprendizajes contra tests

### 5.1 Aprendizajes (`docs/APRENDIZAJES.md`)

| ID | Aprendizaje | Cobertura |
|---|---|---|
| A001 | IP del gateway de Docker | ❌ Infraestructura. No testeable en unitario. |
| A002 | UFW bloqueaba Docker → host | ❌ Infraestructura. |
| A003 | `!` de bash rompe el XML de Traccar | ❌ Herramientas de despliegue, no código. |
| A004 | Clave `event.forward.url` | ❌ Configuración de Traccar. |
| A005 | Traccar envuelve el evento en `{event, position, device}` | ✅ Todo el helper `payloadTraccar()` usa esa forma exacta. `webhook.test.js` verifica que `body.event.type` y `body.event.attributes.alarm` sean las rutas correctas. |
| A006 | WhatsApp sin código `es_CL` | ❌ Configuración de Meta. |
| A007 | `better-sqlite3` necesita `build-essential` | ⚠️ Indirecto: la suite no corre si la dependencia no compila. `package.json` fija la dependencia. |
| A008 | PM2 con 1000+ reinicios | ⚠️ Indirecto y relevante: es la causa que convierte S04 en un incidente real. `bugs-abiertos.test.js` modela el reinicio. |
| A009 | `res.sendFile` no funcionaba | ✅ `autenticacion.test.js` verifica que `GET /dashboard` responda 200 con HTML. |
| A010 | Permisos de clave SSH en Windows | ❌ Infraestructura. |
| A011 | KPI sobre los últimos 100 eventos | ✅ **5 tests dedicados** en `agregaciones.test.js` ("regresión A011"). |
| A012 | CSV requiere BOM UTF-8 | ✅ `aislamiento-multitenant.test.js`, verificado a nivel de bytes. |
| A013 | Token de WhatsApp expira en silencio | ❌ Externo a `server.js`. Requiere un chequeo activo contra la API de Meta (sección 6). |
| A014 | `sed` que no coincide con el formato real | ❌ Proceso de despliegue. |
| A015 | Traccar usa camelCase en los tipos de alarma | ✅ **14 tests** en `normalizacion-alarmas.test.js`, incluyendo el test explícito "regresión A015". Los datos de prueba de la suite usan el formato de Traccar, no el del simulador: exactamente la regla general que dejó A015. |

### 5.2 Informe de arquitectura (H01–H20)

| ID | Hallazgo | Cobertura |
|---|---|---|
| H01 | Hash reversible por fuerza bruta | ⚠️ Documentado, no "verificado como correcto". Hay un test que deja constancia de que el hash se calcula sobre el `deviceId` correlativo y no sobre el IMEI. No se puede testear "es irreversible" porque no lo es. |
| H02 | Webhook sin manejo de errores, idempotencia ni reintento | ✅ Parcial: "Webhook — casos frágiles conocidos" documenta que un `alarm` numérico produce 500 (evento perdido) y que un evento duplicado se inserta dos veces. La ausencia de reintento no es testeable sin Traccar real. |
| H03 | Mover WhatsApp a `server.js` elimina la redundancia | ❌ Decisión de arquitectura futura. |
| H04 | No hay lugar para los datos de contacto | ❌ Funcionalidad inexistente. El test que congela el esquema de `events` avisará cuando se agreguen columnas. |
| H05 | Todo el tráfico sin cifrar, token en query string | ❌ No existe TLS. Documentado en `autenticacion.test.js` (el token viaja como query param en todos los tests, que es como funciona hoy). |
| H06 | Webhook acepta eventos de cualquier origen | ✅ Documentado: "POST /webhook no exige autenticación (S06)". |
| H07 | Sin índices; la migración de arranque recorre toda la tabla | ❌ Rendimiento. Requiere pruebas de carga en staging. |
| H08 | `/export` sin límite de filas | ⚠️ Parcial: se verifica que exporta 360 filas completas (correcto funcionalmente); el riesgo de memoria no se mide. |
| H09 | `demo` se apropia de los dispositivos no asignados | ✅ **2 tests `skip` + 2 tests activos** en `bugs-abiertos.test.js`. Ver sección 6.1. Es el mismo hallazgo que S04. |
| H10 | El rastro individual debilita la anonimización | ⚠️ Se verifica el aislamiento de `/dispositivo/:id`, no la decisión de producto de exponerlo. |
| H11 | Sin backups | ❌ Operaciones. |
| H12 | La analítica usa `created_at` y no `timestamp` | ✅ Test que documenta el comportamiento: un evento del 31 de mayo que llega el 15 de julio se contabiliza en julio. |
| H13 | Sin monitoreo de dispositivos silenciosos | ❌ Funcionalidad inexistente. **Es la brecha más grave sin cobertura posible**: ver sección 6.3. |
| H14 | Colisión de prefijos de 8 caracteres | ❌ No cubierto. Se necesitaría sembrar una colisión artificial; con los volúmenes actuales es poco probable, pero es un test que vale la pena si se agregan miles de dispositivos. |
| H15 | Dependencias del frontend desde CDN | ❌ Frontend. Fase Playwright. |
| H16 | Sin límite de peticiones | ❌ No existe la funcionalidad. |
| H17 | Sin registro de accesos | ❌ No existe la funcionalidad. |
| H18 | `/stats` ignora el filtro de fechas | ✅ Test que documenta el comportamiento: con y sin filtro devuelve lo mismo. |
| H19 | La documentación contradice al código | ✅ Parcial: los tests fijan el comportamiento real (formato del CSV, top 15 de `/riesgo`, 30 filas de `/events`, hash de 16 caracteres) y sirven de fuente de verdad frente a la documentación. |
| H20 | Sin `package.json`, sincronización a mano | ✅ **Resuelto en parte por este trabajo**: ahora hay `package.json` con dependencias declaradas y `package-lock.json`. La sincronización a mano con el VPS sigue igual. |

### 5.3 Informe de seguridad (S01–S18)

| ID | Hallazgo | Cobertura |
|---|---|---|
| S01 | Panel Traccar expuesto sin TLS | ❌ Fuera del código de `server.js`. |
| S02 | Ausencia de HTTPS | ❌ No implementado. |
| S03 | XSS almacenado vía webhook | ✅ **3 tests `skip` + 4 tests activos** en `bugs-abiertos.test.js`. Ver sección 6.1. |
| S04 | Reasignación a `demo` en cada arranque | ✅ **2 tests `skip` + 2 tests activos**. Ver sección 6.1. |
| S05 | Anonimización reversible | ⚠️ Igual que H01: documentado, no validado como correcto. |
| S06 | Webhook sin autenticación | ✅ Documentado en `autenticacion.test.js` y explotado en los tests de S03 (los payloads se inyectan sin credenciales). |
| S07 | Token en la query string | ❌ Es el diseño actual; los tests lo usan tal cual. |
| S08 | Token `demo-token-dev-only` publicado | ✅ Documentado: un test usa ese token literal para demostrar que ve datos de un municipio real tras un reinicio. |
| S09 | CDN sin SRI ni CSP | ❌ Frontend. |
| S10 | Sin rate limiting | ❌ No existe la funcionalidad. |
| S11 | Token de WhatsApp en texto plano | ❌ Fuera de `server.js`. |
| S12 | Base sin cifrar, sin backups, SSH root | ❌ Infraestructura. |
| S13 | `/events` devuelve el `device_hash` completo | ✅ Test que documenta que son 16 caracteres y no el prefijo de 8 que promete `PRIVACIDAD.md`. |
| S14 | Sin auditoría | ❌ No existe la funcionalidad. |
| S15 | Retención indefinida | ❌ No existe la funcionalidad. |
| S16 | Cumplimiento Ley 21.719 | ⚠️ Los tests de anonimización son evidencia técnica utilizable como parte de la base documental, pero el cumplimiento es un trabajo legal, no de testing. |
| S17 | `/dashboard` sin token | ✅ Documentado en `autenticacion.test.js`. |
| S18 | Pérdida de eventos si Node está caído | ❌ Requiere entorno de integración con Traccar. Es, junto con H13, la brecha más importante sin cobertura. |

### 5.4 Resumen de trazabilidad

- **Cubiertos con tests que verifican el comportamiento correcto:** A005, A009, A011, A012, A015, H20 (parcial), y los 8 endpoints en aislamiento y autenticación.
- **Cubiertos con tests que documentan un bug abierto:** S03/S04 (=H09), y T01 (defecto nuevo detectado durante este trabajo).
- **Cubiertos con tests que documentan el comportamiento actual sin juzgarlo:** H02, H06, H12, H18, S06, S08, S13, S17.
- **Sin cobertura posible hoy, por orden de importancia:** H13 y S18 (pérdida silenciosa de eventos y dispositivos silenciosos), H07/H08/S10 (rendimiento), S01/S02/H05 (TLS), H15/S09 (frontend), y todo lo que es infraestructura o funcionalidad todavía inexistente.

---

## 6. Bugs abiertos registrados en la suite

Los 6 tests marcados con `skip` expresan el comportamiento **correcto**. Hoy fallan. Se verificó ejecutándolos sin el `skip`: los 5 de S03/S04 fallan con los mensajes esperados.

Cada bug tiene además un test **activo** que fija el comportamiento defectuoso. Ese test es un detector de corrección: cuando alguien arregle el bug, empezará a fallar, y su mensaje dice explícitamente "si este assert empieza a fallar, el bug fue corregido: quitar los `.skip` de arriba".

### 6.1 Bugs con hallazgo asociado

| Test (`skip`) | Hallazgo | Qué debería pasar | Qué pasa hoy |
|---|---|---|---|
| `BUG ABIERTO S04: un reinicio NO debe entregarle a demo un dispositivo sin asignar` | S04 / H09 (Crítico) | Un dispositivo de reposición de Maipú, aún no asignado, sigue sin asignar tras un `pm2 restart`. | Queda con `client_id = 'demo'`, cuyo token está publicado en el repositorio. |
| `BUG ABIERTO S04: el municipio debe seguir viendo a esa persona tras el reinicio` | S04 / H09 (Crítico) | Maipú ve los eventos de ese dispositivo en `/events`. | No los ve. Un adulto mayor con caídas desaparece del panel de seguimiento. |
| `BUG ABIERTO S03: un alarm_type con HTML/JS no debe almacenarse` | S03 (Crítico) | `normalizeAlarm()` descarta lo que no está en la lista blanca. | Se almacena `<script>fetch(...)</script>` íntegro, solo pasado a minúsculas. |
| `BUG ABIERTO S03: solo deben persistirse tipos de alarma de la lista blanca` | S03 (Crítico) | Solo `sos`, `fall`, `low_battery`, `power_on`, `power_off`, `geofence_enter`, `geofence_exit`. | Se persiste cualquier cadena que llegue del webhook sin autenticar. |
| `BUG ABIERTO S03: la API no debe devolver al dashboard un alarm_type con etiquetas HTML` | S03 (Crítico) | `/events` no entrega contenido con etiquetas. | Lo entrega, y `dashboard.html` lo inserta con `innerHTML` sin escapar. |

Corregir S03 requiere **dos** cambios (lista blanca en `server.js` y `textContent` en `dashboard.html`); la suite solo puede verificar el primero, porque el segundo es frontend.

### 6.2 Defecto nuevo detectado durante este trabajo

| ID | Test (`skip`) | Descripción | Impacto hoy |
|---|---|---|---|
| **T01** | `latitud 0 debería guardarse como 0 y no como NULL` | `anonymize()` usa `position.latitude ? ... : null`. La coordenada `0` es falsy, así que se descarta como si no existiera. | Nulo en producción: Chile no cruza el ecuador ni el meridiano de Greenwich. Es un defecto latente que se activaría con cualquier despliegue fuera de Chile o con un GPS que reporte `0` al no tener fijación. La corrección es cambiar la comprobación por `!= null`. |

### 6.3 Riesgo mayor sin test posible

**H13 + S18 — la alerta que nunca llega.** Ningún test de esta suite puede detectar el peor escenario del sistema: que el dispositivo esté apagado, sin batería o sin cobertura, o que Node.js esté caído cuando Traccar reenvía el evento. Traccar no reintenta el webhook. Un evento perdido ahí no deja rastro en ninguna parte: no hay una fila que falte, porque nunca hubo fila.

En un sistema de alarmas de vida, esto no se resuelve con tests sino con diseño: un latido periódico por dispositivo, una alerta cuando un dispositivo lleva N horas en silencio, y una cola persistente entre Traccar y Node. Mientras eso no exista, la cobertura de tests puede ser del 100% y el sistema seguirá pudiendo perder una alarma sin que nadie se entere. Es la recomendación de producto más importante de este informe.

---

## 7. Qué haría falta para testear lo que hoy no es testeable

### 7.1 Integración real con Traccar (prioridad alta)

Necesario porque el contrato del webhook es una suposición: la suite usa la forma documentada en A005, pero si Traccar cambia de versión y modifica el nombre de un campo, nada lo detecta hasta que un municipio note que los KPI están en cero — exactamente el patrón de A015.

Qué haría falta:
- Un `docker-compose.yml` de pruebas con Traccar y el backend, en un entorno de staging.
- Un cliente que hable el protocolo `minifinder2` y simule un EV07B, o el simulador de dispositivos de Traccar.
- Un test que envíe una alarma por el protocolo real, espere el reenvío y verifique la fila en SQLite.
- Un test que apague el backend, envíe una alarma y mida cuántos eventos se pierden (validación empírica de S18).

### 7.2 Envío real por WhatsApp (prioridad media)

No hay código propio que testear mientras lo haga Traccar. Cuando `server.js` llame directamente a la API de Meta (plan de `CONTINUAR.md`), sí habrá qué testear: construcción de la plantilla, mapeo `device → contacto`, y sobre todo el manejo del token expirado de A013, que hoy falla en silencio. Ese caso se testea con un mock de la API de Meta que devuelva `{"error":{"code":190}}` y verificando que el sistema **grite** en vez de callar.

Aparte, hace falta un chequeo activo en producción —no un test— que consulte la validez del token contra Meta cada pocas horas y alerte antes de que caduque.

### 7.3 Hardware EV07B (prioridad media)

No es testeable por software. Necesita un protocolo de validación en terreno: caídas controladas sobre colchoneta para medir falsos negativos, caminatas para medir falsos positivos, duración real de batería, tiempo de fijación de GPS en interiores. Es un documento de QA de hardware, no una suite.

### 7.4 Dashboard en navegador (prioridad baja, fase 2 opcional)

**Playwright con Firefox** (nunca Chrome), sobre el proyecto que ya existe en `C:\Users\Mirna Arenas\mi-proyecto-playwright\`. No debe formar parte de `npm test`: es lenta, frágil y depende de un navegador instalado. Debe ser un script aparte (`npm run test:e2e`).

Qué cubriría que la suite base no cubre:
- Que el XSS de S03 **se ejecute** de verdad en el navegador (prueba definitiva del hallazgo, y verificación real de la corrección con `textContent`).
- Que los KPI que se ven en pantalla coincidan con lo que devuelve `/summary` (regresión visual de A011).
- Que un token inválido muestre un error entendible y no una página en blanco.
- Que el mapa, el heatmap y los gráficos rendericen sin errores de consola.
- Que las dependencias de CDN carguen (H15/S09).

### 7.5 Rendimiento (prioridad baja hoy, alta al llegar a 500 dispositivos)

Con 100 dispositivos simulados no hay problema. Con 500 dispositivos reales de varios municipios, H07 (sin índices), H08 (`/export` completo en memoria) y S10 (sin rate limiting) se vuelven reales. Requiere un entorno de staging con volumen realista y una herramienta de carga; no tiene sentido medirlo en la máquina de desarrollo.

---

## 8. Cómo correr la suite (Windows)

Desde PowerShell, en la raíz del repositorio:

```powershell
cd "C:\Users\Mirna Arenas\OneDrive\SimpleCare\PWA\simplecare-iot"

# Una sola vez: instalar dependencias
npm install

# Correr toda la suite
npm test

# Con detalle de cada test (nombre y duración)
npm run test:verbose

# Un solo archivo
node --test tests\aislamiento-multitenant.test.js

# Filtrar por nombre
node --test --test-name-pattern "A011" "tests\**\*.test.js"

# Comprobar que los bugs abiertos siguen abiertos (los 5 tests deben FALLAR).
# El `.skip` está en el código, así que hay que quitarlo en una copia temporal:
(Get-Content tests\bugs-abiertos.test.js) -replace 'test\.skip\(', 'test(' |
  Set-Content -Encoding utf8 tests\zz-temporal.test.js
node --test tests\zz-temporal.test.js
Remove-Item tests\zz-temporal.test.js
```

Requisitos: Node.js 20 o superior (probado en 24.18.0) y las dependencias `express` y `better-sqlite3`, que ya son las del servidor. `better-sqlite3` se instala con binario precompilado en Windows; en Linux puede requerir `build-essential` (A007).

La suite escribe en directorios temporales del sistema (`%TEMP%\simplecare-test-*`) y los borra al terminar. **No toca `/opt/simplecare/events.db` ni el VPS.**

### Estructura

```
tests/
├── ayuda/
│   ├── servidor.js                    # arranque aislado, helpers HTTP y de datos
│   └── datos.js                       # escenario multi-tenant compartido
├── webhook.test.js                    # ingesta y robustez
├── anonimizacion.test.js              # hash, GPS, datos personales
├── normalizacion-alarmas.test.js      # A015 y migración idempotente
├── autenticacion.test.js              # 401 / 403 / 200 en los 8 endpoints
├── aislamiento-multitenant.test.js    # fugas entre municipios
├── agregaciones.test.js               # A011, puntaje de riesgo, utilización
└── bugs-abiertos.test.js              # S03 y S04
```

### Resultado de la ejecución (26 de julio de 2026)

```
ℹ tests 189
ℹ suites 31
ℹ pass 183
ℹ fail 0
ℹ skipped 6
ℹ duration_ms 9607
```

Los 6 `skip` son los bugs abiertos de la sección 6. Ejecutados sin `skip`, los 5 de S03/S04 fallan con el mensaje esperado, lo que confirma que el bug está presente y que el test lo detecta.

---

## 9. Recomendación sobre integración continua

### 9.1 Qué automatizar y cuándo

El repositorio es privado y de un solo desarrollador. No hace falta una plataforma compleja. La recomendación tiene tres niveles, en orden de implementación:

**Nivel 1 — antes de cada copia al VPS (hacer ya).**
`CONTINUAR.md` dice que cada cambio en `server.js` se copia al VPS y se comitea. Ese es el momento exacto en que la suite tiene que correr. Basta con la disciplina de ejecutar `npm test` antes de copiar, y no copiar si algo falla. Si conviene, un hook de Git local (`pre-push`) que corra `npm test` lo automatiza sin infraestructura.

**Nivel 2 — GitHub Actions en cada push (recomendado, esfuerzo bajo).**
El repositorio ya está en GitHub. Un workflow mínimo:

```yaml
name: tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: sudo apt-get install -y build-essential python3   # A007
      - run: npm ci
      - run: npm test
```

Es de bajo costo (repositorio privado, minutos gratuitos suficientes para una suite de 10 segundos) y cubre el riesgo más real de este proyecto: que se edite `server.js` directamente en el VPS y el espejo del repositorio quede desincronizado (H20). Si la suite corre en cada push, al menos el código versionado está siempre verificado.

**Nivel 3 — verificación posterior al despliegue (cuando haya un municipio real).**
Los tests verifican el código, no el VPS. Falta una comprobación de humo contra producción después de cada `pm2 restart`: que `/dashboard` responda, que `/summary` con el token de cada municipio devuelva números coherentes, y —crítico dado S04— **que los dispositivos de cada municipio sigan asignados a su municipio**. Esto último puede ser un script de una línea contra la base, ejecutado tras cada reinicio, hasta que S04 esté corregido.

### 9.2 Reglas de trabajo sugeridas

1. **Cada bug de producción nuevo entra primero como test.** Es lo que este proyecto ya hace con `APRENDIZAJES.md`, pero en prosa: A011 y A015 estaban documentados y aun así no había nada que impidiera que volvieran. Un aprendizaje sin test es una nota; con test es una barrera.
2. **Los datos de prueba se generan con el formato exacto de la fuente real.** Es la regla general que dejó A015 y la suite la respeta: los payloads usan camelCase como Traccar, no snake_case como el simulador.
3. **No se quita un `skip` sin corregir el bug**, y no se corrige un bug sin quitar el `skip` correspondiente y borrar su test de "comportamiento actual".
4. **La suite es la fuente de verdad frente a la documentación.** H19 señala que los documentos se contradicen entre sí y con el código. Cuando haya discrepancia, gana el test, y se corrige el documento.

---

## 10. Conclusión

El proyecto pasó de cero tests a 189, con los cuatro riesgos críticos cubiertos y los dos hallazgos críticos de seguridad —S03 y S04— registrados de forma ejecutable en vez de solo documentados.

Tres cosas que este trabajo dejó claras y que no dependen de más tests:

1. **S04 debe corregirse antes del primer municipio real.** La suite lo demuestra en 30 líneas: un dispositivo de reposición cae en `demo` en el siguiente reinicio, el municipio deja de verlo, y el token de `demo` está publicado. La corrección es de tres líneas.
2. **S03 es explotable desde internet sin credenciales** y la suite ya inyecta el payload por el webhook sin autenticarse. Requiere dos correcciones: lista blanca en el backend y `textContent` en el dashboard.
3. **El peor fallo posible del sistema no tiene test posible** (H13/S18): la alarma que nunca llega porque el dispositivo está en silencio o Node estaba caído. Eso se resuelve con latido, alerta por silencio prolongado y una cola persistente. Ninguna suite de pruebas lo sustituye.
