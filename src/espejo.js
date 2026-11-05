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
 * 1. La tabla NUNCA se vacía: nada de borrar y volver a llenar, sino insertar o
 *    actualizar y, al final, retirar solo lo que ya no existe en Supabase.
 *    Nadie puede ver su catálogo a medio llenar.
 * 2. Supabase solo se LEE. Sigue siendo la verdad hasta el final de la mudanza.
 *
 * LO QUE CUESTA ESCRIBIR (3-11-2026, la base más cara de la cuenta)
 * ------------------------------------------------------------------
 * Cada fila escrita se paga. Antes, cada vuelta reescribía con `INSERT OR REPLACE`
 * las ~7.000 filas aunque nada hubiera cambiado, y cada visita al sitio arrancaba
 * OTRA vuelta mientras la anterior seguía copiando (la marca se escribía al final):
 * hasta 103 vueltas en una hora, 1,8 a 3,8 millones de filas. Ahora:
 *   · UN turno por cada 5 minutos: se toma al empezar con una sola escritura
 *     condicionada (`_espejo_turno`); quien no lo toma, no copia.
 *   · Solo se escribe lo que cambió: se compara con lo que ya hay aquí, y además
 *     `ON CONFLICT … DO UPDATE … WHERE` no toca una fila que llega igual.
 *   · Cada vuelta anota cuántas filas escribió (`escritas`). Dos vueltas seguidas
 *     sin cambios en Supabase escriben 0 (candado `pruebas/espejo-sin-escrituras.mjs`).
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

/**
 * PRESUPUESTO DE ESCRITURAS (5-11-2026, regla «LA NUBE NO SE COME EL DINERO»).
 * Un día normal el espejo escribe unos cientos de filas. Si una vuelta quiere escribir más de esto, algo
 * está mal (una tabla que cambia sola, una columna que no compara): la vuelta FRENA antes de escribir,
 * queda en la bitácora como problema y el canario /datos/salud lo muestra en rojo.
 */
export const TOPE_ESCRITURAS_VUELTA = 20000;
/** Tope de un día entero (todas las vueltas): por encima, el canario se pone rojo. */
export const TOPE_ESCRITURAS_DIA = 200000;

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

/**
 * Agrupa filas en sentencias `INSERT ... VALUES (..),(..) ON CONFLICT ... DO UPDATE
 * ... WHERE <algo cambió>` que no pasen del tope. Una fila que llega igual no se
 * escribe: el WHERE compara con lo guardado (después de la afinidad de SQLite).
 */
export function sentenciasDeInsercion(tabla, columnas, filas) {
  const k = claveDe(tabla);
  const resto = columnas.filter((c) => !k.includes(c));
  const cola = resto.length
    ? ` ON CONFLICT(${k.join(', ')}) DO UPDATE SET ${resto.map((c) => `${c} = excluded.${c}`).join(', ')}` +
      ` WHERE ${resto.map((c) => `${tabla}.${c} IS NOT excluded.${c}`).join(' OR ')}`
    : ` ON CONFLICT(${k.join(', ')}) DO NOTHING`;
  const cabeza = `INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES `;
  const salida = [];
  let grupo = [];
  let bytes = cabeza.length + cola.length;
  for (const f of filas) {
    const v = `(${columnas.map((c) => literal(f[c])).join(', ')})`;
    if (bytes + v.length + 2 > TOPE_SENTENCIA && grupo.length) {
      salida.push(cabeza + grupo.join(',') + cola);
      grupo = [];
      bytes = cabeza.length + cola.length;
    }
    grupo.push(v);
    bytes += v.length + 1;
  }
  if (grupo.length) salida.push(cabeza + grupo.join(',') + cola);
  return salida;
}

