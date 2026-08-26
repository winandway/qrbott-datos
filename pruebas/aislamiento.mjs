/**
 * CANDADO — una tienda NO puede ver los datos de otra.
 *
 * Es la prueba más importante de toda la mudanza. En Supabase esa frontera la
 * ponían 360 reglas dentro de la base; en SQLite no existe nada de eso y la
 * pone `acceso.js`. Si esta prueba se pone en rojo, un comerciante puede estar
 * viendo los clientes y las ventas de otro.
 *
 *   node pruebas/aislamiento.mjs
 *
 * No toca la base de verdad: usa una SQLite en memoria con la misma forma.
 */
import { consultar, insertar, actualizar, borrar, tiendasDe, TABLAS } from '../acceso.js';

const fallos = [];
const comprobar = (ok, que) => {
  console.log(`${ok ? '  OK  ' : '  MAL '} ${que}`);
  if (!ok) fallos.push(que);
};

/**
 * Base de mentira con lo justo para probar: guarda filas y responde a las
 * consultas que arma `acceso.js`. Interpreta el SQL de verdad (WHERE con IN y
 * =), porque una base falsa que ignore el WHERE haría pasar la prueba siempre
 * — que es justo el error que esta prueba existe para cazar.
 */
function baseDeMentira(filasPorTabla) {
  const registro = [];
  return {
    registro,
    prepare(sql) {
      const valores = [];
      return {
        bind(...v) {
          valores.push(...v);
          return this;
        },
        async all() {
          registro.push(sql);
          const tabla = sql.match(/FROM (\w+)/)?.[1];
          const filas = filasPorTabla[tabla] || [];
          const donde = sql.split('WHERE')[1]?.split(/ORDER BY|LIMIT/)[0] ?? '';
          let i = 0;
          const condiciones = [];
          // Se recorren las condiciones en el mismo orden en que se pusieron
          // los valores, para consumirlos igual que lo haría SQLite.
          for (const trozo of donde.split(' AND ')) {
            const t = trozo.trim();
            let m;
            if ((m = t.match(/^(\w+) IN \(([?,\s]+)\)$/))) {
              const cuantos = m[2].split(',').length;
              const lista = valores.slice(i, i + cuantos);
              i += cuantos;
              condiciones.push((f) => lista.includes(f[m[1]]));
            } else if ((m = t.match(/^(\w+) = \?$/))) {
              const v = valores[i++];
              condiciones.push((f) => f[m[1]] === v);
            } else if ((m = t.match(/^(\w+) IS NULL$/))) {
              condiciones.push((f) => f[m[1]] == null);
            }
          }
          return { results: filas.filter((f) => condiciones.every((c) => c(f))) };
        },
        async run() {
          registro.push(sql);
          const tabla = sql.match(/(?:INTO|UPDATE|FROM) (\w+)/)?.[1];
          if (/^INSERT/.test(sql)) {
            (filasPorTabla[tabla] ||= []).push({});
            return { meta: { changes: 1 } };
          }
          // UPDATE/DELETE: cuenta las filas que de verdad cumplirían el WHERE.
          const filas = filasPorTabla[tabla] || [];
          const id = valores[valores.length - (sql.match(/IN \(([?,\s]+)\)/)?.[1].split(',').length ?? 0) - 1];
          const lista = valores.slice(valores.length - (sql.match(/IN \(([?,\s]+)\)/)?.[1].split(',').length ?? 0));
          const cuantas = filas.filter((f) => f.id === id && lista.includes(f.bot_id ?? f.id)).length;
          return { meta: { changes: cuantas } };
        },
      };
    },
  };
}

const TIENDA_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const TIENDA_B = 'bbbbbbbb-0000-0000-0000-000000000002';

const datos = {
  pos_customers: [
    { id: 'c1', bot_id: TIENDA_A, name: 'Cliente de A' },
    { id: 'c2', bot_id: TIENDA_B, name: 'Cliente de B' },
  ],
  pos_sales: [
    { id: 'v1', bot_id: TIENDA_A, total: 100 },
    { id: 'v2', bot_id: TIENDA_B, total: 999 },
  ],
  documento_lineas: [
    { id: 'l1', bot_id: TIENDA_A, descripcion: 'Línea de A' },
    { id: 'l2', bot_id: TIENDA_B, descripcion: 'Línea de B' },
  ],
  bots: [
    { id: TIENDA_A, name: 'Tienda A' },
    { id: TIENDA_B, name: 'Tienda B' },
  ],
};

