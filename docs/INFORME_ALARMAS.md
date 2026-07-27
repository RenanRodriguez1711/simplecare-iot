# Informe de alarmas — SimpleCare IoT

**Fecha:** 2026-07-26
**Alcance:** comparación entre las alarmas que soporta Traccar, las que efectivamente decodifica el protocolo `minifinder2`, las que el hardware Eview EV-07B declara emitir, y las que el sistema SimpleCare captura, guarda y muestra.
**Archivos analizados:** `server/server.js`, `server/dashboard.html`, `docs/APRENDIZAJES.md` (A015), `docs/ARQUITECTURA.md`, `docs/API.md`.

> Nota metodológica: todo lo referido a Traccar está verificado leyendo el código fuente de la rama `master` del repositorio oficial. Lo referido al hardware EV-07B proviene de material comercial del fabricante y de plataformas telemáticas de terceros; el manual técnico y el documento de protocolo del fabricante devolvieron HTTP 403 y no se pudieron leer, así que varias filas del hardware quedan marcadas como **no confirmado** a propósito.

---

## 1. Resumen ejecutivo

El protocolo `minifinder2` decodifica **nueve** tipos de alarma. El sistema SimpleCare muestra **tres**. Las seis restantes llegan al webhook, se anonimizan, se normalizan correctamente y se guardan en `events.db` — pero **ninguna API del backend las devuelve** y **ninguna aparece en el dashboard**. Están, literalmente, invisibles en la base de datos.

Las seis alarmas ciegas son: `powerOff`, `powerOn`, `movement`, `overspeed`, `geofenceEnter` y `geofenceExit` (estas dos últimas en su versión emitida por el dispositivo, distinta de las geocercas que calcula Traccar).

Por qué importa, en orden de impacto para el negocio:

1. **`powerOff` es la alarma más grave que hoy se ignora.** Un dispositivo apagado es un adulto mayor sin protección. Hoy no genera KPI, no aparece en la tabla, no suma al puntaje de riesgo y no se puede exportar. Combinado con `lowBattery` —que sí se guarda y se cuenta pero **no aporta al puntaje de riesgo**— el sistema no tiene ninguna métrica de "cobertura efectiva": no sabe cuántas personas están realmente protegidas en este momento.

2. **La detección de inactividad ("No Motion Alarm") del EV-07B no llega nunca.** El fabricante la publicita como una de las funciones centrales del producto para adultos mayores, pero el decodificador `Minifinder2ProtocolDecoder` de Traccar **no mapea ningún bit a una alarma de inactividad**. Si el dispositivo la emite, viaja dentro del bitmask crudo y Traccar la descarta como alarma. Es la brecha más valiosa desde el punto de vista clínico y la única que no se resuelve tocando código de SimpleCare.

3. **`geofenceExit` emitido por el dispositivo se descarta parcialmente.** El EV-07B tiene geocercas propias configuradas en el firmware. Cuando las dispara, Traccar las entrega como `event.type = "alarm"` con `attributes.alarm = "geofenceExit"` — un camino distinto al de las geocercas que dibuja el operador en Traccar (`event.type = "geofenceExit"`). El primero se guarda pero es invisible; el segundo se guarda pero solo aparece en la tabla de últimos eventos. Para un adulto mayor con deterioro cognitivo, salir de la zona segura es una señal de riesgo de primer orden.

4. **`deviceInactive` de Traccar no se guarda en absoluto.** El filtro `relevantes` del webhook no lo incluye. Es el evento que Traccar genera cuando un dispositivo lleva días sin reportar — la señal más directa de que un cliente dejó de estar cubierto.

5. **El puntaje de riesgo mide solo dos de las nueve señales disponibles** y mezcla mal los conceptos: una persona con seis alarmas de batería baja y un dispositivo apagado tres veces en el mes tiene puntaje 0 y no aparece en el panel de seguimiento.

