/**
 * LA PUERTA. Todo lo que se lee o escribe en la base pasa por aquí.
 *
 * POR QUÉ EXISTE
 * --------------
 * En Supabase eran 360 reglas dentro de la base las que impedían que una tienda
 * viera los datos de otra. SQLite no tiene nada de eso: si una consulta olvida
 * el `WHERE bot_id = …`, devuelve el catálogo, los clientes y las ventas de
 * TODOS los negocios. Un solo olvido y un comerciante ve la cartera de otro.
 *
 * La respuesta no es "acordarse siempre". Es que sea IMPOSIBLE olvidarlo:
 *
 *   1. Aquí no se acepta SQL escrito por quien llama. Solo se piden tablas y
 *      condiciones de una lista cerrada.
 *   2. `consultar()` recibe las tiendas permitidas como parámetro obligatorio.
 *      Sin ellas lanza. No hay camino que no pase por el filtro.
 *   3. El filtro se añade DESPUÉS de las condiciones de quien llama, con AND.
 *      No se puede anular desde fuera.
 *   4. Si alguien no tiene ninguna tienda, no ve nada. Falla cerrando.
 */

/** Tablas que se pueden tocar y su columna de tienda. Lista CERRADA. */
export const TABLAS = new Map([
  ['bots', 'id'], // la propia tienda: se filtra por su id
  ['sucursales', 'bot_id'],
  ['bot_knowledge_base', 'bot_id'],
  ['bot_combos', 'bot_id'],
  ['bot_banners', 'bot_id'],
  ['bot_coupons', 'bot_id'],
  ['bot_payment_methods', 'bot_id'],
  ['bot_collaborators', 'bot_id'],
  ['pos_customers', 'bot_id'],
  ['bot_customers', 'bot_id'],
  ['documentos_comerciales', 'bot_id'],
  ['documento_lineas', 'bot_id'],
  ['documento_contadores', 'bot_id'],
  ['bot_datos_emisor', 'bot_id'],
  ['client_requests', 'bot_id'],
  ['pos_registers', 'bot_id'],
  ['pos_sales', 'bot_id'],
  ['pos_cash_movements', 'bot_id'],
  ['pos_shipments', 'bot_id'],
  ['pos_devices', 'bot_id'],
  ['pos_deletions', 'bot_id'],
]);

/** Nombre de columna válido: letras, números y guion bajo. Nada más. */
const COLUMNA_OK = /^[a-z_][a-z0-9_]{0,60}$/i;

export class SinTienda extends Error {
  constructor() {
    super('sin_tiendas: quien consulta no tiene acceso a ninguna tienda');
  }
}
export class TablaNoPermitida extends Error {
  constructor(t) {
    super(`tabla_no_permitida: ${t}`);
  }
}

/**
 * Las tiendas que una persona puede tocar, según `_acceso`.
 *
 * Devuelve SIEMPRE un array. Vacío significa "no ve nada", y eso es lo
 * correcto: ante la duda, se cierra.
 */
export async function tiendasDe(db, userId, soloEditables = false) {
  if (!db || !userId) return [];
  const sql = soloEditables
    ? 'SELECT bot_id FROM _acceso WHERE user_id = ? AND puede_editar = 1'
    : 'SELECT bot_id FROM _acceso WHERE user_id = ?';
  const { results } = await db.prepare(sql).bind(userId).all();
  return (results || []).map((r) => r.bot_id);
}

/** Construye `col IN (?,?,?)` con sus valores. */
function enLista(columna, valores) {
  return { sql: `${columna} IN (${valores.map(() => '?').join(',')})`, valores };
}

/**
 * LEER. `tiendas` es obligatorio y va siempre en el WHERE.
 *
 * @param db        La base (env.DB).
 * @param tiendas   Array de bot_id permitidos. Vacío = no devuelve nada.
 * @param opciones  { tabla, columnas?, donde?, orden?, limite?, desplazar? }
 *                  `donde` es un objeto columna→valor; nunca SQL suelto.
 */
