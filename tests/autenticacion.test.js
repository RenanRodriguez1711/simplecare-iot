'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Autenticación por token (middleware requireClient)
//
// Es la única barrera entre internet y los datos de un municipio. Se verifica
// en los 8 endpoints protegidos, uno por uno: no basta con probar uno y asumir
// que el middleware está montado en el resto.
// ─────────────────────────────────────────────────────────────────────────────

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarServidor, getJson, ENDPOINTS_PROTEGIDOS } = require('./ayuda/servidor');
const { TOKEN_A, sembrarEscenario } = require('./ayuda/datos');

let s;
before(async () => {
  s = await iniciarServidor();
  sembrarEscenario(s.db);
});
after(async () => { await s.cerrar(); });

describe('Sin token → 401', () => {
  for (const ruta of ENDPOINTS_PROTEGIDOS) {
    test(`GET ${ruta} sin token responde 401`, async () => {
      const r = await getJson(s.url, ruta);
      assert.equal(r.status, 401, `${ruta} debe exigir token`);
      assert.equal(r.cuerpo.error, 'Falta token');
    });
  }
});

describe('Token inválido → 403', () => {
  const tokensInvalidos = [
    ['inexistente', 'token-que-no-existe'],
    ['vacío tras el signo igual', ''],
    ['con espacios', '   '],
    ['prefijo del token válido', TOKEN_A.slice(0, 8)],
    ['token válido con sufijo', `${TOKEN_A}x`],
    ['intento de inyección SQL', "' OR '1'='1"],
    ['comodín SQL LIKE', '%'],
  ];

  for (const ruta of ENDPOINTS_PROTEGIDOS) {
    for (const [descripcion, token] of tokensInvalidos) {
      test(`GET ${ruta} con token ${descripcion} responde 401/403`, async () => {
        const r = await getJson(s.url, `${ruta}?token=${encodeURIComponent(token)}`);
        // Un token vacío cae en la rama "falta token" (401); el resto en 403.
        const esperado = token === '' ? 401 : 403;
        assert.equal(r.status, esperado, `${ruta} con token "${token}"`);
        assert.ok(!Array.isArray(r.cuerpo), 'nunca debe devolver datos');
      });
    }
  }

  test('la comparación de token es exacta: no se puede autenticar con un comodín', async () => {
    const r = await getJson(s.url, '/summary?token=%25');
    assert.equal(r.status, 403, 'el % de LIKE no debe funcionar en una comparación con =');
  });
});

describe('Token válido → 200', () => {
  for (const ruta of ENDPOINTS_PROTEGIDOS) {
    test(`GET ${ruta} con token válido responde 200`, async () => {
      const r = await getJson(s.url, `${ruta}?token=${TOKEN_A}`);
      assert.equal(r.status, 200, ruta);
    });
  }
});

describe('Superficie no protegida (comportamiento actual documentado)', () => {
  test('POST /webhook no exige autenticación (S06 — hallazgo abierto)', async () => {
    const r = await fetch(`${s.url}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { type: 'alarm', deviceId: 1, attributes: { alarm: 'sos' } } }),
    });
    assert.equal(r.status, 200, 'hoy cualquiera en la red puede inyectar eventos');
  });

  test('GET /dashboard se sirve sin token (S17 — hallazgo abierto)', async () => {
    const r = await fetch(`${s.url}/dashboard`);
    assert.equal(r.status, 200, 'el HTML es público; los datos sí requieren token');
    const html = await r.text();
    assert.ok(!html.includes(TOKEN_A), 'al menos el HTML no debe filtrar tokens de clientes');
  });
});
