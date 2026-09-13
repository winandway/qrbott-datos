/**
 * EL ESPEJO — mantiene esta base al día con Supabase, desde DENTRO del sitio.
 *
 * POR QUÉ AQUÍ Y NO EN UN WORKER APARTE
 * -------------------------------------
 * Primero vivió como un Worker con reloj en nuestra propia cuenta de
 * Cloudflare. No funcionó: el reloj se registraba, Cloudflare decía haberlo
 * ejecutado, y no pasaba nada (medido con `wrangler tail`: cero invocaciones de
 * reloj en 150 segundos). Además esa cuenta es del plan gratuito, con 50
 * peticiones por invocación, y eso obligaba a partir el trabajo en cinco tandas.
 *
 * Aquí dentro todo es mejor, y no por opinión: YaDominios confirmó por escrito
 * (8-09-2026) que el worker de un sitio corre en SU cuenta de pago, con 1.000
 * peticiones por invocación, 30 s de CPU y 128 MB. Y sobre todo: aquí la base
 * es un ENLACE DIRECTO (`env.DB`), no una llamada de red. Las 2.262 filas se
 * escriben sin gastar ni una petición; solo se gastan las ~21 lecturas a
 * Supabase. De veinte tandas a una sola pasada.
 *
 * QUIÉN LE DA CUERDA
 * ------------------
 * El Vigilante de YaDominios pide la portada de este sitio cada 5 minutos para
 * comprobar que responde. Esa visita —o cualquier otra— dispara el espejo si la
 * última copia tiene más de 5 minutos. No hace falta reloj propio: se aprovecha
 * el que la plataforma ya tiene. Y queda `POST /espejo/correr` con la llave para
 * forzarlo a mano y para los candados.
 *
 * DOS REGLAS QUE NO SE ROMPEN
 * ---------------------------
 * 1. La tabla NUNCA se vacía: nada de borrar y volver a llenar, sino
 *    `INSERT OR REPLACE` y, al final, retirar solo lo que ya no existe en
 *    Supabase. Nadie puede ver su catálogo a medio llenar.
 * 2. Supabase solo se LEE. Sigue siendo la verdad hasta el final de la mudanza.
 */

const FAMILIAS = {
  catalogo: ['bots', 'sucursales', 'bot_knowledge_base', 'bot_combos', 'bot_banners', 'bot_coupons', 'bot_payment_methods', 'bot_collaborators'],
  clientes: ['pos_customers', 'bot_customers'],
  documentos: ['documentos_comerciales', 'documento_lineas', 'documento_contadores', 'bot_datos_emisor'],
  pedidos: ['client_requests'],
  pos: ['pos_registers', 'pos_sales', 'pos_cash_movements', 'pos_shipments', 'pos_devices', 'pos_deletions'],
};

/**
 * Con qué se identifica una fila. Casi todas por `id`, pero dos no lo tienen: la
 * ficha del emisor es una por tienda, y los contadores de documentos uno por
 * tienda y tipo. Sin esto, `INSERT OR REPLACE` no reemplaza y las duplica.
 */
const CLAVE = { bot_datos_emisor: ['bot_id'], documento_contadores: ['bot_id', 'tipo'] };
const claveDe = (t) => CLAVE[t] || ['id'];

/** Tablas hijas sin tienda propia: la heredan de su padre, que va antes en la lista. */
const HEREDA = {
  documento_lineas: { padre: 'documentos_comerciales', clave: 'documento_id' },
  pos_cash_movements: { padre: 'pos_registers', clave: 'register_id' },
};

const TOPE_SENTENCIA = 80000; // D1 admite 100 KB por sentencia
const PAGINA = 1000;
export const CADA_MS = 5 * 60 * 1000;

/** Un valor de Postgres como literal de SQLite. Comillas dobladas y sin bytes nulos. */
function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = (typeof v === 'object' ? JSON.stringify(v) : String(v))
    .split(String.fromCharCode(0)).join('')
    .split("'").join("''");
  return `'${s}'`;
}

// El worker del sitio lleva la URL fija (no viene por variables): se usa la misma.
const SUPABASE_URL = 'https://ekurbldypbygxfwbghik.supabase.co';

async function leerDeSupabase(env, clave, tabla, columnas = '*') {
  const filas = [];
  for (let desde = 0; ; desde += PAGINA) {
    // Supabase a veces contesta 502/503/504 un instante (pasó el 13-09-2026 con dos
    // tablas en plena batería). Un mal segundo suyo no puede dejar una tabla sin
    // copiar hasta la próxima vuelta: se reintenta hasta tres veces con una pausa.
    let r;
    for (let intento = 1; ; intento++) {
      r = await fetch(`${env.SUPABASE_URL || SUPABASE_URL}/rest/v1/${tabla}?select=${columnas}`, {
        headers: { apikey: clave, Authorization: `Bearer ${clave}`, Range: `${desde}-${desde + PAGINA - 1}`, 'Range-Unit': 'items' },
      });
      if (r.ok || r.status < 500 || intento >= 3) break;
      await new Promise((f) => setTimeout(f, 1500 * intento));
    }
    if (!r.ok) throw new Error(`supabase ${tabla} ${r.status}`);
    const tanda = await r.json();
    filas.push(...tanda);
    if (tanda.length < PAGINA) return filas;
  }
}