Punto positivo verificado: la normalización implementada tras A015 es correcta y cubre los casos reales. El riesgo teórico de que Traccar entregue varias alarmas concatenadas por coma (`"sos,fallDown"`) **no se materializa en el webhook**, porque `AlarmEventHandler` separa el string y emite un evento por alarma. Ver sección 5.

---

## 2. Tabla comparativa maestra

Columna "guarda hoy": el webhook guarda cualquier alarma que llegue con `event.type = "alarm"`, así que la respuesta depende solo de si el evento llega. Columna "muestra hoy": si alguna API del backend la devuelve y el dashboard la representa.

| Nombre en Traccar (exacto) | Valor normalizado en la DB | minifinder2 | Hardware EV-07B | Se guarda hoy | Se muestra hoy | Fuente |
|---|---|---|---|---|---|---|
| `sos` | `sos` | **Sí** (bit 12) | **Sí** — "Large SOS button", "one-touch SOS" | Sí | **Sí** | Decoder L191; eviewconnect.com |
| `fallDown` | `fall` (alias) | **Sí** (bit 2) | **Sí** — "Fall Alarm", 70+% precisión | Sí | **Sí** | Decoder L169; eviewgps.com |
| `lowBattery` | `low_battery` | **Sí** (bit 0) | **Sí** — "Low Battery Alert: voice prompts, SMS and TCP messages" | Sí | **Sí** (KPI, chip, export) | Decoder L163; eviewgps.com |
| `powerOff` | `power_off` | **Sí** (bit 8) | **Sí** — flespi lista "Power on/off events", "shutdown alarm" | Sí | **No** | Decoder L182; flespi.com |
| `powerOn` | `power_on` | **Sí** (bit 9) | **Sí** — confirmado en producción (llegó del dispositivo de prueba) | Sí | **No** | Decoder L185; datos de producción |
| `movement` | `movement` | **Sí** (bit 10) | **Sí** — "motion/shock alarm" | Sí | **No** | Decoder L188; gps-trace.com |
| `overspeed` | `overspeed` | **Sí** (bit 1) | **Sí** — flespi lista "Overspeeding detection" | Sí | **No** | Decoder L166; flespi.com |
| `geofenceEnter` | `geofence_enter` | **Sí** (bits 4-7 + 26-29) | **Sí** — "alerts when entering or leaving a particular area" | Sí | **No** | Decoder L174; eviewgps.com |
| `geofenceExit` | `geofence_exit` | **Sí** (bits 4-7) | **Sí** — ídem | Sí | **No** | Decoder L176; eviewgps.com |
| `removing` | `removing` | **No** | **No confirmado** — no hay fuente que documente detección de retiro; el EV-07B es colgante/clip, no pulsera (el modelo pulsera es el EV-07W) | No (nunca llega) | No | Position.java L153; ausente del decoder |
| `tampering` | `tampering` | **No** | No confirmado | No | No | Position.java L152; ausente del decoder |
| `idle` | `idle` | **No** | **Sí, el hardware la tiene** — "No Motion Alarm: no motion for a long time" — pero el decoder no la mapea | **No (se pierde)** | No | Position.java L137; eviewgps.com |
| `general` | `general` | No | n/a | No | No | Position.java L116 |
| `vibration` | `vibration` | No | No confirmado | No | No | Position.java L118 |
| `lowPower` | `low_battery` (alias) | **No** — minifinder2 usa `lowBattery`, no `lowPower` | n/a | No (nunca llega) | n/a | Position.java L123; ausente del decoder |
| `accident` | `accident` | No | No confirmado | No | No | Position.java L135 |
| `fault` | `fault` | No | No confirmado | No | No | Position.java L125 |
| `powerCut` / `powerRestored` | `power_cut` / `power_restored` | No | No confirmado | No | No | Position.java L144-145 |
| `jamming` | `jamming` | No | No confirmado | No | No | Position.java L146 |
| `geofence` (genérica) | `geofence` | No | n/a | No | No | Position.java L131 |
| Resto de constantes `ALARM_*` (`door`, `lock`, `unlock`, `tow`, `highRpm`, `hardAcceleration`, `hardBraking`, `hardCornering`, `laneChange`, `fatigueDriving`, `temperature`, `parking`, `bonnet`, `footBrake`, `fuelLeak`, `gpsAntennaCut`, `lowspeed`) | — | No | No — son alarmas vehiculares | No | No | Position.java L116-153 |

