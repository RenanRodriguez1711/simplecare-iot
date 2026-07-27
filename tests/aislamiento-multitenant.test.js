'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Aislamiento multi-tenant — el test más importante de la suite
//
// Un fallo acá es una fuga de datos de salud de adultos mayores entre
// municipios: incidente reportable bajo la Ley 21.719 y, en la práctica, fin
// del contrato. Se verifica endpoint por endpoint que el cliente A jamás vea
// un dato del cliente B.
// ─────────────────────────────────────────────────────────────────────────────

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarServidor, getJson } = require('./ayuda/servidor');
const { TOKEN_A, TOKEN_B, hA, hB, hC, DIA_A, DIA_B, ESPERADO_A, sembrarEscenario } = require('./ayuda/datos');

let s;
before(async () => {
  s = await iniciarServidor();
  sembrarEscenario(s.db);
});
after(async () => { await s.cerrar(); });

const comoA = (ruta) => getJson(s.url, `${ruta}${ruta.includes('?') ? '&' : '?'}token=${TOKEN_A}`);
const comoB = (ruta) => getJson(s.url, `${ruta}${ruta.includes('?') ? '&' : '?'}token=${TOKEN_B}`);

const hashesDeA = [hA, hC];

describe('/events — la tabla de alertas', () => {
  test('A solo ve sus propios dispositivos', async () => {
    const { status, cuerpo } = await comoA('/events');
    assert.equal(status, 200);
    assert.equal(cuerpo.length, ESPERADO_A.eventos);
    for (const e of cuerpo) {
      assert.ok(hashesDeA.includes(e.device_hash), `device_hash ajeno filtrado: ${e.device_hash}`);
      assert.notEqual(e.device_hash, hB);
    }
  });

  test('B ve sus 9 eventos y ninguno de A', async () => {
    const { cuerpo } = await comoB('/events');
    assert.equal(cuerpo.length, 9);
    for (const e of cuerpo) assert.equal(e.device_hash, hB);
  });

  test('el filtro por tipos no abre una puerta a datos ajenos', async () => {
    const { cuerpo } = await comoA('/events?tipos=fall,sos,low_battery');
    for (const e of cuerpo) assert.ok(hashesDeA.includes(e.device_hash));
    assert.equal(cuerpo.filter(e => e.alarm_type === 'fall').length, 1, 'A tiene 1 caída, no las 5 de B');
  });

  test('el filtro de fechas del día de B no le muestra a A los datos de B', async () => {
    const { cuerpo } = await comoA(`/events?desde=${DIA_B}&hasta=${DIA_B}`);
    assert.equal(cuerpo.length, 0, 'A no tiene eventos ese día y no debe heredar los de B');
  });
});

describe('/summary — tarjetas KPI', () => {
  test('los conteos de A corresponden solo a A', async () => {
    const { cuerpo } = await comoA('/summary');
    assert.deepEqual(cuerpo, {
      total: ESPERADO_A.total,
      sos: ESPERADO_A.sos,
      fall: ESPERADO_A.fall,
      low_battery: ESPERADO_A.low_battery,
      devices: ESPERADO_A.devices,
    });
  });

  test('los conteos de B corresponden solo a B', async () => {
    const { cuerpo } = await comoB('/summary');
    assert.deepEqual(cuerpo, { total: 8, sos: 3, fall: 5, low_battery: 0, devices: 1 });
  });

  test('la suma de A y B no delata eventos cruzados', async () => {
    const a = (await comoA('/summary')).cuerpo;
    const b = (await comoB('/summary')).cuerpo;
    const totalReal = s.db.prepare('SELECT COUNT(*) AS n FROM events WHERE alarm_type IS NOT NULL').get().n;
    assert.equal(a.total + b.total, totalReal, 'ningún evento debe contarse dos veces ni perderse');
  });
});

