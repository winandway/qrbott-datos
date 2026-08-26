/**
 * Traduce el esquema de Postgres (Supabase) a SQLite (D1 de YaDominios) para
 * las familias que de verdad se usan.
 *
 * POR QUÉ UN GENERADOR Y NO ESCRIBIRLO A MANO
 * -------------------------------------------
 * Son cientos de columnas. A mano se olvida una, se cae un dato el día de la
 * mudanza y nadie se entera hasta que un cliente lo reclama. Esto lee la
 * estructura REAL de la base y la traduce entera.
 *
 * DIFERENCIAS QUE HAY QUE RESPETAR
 * --------------------------------
 * - SQLite no tiene uuid, jsonb, timestamptz ni numeric: van como TEXT y REAL.
 * - No tiene seguridad por filas: NINGUNA tabla lleva su propio candado. La
 *   frontera entre tiendas la pone la capa de acceso del worker, y por eso
 *   todas las tablas de negocio llevan `bot_id` obligatorio.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';

const ejecutar = promisify(execFile);
const PSQL = '/opt/homebrew/opt/libpq/bin/psql';
const CONN = 'host=db.ekurbldypbygxfwbghik.supabase.co port=5432 dbname=postgres user=postgres sslmode=require';
const SEP = '~|~';

/** Familias vivas, en el orden en que se van a mudar. */
const FAMILIAS = {
  catalogo: ['bots', 'sucursales', 'bot_knowledge_base', 'bot_combos', 'bot_banners', 'bot_coupons', 'bot_payment_methods', 'bot_collaborators'],
  clientes: ['pos_customers', 'bot_customers'],
  documentos: ['documentos_comerciales', 'documento_lineas', 'documento_contadores', 'bot_datos_emisor'],
  pedidos: ['client_requests'],
  pos: ['pos_registers', 'pos_sales', 'pos_cash_movements', 'pos_shipments', 'pos_stock_faltantes', 'pos_devices', 'pos_deletions'],
};

/** Postgres → SQLite. SQLite solo tiene TEXT, INTEGER, REAL, BLOB. */
function tipoSqlite(pg) {
  if (/^(numeric|double|real|decimal)/.test(pg)) return 'REAL';
  if (/^(integer|bigint|smallint)/.test(pg)) return 'INTEGER';
  if (/^boolean/.test(pg)) return 'INTEGER'; // 0/1
  return 'TEXT'; // uuid, text, jsonb, timestamptz, enums… todo cabe aquí
}

/** El valor por defecto de Postgres, en lo que SQLite entiende. */
function porDefecto(def, tipo) {
  if (!def) return '';
  if (/gen_random_uuid|nextval/.test(def)) return ''; // lo pone quien inserta
  if (/^now\(\)/.test(def)) return " DEFAULT (datetime('now'))";
  if (/^true$/.test(def)) return ' DEFAULT 1';
  if (/^false$/.test(def)) return ' DEFAULT 0';
  const texto = def.match(/^'(.*)'::/);
  if (texto) return ` DEFAULT '${texto[1].replace(/'/g, "''")}'`;
  const num = def.match(/^(-?\d+(\.\d+)?)/);
  if (num) return ` DEFAULT ${num[1]}`;
  if (/'\{\}'|'\[\]'/.test(def)) return ` DEFAULT '${def.includes('[') ? '[]' : '{}'}'`;
  return '';
}

async function columnas(tabla) {
  const sql = `select column_name, data_type, is_nullable, coalesce(column_default,'') from information_schema.columns where table_schema='public' and table_name='${tabla}' order by ordinal_position`;
  const { stdout } = await ejecutar(PSQL, [CONN, '-At', '-F', SEP, '-c', sql], { maxBuffer: 32 * 1024 * 1024 });
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [nombre, tipo, nulo, def] = l.split(SEP);
      return { nombre, tipo, nulo, def };
    });
}