**Total de constantes `ALARM_*` en Traccar: 38.** **Soportadas por `minifinder2`: 9.**

### Atributos que el decoder marca pero que NO son alarmas

Estos no viajan en `attributes.alarm` y por lo tanto **nunca entran al sistema por la ruta actual**, aunque son informativos:

| Atributo | Bit / origen | Utilidad potencial |
|---|---|---|
| `button1` | bit 13 del bitmask 0x02 | Botón secundario del dispositivo |
| `button2` | bit 14 | Botón terciario |
| `bark` | bit 31 | Función de mascotas, irrelevante aquí |
| `event` (`Position.KEY_EVENT`) | **el bitmask completo de 32 bits, crudo** | **Contiene los bits que el decoder no mapea** (3, 11, 15-25, 30). Aquí podría venir la alarma de inactividad. |
| `battery` / `batteryLevel` | clave 0x14 y 0x24 | Permitiría umbrales propios de batería sin depender de la alarma |
| `motion` (`KEY_MOTION`) | bit 9 del status 0x24 | Booleano de movimiento por posición — base alternativa para detectar inactividad prolongada del lado del servidor |
| `charge` | bit 4 del status 0x24 | Indica si está cargando |

---

## 3. Brechas detectadas

### Categoría A — Alarmas que llegan y se guardan, pero no se muestran

**A1. `power_off` invisible — severidad ALTA.**
Un dispositivo apagado deja de proteger. El evento llega, se guarda, y no existe para el dashboard: `/summary` no lo cuenta, `/events` lo filtra por whitelist, `/heatmap` lo excluye, `/export` lo omite y `/riesgo` lo puntúa en 0. Impacto concreto: el municipio no puede detectar a la persona cuyo dispositivo se apaga todas las noches, que es exactamente el patrón de un usuario que no adhirió al producto.

**A2. `geofence_exit` / `geofence_enter` (versión dispositivo) invisibles — severidad ALTA.**
Salida de zona segura en un adulto mayor con deterioro cognitivo es una alerta de primer nivel. Hoy la fila existe en la DB con `event_type = 'alarm'` y `alarm_type = 'geofence_exit'`, y ninguna consulta la busca.

**A3. `power_on` invisible — severidad MEDIA.**
Por sí sola es ruido, pero emparejada con `power_off` da el dato de negocio más importante que hoy falta: **tiempo de cobertura efectiva** (cuántas horas al día el dispositivo estuvo encendido). Ya se confirmó que llega en producción.

**A4. `movement` invisible — severidad BAJA.**
Alto volumen y bajo valor clínico. Recomendación: guardarla pero no exponerla como KPI (ver sección 6).

**A5. `overspeed` invisible — severidad BAJA / posible ruido.**
Se dispara si la persona va en auto o bus. Sin valor para el caso de uso; conviene decidir explícitamente si se filtra en el webhook para no inflar la tabla.

**A6. `low_battery` se muestra pero no pondera riesgo — severidad MEDIA.**
Tiene KPI, chip y export, pero el `SUM(CASE...)` de `/riesgo` la ignora y el `HAVING puntaje > 0` elimina de la tabla a cualquier persona cuyas únicas alarmas sean de batería. Una persona con quince alarmas de batería baja en el mes no aparece en "Personas que requieren seguimiento", cuando es justamente alguien a quien hay que ir a visitar.

