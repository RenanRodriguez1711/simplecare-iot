'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Escenario multi-tenant compartido por los tests de aislamiento, autenticación
// y agregaciones.
//
//   Municipalidad de Maipú (client_id "maipu", token TOKEN_A)
//     · dispositivo hA: 2 SOS + 1 caída (con coordenadas), 1 batería baja
//                       (sin coordenadas), 1 deviceOnline — día 2026-06-10
//     · dispositivo hC: 2 batería baja (sin coordenadas)  — día 2026-06-10
//
//   Municipalidad de Providencia (client_id "providencia", token TOKEN_B)
//     · dispositivo hB: 5 caídas + 3 SOS (con coordenadas), 1 deviceOnline
//                       — día 2026-06-11, en otra región del país
//
// Las coordenadas de A (~-33.5) y B (~-20.2) están deliberadamente en zonas
// geográficas distintas para que una fuga sea evidente en /heatmap y /export.
// ─────────────────────────────────────────────────────────────────────────────

const { hashDe, crearCliente, asignarDispositivo, insertarEvento } = require('./servidor');

const TOKEN_A = 'token-maipu-secreto';
const TOKEN_B = 'token-providencia-secreto';

const hA = hashDe('maipu-dispositivo-1');
const hC = hashDe('maipu-dispositivo-2');
const hB = hashDe('providencia-dispositivo-1');

const DIA_A = '2026-06-10';
const DIA_B = '2026-06-11';

/** Conteos esperados para el cliente A (Maipú). Sirven de contrato de los tests. */
const ESPERADO_A = {
  eventos: 7,
  total: 6,          // filas con alarm_type NO nulo
  sos: 2,
  fall: 1,
  low_battery: 3,
  devices: 2,
  heatmap: 3,        // solo alarmas con coordenadas
  puntajeRiesgo: 1 * 3 + 2 * 2, // caída=3, SOS=2, batería=0
  filasCsv: 6,
};

function sembrarEscenario(db) {
  crearCliente(db, 'maipu', 'Municipalidad de Maipú', TOKEN_A);
  crearCliente(db, 'providencia', 'Municipalidad de Providencia', TOKEN_B);
  asignarDispositivo(db, hA, 'maipu');
  asignarDispositivo(db, hC, 'maipu');
  asignarDispositivo(db, hB, 'providencia');

  const ts = (dia, hora) => `${dia} ${hora}`;

  // ── Maipú ──
  insertarEvento(db, { device_hash: hA, alarm_type: 'sos',  lat_zone: -33.50, lon_zone: -70.70, created_at: ts(DIA_A, '09:00:00') });
  insertarEvento(db, { device_hash: hA, alarm_type: 'sos',  lat_zone: -33.50, lon_zone: -70.70, created_at: ts(DIA_A, '09:05:00') });
  insertarEvento(db, { device_hash: hA, alarm_type: 'fall', lat_zone: -33.51, lon_zone: -70.71, created_at: ts(DIA_A, '10:00:00') });
  insertarEvento(db, { device_hash: hA, alarm_type: 'low_battery', created_at: ts(DIA_A, '11:00:00') });
  insertarEvento(db, { device_hash: hA, alarm_type: null, event_type: 'deviceOnline', created_at: ts(DIA_A, '08:00:00') });
  insertarEvento(db, { device_hash: hC, alarm_type: 'low_battery', created_at: ts(DIA_A, '12:00:00') });
  insertarEvento(db, { device_hash: hC, alarm_type: 'low_battery', created_at: ts(DIA_A, '12:30:00') });

  // ── Providencia ──
  for (let i = 0; i < 5; i++) {
    insertarEvento(db, { device_hash: hB, alarm_type: 'fall', lat_zone: -20.20, lon_zone: -70.10, created_at: ts(DIA_B, `1${i}:00:00`) });
  }
  for (let i = 0; i < 3; i++) {
    insertarEvento(db, { device_hash: hB, alarm_type: 'sos', lat_zone: -20.21, lon_zone: -70.11, created_at: ts(DIA_B, `0${i + 1}:00:00`) });
  }
  insertarEvento(db, { device_hash: hB, alarm_type: null, event_type: 'deviceOnline', created_at: ts(DIA_B, '07:00:00') });
}

module.exports = { TOKEN_A, TOKEN_B, hA, hB, hC, DIA_A, DIA_B, ESPERADO_A, sembrarEscenario };
