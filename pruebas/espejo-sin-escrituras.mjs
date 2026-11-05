/**
 * CANDADO — EL ESPEJO NO ESCRIBE LO QUE NO CAMBIÓ (3-11-2026, la base más cara de la cuenta).
 *
 * site-qrbott-db llegó a 75 millones de filas escritas en el ciclo: ráfagas de 1,8 a 3,8
 * millones por hora. Causa: cada vuelta reescribía las ~7.000 filas con INSERT OR REPLACE,
 * y cada visita arrancaba otra vuelta mientras la anterior copiaba (103 vueltas en una hora).
 *
 * Sobre una base SQLite de verdad (node:sqlite, el mismo motor de D1) con el esquema del
 * sitio, y un Supabase de mentira:
 *   1. La primera vuelta copia todo.
 *   2. La segunda, sin cambios en Supabase, escribe 0 filas (contado por SQLite, no por nosotros).
 *   3. Si cambia una fila, se escribe solo esa; si se borra una, solo se borra esa.
 *   4. Dos vueltas a la vez (sin forzar): solo una copia; la otra se salta.
 *   5. Pasados 5 minutos, la siguiente vuelta sí toma el turno.
 *
 *   node pruebas/espejo-sin-escrituras.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import * as espejo from '../src/espejo.js';
const { espejar, CADA_MS } = espejo;

const fallos = [];
const ok = (c, q) => { console.log(`${c ? '  OK  ' : '  MAL '} ${q}`); if (!c) fallos.push(q); };

// ── La base: SQLite real con el esquema del sitio, envuelta como env.DB de D1 ──
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
sqlite.exec("CREATE TABLE IF NOT EXISTS _config (clave TEXT PRIMARY KEY, valor TEXT); INSERT INTO _config VALUES ('clave_supabase', 'clave-de-prueba');");
const totalCambios = () => Number(sqlite.prepare('SELECT total_changes() AS n').get().n);

function preparar(sql, params = []) {
  const correr = () => {
    const st = sqlite.prepare(sql);
    if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: st.all(...params), meta: { rows_written: 0, changes: 0 } };
    const r = st.run(...params);
    return { results: [], meta: { rows_written: Number(r.changes), changes: Number(r.changes) } };
  };
  return {
    bind: (...p) => preparar(sql, p),
    run: async () => correr(),
    all: async () => correr(),
    first: async () => correr().results[0] ?? null,
    _correr: correr,
  };
}
const DB = {
  prepare: (sql) => preparar(sql),
  batch: async (stmts) => { sqlite.exec('BEGIN'); try { const r = stmts.map((s) => s._correr()); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } },
};

// ── Supabase de mentira ──
const BOT = '11111111-1111-1111-1111-111111111111';
const datos = {
  bots: [{ id: BOT, user_id: 'u1', name: "Tienda de 'prueba' — ñandú", description: null, is_active: true, created_at: '2026-11-01T10:00:00+00:00' }],
  sucursales: [1, 2, 3].map((i) => ({ id: `s${i}`, bot_id: BOT, nombre: `Sucursal ${i}`, activa: true, created_at: '2026-11-01T10:00:00+00:00' })),
  pos_sales: Array.from({ length: 120 }, (_, i) => ({ id: `v${i}`, bot_id: BOT, customer_id: 'c1', seller_id: 'u1', receipt_number: i + 1, items: [{ n: i, p: 1.25 }], subtotal: 10.5 + i, total: 10.5 + i, payments: [{ metodo: 'efectivo', monto: 10.5 + i }], extemporanea: false, created_at: '2026-11-02T10:00:00+00:00' })),
};
let lecturas = 0;
globalThis.fetch = async (url) => {
  lecturas++;
  const tabla = new URL(url).pathname.split('/').pop();
  return new Response(JSON.stringify(datos[tabla] ?? []), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const env = { DB, SUPABASE_URL: 'https://supabase.invalid' };

// 1. Primera vuelta
const c0 = totalCambios();
const v1 = await espejar(env, { forzar: true });
const escritas1 = totalCambios() - c0;
ok(v1.ok && escritas1 >= 124, `1. la primera vuelta copia todo (${escritas1} escrituras, ${v1.problemas?.join('; ') || 'sin problemas'})`);
ok(Number(sqlite.prepare('SELECT count(*) n FROM pos_sales').get().n) === 120, '1. las 120 ventas están aquí');

// 2. Segunda vuelta sin cambios
const c1 = totalCambios();
const v2 = await espejar(env, { forzar: true });
const escritas2 = totalCambios() - c1;
// Fuera del espejo propiamente: el turno (1) y la línea de la bitácora _espejo (1).
ok(escritas2 <= 2 && v2.escritas === 0, `2. sin cambios en Supabase, el espejo escribe 0 filas (SQLite contó ${escritas2}: turno + bitácora; el espejo dice ${v2.escritas})`);

// 2b. La base por sí sola: aunque llegue una fila igual, el UPSERT no la reescribe.
if (espejo.sentenciasDeInsercion) {
  const cols = Object.keys(datos.pos_sales[0]);
  const antesSql = totalCambios();
  for (const st of espejo.sentenciasDeInsercion('pos_sales', cols, datos.pos_sales)) sqlite.prepare(st).run();
  ok(totalCambios() - antesSql === 0, `2. reenviar las 120 ventas iguales no escribe ninguna (SQLite contó ${totalCambios() - antesSql})`);
} else ok(false, '2. el espejo expone sentenciasDeInsercion con UPSERT condicionado');

// 3. Un cambio y un borrado
datos.pos_sales[7].total = 999;
datos.pos_sales.pop();
const c2 = totalCambios();
const v3 = await espejar(env, { forzar: true });
const escritas3 = totalCambios() - c2;
ok(v3.cambiadas === 1 && v3.escritas === 2 && escritas3 <= 4, `3. una venta cambiada y una borrada → 2 escrituras (espejo ${v3.escritas}, SQLite ${escritas3})`);
ok(Number(sqlite.prepare("SELECT total FROM pos_sales WHERE id = 'v7'").get().total) === 999 && Number(sqlite.prepare('SELECT count(*) n FROM pos_sales').get().n) === 119, '3. el cambio y el borrado llegaron');
ok(sqlite.prepare(`SELECT name FROM bots WHERE id = '${BOT}'`).get().name === "Tienda de 'prueba' — ñandú", '3. el texto con comillas y tildes viaja intacto');

// 4. Dos vueltas a la vez, sin forzar (el turno de la vuelta 3 sigue vigente: ninguna copia)
sqlite.exec('UPDATE _espejo_turno SET hora = 0'); // como si la última vuelta fuera de hace mucho
lecturas = 0;
const [a, b] = await Promise.all([espejar(env), espejar(env)]);
const copiaron = [a, b].filter((r) => !r.saltada).length;
ok(copiaron === 1, `4. dos visitas a la vez: copia solo una (copiaron ${copiaron})`);
const c3 = lecturas;
const v5 = await espejar(env);
ok(v5.saltada === true && lecturas === c3, '4. dentro de los 5 minutos nadie más copia (ni lee a Supabase)');

// 5. Pasados 5 minutos
sqlite.exec(`UPDATE _espejo_turno SET hora = ${Date.now() - CADA_MS - 1000}`);
const v6 = await espejar(env);
ok(!v6.saltada && v6.escritas === 0, '5. pasados 5 minutos la siguiente vuelta toma el turno (y sigue sin escribir nada)');

// 6. El presupuesto: una vuelta que quiere escribir de más FRENA antes de escribir (regla «la nube no se come el dinero»).
for (const v of datos.pos_sales) v.total += 1; // 119 ventas cambian de golpe
sqlite.exec(`UPDATE _espejo_turno SET hora = 0`);
const c6 = totalCambios();
const v7 = await espejar(env, { forzar: true, tope: 50 });
const escritasTope = totalCambios() - c6;
ok(v7.frenada === true && v7.escritas === 0, `6. con tope de 50 y 119 cambios, la vuelta frena sin escribir (espejo ${v7.escritas}, frenada ${v7.frenada})`);
ok(escritasTope <= 2, `6. SQLite no contó escrituras de ventas (solo turno y bitácora: ${escritasTope})`);
ok((v7.problemas || []).some((p) => /tope_escrituras/.test(p)), '6. el problema queda anotado en la bitácora');
const consumo = await espejo.consumoDelEspejo(DB);
ok(consumo.color === 'amarillo' && consumo.vueltas_frenadas_24h >= 1, `6. el canario lo muestra (${consumo.color}, ${consumo.vueltas_frenadas_24h} frenadas)`);
const v8 = await espejar(env, { forzar: true });
ok(!v8.frenada && v8.cambiadas === 119, '6. con el tope normal, la vuelta siguiente sí copia los cambios');

console.log(fallos.length ? `\nFALLÓ (${fallos.length}):\n - ${fallos.join('\n - ')}\n` : '\nTODO EN VERDE: el espejo solo escribe lo que cambió, y una sola vuelta a la vez.\n');
process.exit(fallos.length ? 1 : 0);