**A7. El modal individual etiqueta mal cualquier tipo nuevo — severidad MEDIA (latente).**
En `dashboard.html` el modal usa `e.alarm_type === 'sos' ? SOS : Caída`. Cualquier alarma distinta de `sos` se pinta naranja y se rotula **"Caída"**. Hoy no se nota porque `/dispositivo/:id` solo trae filas con coordenadas y en la práctica son SOS y caídas; en cuanto se amplíen los tipos, el mapa individual mostrará caídas falsas. Es un error de datos mostrado al municipio, no solo un tema estético.

### Categoría B — Alarmas que el dispositivo puede emitir pero el sistema descarta o pierde

**B1. Inactividad prolongada ("No Motion") — severidad ALTA, y la más difícil.**
El fabricante la lista como función central ("No Motion Alarm — no motion for a long time"), pero `Minifinder2ProtocolDecoder` no la mapea a ninguna constante `ALARM_*`. La pérdida ocurre **dentro de Traccar**, antes del webhook. No se arregla en `server.js`. Opciones, en orden de esfuerzo:
- Leer `position.attributes.event` (el bitmask crudo de 32 bits) y decodificar los bits no mapeados. Requiere el documento de protocolo del fabricante, que no se pudo obtener.
- Derivarla del lado del servidor a partir de `attributes.motion` (booleano por posición) o de la ausencia de posiciones con movimiento. Es la vía viable sin documentación.
- Usar el evento nativo `deviceStopped` de Traccar, que hoy tampoco se guarda.

**B2. `deviceInactive` de Traccar no se guarda — severidad ALTA.**
Ver sección 4.

**B3. Detección de retiro del dispositivo — no aplica, y conviene dejarlo escrito.**
El enunciado del encargo menciona "retiro de la muñeca". Verificado: `minifinder2` **no** decodifica `ALARM_REMOVING` ni `ALARM_TAMPERING`, y no se encontró ninguna fuente que documente detección de retiro en el EV-07B. El EV-07B es un dispositivo colgante/clip de ~40 g; el modelo tipo reloj de la misma familia es el EV-07W. **Conclusión: esta alarma no está disponible por esta vía y no debe planificarse.** Si el retiro del dispositivo es un requisito de producto, hay que resolverlo por hardware distinto, no por software.

### Categoría C — Nombres que el sistema busca y que nunca van a llegar

**C1. El alias `lowPower` → `low_battery` es código muerto para este hardware.**
`minifinder2` emite `lowBattery` (bit 0), nunca `lowPower`. El alias no hace daño y da robustez si algún día se conecta otro protocolo, pero el comentario del código (`"batería baja tiene dos nombres según el firmware"`) sugiere una incertidumbre que ya está resuelta: **con `minifinder2` siempre es `lowBattery`**. Conviene anotarlo para no volver a investigarlo.

**C2. `fall` no es un nombre de Traccar.**
Es un nombre interno de SimpleCare, heredado de los datos simulados. Existe únicamente porque el alias `fallDown → fall` lo produce. No es un problema —es una decisión de nomenclatura válida— pero `docs/API.md` lo documenta como si fuera un "tipo de alarma" de Traccar y eso induce a error. Traccar nunca envía `fall`.

**C3. `docs/API.md` está desactualizado.**
Declara "Tipos de alarma: `sos`, `fall`, `low_battery`" y el schema comenta `alarm_type TEXT -- 'sos' | 'fall' | 'low_battery' | NULL`. En la DB hoy ya conviven `power_on` y, potencialmente, otros seis valores. La documentación describe el filtro, no la realidad de los datos.

---

## 4. Análisis del filtro `relevantes` en `/webhook`

```js
const relevantes = ['alarm', 'geofenceEnter', 'geofenceExit', 'deviceOffline', 'deviceOnline'];
```