describe('/stats — gráfico mensual', () => {
  test('A no ve las 5 caídas de B en la agregación mensual', async () => {
    const { cuerpo } = await comoA('/stats');
    const caidas = cuerpo.filter(r => r.alarm_type === 'fall');
    assert.equal(caidas.length, 1, 'una sola fila de caídas');
    assert.equal(caidas[0].total, 1, 'con total 1, no 6');
    const suma = cuerpo.reduce((acc, r) => acc + r.total, 0);
    assert.equal(suma, ESPERADO_A.eventos, 'el total agregado debe ser exactamente el universo de A');
  });

  test('B ve sus 5 caídas', async () => {
    const { cuerpo } = await comoB('/stats');
    const caidas = cuerpo.filter(r => r.alarm_type === 'fall');
    assert.equal(caidas[0].total, 5);
  });
});

describe('/heatmap — mapa de calor', () => {
  test('A solo recibe coordenadas de su propia comuna', async () => {
    const { cuerpo } = await comoA('/heatmap');
    assert.equal(cuerpo.length, ESPERADO_A.heatmap);
    for (const p of cuerpo) {
      assert.ok(p.lat_zone < -33 && p.lat_zone > -34, `coordenada fuera de la zona de A: ${p.lat_zone}`);
      assert.notEqual(p.lat_zone, -20.20, 'coordenada de B filtrada');
    }
  });

  test('B recibe solo las suyas', async () => {
    const { cuerpo } = await comoB('/heatmap');
    assert.equal(cuerpo.length, 8);
    for (const p of cuerpo) assert.ok(p.lat_zone < -20 && p.lat_zone > -21);
  });

  test('un tipo inválido en el filtro no desactiva el aislamiento', async () => {
    const { cuerpo } = await comoA('/heatmap?tipos=sos,fall,low_battery,__todo__');
    for (const p of cuerpo) assert.ok(p.lat_zone < -33);
  });
});

describe('/utilization — utilización diaria', () => {
  test('A ve solo su día de actividad', async () => {
    const { cuerpo } = await comoA('/utilization');
    assert.equal(cuerpo.length, 1);
    assert.equal(cuerpo[0].dia, DIA_A);
    assert.equal(cuerpo[0].activos, 1);
  });

  test('B ve solo el suyo', async () => {
    const { cuerpo } = await comoB('/utilization');
    assert.equal(cuerpo.length, 1);
    assert.equal(cuerpo[0].dia, DIA_B);
  });
});

describe('/riesgo — panel de riesgo por persona', () => {
  test('A solo ve a sus propias personas', async () => {
    const { cuerpo } = await comoA('/riesgo');
    assert.equal(cuerpo.length, 1, 'solo hA supera puntaje 0');
    assert.equal(cuerpo[0].id_anonimo, hA.slice(0, 8));
    assert.notEqual(cuerpo[0].id_anonimo, hB.slice(0, 8));
  });

  test('B solo ve a las suyas', async () => {
    const { cuerpo } = await comoB('/riesgo');
    assert.equal(cuerpo.length, 1);
    assert.equal(cuerpo[0].id_anonimo, hB.slice(0, 8));
  });
});

describe('/dispositivo/:id — historial individual', () => {
  test('A consulta su propio dispositivo y obtiene su historial', async () => {
    const { cuerpo } = await comoA(`/dispositivo/${hA.slice(0, 8)}`);
    assert.equal(cuerpo.length, 3, '2 SOS + 1 caída con coordenadas');
  });

  test('A consulta el device_hash de B y recibe una lista vacía', async () => {
    const { status, cuerpo } = await comoA(`/dispositivo/${hB.slice(0, 8)}`);
    assert.equal(status, 200);
    assert.deepEqual(cuerpo, [], 'acceso directo por identificador ajeno: debe devolver nada');
  });

  test('A con el hash completo de B tampoco obtiene datos', async () => {
    const { cuerpo } = await comoA(`/dispositivo/${hB}`);
    assert.deepEqual(cuerpo, []);
  });

  test('B consulta el dispositivo de A y recibe una lista vacía', async () => {
    const { cuerpo } = await comoB(`/dispositivo/${hA.slice(0, 8)}`);
    assert.deepEqual(cuerpo, []);
  });

  test('el saneado del :id evita inyección y comodines', async () => {
    for (const id of ["' OR 1=1 --", '%', '________', '../../etc/passwd']) {
      const { status, cuerpo } = await comoA(`/dispositivo/${encodeURIComponent(id)}`);
      assert.equal(status, 200);
      assert.deepEqual(cuerpo, [], `id malicioso "${id}" no debe devolver filas`);
    }
  });
});

