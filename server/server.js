const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());

const db = new Database('/opt/simplecare/events.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_hash TEXT NOT NULL,
    alarm_type  TEXT,
    event_type  TEXT,
    timestamp   TEXT,
    lat_zone    REAL,
    lon_zone    REAL,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clients (
    client_id TEXT PRIMARY KEY,
    nombre    TEXT NOT NULL,
    token     TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS device_clients (
    device_hash TEXT PRIMARY KEY,
    client_id   TEXT NOT NULL REFERENCES clients(client_id)
  );
`);

// Cliente de prueba: preserva acceso al dashboard ficticio existente mientras no hay clientes reales.
db.prepare(`INSERT OR IGNORE INTO clients (client_id, nombre, token) VALUES (?, ?, ?)`)
  .run('demo', 'Municipio Demo', 'demo-token-dev-only');

// Asigna al cliente demo todos los dispositivos ya existentes (datos simulados / pruebas previas).
// Dispositivos nuevos se asignan a un cliente manualmente (panel admin, pendiente).
db.exec(`
  INSERT OR IGNORE INTO device_clients (device_hash, client_id)
  SELECT DISTINCT device_hash, 'demo' FROM events
`);

// ── Middleware de autenticación por token ──────────────────────────────────────

function requireClient(req, res, next) {
  const token = req.query.token;
  if (!token) return res.status(401).json({ error: 'Falta token' });
  const client = db.prepare('SELECT client_id, nombre FROM clients WHERE token = ?').get(token);
  if (!client) return res.status(403).json({ error: 'Token inválido' });
  req.clientId = client.client_id;
  next();
}

// ── Normalización de nombres de alarma ────────────────────────────────────────
// Traccar entrega los tipos en camelCase ('lowBattery', 'fallDown'). La DB y el
// dashboard usan snake_case canónico. Sin esto, las alarmas reales no coinciden
// con los filtros y quedan invisibles en el dashboard.

const ALARM_ALIASES = {
  fallDown: 'fall',        // Traccar nombra la caída 'fallDown'
  lowPower: 'low_battery', // batería baja tiene dos nombres según el firmware
};

function normalizeAlarm(alarm) {
  if (!alarm) return null;
  if (ALARM_ALIASES[alarm]) return ALARM_ALIASES[alarm];
  return alarm.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

// Normaliza las filas ya guardadas con nombres en camelCase (idempotente).
for (const { alarm_type } of db.prepare('SELECT DISTINCT alarm_type FROM events WHERE alarm_type IS NOT NULL').all()) {
  const normalizado = normalizeAlarm(alarm_type);
  if (normalizado !== alarm_type) {
    const { changes } = db.prepare('UPDATE events SET alarm_type = ? WHERE alarm_type = ?').run(normalizado, alarm_type);
    console.log(`Normalizado: ${alarm_type} -> ${normalizado} (${changes} filas)`);
  }
}

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

// ── Servir dashboard ──────────────────────────────────────────────────────────

app.get(['/dashboard', '/dashboard/:clientId'], (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(fs.readFileSync('/opt/simplecare/public/dashboard.html', 'utf8'));
});

// ── Webhook (Traccar → Node.js) ───────────────────────────────────────────────

app.post('/webhook', (req, res) => {
  const body = req.body;
  if (!body?.event?.type) return res.status(200).send('OK');
  const tipo = body.event.type;
  console.log('Evento:', tipo, body.event.attributes?.alarm || '');
  const relevantes = ['alarm', 'geofenceEnter', 'geofenceExit', 'deviceOffline', 'deviceOnline'];
  if (relevantes.includes(tipo)) {
    const anon = anonymize(body);
    db.prepare(`
      INSERT INTO events (device_hash, alarm_type, event_type, timestamp, lat_zone, lon_zone)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(anon.device_hash, anon.alarm_type, anon.event_type, anon.timestamp, anon.lat_zone, anon.lon_zone);
    console.log('Guardado:', anon);
  }
  res.status(200).send('OK');
});

// ── Estadísticas mensuales (gráfico de barras) ────────────────────────────────