El filtro opera sobre `event.type`, que en Traccar tiene 22 valores posibles (`Event.java`). Evaluación de los 17 que se descartan:

| Tipo de evento descartado | ¿Debería guardarse? | Razón |
|---|---|---|
| `deviceInactive` | **Sí, prioritario** | Traccar lo emite cuando el dispositivo lleva días sin reportar. Es la señal canónica de "este cliente dejó de estar cubierto". Hoy se pierde por completo. |
| `deviceStopped` / `deviceMoving` | **Sí, evaluar** | Única vía nativa de Traccar para aproximar inactividad prolongada (brecha B1) sin depender del bitmask del fabricante. Ojo con el volumen: puede ser alto. |
| `deviceUnknown` | Sí, con bajo peso | Dispositivo no registrado intentando conectarse: típicamente una unidad recién despachada sin dar de alta. Valor operacional, no clínico. |
| `commandResult`, `queuedCommandSent` | No | Ruido técnico. |
| `deviceOverspeed` | No | Duplicaría la alarma `overspeed`, que ya se descartó por irrelevante. |
| `deviceFuelDrop`, `deviceFuelIncrease`, `ignitionOn`, `ignitionOff`, `maintenance`, `driverChanged`, `highRpm` y demás vehiculares | No | El EV-07B no los genera. |
| `proximityEnter`, `proximityExit`, `unaccompaniedMotion` | No por ahora | Dependen de balizas BLE. El EV-07B soporta beacons, así que podrían ser útiles a futuro (detectar si la persona está en casa), pero requieren infraestructura adicional. |
| `textMessage`, `media` | No | Sin uso en este producto. |

**Veredicto: el filtro descarta un evento crítico (`deviceInactive`) y dos potencialmente valiosos (`deviceStopped` / `deviceMoving`). El resto de las exclusiones está bien.**

Dos observaciones adicionales sobre el handler:

- El filtro es una lista blanca fija en código. Cada tipo nuevo exige un deploy. Dado que el costo de almacenamiento es despreciable (~5 KB por dispositivo/mes según `ARQUITECTURA.md`), sería más robusto invertir la lógica: **guardar todo excepto una lista negra de ruido conocido**. Un evento no guardado se pierde para siempre; uno guardado de más se filtra en la consulta.
- `anonymize()` no preserva ningún atributo del evento. En particular se descartan `batteryLevel`, `motion`, `charge` y el bitmask crudo `event` — precisamente los datos que harían falta para cerrar la brecha B1. Agregar una columna `attributes TEXT` con un subconjunto explícito y no identificatorio (nivel de batería, booleano de movimiento, bitmask) no compromete el modelo de anonimización, que se sostiene sobre el hash del `deviceId` y el redondeo de coordenadas.

---

## 5. Análisis de `ALARM_ALIASES` y `normalizeAlarm()`

```js
const ALARM_ALIASES = {
  fallDown: 'fall',
  lowPower: 'low_battery',
};

function normalizeAlarm(alarm) {
  if (!alarm) return null;
  if (ALARM_ALIASES[alarm]) return ALARM_ALIASES[alarm];
  return alarm.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}
```

### Verificación contra las 9 alarmas reales de `minifinder2`

| Entrada real | Salida de `normalizeAlarm` | ¿Correcta? |
|---|---|---|
| `sos` | `sos` | Sí |
| `fallDown` | `fall` (alias) | Sí |
| `lowBattery` | `low_battery` | Sí |
| `powerOff` | `power_off` | Sí |
| `powerOn` | `power_on` | Sí |
| `movement` | `movement` | Sí |
| `overspeed` | `overspeed` | Sí |
| `geofenceEnter` | `geofence_enter` | Sí |
| `geofenceExit` | `geofence_exit` | Sí |

**La normalización cubre correctamente el 100% de los casos reales de este protocolo.** El regex camelCase → snake_case es genérico y bien construido.

### Riesgos residuales

