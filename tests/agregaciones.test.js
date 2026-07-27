'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Agregaciones: /summary (regresión de A011) y /riesgo (puntaje)
//
// A011: el dashboard calculaba los KPI sobre los últimos 100 eventos en memoria.
// Con miles de eventos, los primeros 100 eran casi todos conexiones y los KPI
// mostraban cero. La corrección fue agregar en SQL sobre el total. Estos tests
// fijan esa corrección: /summary debe contar sobre TODO el universo del cliente,
// no sobre la muestra que devuelve /events.
// ─────────────────────────────────────────────────────────────────────────────

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarServidor, getJson, crearCliente, asignarDispositivo, insertarEvento, hashDe } = require('./ayuda/servidor');

const TOKEN = 'token-volumen';
const hV = hashDe('municipio-volumen-1');
const hW = hashDe('municipio-volumen-2');

let s;
before(async () => {
  s = await iniciarServidor();
  crearCliente(s.db, 'volumen', 'Municipio con Volumen', TOKEN);
  asignarDispositivo(s.db, hV, 'volumen');
  asignarDispositivo(s.db, hW, 'volumen');

  // 400 conexiones ANTES (las más recientes por created_at), que son las que
  // llenarían la ventana truncada y esconderían las alarmas — el escenario A011.
  for (let i = 0; i < 400; i++) {
    insertarEvento(s.db, {
      device_hash: i % 2 === 0 ? hV : hW,
      alarm_type: null,
      event_type: i % 2 === 0 ? 'deviceOnline' : 'deviceOffline',
      created_at: `2026-06-25 ${String(Math.floor(i / 60) % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`,
    });
  }
  // Alarmas repartidas en un día anterior: quedan fuera de cualquier ventana truncada.
  for (let i = 0; i < 150; i++) insertarEvento(s.db, { device_hash: hV, alarm_type: 'sos',  event_type: 'alarm', lat_zone: -33.45, lon_zone: -70.66, created_at: `2026-06-01 00:${String(i % 60).padStart(2, '0')}:00` });
  for (let i = 0; i < 120; i++) insertarEvento(s.db, { device_hash: hV, alarm_type: 'fall', event_type: 'alarm', lat_zone: -33.46, lon_zone: -70.67, created_at: `2026-06-02 00:${String(i % 60).padStart(2, '0')}:00` });
  for (let i = 0; i < 90;  i++) insertarEvento(s.db, { device_hash: hW, alarm_type: 'low_battery', event_type: 'alarm', created_at: `2026-06-03 00:${String(i % 60).padStart(2, '0')}:00` });
});
after(async () => { await s.cerrar(); });

const como = (ruta) => getJson(s.url, `${ruta}${ruta.includes('?') ? '&' : '?'}token=${TOKEN}`);

describe('/summary — regresión A011: contar sobre el total, no sobre una muestra', () => {
  test('los KPI reflejan las 360 alarmas completas', async () => {
    const { cuerpo } = await como('/summary');
    assert.equal(cuerpo.sos, 150);
    assert.equal(cuerpo.fall, 120);
    assert.equal(cuerpo.low_battery, 90);
    assert.equal(cuerpo.total, 360, 'total = todas las filas con alarm_type, sin límite');
    assert.equal(cuerpo.devices, 2);
  });

  test('/events sigue truncado a 30 filas: por eso los KPI NO pueden calcularse desde ahí', async () => {
    const { cuerpo } = await como('/events');
    assert.equal(cuerpo.length, 30, 'la tabla del dashboard es una muestra');
    const alarmasEnLaMuestra = cuerpo.filter(e => e.alarm_type !== null).length;
    assert.equal(alarmasEnLaMuestra, 0,
      'la muestra son puras conexiones: exactamente el escenario que produjo A011');
  });

  test('el total del resumen es muy superior al de la muestra (la trampa de A011)', async () => {
    const resumen = (await como('/summary')).cuerpo;
    const muestra = (await como('/events')).cuerpo;
    assert.ok(resumen.total > muestra.length * 10,
      'si alguien vuelve a calcular los KPI desde /events, este test lo detecta');
  });

  test('el filtro de fechas acota el resumen sin volver a truncarlo', async () => {
    const { cuerpo } = await como('/summary?desde=2026-06-01&hasta=2026-06-01');
    assert.equal(cuerpo.sos, 150);
    assert.equal(cuerpo.fall, 0);
    assert.equal(cuerpo.total, 150);
  });

  test('un rango sin datos devuelve ceros, no error', async () => {
    const { status, cuerpo } = await como('/summary?desde=2020-01-01&hasta=2020-01-02');
    assert.equal(status, 200);
    assert.deepEqual(cuerpo, { total: 0, sos: 0, fall: 0, low_battery: 0, devices: 0 });
  });
});

describe('/heatmap y /export tampoco se truncan', () => {
  test('/heatmap devuelve las 270 alarmas con coordenadas', async () => {
    const { cuerpo } = await como('/heatmap');
    assert.equal(cuerpo.length, 270, '150 SOS + 120 caídas; las de batería no tienen coordenadas');
  });

  test('/export incluye las 360 alarmas', async () => {
    const { texto } = await como('/export');
    const filas = texto.replace(/^﻿/, '').trim().split('\n');
    assert.equal(filas.length - 1, 360);
  });
});