/** Agrupa filas en sentencias `INSERT ... VALUES (..),(..)` que no pasen del tope. */
function sentenciasDeInsercion(tabla, columnas, filas) {
  const cabeza = `INSERT OR REPLACE INTO ${tabla} (${columnas.join(', ')}) VALUES `;
  const salida = [];
  let grupo = [];
  let bytes = cabeza.length;
  for (const f of filas) {
    const v = `(${columnas.map((c) => literal(f[c])).join(', ')})`;
    if (bytes + v.length + 2 > TOPE_SENTENCIA && grupo.length) {
      salida.push(cabeza + grupo.join(','));
      grupo = [];
      bytes = cabeza.length;
    }
    grupo.push(v);
    bytes += v.length + 1;
  }
  if (grupo.length) salida.push(cabeza + grupo.join(','));
  return salida;
}

/** Las columnas de cada tabla, del esquema guardado en la propia base. */
async function columnasDeTodas(db) {
  const { results } = await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all();
  const mapa = {};
  for (const f of results || []) {
    const txt = String(f.sql || '');
    mapa[f.name] = txt
      .slice(txt.indexOf('(') + 1, txt.lastIndexOf(')'))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(l))
      .map((l) => l.split(/[\s(]/)[0].replace(/["`[\],]/g, ''))
      .filter(Boolean);
  }
  return mapa;
}

async function espejarTabla(env, clave, db, tabla, cols, padres) {
  if (!cols?.length) return { tabla, saltada: true };
  const filas = await leerDeSupabase(env, clave, tabla);
  const h = HEREDA[tabla];

  const vivas = [];
  let sinTienda = 0;
  for (const fila of filas) {
    if (h) {
      fila.bot_id = padres[h.padre]?.get(fila[h.clave]) ?? null;
      if (!fila.bot_id) { sinTienda++; continue; } // sin tienda no se puede filtrar: no entra
    }
    vivas.push(fila);
  }

  const usadas = cols.filter((c) => vivas.some((f) => c in f));
  if (vivas.length) {
    const stmts = sentenciasDeInsercion(tabla, usadas, vivas).map((s) => db.prepare(s));
    for (let i = 0; i < stmts.length; i += 10) await db.batch(stmts.slice(i, i + 10)); // cada lote, una transacción
  }

  const k = claveDe(tabla);
  const comoTexto = (f) => JSON.stringify(k.map((c) => String(f[c] ?? '')));
  const allá = new Set(vivas.map(comoTexto));
  const { results: aquí } = await db.prepare(`SELECT ${k.join(', ')} FROM ${tabla}`).all();
  const sobran = (aquí || []).filter((f) => !allá.has(comoTexto(f)));
  if (sobran.length) {
    const trozos = [];
    for (let i = 0; i < sobran.length; i += 200) trozos.push(sobran.slice(i, i + 200));
    await db.batch(
      trozos.map((t) =>
        db.prepare(`DELETE FROM ${tabla} WHERE ${t.map((f) => `(${k.map((c) => `${c} = ${literal(f[c])}`).join(' AND ')})`).join(' OR ')}`),
      ),
    );
  }

  const destino = (aquí || []).length - sobran.length;
  return { tabla, origen: filas.length, destino, esperadas: vivas.length, sinTienda, borradas: sobran.length, ok: destino === vivas.length, filasLeidas: filas };
}

/** Copia TODAS las familias de una pasada. Aquí caben: la base es un enlace, no una llamada. */
export async function espejar(env) {
  const t0 = Date.now();
  const db = env.DB;
  const clave = (await db.prepare("SELECT valor FROM _config WHERE clave = 'clave_supabase'").first())?.valor;
  if (!clave) return { ok: false, filas: 0, tablas: 0, segundos: 0, hora: new Date().toISOString(), problemas: ['falta clave_supabase en _config'] };

  await db.prepare('CREATE TABLE IF NOT EXISTS _espejo (hora TEXT PRIMARY KEY, familia TEXT, ok INTEGER, filas INTEGER, segundos INTEGER, detalle TEXT)').run();

  const columnas = await columnasDeTodas(db);
  const padres = {};
  const resumen = [];
  for (const tablas of Object.values(FAMILIAS)) {
    for (const t of tablas) {
      try {
        const r = await espejarTabla(env, clave, db, t, columnas[t], padres);
        resumen.push(r);
        if (t === 'documentos_comerciales' || t === 'pos_registers') {
          padres[t] = new Map((r.filasLeidas || []).map((f) => [f.id, f.bot_id]));
        }
      } catch (e) {
        resumen.push({ tabla: t, ok: false, error: String(e).slice(0, 200) });
      }
    }
  }

  const mal = resumen.filter((r) => !r.ok && !r.saltada);
  const estado = {
    hora: new Date().toISOString(),
    familia: 'todas',
    segundos: Math.round((Date.now() - t0) / 1000),
    filas: resumen.reduce((a, r) => a + (r.destino || 0), 0),
    tablas: resumen.length,
    ok: mal.length === 0,
    problemas: mal.map((m) => `${m.tabla}: ${m.error ?? `${m.esperadas}→${m.destino}`}`),
  };
  await db
    .prepare('INSERT OR REPLACE INTO _espejo (hora, familia, ok, filas, segundos, detalle) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(estado.hora, estado.familia, estado.ok ? 1 : 0, estado.filas, estado.segundos, JSON.stringify(estado.problemas))
    .run();
  return estado;
}

/** ¿Cuándo se copió por última vez? Devuelve los milisegundos transcurridos (Infinity si nunca). */
export async function desdeLaUltima(db) {
  try {
    const r = await db.prepare('SELECT hora FROM _espejo ORDER BY hora DESC LIMIT 1').first();
    return r?.hora ? Date.now() - Date.parse(r.hora) : Infinity;
  } catch {
    return Infinity; // aún no existe la tabla: hay que copiar
  }
}