export async function consultar(db, tiendas, opciones) {
  if (!Array.isArray(tiendas)) throw new SinTienda();
  const { tabla, columnas = '*', donde = {}, orden, limite = 200, desplazar = 0 } = opciones;

  const colTienda = TABLAS.get(tabla);
  if (!colTienda) throw new TablaNoPermitida(tabla);
  if (tiendas.length === 0) return []; // falla cerrando

  const condiciones = [];
  const valores = [];
  for (const [col, val] of Object.entries(donde)) {
    if (!COLUMNA_OK.test(col)) throw new Error(`columna_invalida: ${col}`);
    if (val === null) {
      condiciones.push(`${col} IS NULL`);
    } else if (Array.isArray(val)) {
      if (val.length === 0) return [];
      const e = enLista(col, val);
      condiciones.push(e.sql);
      valores.push(...e.valores);
    } else {
      condiciones.push(`${col} = ?`);
      valores.push(val);
    }
  }

  // EL FILTRO DE TIENDA VA AL FINAL Y CON AND: no hay forma de anularlo desde
  // fuera, porque no se acepta SQL de quien llama.
  const f = enLista(colTienda, tiendas);
  condiciones.push(f.sql);
  valores.push(...f.valores);

  const cols = columnas === '*' ? '*' : columnas.filter((c) => COLUMNA_OK.test(c)).join(', ') || '*';
  let sql = `SELECT ${cols} FROM ${tabla} WHERE ${condiciones.join(' AND ')}`;
  if (orden && COLUMNA_OK.test(orden.columna)) {
    sql += ` ORDER BY ${orden.columna} ${orden.desc ? 'DESC' : 'ASC'}`;
  }
  sql += ` LIMIT ${Math.min(Number(limite) || 200, 1000)} OFFSET ${Math.max(Number(desplazar) || 0, 0)}`;

  const { results } = await db.prepare(sql).bind(...valores).all();
  return results || [];
}

/**
 * ESCRIBIR. La tienda del registro tiene que estar entre las permitidas.
 *
 * No se confía en el `bot_id` que venga en los datos: se comprueba contra la
 * lista antes de tocar nada.
 */
export async function insertar(db, tiendas, tabla, datos) {
  const colTienda = TABLAS.get(tabla);
  if (!colTienda) throw new TablaNoPermitida(tabla);
  if (!Array.isArray(tiendas) || tiendas.length === 0) throw new SinTienda();

  const tienda = datos[colTienda];
  if (!tienda || !tiendas.includes(tienda)) {
    throw new Error('sin_acceso_a_la_tienda');
  }

  const cols = Object.keys(datos).filter((c) => COLUMNA_OK.test(c));
  if (cols.length === 0) throw new Error('sin_datos');
  const sql = `INSERT INTO ${tabla} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  await db.prepare(sql).bind(...cols.map((c) => datos[c])).run();
  return { ok: true, tabla, id: datos.id ?? null };
}

/** ACTUALIZAR. Igual que leer: el filtro de tienda va siempre. */
export async function actualizar(db, tiendas, tabla, id, cambios) {
  const colTienda = TABLAS.get(tabla);
  if (!colTienda) throw new TablaNoPermitida(tabla);
  if (!Array.isArray(tiendas) || tiendas.length === 0) throw new SinTienda();
  if (!id) throw new Error('falta_id');

  const cols = Object.keys(cambios).filter((c) => COLUMNA_OK.test(c) && c !== colTienda && c !== 'id');
  if (cols.length === 0) throw new Error('sin_cambios');

  const f = enLista(colTienda, tiendas);
  const sql = `UPDATE ${tabla} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND ${f.sql}`;
  const r = await db
    .prepare(sql)
    .bind(...cols.map((c) => cambios[c]), id, ...f.valores)
    .run();
  const tocadas = r.meta?.changes ?? 0;
  if (tocadas === 0) throw new Error('no_existe_o_sin_acceso');
  return { ok: true, tocadas };
}

/** BORRAR. Con el mismo candado. */
export async function borrar(db, tiendas, tabla, id) {
  const colTienda = TABLAS.get(tabla);
  if (!colTienda) throw new TablaNoPermitida(tabla);
  if (!Array.isArray(tiendas) || tiendas.length === 0) throw new SinTienda();
  const f = enLista(colTienda, tiendas);
  const r = await db
    .prepare(`DELETE FROM ${tabla} WHERE id = ? AND ${f.sql}`)
    .bind(id, ...f.valores)
    .run();
  const tocadas = r.meta?.changes ?? 0;
  if (tocadas === 0) throw new Error('no_existe_o_sin_acceso');
  return { ok: true, tocadas };
}