app.get('/stats', requireClient, (req, res) => {
  res.json(db.prepare(`
    SELECT event_type, alarm_type, COUNT(*) as total, strftime('%Y-%m', created_at) as month
    FROM events
    WHERE device_hash IN (SELECT device_hash FROM device_clients WHERE client_id = ?)
    GROUP BY event_type, alarm_type, month
    ORDER BY month DESC
  `).all(req.clientId));
});

// ── Eventos recientes filtrados (tabla del dashboard) ─────────────────────────

app.get('/events', requireClient, (req, res) => {
  const desde = req.query.desde || null;
  const hasta  = req.query.hasta  || null;
  const tipos  = req.query.tipos
    ? req.query.tipos.split(',').filter(t => ['sos','fall','low_battery'].includes(t))
    : null;
  const conds  = ['device_hash IN (SELECT device_hash FROM device_clients WHERE client_id = ?)'];
  const params = [req.clientId];
  if (tipos && tipos.length > 0) {
    conds.push(`alarm_type IN (${tipos.map(() => '?').join(',')})`);
    params.push(...tipos);
  }
  if (desde) { conds.push("date(created_at) >= ?"); params.push(desde); }
  if (hasta)  { conds.push("date(created_at) <= ?"); params.push(hasta);  }
  const where = 'WHERE ' + conds.join(' AND ');
  res.json(db.prepare(`SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT 30`).all(...params));
});

// ── Resumen KPI (tarjetas del dashboard) ──────────────────────────────────────

app.get('/summary', requireClient, (req, res) => {
  const desde = req.query.desde || null;
  const hasta  = req.query.hasta  || null;
  const p  = [req.clientId], dc = [];
  if (desde) { dc.push("date(created_at) >= ?"); p.push(desde); }
  if (hasta)  { dc.push("date(created_at) <= ?"); p.push(hasta);  }
  const clientCond = 'device_hash IN (SELECT device_hash FROM device_clients WHERE client_id = ?)';
  const and = dc.length ? ' AND ' + dc.join(' AND ') : '';
  res.json({
    total:       db.prepare(`SELECT COUNT(*) as n FROM events WHERE ${clientCond} AND alarm_type IS NOT NULL${and}`).get(...p).n,
    sos:         db.prepare(`SELECT COUNT(*) as n FROM events WHERE ${clientCond} AND alarm_type='sos'${and}`).get(...p).n,
    fall:        db.prepare(`SELECT COUNT(*) as n FROM events WHERE ${clientCond} AND alarm_type='fall'${and}`).get(...p).n,
    low_battery: db.prepare(`SELECT COUNT(*) as n FROM events WHERE ${clientCond} AND alarm_type='low_battery'${and}`).get(...p).n,
    devices:     db.prepare(`SELECT COUNT(DISTINCT device_hash) as n FROM events WHERE ${clientCond}${and}`).get(...p).n,
  });
});

// ── Coordenadas para mapa de calor ────────────────────────────────────────────

app.get('/heatmap', requireClient, (req, res) => {
  const desde = req.query.desde || null;
  const hasta  = req.query.hasta  || null;
  const tipos  = req.query.tipos
    ? req.query.tipos.split(',').filter(t => ['sos','fall','low_battery'].includes(t))
    : ['sos','fall','low_battery'];
  if (!tipos.length) return res.json([]);
  const p = [], dc = [];
  if (desde) { dc.push("date(created_at) >= ?"); p.push(desde); }
  if (hasta)  { dc.push("date(created_at) <= ?"); p.push(hasta);  }
  const tiposQ = tipos.map(() => '?').join(',');
  const and    = dc.length ? ' AND ' + dc.join(' AND ') : '';
  const rows   = db.prepare(`
    SELECT lat_zone, lon_zone FROM events
    WHERE lat_zone IS NOT NULL AND alarm_type IN (${tiposQ})${and}
      AND device_hash IN (SELECT device_hash FROM device_clients WHERE client_id = ?)
  `).all(...tipos, ...p, req.clientId);
  res.json(rows);
});

// ── Utilización diaria (gráfico de línea) ─────────────────────────────────────

