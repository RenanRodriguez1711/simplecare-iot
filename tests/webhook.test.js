'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Webhook e ingesta (POST /webhook)
//
// Este es el punto de entrada de TODAS las alarmas del sistema. Un fallo acá
// significa una alerta perdida: un adulto mayor que se cayó y cuyo evento nunca
// llegó al dashboard. La prioridad de estos tests es que el proceso nunca se
// caiga y que nunca se pierda un evento relevante.
// ─────────────────────────────────────────────────────────────────────────────

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarServidor, payloadTraccar, postWebhook, hashDe } = require('./ayuda/servidor');

let s;
before(async () => { s = await iniciarServidor(); });
after(async () => { await s.cerrar(); });

const contarEventos = () => s.db.prepare('SELECT COUNT(*) AS n FROM events').get().n;

describe('Webhook — eventos válidos', () => {
  test('un evento de alarma SOS completo se guarda', async () => {
    const antes = contarEventos();
    const r = await postWebhook(s.url, payloadTraccar({ deviceId: 101, alarm: 'sos' }));
    assert.equal(r.status, 200);
    assert.equal(contarEventos(), antes + 1);

    const fila = s.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
    assert.equal(fila.alarm_type, 'sos');
    assert.equal(fila.event_type, 'alarm');
    assert.equal(fila.device_hash, hashDe(101));
    assert.equal(fila.timestamp, '2026-06-20T14:32:00Z');
    assert.equal(fila.lat_zone, -33.46);
    assert.equal(fila.lon_zone, -70.65);
  });

  test('los 5 tipos de evento relevantes se guardan', async () => {
    const relevantes = ['alarm', 'geofenceEnter', 'geofenceExit', 'deviceOffline', 'deviceOnline'];
    for (const tipo of relevantes) {
      const antes = contarEventos();
      const r = await postWebhook(s.url, payloadTraccar({ deviceId: 200, type: tipo, alarm: undefined }));
      assert.equal(r.status, 200, `tipo ${tipo}`);
      assert.equal(contarEventos(), antes + 1, `el tipo relevante ${tipo} debe persistirse`);
    }
  });

  test('un tipo de evento NO relevante se acepta pero no se guarda', async () => {
    const antes = contarEventos();
    for (const tipo of ['deviceMoving', 'commandResult', 'maintenance', 'textMessage']) {
      const r = await postWebhook(s.url, payloadTraccar({ deviceId: 300, type: tipo }));
      assert.equal(r.status, 200, `tipo ${tipo}`);
    }
    assert.equal(contarEventos(), antes, 'los tipos no relevantes no deben ensuciar la tabla');
  });
});

describe('Webhook — payloads malformados (robustez del proceso)', () => {
  // Cada caso: [descripción, cuerpo, statusEsperado].
  // 200 = el handler lo procesó y lo descartó silenciosamente.
  // 400 = express.json() en modo estricto lo rechazó antes de llegar al handler.
  // En ambos casos lo crítico es idéntico: el proceso NO se cae.
  const casosBasura = [
    ['objeto vacío', {}, 200],
    ['array', [1, 2, 3], 200],
    ['sin event', { position: { latitude: -33.4, longitude: -70.6 } }, 200],
    ['event vacío', { event: {} }, 200],
    ['event sin type', { event: { deviceId: 5, attributes: { alarm: 'sos' } } }, 200],
    ['event.type null', { event: { type: null } }, 200],
    ['event como string', { event: 'alarm' }, 200],
    ['event como número', { event: 7 }, 200],
    ['anidamiento profundo', { event: { type: { type: { type: 'alarm' } } } }, 200],
    ['null literal', null, 400],
    ['string JSON suelto', 'soy un string', 400],
    ['número suelto', 42, 400],
  ];

  for (const [descripcion, cuerpo, esperado] of casosBasura) {
    test(`payload basura: ${descripcion} → ${esperado} y el proceso sigue vivo`, async () => {
      const antes = contarEventos();
      const r = await postWebhook(s.url, cuerpo);
      assert.equal(r.status, esperado, `${descripcion} debería responder ${esperado}`);
      assert.equal(contarEventos(), antes, 'un payload basura no debe escribir en la base');
      // Prueba de vida: el servidor sigue atendiendo después del payload basura.
      const vivo = await postWebhook(s.url, payloadTraccar({ deviceId: 999 }));
      assert.equal(vivo.status, 200);
    });
  }

  test('JSON sintácticamente inválido → 400 sin tumbar el proceso', async () => {
    const r = await postWebhook(s.url, '{esto no es json', { crudo: true });
    assert.equal(r.status, 400, 'express.json() rechaza el cuerpo malformado');
    const vivo = await postWebhook(s.url, payloadTraccar({ deviceId: 998 }));
    assert.equal(vivo.status, 200, 'el proceso debe seguir vivo tras un JSON roto');
  });

  test('cuerpo completamente vacío (sin body) → 200', async () => {
    const r = await fetch(`${s.url}/webhook`, { method: 'POST' });
    assert.equal(r.status, 200);
  });
});