const partes = [
  '-- =====================================================================',
  '-- QRbott — esquema de la base en YaDominios Cloud (SQLite / D1)',
  '-- GENERADO desde la estructura real de Supabase. No editar a mano:',
  '-- se regenera con scripts/generar-esquema.mjs y se vuelve a publicar.',
  '--',
  '-- OJO, LO MÁS IMPORTANTE: SQLite NO tiene seguridad por filas. Aquí no hay',
  '-- ni una política. La frontera que impide que una tienda vea los datos de',
  '-- otra vive en la capa de acceso del worker (`_worker.js`), que añade el',
  '-- filtro de tienda a TODA consulta. Por eso cada tabla de negocio lleva su',
  '-- `bot_id` y hay un índice por él.',
  '-- =====================================================================',
  '',
];

let totalTablas = 0;
let totalColumnas = 0;

for (const [familia, tablas] of Object.entries(FAMILIAS)) {
  partes.push(`-- ---------- Familia: ${familia} ----------`, '');
  for (const t of tablas) {
    const cols = await columnas(t);
    if (!cols.length) {
      console.log(`   (saltada, no existe) ${t}`);
      continue;
    }
    let tieneBot = cols.some((c) => c.nombre === 'bot_id') || t === 'bots';
    // Tablas hijas que en Postgres se protegían por su padre (documento_lineas
    // por documentos_comerciales). Sin seguridad por filas eso no vale: si la
    // tabla no lleva su propia tienda, una consulta puede olvidarla y devolver
    // líneas de otro negocio. Se le añade `bot_id` a propósito.
    const HIJAS = { documento_lineas: 'documentos_comerciales', pos_cash_movements: 'pos_registers' };
    if (!tieneBot && HIJAS[t]) {
      cols.splice(1, 0, { nombre: 'bot_id', tipo: 'uuid', nulo: 'NO', def: '' });
      tieneBot = true;
      console.log(`      + bot_id añadido a ${t} (heredado de ${HIJAS[t]})`);
    }
    const lineas = cols.map((c) => {
      const pk = c.nombre === 'id' ? ' PRIMARY KEY' : '';
      const nn = c.nulo === 'NO' && !pk ? ' NOT NULL' : '';
      return `  ${c.nombre} ${tipoSqlite(c.tipo)}${pk}${nn}${porDefecto(c.def, c.tipo)}`;
    });
    partes.push(`CREATE TABLE IF NOT EXISTS ${t} (`, lineas.join(',\n'), ');');
    if (tieneBot && t !== 'bots') {
      partes.push(`CREATE INDEX IF NOT EXISTS ${t}_bot_idx ON ${t} (bot_id);`);
    }
    partes.push('');
    totalTablas++;
    totalColumnas += cols.length;
    console.log(`   ${t}: ${cols.length} columnas${tieneBot ? '' : '  ← SIN bot_id, revisar'}`);
  }
}

// Quién puede ver qué tienda. Es la pieza de la que depende TODA la seguridad.
partes.push(
  '-- ---------- Accesos: de esto depende toda la seguridad ----------',
  '--',
  '-- Reemplaza a las 360 políticas de Supabase. La capa de acceso lee esta',
  '-- tabla para saber qué tiendas puede tocar cada persona, y filtra por ahí.',
  '-- Si esta tabla queda vacía para alguien, no ve NADA. Falla cerrando.',
  'CREATE TABLE IF NOT EXISTS _acceso (',
  '  user_id TEXT NOT NULL,',
  '  bot_id TEXT NOT NULL,',
  "  rol TEXT NOT NULL DEFAULT 'dueno',   -- dueno | socio | vendedor",
  "  puede_editar INTEGER NOT NULL DEFAULT 1,",
  "  actualizado_en TEXT NOT NULL DEFAULT (datetime('now')),",
  '  PRIMARY KEY (user_id, bot_id)',
  ');',
  'CREATE INDEX IF NOT EXISTS _acceso_user_idx ON _acceso (user_id);',
  '',
);

writeFileSync('/Users/windocellc/qrbott-datos/schema.sql', partes.join('\n'));
console.log(`\nEsquema escrito: ${totalTablas} tablas, ${totalColumnas} columnas.`);