describe('/riesgo — puntaje caída=3 / SOS=2 / batería excluida', () => {
  test('el puntaje de un dispositivo con caídas y SOS es 3·caídas + 2·SOS', async () => {
    const { cuerpo } = await como('/riesgo');
    const fila = cuerpo.find(r => r.id_anonimo === hV.slice(0, 8));
    assert.ok(fila, 'el dispositivo con alarmas debe aparecer');
    assert.equal(fila.fall, 120);
    assert.equal(fila.sos, 150);
    assert.equal(fila.puntaje, 120 * 3 + 150 * 2);
  });

  test('la batería baja NO suma puntaje: un dispositivo con solo baterías no aparece', async () => {
    const { cuerpo } = await como('/riesgo');
    const soloBateria = cuerpo.find(r => r.id_anonimo === hW.slice(0, 8));
    assert.equal(soloBateria, undefined,
      '90 alarmas de batería baja no deben poner a nadie en el panel de riesgo');
  });

  test('el orden es descendente por puntaje y se limita a 15 personas', async () => {
    // Se agregan 20 dispositivos con puntajes conocidos y decrecientes.
    for (let d = 1; d <= 20; d++) {
      const h = hashDe(`riesgo-${d}`);
      asignarDispositivo(s.db, h, 'volumen');
      for (let i = 0; i < d; i++) {
        insertarEvento(s.db, { device_hash: h, alarm_type: 'fall', event_type: 'alarm', created_at: '2026-06-04 01:00:00' });
      }
    }
    const { cuerpo } = await como('/riesgo');
    assert.equal(cuerpo.length, 15, 'top 15 según API.md');
    for (let i = 1; i < cuerpo.length; i++) {
      assert.ok(cuerpo[i - 1].puntaje >= cuerpo[i].puntaje, 'debe venir ordenado de mayor a menor riesgo');
    }
    assert.equal(cuerpo[0].id_anonimo, hV.slice(0, 8), 'el de mayor riesgo encabeza la lista');
  });

  test('el puntaje de una sola caída (3) supera al de un solo SOS (2)', async () => {
    // La caída pesa más porque el adulto mayor puede estar inconsciente y no
    // poder presionar el botón. Este orden es una decisión de producto: si
    // alguien lo invierte por error, este test lo detiene.
    const unaCaida = 3, unSos = 2;
    assert.ok(unaCaida > unSos);
    const { cuerpo } = await como('/riesgo');
    const fila = cuerpo.find(r => r.id_anonimo === hV.slice(0, 8));
    assert.equal(fila.puntaje, fila.fall * unaCaida + fila.sos * unSos);
  });

  test('ultima_alerta corresponde al evento más reciente del dispositivo', async () => {
    const { cuerpo } = await como('/riesgo');
    const fila = cuerpo.find(r => r.id_anonimo === hV.slice(0, 8));
    const maximo = s.db.prepare('SELECT MAX(created_at) AS m FROM events WHERE device_hash = ? AND alarm_type IS NOT NULL').get(hV).m;
    assert.equal(fila.ultima_alerta, maximo);
  });
});

describe('Comportamientos actuales documentados (hallazgos abiertos)', () => {
  test('H18: /stats ignora desde/hasta y devuelve el histórico completo', async () => {
    const conFiltro = (await como('/stats?desde=2026-06-01&hasta=2026-06-01')).cuerpo;
    const sinFiltro = (await como('/stats')).cuerpo;
    assert.deepEqual(conFiltro, sinFiltro,
      'el gráfico mensual no respeta el rango elegido en el dashboard (H18)');
  });

  test('H12: las agregaciones usan created_at (hora de llegada UTC), no timestamp del evento', async () => {
    // Un evento ocurrido el 2026-05-31 a las 23:00 en Chile llega al servidor
    // ya en junio UTC y se contabiliza en junio. Con eventos retrasados por
    // falta de cobertura, la diferencia puede ser de días.
    insertarEvento(s.db, {
      device_hash: hV, alarm_type: 'sos', event_type: 'alarm',
      timestamp: '2026-05-31T23:30:00Z',   // hora real del evento
      created_at: '2026-07-15 04:00:00',   // hora de llegada (reenvío tardío)
    });
    const enJulio = (await como('/summary?desde=2026-07-15&hasta=2026-07-15')).cuerpo;
    const enMayo = (await como('/summary?desde=2026-05-31&hasta=2026-05-31')).cuerpo;
    assert.equal(enJulio.sos, 1, 'se cuenta el día en que llegó');
    assert.equal(enMayo.sos, 0, 'no el día en que ocurrió (H12)');
  });
});

describe('/utilization — dispositivos activos por día', () => {
  test('cuenta dispositivos únicos, no eventos', async () => {
    const { cuerpo } = await como('/utilization');
    const dia = cuerpo.find(d => d.dia === '2026-06-25');
    assert.ok(dia, 'el día con 400 conexiones debe estar');
    assert.equal(dia.activos, 2, '400 conexiones de 2 dispositivos = 2 activos');
  });

  test('solo considera deviceOnline / deviceOffline, no las alarmas', async () => {
    const { cuerpo } = await como('/utilization');
    assert.equal(cuerpo.find(d => d.dia === '2026-06-01'), undefined,
      'el día que solo tiene alarmas no cuenta como utilización');
  });
});
