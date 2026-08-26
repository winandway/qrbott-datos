/**
 * CUENTAS PROPIAS — entrar a QRbott sin depender de Supabase.
 *
 * LO MÁS IMPORTANTE: NADIE CAMBIA SU CONTRASEÑA
 * ---------------------------------------------
 * Las contraseñas de los 35 clientes están cifradas en Supabase y no se pueden
 * copiar: un cifrado bien hecho no se puede leer, ni siquiera por nosotros.
 *
 * Así que la mudanza es silenciosa. Al entrar:
 *   1. Se busca al usuario en NUESTRA base. Si está, se comprueba aquí y listo.
 *   2. Si no está, se le pregunta a Supabase (que todavía es la verdad).
 *   3. Si Supabase dice que la contraseña es correcta, se guarda cifrada en
 *      nuestra base. La próxima vez ya no hace falta preguntarle a nadie.
 *
 * El comerciante no nota nada. Entra como siempre, y su cuenta se muda sola.
 *
 * CÓMO SE GUARDAN LAS CONTRASEÑAS
 * -------------------------------
 * Nunca en claro. PBKDF2 con SHA-256, 210.000 vueltas y una sal distinta por
 * persona — lo que recomienda OWASP para 2026 cuando no hay bcrypt disponible
 * (en este entorno no lo hay sin traer librerías de fuera, y traer una librería
 * de terceros a la puerta de las contraseñas es peor).
 *
 * LA SESIÓN
 * ---------
 * Un vale firmado por nosotros (HMAC-SHA256) con el id del usuario y su fecha
 * de caducidad. La llave de firma vive en la base (`_config`), NO en este
 * archivo: el repositorio es público.
 */

const VUELTAS = 210_000;
const HORAS_SESION = 12;

const utf8 = (s) => new TextEncoder().encode(s);
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deB64url = (s) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/** Comparación que no delata por el tiempo que tarda. */
function igualSeguro(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Cifra una contraseña. Devuelve "pbkdf2$vueltas$sal$resumen". */
export async function cifrarClave(clave) {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey('raw', utf8(clave), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: sal, iterations: VUELTAS, hash: 'SHA-256' },
    material,
    256,
  );
  return `pbkdf2$${VUELTAS}$${b64url(sal)}$${b64url(bits)}`;
}