app.get('/utilization', requireClient, (req, res) => {
  const desde = req.query.desde || null;
  const hasta  = req.query.hasta  || null;
  const p = [], dc = [];
  if (desde) { dc.push("date(created_at) >= ?"); p.push(desde); }
  if (hasta)  { dc.push("date(created_at) <= ?"); p.push(hasta);  }
  const and  = dc.length ? ' AND ' + dc.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT date(created_at) as dia, COUNT(DISTINCT device_hash) as activos
    FROM events
    WHERE event_type IN ('deviceOnline','deviceOffline')${and}
      AND device_hash IN (SELECT device_hash FROM device_clients WHERE client_id = ?)
    GROUP BY dia
    ORDER BY dia DESC
    LIMIT 90
  `).all(...p, req.clientId);
  res.json(rows);
});

// ── Panel de riesgo por persona ───────────────────────────────────────────────

app.get('/riesgo', requireClient, (req, res) => {
  const desde = req.query.desde || null;
  const hasta  = req.query.hasta  || null;
  const p = [], dc = [];
  if (desde) { dc.push("date(created_at) >= ?"); p.push(desde); }
  if (hasta)  { dc.push("date(created_at) <= ?"); p.push(hasta);  }
  const and  = dc.length ? ' AND ' + dc.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT
      substr(device_hash, 1, 8) as id_anonimo,
      SUM(CASE WHEN alarm_type='fall' THEN 1 ELSE 0 END) as fall,
      SUM(CASE WHEN alarm_type='sos'  THEN 1 ELSE 0 END) as sos,
      MAX(created_at) as ultima_alerta,
      SUM(CASE WHEN alarm_type='fall' THEN 3 ELSE 0 END) +
      SUM(CASE WHEN alarm_type='sos'  THEN 2 ELSE 0 END) as puntaje
    FROM events
    WHERE alarm_type IS NOT NULL${and}
      AND device_hash IN (SELECT device_hash FROM device_clients WHERE client_id = ?)
    GROUP BY device_hash
    HAVING puntaje > 0
    ORDER BY puntaje DESC
    LIMIT 15
  `).all(...p, req.clientId);
  res.json(rows);
});

// ── Historial individual (modal del mapa) ─────────────────────────────────────

app.get('/dispositivo/:id', requireClient, (req, res) => {
  const id   = req.params.id.replace(/[^a-f0-9]/gi, '').substring(0, 8);
  const rows = db.prepare(`
    SELECT alarm_type, lat_zone, lon_zone, created_at
    FROM events
    WHERE substr(device_hash, 1, 8) = ?
      AND alarm_type IS NOT NULL
      AND lat_zone IS NOT NULL
      AND device_hash IN (SELECT device_hash FROM device_clients WHERE client_id = ?)
    ORDER BY created_at ASC
  `).all(id, req.clientId);
  res.json(rows);
});

// ── Exportar CSV ──────────────────────────────────────────────────────────────

app.get('/export', requireClient, (req, res) => {
  const desde = req.query.desde || null;
  const hasta  = req.query.hasta  || null;
  const tipos  = req.query.tipos
    ? req.query.tipos.split(',').filter(t => ['sos','fall','low_battery'].includes(t))
    : ['sos','fall','low_battery'];
  if (!tipos.length) return res.send('fecha,tipo_alerta,zona_lat,zona_lon\n');
  const p = [], dc = [];
  if (desde) { dc.push("date(created_at) >= ?"); p.push(desde); }
  if (hasta)  { dc.push("date(created_at) <= ?"); p.push(hasta);  }
  const tiposQ = tipos.map(() => '?').join(',');
  const and    = dc.length ? ' AND ' + dc.join(' AND ') : '';
  const rows   = db.prepare(`
    SELECT created_at, alarm_type, event_type, lat_zone, lon_zone
    FROM events
    WHERE alarm_type IN (${tiposQ})${and}
      AND device_hash IN (SELECT device_hash FROM device_clients WHERE client_id = ?)
    ORDER BY created_at DESC
  `).all(...tipos, ...p, req.clientId);
  const lines = ['fecha,tipo_alerta,zona_lat,zona_lon'];
  rows.forEach(r => lines.push(
    `${r.created_at},${r.alarm_type || r.event_type},${r.lat_zone ?? ''},${r.lon_zone ?? ''}`
  ));
  const nombre = `simplecare_${desde || 'inicio'}_${hasta || 'hoy'}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.send('﻿' + lines.join('\n'));
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(3000, () => console.log('SimpleCare corriendo en puerto 3000'));