describe('Webhook — campos faltantes en eventos relevantes', () => {
  test('alarma sin position: se guarda con coordenadas nulas', async () => {
    const r = await postWebhook(s.url, payloadTraccar({ deviceId: 401, latitude: null }));
    assert.equal(r.status, 200);
    const fila = s.db.prepare('SELECT * FROM events WHERE device_hash = ? ORDER BY id DESC LIMIT 1').get(hashDe(401));
    assert.ok(fila, 'el evento debe guardarse aunque no traiga posición');
    assert.equal(fila.lat_zone, null);
    assert.equal(fila.lon_zone, null);
    assert.equal(fila.alarm_type, 'sos', 'la alarma no se pierde por falta de GPS');
  });

  test('alarma sin attributes: se guarda con alarm_type nulo', async () => {
    const r = await postWebhook(s.url, { event: { type: 'alarm', deviceId: 402, eventTime: 'x' } });
    assert.equal(r.status, 200);
    const fila = s.db.prepare('SELECT * FROM events WHERE device_hash = ? ORDER BY id DESC LIMIT 1').get(hashDe(402));
    assert.ok(fila);
    assert.equal(fila.alarm_type, null);
  });

  test('evento sin deviceId: se guarda bajo el hash de "undefined" (comportamiento actual)', async () => {
    const r = await postWebhook(s.url, { event: { type: 'alarm', attributes: { alarm: 'sos' } } });
    assert.equal(r.status, 200);
    const fila = s.db.prepare('SELECT * FROM events WHERE device_hash = ?').get(hashDe(undefined));
    assert.ok(fila, 'hoy no se descarta: queda un evento huérfano bajo un hash constante');
  });

  test('evento sin eventTime: timestamp nulo, el evento igual se guarda', async () => {
    const r = await postWebhook(s.url, { event: { type: 'alarm', deviceId: 403, attributes: { alarm: 'fall' } } });
    assert.equal(r.status, 200);
    const fila = s.db.prepare('SELECT * FROM events WHERE device_hash = ? ORDER BY id DESC LIMIT 1').get(hashDe(403));
    assert.equal(fila.timestamp, null);
    assert.equal(fila.alarm_type, 'fall');
  });

  test('position sin longitude: lat se guarda, lon queda nula', async () => {
    const r = await postWebhook(s.url, {
      event: { type: 'alarm', deviceId: 404, attributes: { alarm: 'sos' } },
      position: { latitude: -33.4569 },
    });
    assert.equal(r.status, 200);
    const fila = s.db.prepare('SELECT * FROM events WHERE device_hash = ? ORDER BY id DESC LIMIT 1').get(hashDe(404));
    assert.equal(fila.lat_zone, -33.46);
    assert.equal(fila.lon_zone, null);
  });
});

describe('Webhook — casos frágiles conocidos (relacionados con H02)', () => {
  test('alarm numérico hace fallar el handler con 500 pero NO tumba el proceso', async () => {
    // normalizeAlarm() llama a .replace() sobre el valor: si no es string, lanza.
    // Express atrapa la excepción síncrona y responde 500. El evento SE PIERDE.
    // Documentado en INFORME_TESTING.md como fragilidad de ingesta (H02).
    const r = await postWebhook(s.url, {
      event: { type: 'alarm', deviceId: 500, attributes: { alarm: 12345 } },
    });
    assert.equal(r.status, 500, 'comportamiento actual: el evento se pierde con 500');
    const vivo = await postWebhook(s.url, payloadTraccar({ deviceId: 501 }));
    assert.equal(vivo.status, 200, 'lo importante: el proceso sobrevive');
  });

  test('un evento duplicado se inserta dos veces (no hay idempotencia — H02)', async () => {
    const payload = payloadTraccar({ deviceId: 600, alarm: 'fall' });
    await postWebhook(s.url, payload);
    await postWebhook(s.url, payload);
    const n = s.db.prepare('SELECT COUNT(*) AS n FROM events WHERE device_hash = ?').get(hashDe(600)).n;
    assert.equal(n, 2, 'comportamiento actual documentado: sin deduplicación por event.id');
  });
});