**R1 — Alarmas múltiples concatenadas: riesgo verificado como NO aplicable.**
`Position.addAlarm()` concatena con coma cuando hay varias alarmas en la misma posición (`"sos,fallDown"`). Si ese string llegara al webhook, `normalizeAlarm` produciría `"sos,fall_down"`, un valor que ninguna consulta encuentra — repitiendo exactamente el bug A015. Sin embargo, `AlarmEventHandler` hace `alarmString.split(",")` y **emite un evento separado por cada alarma**, cada uno con un valor único en `event.attributes.alarm`. El webhook recibe valores atómicos.

Esto es relevante porque en `minifinder2` las alarmas **sí llegan juntas**: son bits de un mismo entero de 32 bits, así que una caída con batería baja simultánea activa dos bits en el mismo mensaje. La protección viene de Traccar, no de SimpleCare. Un `String(alarm).split(',')` defensivo en el webhook costaría una línea y eliminaría la dependencia de un comportamiento aguas arriba que podría cambiar entre versiones de Traccar.

**R2 — El alias `fallDown → fall` renombra semánticamente y no es reversible.**
`normalizeAlarm` no es inyectiva en el sentido de que no se puede reconstruir el nombre Traccar original desde la DB. No es un bug hoy, pero conviene que el mapeo inverso quede documentado en `API.md`.

**R3 — `overspeed` y `lowspeed` son nombres irregulares en Traccar.**
`ALARM_OVERSPEED = "overspeed"` y `ALARM_LOW_SPEED = "lowspeed"` (todo minúscula, sin camelCase interno). El regex los deja intactos, lo cual es correcto, pero rompe la simetría: `low_battery` lleva guion bajo y `lowspeed` no lo llevaría. Solo importa si alguna vez se agrega `lowspeed`, que no es el caso.

**R4 — Los `event_type` no se normalizan.**
`event_type` conserva camelCase (`deviceOnline`, `geofenceEnter`) mientras `alarm_type` está en snake_case. Es una inconsistencia deliberada y funciona, pero significa que la misma geocerca aparece como `geofence_enter` si la disparó el dispositivo y como `geofenceEnter` si la calculó Traccar. Cualquier consulta futura sobre geocercas tiene que buscar ambas formas. Vale la pena dejarlo escrito antes de que se convierta en el próximo A015.

**R5 — El backfill de arranque es correcto pero silencioso ante colisiones.**
El bucle de normalización al iniciar el servidor es idempotente, como declara A015. Un detalle: si existieran filas con `fall` (simuladas) y filas con `fallDown` (reales), el `UPDATE` fusiona ambas en `fall` sin registrar la fusión más allá de un `console.log`. Es el comportamiento deseado, pero no queda traza en la DB de qué filas eran originalmente de qué formato.

### Alias que faltan

Ninguno es necesario para `minifinder2`. Si el catálogo se amplía a otros dispositivos, los candidatos serían `lowPower → low_battery` (ya está) y `powerCut → power_off`. **No agregar alias especulativos**: cada alias es una traducción que oculta el nombre real y dificulta el diagnóstico, como quedó demostrado en A015.

---

## 6. Recomendaciones

### 6.1 Alarmas a incorporar al dashboard

Prioridad 1 — **`power_off` + `power_on` como métrica de cobertura.**
No agregar un chip más. Agregar una tarjeta KPI **"Dispositivos apagados en el período"** y, si se guarda el par encendido/apagado, un indicador de horas de cobertura. Es la métrica que un municipio necesita para justificar la renovación del contrato: no "cuántas emergencias hubo", sino "cuántas personas estuvieron efectivamente protegidas".

Prioridad 2 — **`geofence_exit` como chip y como capa del mapa.**
Chip "🚪 Salida de zona" junto a los tres existentes. Requiere unificar en la consulta las dos rutas de geocerca: `alarm_type = 'geofence_exit'` (dispositivo) y `event_type = 'geofenceExit'` (Traccar).

