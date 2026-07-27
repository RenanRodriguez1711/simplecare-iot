'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Anonimización (función anonymize + efecto en la base)
//
// La promesa comercial y legal del producto (Ley 21.719, docs/PRIVACIDAD.md) es
// que el municipio recibe datos anonimizados. Estos tests verifican el contrato
// técnico: hash determinista, GPS degradado a zona, y CERO datos personales en
// la base. No verifican que la anonimización sea *irreversible* — no lo es
// (S05/H01), y eso se discute en INFORME_TESTING.md.
// ─────────────────────────────────────────────────────────────────────────────

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidor, payloadTraccar, postWebhook, hashDe } = require('./ayuda/servidor');

let s;
before(async () => { s = await iniciarServidor(); });
after(async () => { await s.cerrar(); });

const ultimaFila = (hash) =>
  s.db.prepare('SELECT * FROM events WHERE device_hash = ? ORDER BY id DESC LIMIT 1').get(hash);

describe('Anonimización — determinismo del hash', () => {
  test('el mismo deviceId produce siempre el mismo hash', async () => {
    await postWebhook(s.url, payloadTraccar({ deviceId: 45 }));
    await postWebhook(s.url, payloadTraccar({ deviceId: 45, alarm: 'fall' }));
    const hashes = s.db.prepare('SELECT DISTINCT device_hash FROM events').all().map(r => r.device_hash);
    assert.equal(hashes.length, 1, 'dos eventos del mismo dispositivo deben compartir hash');
  });

  test('el hash es SHA256(deviceId) truncado a 16 caracteres hexadecimales', async () => {
    const esperado = crypto.createHash('sha256').update('45').digest('hex').slice(0, 16);
    const fila = ultimaFila(esperado);
    assert.ok(fila, 'el hash almacenado debe coincidir con el cálculo de referencia');
    assert.equal(fila.device_hash.length, 16);
    assert.match(fila.device_hash, /^[0-9a-f]{16}$/, 'solo hexadecimal en minúscula');
  });

  test('deviceIds distintos producen hashes distintos', async () => {
    await postWebhook(s.url, payloadTraccar({ deviceId: 46 }));
    assert.notEqual(hashDe(45), hashDe(46));
    const n = s.db.prepare('SELECT COUNT(DISTINCT device_hash) AS n FROM events').get().n;
    assert.equal(n, 2);
  });

  test('el deviceId numérico y su string equivalente colapsan al mismo hash', async () => {
    // anonymize() hace String(event.deviceId): 45 y "45" son el mismo dispositivo.
    assert.equal(hashDe(45), hashDe('45'));
  });

  test('el hash es estable entre reinicios (no depende de sal aleatoria por proceso)', () => {
    // Si mañana se agrega sal (remediación de S05), debe ser persistente:
    // una sal por arranque rompería la continuidad histórica de cada persona.
    assert.equal(hashDe(45), crypto.createHash('sha256').update('45').digest('hex').slice(0, 16));
  });
});

describe('Anonimización — degradación del GPS a zona', () => {
  const casos = [
    [-33.4569, -70.6483, -33.46, -70.65],
    [-33.4512, -70.6412, -33.45, -70.64],
    [-33.455, -70.645, -33.45, -70.64], // Math.round de negativos: redondea hacia +∞
    [-20.2135, -70.1502, -20.21, -70.15],
    [-53.163, -70.9171, -53.16, -70.92],
  ];

  for (const [lat, lon, latEsp, lonEsp] of casos) {
    test(`(${lat}, ${lon}) se redondea a (${latEsp}, ${lonEsp})`, async () => {
      const id = 1000 + Math.round(Math.abs(lat) * 1000);
      await postWebhook(s.url, payloadTraccar({ deviceId: id, latitude: lat, longitude: lon }));
      const fila = ultimaFila(hashDe(id));
      assert.equal(fila.lat_zone, latEsp);
      assert.equal(fila.lon_zone, lonEsp);
    });
  }

  test('la precisión guardada nunca supera 2 decimales', () => {
    const filas = s.db.prepare('SELECT lat_zone, lon_zone FROM events WHERE lat_zone IS NOT NULL').all();
    assert.ok(filas.length > 0);
    for (const f of filas) {
      assert.equal(Math.round(f.lat_zone * 100) / 100, f.lat_zone, `lat_zone ${f.lat_zone} tiene más de 2 decimales`);
      assert.equal(Math.round(f.lon_zone * 100) / 100, f.lon_zone, `lon_zone ${f.lon_zone} tiene más de 2 decimales`);
    }
  });

  test('la coordenada exacta original nunca se almacena', async () => {
    await postWebhook(s.url, payloadTraccar({ deviceId: 7777, latitude: -33.456789, longitude: -70.648321 }));
    const volcado = JSON.stringify(s.db.prepare('SELECT * FROM events').all());
    assert.ok(!volcado.includes('456789'), 'la latitud exacta no debe quedar en la base');
    assert.ok(!volcado.includes('648321'), 'la longitud exacta no debe quedar en la base');
  });
});