/** ¿Esta contraseña corresponde a este cifrado? */
export async function claveCoincide(clave, guardado) {
  try {
    const [algo, vueltas, sal, resumen] = String(guardado).split('$');
    if (algo !== 'pbkdf2') return false;
    const material = await crypto.subtle.importKey('raw', utf8(clave), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: deB64url(sal), iterations: Number(vueltas), hash: 'SHA-256' },
      material,
      256,
    );
    return igualSeguro(b64url(bits), resumen);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* La sesión                                                           */
/* ------------------------------------------------------------------ */

/** La llave con la que firmamos las sesiones. Vive en la base, no en el código. */
async function llaveFirma(db) {
  const fila = await db.prepare("SELECT valor FROM _config WHERE clave = 'llave_sesion'").first();
  if (fila?.valor) return fila.valor;
  // Primera vez: se crea sola y queda guardada. Nadie tiene que configurar nada.
  const nueva = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await db
    .prepare("INSERT INTO _config (clave, valor) VALUES ('llave_sesion', ?) ON CONFLICT(clave) DO NOTHING")
    .bind(nueva)
    .run();
  const otra = await db.prepare("SELECT valor FROM _config WHERE clave = 'llave_sesion'").first();
  return otra?.valor ?? nueva;
}

async function firmar(db, texto) {
  const llave = await crypto.subtle.importKey(
    'raw',
    utf8(await llaveFirma(db)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return b64url(await crypto.subtle.sign('HMAC', llave, utf8(texto)));
}

/** Crea el vale de sesión. */
export async function crearSesion(db, usuario) {
  const cuerpo = b64url(
    utf8(
      JSON.stringify({
        id: usuario.id,
        correo: usuario.correo,
        vence: Date.now() + HORAS_SESION * 3600_000,
      }),
    ),
  );
  return `${cuerpo}.${await firmar(db, cuerpo)}`;
}

/** Lee el vale. Devuelve el usuario o null si está mal firmado o vencido. */
export async function leerSesion(db, vale) {
  if (!vale || typeof vale !== 'string' || !vale.includes('.')) return null;
  const [cuerpo, firma] = vale.split('.');
  if (!igualSeguro(firma, await firmar(db, cuerpo))) return null;
  try {
    const d = JSON.parse(new TextDecoder().decode(deB64url(cuerpo)));
    if (!d.vence || Date.now() > d.vence) return null;
    return { id: d.id, correo: d.correo };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Entrar, registrarse y la mudanza silenciosa                         */
/* ------------------------------------------------------------------ */

const correoValido = (c) => typeof c === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c) && c.length <= 254;

export class ClaveDebil extends Error {
  constructor() {
    super('clave_corta');
  }
}

/** Reglas mínimas de contraseña. Cortita y clara: 8 o más. */
function revisarClave(clave) {
  if (typeof clave !== 'string' || clave.length < 8) throw new ClaveDebil();
}

/**
 * Le pregunta a Supabase si esa contraseña es correcta.
 *
 * Solo se usa mientras dure la mudanza, para la gente que todavía no ha entrado
 * ni una vez desde el cambio. Cuando ya no queden usuarios sin mudar, esta
 * función se borra y con ella la última atadura.
 */
async function preguntarASupabase(correo, clave, env) {
  const url = env.SUPABASE_URL;
  const anon = env.SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: correo, password: clave }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.user?.id ? { id: d.user.id, correo: d.user.email } : null;
}

export async function buscarPorCorreo(db, correo) {
  return db.prepare('SELECT * FROM usuarios WHERE correo = ?').bind(String(correo).toLowerCase().trim()).first();
}

/**
 * ENTRAR.
 *
 * Devuelve { usuario, vale, mudado } — `mudado` es true cuando esta persona
 * acaba de pasarse a nuestra base sin enterarse.
 */
export async function entrar(db, env, correo, clave) {
  if (!correoValido(correo) || typeof clave !== 'string' || !clave) {
    throw new Error('datos_incompletos');
  }
  const c = String(correo).toLowerCase().trim();

  const existente = await buscarPorCorreo(db, c);
  if (existente) {
    if (existente.activo === 0) throw new Error('cuenta_desactivada');
    if (!(await claveCoincide(clave, existente.clave_cifrada))) throw new Error('credenciales_invalidas');
    await db.prepare("UPDATE usuarios SET ultimo_acceso = datetime('now') WHERE id = ?").bind(existente.id).run();
    return { usuario: existente, vale: await crearSesion(db, existente), mudado: false };
  }

  // Todavía no está de este lado: se le pregunta a Supabase y, si es correcta,
  // se guarda aquí. Es la mudanza silenciosa.
  const deSupabase = await preguntarASupabase(c, clave, env);
  if (!deSupabase) throw new Error('credenciales_invalidas');

  const usuario = {
    id: deSupabase.id, // se conserva el MISMO id: los accesos y los datos ya lo usan
    correo: c,
    clave_cifrada: await cifrarClave(clave),
    origen: 'supabase',
    activo: 1,
  };
  await db
    .prepare(
      `INSERT INTO usuarios (id, correo, clave_cifrada, origen, activo, ultimo_acceso)
       VALUES (?, ?, ?, ?, 1, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET clave_cifrada = excluded.clave_cifrada, ultimo_acceso = datetime('now')`,
    )
    .bind(usuario.id, usuario.correo, usuario.clave_cifrada, usuario.origen)
    .run();

  return { usuario, vale: await crearSesion(db, usuario), mudado: true };
}

/** REGISTRARSE. Para cuentas nuevas, que ya nacen de este lado. */
export async function registrar(db, correo, clave, nombre) {
  if (!correoValido(correo)) throw new Error('correo_invalido');
  revisarClave(clave);
  const c = String(correo).toLowerCase().trim();
  if (await buscarPorCorreo(db, c)) throw new Error('correo_ya_registrado');

  const usuario = {
    id: crypto.randomUUID(),
    correo: c,
    clave_cifrada: await cifrarClave(clave),
    nombre: (nombre || '').trim() || null,
    origen: 'propio',
    activo: 1,
  };
  await db
    .prepare(
      `INSERT INTO usuarios (id, correo, clave_cifrada, nombre, origen, activo, ultimo_acceso)
       VALUES (?, ?, ?, ?, ?, 1, datetime('now'))`,
    )
    .bind(usuario.id, usuario.correo, usuario.clave_cifrada, usuario.nombre, usuario.origen)
    .run();
  return { usuario, vale: await crearSesion(db, usuario) };
}

/** CAMBIAR LA CONTRASEÑA. Exige la actual: que te dejen el equipo abierto no basta. */
export async function cambiarClave(db, userId, claveActual, claveNueva) {
  revisarClave(claveNueva);
  const u = await db.prepare('SELECT * FROM usuarios WHERE id = ?').bind(userId).first();
  if (!u) throw new Error('no_existe');
  if (!(await claveCoincide(claveActual, u.clave_cifrada))) throw new Error('credenciales_invalidas');
  await db
    .prepare("UPDATE usuarios SET clave_cifrada = ?, actualizado_en = datetime('now') WHERE id = ?")
    .bind(await cifrarClave(claveNueva), userId)
    .run();
  return { ok: true };
}
