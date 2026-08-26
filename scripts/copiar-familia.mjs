/**
 * Copia una familia de tablas de Supabase a la base de YaDominios.
 *
 * CÓMO SE USA
 *   TOKEN_YAD=… PGPASSWORD=… node copiar-familia.mjs catalogo
 *   TOKEN_YAD=… PGPASSWORD=… node copiar-familia.mjs               (todas)
 *
 * REGLAS QUE SE RESPETAN
 * ----------------------
 * - **No se toca Supabase.** Solo se lee. Mientras dure la mudanza, la verdad
 *   sigue estando allí.
 * - Se puede correr las veces que haga falta: cada tabla se vacía y se vuelve a
 *   llenar, así el resultado es siempre el mismo.
 * - **Se cuenta antes y después.** Si el número no cuadra, se dice en rojo:
 *   una copia a medias que se dé por buena es peor que no copiar.
 * - `documento_lineas` y `pos_cash_movements` reciben el `bot_id` de su
 *   documento/turno: en SQLite no hay seguridad por filas y sin su propia
 *   tienda una consulta podría devolver líneas de otro negocio.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ejecutar = promisify(execFile);
const PSQL = '/opt/homebrew/opt/libpq/bin/psql';
const CONN = 'host=db.ekurbldypbygxfwbghik.supabase.co port=5432 dbname=postgres user=postgres sslmode=require';

const TOKEN = process.env.TOKEN_YAD;
if (!TOKEN) {
  console.error('Falta TOKEN_YAD.');
  process.exit(1);
}

const FAMILIAS = {
  catalogo: ['bots', 'sucursales', 'bot_knowledge_base', 'bot_combos', 'bot_banners', 'bot_coupons', 'bot_payment_methods', 'bot_collaborators'],
  clientes: ['pos_customers', 'bot_customers'],
  documentos: ['documentos_comerciales', 'documento_lineas', 'documento_contadores', 'bot_datos_emisor'],
  pedidos: ['client_requests'],
  pos: ['pos_registers', 'pos_sales', 'pos_cash_movements', 'pos_shipments', 'pos_devices', 'pos_deletions'],
};

/** De dónde saca la tienda una tabla hija que no la tiene. */
const HEREDA = {
  documento_lineas: { padre: 'documentos_comerciales', clave: 'documento_id' },
  pos_cash_movements: { padre: 'pos_registers', clave: 'register_id' },
};

async function d1(sql, params = []) {
  const r = await fetch('https://yapanel.yadominios.com/api/hosting/db/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sitio: 'qrbott', token: TOKEN, sql, params }),
  });
  const d = await r.json();
  if (d.error) throw new Error(`${d.error} :: ${sql.slice(0, 120)}`);
  return d;
}

/** Lee una tabla entera de Postgres como JSON, sin líos de separadores. */
async function leer(tabla, extra = '') {
  const sql = `select coalesce(json_agg(t), '[]'::json)::text from (select * from public.${tabla} ${extra}) t`;
  const { stdout } = await ejecutar(PSQL, [CONN, '-At', '-c', sql], { maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(stdout.trim() || '[]');
}

/** Las columnas que la tabla tiene en la base NUEVA (puede haber menos). */
async function columnasDestino(tabla) {
  const { results } = await d1(`PRAGMA table_info(${tabla})`);
  return (results || []).map((r) => r.name);
}

/** Postgres → SQLite: booleanos a 0/1, objetos a texto JSON. */
function valorSqlite(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

async function copiar(tabla) {
  const filas = await leer(tabla);
  const cols = await columnasDestino(tabla);
  if (cols.length === 0) {
    console.log(`  ${tabla.padEnd(26)} (no existe en destino, saltada)`);
    return { tabla, origen: filas.length, destino: 0, ok: false };
  }

  // Tablas hijas: se les pega la tienda de su padre.
  let mapaTienda = null;
  const h = HEREDA[tabla];
  if (h) {
    const padres = await leer(h.padre);
    mapaTienda = new Map(padres.map((p) => [p.id, p.bot_id]));
  }

  await d1(`DELETE FROM ${tabla}`);

  let puestas = 0;
  let sinTienda = 0;
  for (const fila of filas) {
    if (h) {
      fila.bot_id = mapaTienda.get(fila[h.clave]) ?? null;
      if (!fila.bot_id) {
        // Sin tienda no se copia: una fila suelta que nadie puede filtrar es
        // exactamente el agujero que esta mudanza quiere evitar.
        sinTienda++;
        continue;
      }
    }
    const usadas = cols.filter((c) => c in fila);
    const sql = `INSERT INTO ${tabla} (${usadas.join(', ')}) VALUES (${usadas.map(() => '?').join(', ')})`;
    await d1(sql, usadas.map((c) => valorSqlite(fila[c])));
    puestas++;
  }

  const { results } = await d1(`SELECT count(*) AS n FROM ${tabla}`);
  const destino = results[0].n;
  const esperadas = filas.length - sinTienda;
  const ok = destino === esperadas;
  console.log(
    `  ${tabla.padEnd(26)} ${String(filas.length).padStart(5)} → ${String(destino).padStart(5)}  ${ok ? 'OK' : 'MAL'}` +
      (sinTienda ? `  (${sinTienda} sin tienda, no se copiaron)` : ''),
  );
  return { tabla, origen: filas.length, destino, ok, sinTienda };
}

const pedidas = process.argv[2] ? [process.argv[2]] : Object.keys(FAMILIAS);
const resumen = [];
for (const fam of pedidas) {
  const tablas = FAMILIAS[fam];
  if (!tablas) {
    console.error(`Familia desconocida: ${fam}. Hay: ${Object.keys(FAMILIAS).join(', ')}`);
    process.exit(1);
  }
  console.log(`\n=== Familia: ${fam} ===`);
  for (const t of tablas) resumen.push(await copiar(t));
}

const mal = resumen.filter((r) => !r.ok);
const total = resumen.reduce((a, r) => a + r.destino, 0);
console.log(
  mal.length === 0
    ? `\n${total} filas copiadas y contadas. Todo cuadra.\n`
    : `\nNO CUADRA en ${mal.length} tabla(s): ${mal.map((m) => m.tabla).join(', ')}\n`,
);
process.exit(mal.length === 0 ? 0 : 1);