describe('/export — descarga CSV', () => {
  test('el CSV de A no contiene ni una coordenada de B', async () => {
    const { status, texto } = await comoA('/export');
    assert.equal(status, 200);
    assert.ok(!texto.includes('-20.2'), 'zona geográfica de B presente en el CSV de A');
    const filas = texto.trim().split('\n');
    assert.equal(filas.length, ESPERADO_A.filasCsv + 1, 'encabezado + filas de A únicamente');
  });

  test('el CSV de B no contiene coordenadas de A', async () => {
    const { texto } = await comoB('/export');
    assert.ok(!texto.includes('-33.5'));
    assert.equal(texto.trim().split('\n').length, 8 + 1);
  });

  test('el CSV mantiene el BOM UTF-8 para Excel (A012)', async () => {
    // Se revisan los BYTES: fetch().text() descarta el BOM al decodificar.
    const r = await fetch(`${s.url}/export?token=${TOKEN_A}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xEF, 0xBB, 0xBF],
      'sin BOM, Excel rompe las tildes y la ñ');
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="simplecare_.*\.csv"/);
  });

  test('el encabezado del CSV es el documentado en API.md', async () => {
    const { texto } = await comoA('/export');
    assert.equal(texto.replace(/^﻿/, '').split('\n')[0], 'fecha,tipo_alerta,zona_lat,zona_lon');
  });
});

describe('Aislamiento estructural', () => {
  test('ningún endpoint devuelve datos si el cliente no tiene dispositivos asignados', async () => {
    s.db.prepare('INSERT OR REPLACE INTO clients (client_id, nombre, token) VALUES (?,?,?)')
      .run('sin-datos', 'Municipio Sin Dispositivos', 'token-sin-datos');
    for (const ruta of ['/events', '/stats', '/heatmap', '/utilization', '/riesgo']) {
      const { cuerpo } = await getJson(s.url, `${ruta}?token=token-sin-datos`);
      assert.deepEqual(cuerpo, [], `${ruta} debe venir vacío para un cliente sin dispositivos`);
    }
    const { cuerpo } = await getJson(s.url, '/summary?token=token-sin-datos');
    assert.deepEqual(cuerpo, { total: 0, sos: 0, fall: 0, low_battery: 0, devices: 0 });
  });

  test('S13 (documentado): /events devuelve el device_hash COMPLETO, no el prefijo de 8', async () => {
    // PRIVACIDAD.md dice que el municipio solo ve un identificador corto.
    // La API entrega los 16 caracteres. No es una fuga entre clientes, pero sí
    // una contradicción con la documentación. Ver INFORME_SEGURIDAD.md S13.
    const { cuerpo } = await comoA('/events');
    assert.equal(cuerpo[0].device_hash.length, 16,
      'si esto pasa a 8, S13 fue corregido y hay que actualizar este test');
  });

  test('el cliente demo no ve los dispositivos ya asignados a un municipio real', async () => {
    const { cuerpo } = await getJson(s.url, '/events?token=demo-token-dev-only');
    for (const e of cuerpo) {
      assert.notEqual(e.device_hash, hA);
      assert.notEqual(e.device_hash, hB);
      assert.notEqual(e.device_hash, hC);
    }
  });
});