console.log('\n=== 1. La tienda A solo ve lo suyo ===');
{
  const db = baseDeMentira(datos);
  const clientes = await consultar(db, [TIENDA_A], { tabla: 'pos_customers' });
  comprobar(clientes.length === 1 && clientes[0].bot_id === TIENDA_A, 'clientes: solo los de A');

  const ventas = await consultar(db, [TIENDA_A], { tabla: 'pos_sales' });
  comprobar(ventas.length === 1 && ventas[0].total === 100, 'ventas: solo las de A (no ve las de 999 de B)');

  const lineas = await consultar(db, [TIENDA_A], { tabla: 'documento_lineas' });
  comprobar(
    lineas.length === 1 && lineas[0].descripcion === 'Línea de A',
    'líneas de documento: solo las de A (esta tabla NO tenía tienda propia en Supabase)',
  );

  const tiendas = await consultar(db, [TIENDA_A], { tabla: 'bots' });
  comprobar(tiendas.length === 1 && tiendas[0].id === TIENDA_A, 'la lista de tiendas solo trae la suya');
}

console.log('\n=== 2. No se puede colar el filtro desde fuera ===');
{
  const db = baseDeMentira(datos);
  // Alguien intenta pedir explícitamente los datos de la otra tienda.
  const r = await consultar(db, [TIENDA_A], { tabla: 'pos_customers', donde: { bot_id: TIENDA_B } });
  comprobar(r.length === 0, 'pedir bot_id de otra tienda devuelve VACÍO, no sus datos');

  const sql = db.registro[db.registro.length - 1];
  comprobar(/bot_id IN \(/.test(sql), 'la consulta llevaba el filtro de tienda');
  comprobar((sql.match(/bot_id/g) || []).length >= 2, 'el filtro se suma al del que llama, no lo reemplaza');
}

console.log('\n=== 3. Sin tiendas no se ve nada (falla cerrando) ===');
{
  const db = baseDeMentira(datos);
  const r = await consultar(db, [], { tabla: 'pos_sales' });
  comprobar(r.length === 0, 'usuario sin tiendas: cero resultados');
  comprobar(db.registro.length === 0, 'ni siquiera se llegó a consultar la base');

  let lanzo = false;
  try {
    await consultar(db, undefined, { tabla: 'pos_sales' });
  } catch {
    lanzo = true;
  }
  comprobar(lanzo, 'llamar sin la lista de tiendas lanza error (no hay camino sin filtro)');
}

console.log('\n=== 4. Escribir en una tienda ajena se rechaza ===');
{
  const db = baseDeMentira(datos);
  let error = null;
  try {
    await insertar(db, [TIENDA_A], 'pos_customers', { id: 'x', bot_id: TIENDA_B, name: 'colado' });
  } catch (e) {
    error = e.message;
  }
  comprobar(error === 'sin_acceso_a_la_tienda', `insertar en tienda ajena: ${error ?? 'DEJÓ PASAR'}`);

  let e2 = null;
  try {
    await actualizar(db, [TIENDA_A], 'pos_sales', 'v2', { total: 1 });
  } catch (e) {
    e2 = e.message;
  }
  comprobar(e2 === 'no_existe_o_sin_acceso', `cambiar una venta ajena: ${e2 ?? 'DEJÓ PASAR'}`);

  let e3 = null;
  try {
    await borrar(db, [TIENDA_A], 'pos_customers', 'c2');
  } catch (e) {
    e3 = e.message;
  }
  comprobar(e3 === 'no_existe_o_sin_acceso', `borrar un cliente ajeno: ${e3 ?? 'DEJÓ PASAR'}`);
}

console.log('\n=== 5. Solo se pueden tocar las tablas de la lista ===');
{
  const db = baseDeMentira(datos);
  let e = null;
  try {
    await consultar(db, [TIENDA_A], { tabla: 'auth_users' });
  } catch (err) {
    e = err.message;
  }
  comprobar(/tabla_no_permitida/.test(e ?? ''), `tabla fuera de la lista: ${e ?? 'DEJÓ PASAR'}`);

  let e2 = null;
  try {
    await consultar(db, [TIENDA_A], { tabla: 'pos_sales', donde: { 'total; DROP TABLE bots': 1 } });
  } catch (err) {
    e2 = err.message;
  }
  comprobar(/columna_invalida/.test(e2 ?? ''), `nombre de columna con truco: ${e2 ?? 'DEJÓ PASAR'}`);
}

console.log('\n=== 6. Toda tabla de la lista tiene columna de tienda ===');
{
  const sinTienda = [...TABLAS.entries()].filter(([, col]) => !col);
  comprobar(sinTienda.length === 0, `las ${TABLAS.size} tablas permitidas tienen su columna de tienda`);
}

console.log(
  fallos.length === 0
    ? '\nTODO EN VERDE: una tienda no puede ver los datos de otra.\n'
    : `\nFALLÓ (${fallos.length}):\n - ${fallos.join('\n - ')}\n`,
);
process.exit(fallos.length === 0 ? 0 : 1);