Prioridad 3 — **`deviceInactive` como alerta operacional destacada.**
No es una alarma clínica sino un aviso de servicio. Merece un lugar propio en la interfaz: "Dispositivos sin reportar hace más de N días", con lista de IDs anónimos. Es accionable de inmediato para el municipio.

No incorporar por ahora: `movement` (volumen alto, valor clínico bajo — guardarla, no mostrarla) y `overspeed` (irrelevante para el caso de uso; evaluar filtrarla en el webhook para no ensuciar la tabla).

### 6.2 Cambio estructural previo: eliminar la whitelist duplicada

El literal `['sos','fall','low_battery']` está repetido **cuatro veces** en `server.js` (`/events` L139, `/heatmap` L178-179, `/export` L265-266, y de forma implícita en `/summary` L164-168). Cada tipo nuevo obliga a tocar los cuatro y basta olvidar uno para reintroducir el bug de A015 en una sola pantalla. Extraerlo a una constante única —por ejemplo `TIPOS_VISIBLES`— es requisito previo a cualquier ampliación. El mismo valor está además duplicado en `dashboard.html` (L194, L200, L205), donde idealmente debería llegar desde el backend en lugar de estar hardcodeado en el cliente.

### 6.3 Alias a agregar

**Ninguno.** El diccionario actual es correcto y suficiente. Lo que sí corresponde es documentar en `ALARM_ALIASES` que `lowPower` no se produce con `minifinder2` (el comentario actual sugiere una ambigüedad ya resuelta) y agregar el `split(',')` defensivo descrito en R1.

### 6.4 Puntaje de riesgo

El puntaje actual (`fall = 3`, `sos = 2`) mezcla dos preguntas distintas en un solo número: *¿esta persona está en riesgo?* y *¿este dispositivo está funcionando?*. Recomendación: **separarlas en dos columnas**.

**Columna A — Riesgo de la persona** (mantiene la semántica actual del panel):

| Alarma | Puntos | Justificación |
|---|---|---|
| `fall` | 3 | Se mantiene. Evento clínico objetivo. |
| `sos` | **3** (hoy 2) | Subir. Una pulsación de SOS es una petición deliberada de ayuda de la propia persona; tiene al menos tanto valor de señal como una caída detectada por algoritmo, que además tiene ~70% de precisión según el fabricante. |
| Inactividad prolongada | 3 | Cuando se resuelva la brecha B1. Peso equivalente a una caída: la persona en el suelo sin poder pulsar el botón es el escenario que este producto existe para cubrir. |
| `geofence_exit` | 2 | Salida de zona segura. |
| `movement` | 0 | Se guarda, no puntúa. |
| `overspeed` | 0 | Se guarda o se descarta, no puntúa. |

**Columna B — Estado del dispositivo** (nueva, no suma al riesgo de la persona):

| Señal | Puntos |
|---|---|
| `power_off` | 3 |
| `deviceInactive` | 3 |
| `low_battery` | 1 |

Justificación de la separación: si `power_off` y `low_battery` suman al mismo número que `fall` y `sos`, el panel "Personas que requieren seguimiento" se llenará de casos de batería —que son los más frecuentes por lejos— y sepultará las emergencias reales. Son dos flujos de trabajo distintos: la columna A la atiende un profesional de salud o social; la columna B la atiende soporte técnico o quien va a cambiar el cargador. Ambas son valiosas; mezclarlas destruye las dos.

Además, **eliminar el `HAVING puntaje > 0`** o reemplazarlo por `HAVING puntaje_persona > 0 OR puntaje_dispositivo > 0`, para que las personas con solo problemas de dispositivo dejen de ser invisibles.

### 6.5 Correcciones puntuales

