'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades compartidas por la suite de tests de SimpleCare IoT.
//
// Regla de oro: los tests JAMÁS deben tocar la base de datos de producción
// (/opt/simplecare/events.db) ni el VPS. Cada test levanta el servidor sobre
// una base SQLite temporal y desechable, creada con fs.mkdtempSync.
// ─────────────────────────────────────────────────────────────────────────────

const os     = require('node:os');
const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');

const RUTA_SERVER = require.resolve('../../server/server.js');

// Mismo esquema que crea server.js. Se replica acá para poder sembrar filas
// ANTES de que el servidor arranque (necesario para probar las migraciones
// de arranque: normalización de alarmas y reasignación al cliente demo).
const ESQUEMA = `
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
`;

/** Hash anónimo tal como lo calcula server.js: sha256(deviceId) truncado a 16 hex. */
function hashDe(deviceId) {
  return crypto.createHash('sha256').update(String(deviceId)).digest('hex').slice(0, 16);
}

/** Crea un directorio temporal aislado para la base de datos de un test. */
function crearDirTemporal() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'simplecare-test-'));
}

/**
 * Levanta el servidor sobre una base temporal.
 *
 * @param {object}   [opciones]
 * @param {string}   [opciones.dir]     Directorio ya existente (para reiniciar sobre la misma DB).
 * @param {Function} [opciones.semilla] fn(db) que se ejecuta ANTES de cargar server.js.
 * @returns {Promise<{url:string, db:object, mod:object, dir:string, cerrar:Function}>}
 */
async function iniciarServidor({ dir, semilla } = {}) {
  const directorio = dir || crearDirTemporal();
  const rutaDb = path.join(directorio, 'events.db');

  if (semilla) {
    const Database = require('better-sqlite3');
    const dbSemilla = new Database(rutaDb);
    dbSemilla.exec(ESQUEMA);
    semilla(dbSemilla);
    dbSemilla.close();
  }

  // Se descarta el módulo de la caché para que server.js vuelva a ejecutar todo
  // su trabajo de arranque (creación de tablas, cliente demo, migraciones).
  delete require.cache[RUTA_SERVER];
  process.env.SIMPLECARE_DB = rutaDb;
  process.env.SIMPLECARE_DASHBOARD = path.join(__dirname, '..', '..', 'server', 'dashboard.html');

  const mod = require(RUTA_SERVER);

  const servidor = await new Promise((resolve) => {
    const s = mod.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${servidor.address().port}`;

  return {
    url,
    db: mod.db,
    mod,
    dir: directorio,
    async cerrar({ borrarDir = true } = {}) {
      await new Promise((resolve) => servidor.close(resolve));
      try { mod.db.close(); } catch { /* ya cerrada */ }
      delete require.cache[RUTA_SERVER];
      if (borrarDir) {
        try { fs.rmSync(directorio, { recursive: true, force: true }); } catch { /* Windows puede retener el handle */ }
      }
    },
  };
}

// ── Helpers de datos ─────────────────────────────────────────────────────────

function crearCliente(db, clientId, nombre, token) {
  db.prepare('INSERT OR REPLACE INTO clients (client_id, nombre, token) VALUES (?, ?, ?)')
    .run(clientId, nombre, token);
}

function asignarDispositivo(db, deviceHash, clientId) {
  db.prepare('INSERT OR REPLACE INTO device_clients (device_hash, client_id) VALUES (?, ?)')
    .run(deviceHash, clientId);
}

function insertarEvento(db, ev) {
  const {
    device_hash, alarm_type = null, event_type = 'alarm',
    timestamp = '2026-06-20T14:32:00Z', lat_zone = null, lon_zone = null,
    created_at = '2026-06-20 14:32:10',
  } = ev;
  db.prepare(`INSERT INTO events (device_hash, alarm_type, event_type, timestamp, lat_zone, lon_zone, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(device_hash, alarm_type, event_type, timestamp, lat_zone, lon_zone, created_at);
}

// ── Helpers HTTP ─────────────────────────────────────────────────────────────

/** Payload con la forma exacta que envía Traccar (ver A005). */
function payloadTraccar({ deviceId = 45, type = 'alarm', alarm = 'sos',
                          latitude = -33.4569, longitude = -70.6483,
                          eventTime = '2026-06-20T14:32:00Z', nombre = 'Miguel' } = {}) {
  return {
    event: { id: 1, type, deviceId, eventTime, attributes: alarm === undefined ? {} : { alarm } },
    position: latitude === null ? undefined : { latitude, longitude, speed: 0.0 },
    device: { id: deviceId, name: nombre },
  };
}

async function postWebhook(url, cuerpo, { crudo = false } = {}) {
  return fetch(`${url}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: crudo ? cuerpo : JSON.stringify(cuerpo),
  });
}

async function getJson(url, ruta) {
  const r = await fetch(`${url}${ruta}`);
  const texto = await r.text();
  let cuerpo = null;
  try { cuerpo = JSON.parse(texto); } catch { cuerpo = texto; }
  return { status: r.status, cuerpo, texto };
}

/** Los 8 endpoints protegidos por requireClient. */
const ENDPOINTS_PROTEGIDOS = [
  '/stats',
  '/events',
  '/summary',
  '/heatmap',
  '/utilization',
  '/riesgo',
  '/dispositivo/abcd1234',
  '/export',
];

module.exports = {
  ESQUEMA, ENDPOINTS_PROTEGIDOS,
  hashDe, crearDirTemporal, iniciarServidor,
  crearCliente, asignarDispositivo, insertarEvento,
  payloadTraccar, postWebhook, getJson,
};