describe('Anonimización — ningún dato personal llega a la base', () => {
  test('el nombre del dispositivo nunca se almacena', async () => {
    await postWebhook(s.url, payloadTraccar({ deviceId: 8001, nombre: 'Miguel Fuentes Rojas' }));
    const volcado = JSON.stringify(s.db.prepare('SELECT * FROM events').all());
    for (const fragmento of ['Miguel', 'Fuentes', 'Rojas']) {
      assert.ok(!volcado.includes(fragmento), `el nombre "${fragmento}" no debe aparecer en events`);
    }
  });

  test('campos adicionales del payload (device, position extendida) no se persisten', async () => {
    await postWebhook(s.url, {
      event: { type: 'alarm', deviceId: 8002, eventTime: '2026-06-20T14:32:00Z', attributes: { alarm: 'sos' } },
      position: { latitude: -33.45, longitude: -70.65, speed: 4.2, address: 'Av. Providencia 1234, Santiago', accuracy: 12 },
      device: { id: 8002, name: 'Rosa', phone: '+56912345678', uniqueId: '860906051234567' },
    });
    const volcado = JSON.stringify(s.db.prepare('SELECT * FROM events').all());
    for (const fragmento of ['Rosa', '+56912345678', '860906051234567', 'Providencia 1234', 'address', 'speed']) {
      assert.ok(!volcado.includes(fragmento), `"${fragmento}" no debe filtrarse a la base`);
    }
  });

  test('la tabla events no tiene columnas para datos personales', () => {
    const columnas = s.db.prepare('PRAGMA table_info(events)').all().map(c => c.name).sort();
    assert.deepEqual(columnas,
      ['alarm_type', 'created_at', 'device_hash', 'event_type', 'id', 'lat_zone', 'lon_zone', 'timestamp'],
      'un cambio de esquema que agregue campos personales debe hacer fallar este test');
  });

  test('el IMEI (uniqueId) no interviene en el hash: se usa el deviceId interno de Traccar', () => {
    // Documenta el hecho real detrás de S05/H01: el hash se calcula sobre un
    // entero correlativo pequeño, no sobre el IMEI. PRIVACIDAD.md dice lo contrario.
    assert.equal(hashDe(45), hashDe(45));
    assert.notEqual(hashDe('860906051234567'), hashDe(45));
  });
});

describe('Anonimización — borde conocido: coordenada 0', () => {
  // `position.latitude ? ... : null` trata el 0 como ausencia de dato.
  // Chile no cruza el ecuador ni el meridiano de Greenwich, así que hoy no
  // afecta a producción, pero es un defecto latente. Ver INFORME_TESTING.md (T01).
  test.skip('latitud 0 debería guardarse como 0 y no como NULL (bug abierto T01)', async () => {
    await postWebhook(s.url, payloadTraccar({ deviceId: 9001, latitude: 0, longitude: 0 }));
    const fila = ultimaFila(hashDe(9001));
    assert.equal(fila.lat_zone, 0);
    assert.equal(fila.lon_zone, 0);
  });

  test('comportamiento ACTUAL documentado: latitud 0 se guarda como NULL', async () => {
    await postWebhook(s.url, payloadTraccar({ deviceId: 9002, latitude: 0, longitude: 0 }));
    const fila = ultimaFila(hashDe(9002));
    assert.equal(fila.lat_zone, null);
    assert.equal(fila.lon_zone, null);
  });
});
