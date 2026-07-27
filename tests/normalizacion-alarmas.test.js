'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Normalización de alarmas — regresión de A015
//
// El bug: Traccar entrega los tipos en camelCase (lowBattery, fallDown, powerOn)
// y todas las queries filtraban por snake_case. Las alarmas REALES no se
// contaban en ningún KPI, filtro ni exportación, y el bug estuvo oculto meses
// porque los datos simulados sí usaban snake_case.
//
// `fallDown` es la caída: el evento de mayor peso del panel de riesgo. Sin esta
// normalización, el panel de riesgo con datos reales queda vacío.
// ─────────────────────────────────────────────────────────────────────────────

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  iniciarServidor, payloadTraccar, postWebhook, hashDe, insertarEvento,
} = require('./ayuda/servidor');

describe('normalizeAlarm() — unidad', () => {
  let s;
  before(async () => { s = await iniciarServidor(); });
  after(async () => { await s.cerrar(); });

  test('alias explícitos de ALARM_ALIASES', () => {
    const { normalizeAlarm, ALARM_ALIASES } = s.mod;
    assert.equal(normalizeAlarm('fallDown'), 'fall', 'la caída de Traccar debe mapear a fall');
    assert.equal(normalizeAlarm('lowPower'), 'low_battery');
    // Todos los alias declarados deben aplicarse tal cual.
    for (const [origen, destino] of Object.entries(ALARM_ALIASES)) {
      assert.equal(normalizeAlarm(origen), destino, `alias ${origen}`);
    }
  });

  test('conversión genérica camelCase → snake_case', () => {
    const { normalizeAlarm } = s.mod;
    const casos = {
      lowBattery: 'low_battery',
      powerOn: 'power_on',
      powerOff: 'power_off',
      geofenceEnter: 'geofence_enter',
      geofenceExit: 'geofence_exit',
      sosButton: 'sos_button',
      hardAcceleration: 'hard_acceleration',
    };
    for (const [entrada, salida] of Object.entries(casos)) {
      assert.equal(normalizeAlarm(entrada), salida, `entrada ${entrada}`);
    }
  });

  test('los valores ya canónicos quedan intactos (idempotencia de la función)', () => {
    const { normalizeAlarm } = s.mod;
    for (const v of ['sos', 'fall', 'low_battery', 'power_on', 'geofence_enter']) {
      assert.equal(normalizeAlarm(v), v, `${v} ya es canónico`);
      assert.equal(normalizeAlarm(normalizeAlarm(v)), v, `${v} debe ser estable al reaplicar`);
    }
  });

  test('valores nulos o vacíos devuelven null', () => {
    const { normalizeAlarm } = s.mod;
    for (const v of [null, undefined, '', 0, false, NaN]) {
      assert.equal(normalizeAlarm(v), null, `entrada ${String(v)}`);
    }
  });

  test('mayúsculas y dígitos', () => {
    const { normalizeAlarm } = s.mod;
    assert.equal(normalizeAlarm('SOS'), 'sos');
    assert.equal(normalizeAlarm('Fall'), 'fall');
    assert.equal(normalizeAlarm('alarm1Type'), 'alarm1_type');
  });
});

describe('Normalización en el webhook — camino real de ingesta', () => {
  let s;
  before(async () => { s = await iniciarServidor(); });
  after(async () => { await s.cerrar(); });

  const casos = [
    ['fallDown', 'fall'],
    ['lowBattery', 'low_battery'],
    ['lowPower', 'low_battery'],
    ['powerOn', 'power_on'],
    ['sos', 'sos'],
  ];

  for (const [entrada, esperado] of casos) {
    test(`una alarma "${entrada}" de Traccar se guarda como "${esperado}"`, async () => {
      const id = `dev-${entrada}`;
      await postWebhook(s.url, payloadTraccar({ deviceId: id, alarm: entrada }));
      const fila = s.db.prepare('SELECT alarm_type FROM events WHERE device_hash = ?').get(hashDe(id));
      assert.ok(fila, 'el evento debe existir');
      assert.equal(fila.alarm_type, esperado);
    });
  }

  test('regresión A015: una caída real (fallDown) es contabilizada por el filtro snake_case', () => {
    const n = s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE alarm_type = 'fall'").get().n;
    assert.equal(n, 1, "el evento fallDown debe ser visible para las queries que filtran por 'fall'");
    const crudos = s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE alarm_type IN ('fallDown','lowBattery','powerOn')").get().n;
    assert.equal(crudos, 0, 'ningún valor camelCase debe sobrevivir en la base');
  });
});

describe('Migración de arranque de filas ya guardadas (idempotente)', () => {
  let s;
  const camelPrevio = [
    { device_hash: hashDe(1), alarm_type: 'fallDown' },
    { device_hash: hashDe(1), alarm_type: 'lowBattery' },
    { device_hash: hashDe(2), alarm_type: 'powerOn' },
    { device_hash: hashDe(2), alarm_type: 'lowPower' },
    { device_hash: hashDe(3), alarm_type: 'sos' },        // ya canónico
    { device_hash: hashDe(3), alarm_type: null },          // sin alarma
  ];

  after(async () => { if (s) await s.cerrar(); });

  test('el primer arranque normaliza las filas históricas en camelCase', async () => {
    s = await iniciarServidor({
      semilla: (db) => camelPrevio.forEach(ev => insertarEvento(db, ev)),
    });
    const tipos = s.db.prepare('SELECT alarm_type, COUNT(*) AS n FROM events GROUP BY alarm_type ORDER BY alarm_type').all();
    const mapa = Object.fromEntries(tipos.map(t => [String(t.alarm_type), t.n]));
    assert.equal(mapa.fall, 1, 'fallDown → fall');
    assert.equal(mapa.low_battery, 2, 'lowBattery y lowPower → low_battery');
    assert.equal(mapa.power_on, 1, 'powerOn → power_on');
    assert.equal(mapa.sos, 1, 'sos se mantiene');
    assert.equal(mapa.null, 1, 'las filas sin alarma no se tocan');
  });

  test('el segundo arranque sobre la misma base no cambia nada (idempotencia)', async () => {
    const antes = s.db.prepare('SELECT id, alarm_type FROM events ORDER BY id').all();
    const dir = s.dir;
    await s.cerrar({ borrarDir: false });

    s = await iniciarServidor({ dir });
    const despues = s.db.prepare('SELECT id, alarm_type FROM events ORDER BY id').all();
    assert.deepEqual(despues, antes, 'reiniciar el servidor no debe alterar los alarm_type ya normalizados');
    assert.equal(despues.length, antes.length, 'la migración no debe duplicar ni borrar filas');
  });

  test('un tercer arranque tampoco cambia nada', async () => {
    const antes = s.db.prepare('SELECT id, alarm_type FROM events ORDER BY id').all();
    const dir = s.dir;
    await s.cerrar({ borrarDir: false });

    s = await iniciarServidor({ dir });
    const despues = s.db.prepare('SELECT id, alarm_type FROM events ORDER BY id').all();
    assert.deepEqual(despues, antes);
  });
});
