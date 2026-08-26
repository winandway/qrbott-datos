/**
 * CANDADO — las cuentas propias funcionan y nadie tiene que cambiar su clave.
 *
 * Prueba contra el servicio EN VIVO, con una cuenta real (la de la tienda
 * demo). Comprueba lo que de verdad importa:
 *   - que se pueda entrar con la contraseña de siempre,
 *   - que la cuenta se mude sola a nuestra base la primera vez,
 *   - que la segunda vez ya no dependa de Supabase,
 *   - que una contraseña mala no entre,
 *   - y que la sesión sirva para leer datos, SIEMPRE filtrados por tienda.
 *
 *   node pruebas/cuentas.mjs
 */
const BASE = process.env.BASE || 'https://qrbott.sitios.dev';
const CORREO = process.env.CORREO || 'landy.qrbott@windoce.com';
const CLAVE = process.env.CLAVE || 'QRbottDemo2026';

const fallos = [];
const comprobar = (ok, que) => {
  console.log(`${ok ? '  OK  ' : '  MAL '} ${que}`);
  if (!ok) fallos.push(que);
};

const pedir = (ruta, cuerpo, vale) =>
  fetch(`${BASE}${ruta}`, {
    method: cuerpo ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(vale ? { Authorization: `Bearer ${vale}` } : {}),
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  }).then(async (r) => ({ estado: r.status, datos: await r.json().catch(() => ({})) }));

console.log(`\n=== 1. Entrar con la contraseña de siempre — ${BASE}`);
const uno = await pedir('/cuentas/entrar', { correo: CORREO, clave: CLAVE });
comprobar(uno.estado === 200 && uno.datos.ok, `entra con su clave de Supabase (${uno.estado})`);
comprobar(!!uno.datos.vale, 'devuelve un vale de sesión');
comprobar(Array.isArray(uno.datos.tiendas) && uno.datos.tiendas.length > 0, `ve sus tiendas (${uno.datos.tiendas?.length ?? 0})`);
if (uno.datos.mudado) console.log('       (esta cuenta acaba de mudarse a nuestra base)');

console.log('\n=== 2. La segunda vez ya no depende de Supabase ===');
const dos = await pedir('/cuentas/entrar', { correo: CORREO, clave: CLAVE });
comprobar(dos.estado === 200 && dos.datos.ok, 'vuelve a entrar');
comprobar(dos.datos.mudado === false, 'ya NO se preguntó a Supabase: la cuenta vive de este lado');
comprobar(dos.datos.usuario?.id === uno.datos.usuario?.id, 'conserva el mismo id (sus datos y accesos siguen atados)');

console.log('\n=== 3. Una contraseña mala no entra ===');
const mala = await pedir('/cuentas/entrar', { correo: CORREO, clave: 'esta-no-es-la-clave' });
comprobar(mala.estado === 401, `clave incorrecta: ${mala.estado}`);
comprobar(mala.datos.error === 'credenciales_invalidas', 'no dice si falló el correo o la clave');
const noExiste = await pedir('/cuentas/entrar', { correo: 'nadie@ejemplo.com', clave: 'loquesea' });
comprobar(
  noExiste.datos.error === mala.datos.error,
  'un correo que no existe da el MISMO error (no se puede adivinar quién está registrado)',
);

console.log('\n=== 4. La sesión sirve para leer datos, con su filtro ===');
const vale = uno.datos.vale;
const yo = await pedir('/cuentas/yo', null, vale);
comprobar(yo.estado === 200 && yo.datos.ok, 'la sesión se reconoce');

const productos = await pedir('/datos/consulta', { operacion: 'leer', tabla: 'bot_knowledge_base', limite: 5 }, vale);
comprobar(productos.estado === 200 && Array.isArray(productos.datos.filas), `lee productos (${productos.datos.filas?.length ?? 0})`);
const misTiendas = new Set(uno.datos.tiendas);
comprobar(
  (productos.datos.filas || []).every((f) => misTiendas.has(f.bot_id)),
  'TODOS los productos son de sus tiendas, ninguno ajeno',
);

console.log('\n=== 5. Sin sesión no se ve nada ===');
const sinVale = await pedir('/datos/consulta', { operacion: 'leer', tabla: 'pos_sales' });
comprobar(sinVale.estado === 401, `sin sesión: ${sinVale.estado}`);
const valeFalso = await pedir('/datos/consulta', { operacion: 'leer', tabla: 'pos_sales' }, 'inventado.firma');
comprobar(valeFalso.estado === 401, `con un vale inventado: ${valeFalso.estado}`);

console.log('\n=== 6. No se puede escribir en una tienda ajena ===');
const ajena = await pedir(
  '/datos/consulta',
  { operacion: 'insertar', tabla: 'pos_customers', datos: { id: 'x', bot_id: '11111111-1111-1111-1111-111111111111', name: 'colado' } },
  vale,
);
comprobar(ajena.estado === 403, `insertar en tienda ajena: ${ajena.estado} ${ajena.datos.error ?? ''}`);

console.log('\n=== 7. Solo las tablas permitidas ===');
const prohibida = await pedir('/datos/consulta', { operacion: 'leer', tabla: 'usuarios' }, vale);
comprobar(
  prohibida.estado === 400 && /tabla_no_permitida/.test(prohibida.datos.error || ''),
  `la tabla de contraseñas NO se puede leer: ${prohibida.datos.error ?? prohibida.estado}`,
);

console.log(
  fallos.length === 0
    ? '\nTODO EN VERDE: se entra sin Supabase y nadie cambió su contraseña.\n'
    : `\nFALLÓ (${fallos.length}):\n - ${fallos.join('\n - ')}\n`,
);
process.exit(fallos.length === 0 ? 0 : 1);