/** Un valor como se compara: el de Supabase y el de aquí se escriben distinto (true/1, objeto/texto). */
function comparable(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** ¿La fila de Supabase trae algo distinto de la que ya está aquí? */
export function cambio(nueva, guardada, columnas) {
  if (!guardada) return true;
  return columnas.some((c) => comparable(nueva[c]) !== comparable(guardada[c]));
}

/** Filas escritas que la base informa en una tanda (`meta.rows_written`). */
const escritasDe = (resultados) => (resultados || []).reduce((a, r) => a + (r?.meta?.rows_written || 0), 0);

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

async function espejarTabla(env, clave, db, tabla, cols, padres, presupuesto = { restante: Infinity }) {
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
  const k = claveDe(tabla);
  const comoTexto = (f) => JSON.stringify(k.map((c) => String(f[c] ?? '')));

  // Lo que ya hay aquí (leer es mil veces más barato que escribir): solo se escribe lo que cambió.
  const { results: antes } = await db.prepare(`SELECT ${usadas.length ? usadas.join(', ') : k.join(', ')} FROM ${tabla}`).all();
  const guardadas = new Map((antes || []).map((f) => [comoTexto(f), f]));
  const cambiadas = vivas.filter((f) => cambio(f, guardadas.get(comoTexto(f)), usadas));

  let escritas = 0;
  // El presupuesto se mira ANTES de escribir: si no alcanza, esta tabla no se toca en esta vuelta.
  if (cambiadas.length > presupuesto.restante) {
    throw new Error(`tope_escrituras: ${tabla} quería escribir ${cambiadas.length} filas y quedaban ${presupuesto.restante}`);
  }
  presupuesto.restante -= cambiadas.length;
  if (cambiadas.length) {
    const stmts = sentenciasDeInsercion(tabla, usadas, cambiadas).map((s) => db.prepare(s));
    for (let i = 0; i < stmts.length; i += 10) escritas += escritasDe(await db.batch(stmts.slice(i, i + 10))); // cada lote, una transacción
  }

  const allá = new Set(vivas.map(comoTexto));
  const sobran = [...guardadas.keys()].filter((c) => !allá.has(c)).map((c) => guardadas.get(c));
  if (sobran.length) {
    const trozos = [];
    for (let i = 0; i < sobran.length; i += 200) trozos.push(sobran.slice(i, i + 200));
    escritas += escritasDe(await db.batch(
      trozos.map((t) =>
        db.prepare(`DELETE FROM ${tabla} WHERE ${t.map((f) => `(${k.map((c) => `${c} = ${literal(f[c])}`).join(' AND ')})`).join(' OR ')}`),
      ),
    ));
  }

  const nuevas = vivas.filter((f) => !guardadas.has(comoTexto(f))).length;
  const destino = guardadas.size - sobran.length + nuevas;
  return { tabla, origen: filas.length, destino, esperadas: vivas.length, sinTienda, borradas: sobran.length, cambiadas: cambiadas.length, escritas, ok: destino === vivas.length, filasLeidas: filas };
}

/**
 * Toma el turno de esta vuelta con UNA escritura condicionada: solo la gana quien llega
 * cuando el turno anterior tiene más de 5 minutos. Las visitas que llegan mientras otra
 * vuelta copia no lo ganan y no copian (antes cada una arrancaba su propia copia).
 * `forzar` (POST /espejo/correr, los candados) se lo salta.
 */
export async function tomarTurno(db, forzar = false) {
  await db.prepare('CREATE TABLE IF NOT EXISTS _espejo_turno (id INTEGER PRIMARY KEY, hora INTEGER NOT NULL)').run();
  const ahora = Date.now();
  if (forzar) {
    await db.prepare('INSERT INTO _espejo_turno (id, hora) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET hora = excluded.hora').bind(ahora).run();
    return true;
  }
  const r = await db
    .prepare('INSERT INTO _espejo_turno (id, hora) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET hora = excluded.hora WHERE _espejo_turno.hora <= ?')
    .bind(ahora, ahora - CADA_MS)
    .run();
  return (r?.meta?.changes ?? r?.meta?.rows_written ?? 0) > 0;
}

/** Copia TODAS las familias de una pasada. Aquí caben: la base es un enlace, no una llamada. */
export async function espejar(env, { forzar = false, tope = TOPE_ESCRITURAS_VUELTA } = {}) {
  const t0 = Date.now();
  const db = env.DB;
  if (!(await tomarTurno(db, forzar))) return { ok: true, saltada: true, motivo: 'otra vuelta tiene el turno', hora: new Date().toISOString() };
  const clave = (await db.prepare("SELECT valor FROM _config WHERE clave = 'clave_supabase'").first())?.valor;
  if (!clave) return { ok: false, filas: 0, tablas: 0, segundos: 0, hora: new Date().toISOString(), problemas: ['falta clave_supabase en _config'] };

  await db.prepare('CREATE TABLE IF NOT EXISTS _espejo (hora TEXT PRIMARY KEY, familia TEXT, ok INTEGER, filas INTEGER, segundos INTEGER, detalle TEXT)').run();

  const columnas = await columnasDeTodas(db);
  const padres = {};
  const resumen = [];
  const presupuesto = { restante: tope };
  for (const tablas of Object.values(FAMILIAS)) {
    for (const t of tablas) {
      try {
        const r = await espejarTabla(env, clave, db, t, columnas[t], padres, presupuesto);
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
    cambiadas: resumen.reduce((a, r) => a + (r.cambiadas || 0), 0),
    escritas: resumen.reduce((a, r) => a + (r.escritas || 0), 0),
    tablas: resumen.length,
    ok: mal.length === 0,
    problemas: mal.map((m) => `${m.tabla}: ${m.error ?? `${m.esperadas}→${m.destino}`}`),
    frenada: mal.some((m) => String(m.error || '').startsWith('Error: tope_escrituras')),
  };
  await db
    .prepare('INSERT OR REPLACE INTO _espejo (hora, familia, ok, filas, segundos, detalle) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(estado.hora, estado.familia, estado.ok ? 1 : 0, estado.filas, estado.segundos, JSON.stringify({ problemas: estado.problemas, cambiadas: estado.cambiadas, escritas: estado.escritas, frenada: estado.frenada }))
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

/**
 * Lo que el canario /datos/salud cuenta del espejo: filas escritas en las últimas 24 h (de la bitácora) y
 * si alguna vuelta frenó por el tope. Verde, amarillo (frenó una vuelta) o rojo (pasó el tope del día).
 */
export async function consumoDelEspejo(db) {
  try {
    const desde = new Date(Date.now() - 86400_000).toISOString();
    const r = await db
      .prepare("SELECT count(*) AS vueltas, coalesce(sum(json_extract(detalle, '$.escritas')), 0) AS escritas, coalesce(sum(CASE WHEN json_extract(detalle, '$.frenada') THEN 1 ELSE 0 END), 0) AS frenadas FROM _espejo WHERE hora >= ?")
      .bind(desde)
      .first();
    const escritas = Number(r?.escritas || 0);
    const frenadas = Number(r?.frenadas || 0);
    const color = escritas > TOPE_ESCRITURAS_DIA ? 'rojo' : frenadas > 0 ? 'amarillo' : 'verde';
    return { color, vueltas_24h: Number(r?.vueltas || 0), escritas_24h: escritas, vueltas_frenadas_24h: frenadas, tope_dia: TOPE_ESCRITURAS_DIA, tope_vuelta: TOPE_ESCRITURAS_VUELTA };
  } catch (e) {
    return { color: 'rojo', error: `no se pudo medir: ${String(e).slice(0, 120)}` }; // nunca «verde» si no se pudo medir
  }
}
