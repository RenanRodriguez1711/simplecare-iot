# API — SimpleCare IoT Backend

Base URL: `http://2.24.196.49:3000`  
Futuro (con subdominio): `https://panel.simplecare.cl`

---

## Endpoints

### POST /webhook
Recibe eventos desde Traccar. **Solo para uso interno de Traccar** — no exponer públicamente sin autenticación.

**Body (JSON enviado por Traccar):**
```json
{
  "event": {
    "id": 123,
    "type": "alarm",
    "deviceId": 45,
    "eventTime": "2026-06-20T14:32:00Z",
    "attributes": {
      "alarm": "sos"
    }
  },
  "position": {
    "latitude": -33.4569,
    "longitude": -70.6483,
    "speed": 0.0
  },
  "device": {
    "id": 45,
    "name": "Miguel"
  }
}
```

**Tipos de evento procesados:** `alarm`, `deviceOnline`, `deviceOffline`, `geofenceEnter`, `geofenceExit`  
**Tipos de alarma:** `sos`, `fall`, `low_battery`  
**Respuesta:** `200 OK`

---

### GET /dashboard
Sirve el HTML del dashboard municipal.

**Respuesta:** `text/html` — página completa del dashboard

---

### GET /summary
Retorna conteos totales para las tarjetas KPI del dashboard.

**Query params:**
| Param | Tipo | Descripción |
|---|---|---|
| `desde` | `YYYY-MM-DD` | Fecha inicio (opcional) |
| `hasta` | `YYYY-MM-DD` | Fecha fin (opcional) |

**Respuesta:**
```json
{
  "total": 342,
  "sos": 12,
  "fall": 89,
  "low_battery": 241,
  "devices": 87
}
```

---

### GET /events
Retorna los últimos 30 eventos filtrados (para la tabla del dashboard).

**Query params:**
| Param | Tipo | Descripción |
|---|---|---|
| `desde` | `YYYY-MM-DD` | Fecha inicio (opcional) |
| `hasta` | `YYYY-MM-DD` | Fecha fin (opcional) |
| `tipos` | `string` | Tipos separados por coma: `sos,fall,low_battery` |

**Respuesta:**
```json
[
  {
    "id": 1,
    "device_hash": "d4735e3a265e16ee",
    "alarm_type": "sos",
    "event_type": "alarm",
    "timestamp": "2026-06-20T14:32:00Z",
    "lat_zone": -33.46,
    "lon_zone": -70.65,
    "created_at": "2026-06-20 14:32:10"
  }
]
```

---

### GET /heatmap
Retorna coordenadas para el mapa de calor. Solo eventos con `alarm_type` y coordenadas.

**Query params:**
| Param | Tipo | Descripción |
|---|---|---|
| `desde` | `YYYY-MM-DD` | Fecha inicio (opcional) |
| `hasta` | `YYYY-MM-DD` | Fecha fin (opcional) |
| `tipos` | `string` | Tipos separados por coma (default: `sos,fall,low_battery`) |

**Respuesta:**
```json
[
  { "lat_zone": -33.46, "lon_zone": -70.65 },
  { "lat_zone": -33.44, "lon_zone": -70.67 }
]
```

---

### GET /stats
Retorna conteos agrupados por mes y tipo de alarma. Usado para el gráfico de barras mensual.

**Sin parámetros.**

**Respuesta:**
```json
[
  { "event_type": "alarm", "alarm_type": "sos", "total": 4, "month": "2026-06" },
  { "event_type": "alarm", "alarm_type": "fall", "total": 28, "month": "2026-06" }
]
```

---

### GET /utilization
Retorna dispositivos únicos que se conectaron por día. Usado para el gráfico de línea de utilización.

**Query params:**
| Param | Tipo | Descripción |
|---|---|---|
| `desde` | `YYYY-MM-DD` | Fecha inicio (opcional) |
| `hasta` | `YYYY-MM-DD` | Fecha fin (opcional) |

**Respuesta:**
```json
[
  { "dia": "2026-06-25", "activos": 66 },
  { "dia": "2026-06-24", "activos": 64 }
]
```
Ordenado DESC, máximo 90 registros.

---

### GET /riesgo
Retorna top 15 personas con mayor puntaje de riesgo en el período.

**Puntaje:** caída = 3 pts, SOS = 2 pts  
**Niveles:** Alto ≥ 6 / Medio 3–5 / Bajo 1–2

**Query params:**
| Param | Tipo | Descripción |
|---|---|---|
| `desde` | `YYYY-MM-DD` | Fecha inicio (opcional) |
| `hasta` | `YYYY-MM-DD` | Fecha fin (opcional) |

**Respuesta:**
```json
[
  {
    "id_anonimo": "d4735e3a",
    "fall": 8,
    "sos": 2,
    "ultima_alerta": "2026-06-24 11:20:05",
    "puntaje": 28
  }
]
```

---

### GET /dispositivo/:id
Retorna historial de alertas de una persona específica (para el modal del mapa individual).

**Parámetro de ruta:** `:id` — 8 primeros caracteres del hash anónimo

**Respuesta:**
```json
[
  {
    "alarm_type": "fall",
    "lat_zone": -33.45,
    "lon_zone": -70.66,
    "created_at": "2026-06-18 09:14:22"
  }
]
```
Solo eventos con coordenadas. Ordenado ASC por fecha.

---

### GET /export
Descarga un archivo CSV con todos los eventos filtrados. Compatible con Excel (incluye BOM UTF-8).

**Query params:**
| Param | Tipo | Descripción |
|---|---|---|
| `desde` | `YYYY-MM-DD` | Fecha inicio (opcional) |
| `hasta` | `YYYY-MM-DD` | Fecha fin (opcional) |
| `tipos` | `string` | Tipos separados por coma (default: `sos,fall,low_battery`) |

**Respuesta:** `text/csv` con `Content-Disposition: attachment`  
**Nombre del archivo:** `simplecare_DESDE_HASTA.csv`

**Formato CSV:**
```
fecha,tipo_alerta,zona_lat,zona_lon
2026-06-20 14:32:10,sos,-33.46,-70.65
2026-06-19 09:11:43,fall,-33.44,-70.67
```

---

## Schema de la base de datos

```sql
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_hash TEXT NOT NULL,      -- SHA256 del deviceId, 16 chars hex
  alarm_type  TEXT,               -- 'sos' | 'fall' | 'low_battery' | NULL
  event_type  TEXT,               -- 'alarm' | 'deviceOnline' | 'deviceOffline'
  timestamp   TEXT,               -- timestamp original del evento Traccar
  lat_zone    REAL,               -- latitud redondeada a 2 decimales
  lon_zone    REAL,               -- longitud redondeada a 2 decimales
  created_at  TEXT DEFAULT (datetime('now'))
);
```