1. **`dashboard.html`, modal individual:** reemplazar el ternario `alarm_type === 'sos' ? SOS : Caída` por un mapa explícito tipo → (color, etiqueta), con un caso por defecto neutro. Hoy es un error latente que mostrará caídas inexistentes al municipio en cuanto se amplíen los tipos.
2. **`docs/API.md`:** actualizar la línea "Tipos de alarma: `sos`, `fall`, `low_battery`" y el comentario del schema `alarm_type`, que ya no reflejan lo que hay en la DB.
3. **`docs/ARQUITECTURA.md`:** la sección del dispositivo dice "Eventos que emite: SOS, caída detectada, batería baja, conexión/desconexión". Son nueve, no cuatro.
4. **`server.js`, `anonymize()`:** conservar `batteryLevel`, `motion` y el bitmask `event` en una columna de atributos. Sin ellos, la brecha B1 no se puede cerrar por análisis de datos históricos.
5. **Obtener el documento de protocolo de Eview.** Es el único camino para saber qué significan los bits 3, 11, 15-25 y 30 del bitmask, y por tanto si la alarma de inactividad está realmente ahí. Las fuentes públicas están bloqueadas (HTTP 403); hay que pedirlo al proveedor.

---

## 7. Fuentes consultadas

**Código fuente de Traccar (rama `master`, verificado línea por línea):**
- `Position.java` — las 38 constantes `ALARM_*` y el método `addAlarm()`: https://raw.githubusercontent.com/traccar/traccar/master/src/main/java/org/traccar/model/Position.java
- `Minifinder2ProtocolDecoder.java` — mapeo de bits a alarmas (clave 0x02, líneas 160-206): https://raw.githubusercontent.com/traccar/traccar/master/src/main/java/org/traccar/protocol/Minifinder2ProtocolDecoder.java
- `Event.java` — los 22 tipos de evento: https://raw.githubusercontent.com/traccar/traccar/master/src/main/java/org/traccar/model/Event.java
- `AlarmEventHandler.java` — separación de alarmas múltiples por coma: https://raw.githubusercontent.com/traccar/traccar/master/src/main/java/org/traccar/handler/events/AlarmEventHandler.java

**Hardware Eview EV-07B:**
- Ficha del fabricante (mPERS) — "Fall Alarm", "No Motion Alarm", "Low Battery Alert", geocercas: https://eviewgps.com/mobile/ev07b
- Página de producto Eview Connect — "No Motion Alarms and one-touch SOS", geo-fence alerts: https://www.eviewconnect.com/product/ev-07b/
- flespi — listado de tipos de alarma y evento soportados (power on/off, overspeed, tilt, beacon, shutdown alarm): https://flespi.com/devices/eview-ev-07b
- GPS-Trace — "motion/shock alarm, elderly falling": https://gps-trace.com/en/devices/eview-ev-07b
- Uffizio — ficha técnica general: https://uffizio.com/gps-tracker/eview-ev/07b/

**Fuentes consultadas sin éxito (devolvieron HTTP 403 — información no verificada):**
- Manual de usuario FCC EV-07B-LTE: https://fccid.io/2AUMJEV-07B-LTE/User-Manual/User-manual-4457926
- Protocolo SMS de alarmas personales Eview (2023): https://mijnsos.nl/media/solwin/productattachment/attachment/file/e/v/eview_personal_alarm_sms_protocol_2023.pdf
- Manual de usuario en manuals.plus: https://manuals.plus/ae/1005009137278336

Por eso el mapeo bit-a-bit del bitmask crudo del fabricante y la existencia de detección de retiro del dispositivo quedan marcados como **no confirmados** en este informe.

**Datos de producción de SimpleCare (observados, no de fuente externa):**
- Alarmas reales recibidas del dispositivo de prueba: `sos`, `lowBattery`, `powerOn`
- Datos simulados históricos: `sos`, `fall`, `low_battery`
- Registro del hallazgo: `docs/APRENDIZAJES.md`, entrada A015
