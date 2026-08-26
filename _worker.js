// GENERADO por construir.mjs — no editar a mano. El código está en src/.

// src/cuentas.js
var VUELTAS = 21e4;
var HORAS_SESION = 12;
var utf8 = (s) => new TextEncoder().encode(s);
var b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
var deB64url = (s) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - t.length % 4) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
function igualSeguro(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function cifrarClave(clave) {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey("raw", utf8(clave), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: sal, iterations: VUELTAS, hash: "SHA-256" },
    material,
    256
  );
  return `pbkdf2$${VUELTAS}$${b64url(sal)}$${b64url(bits)}`;
}
async function claveCoincide(clave, guardado) {
  try {
    const [algo, vueltas, sal, resumen] = String(guardado).split("$");
    if (algo !== "pbkdf2") return false;
    const material = await crypto.subtle.importKey("raw", utf8(clave), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: deB64url(sal), iterations: Number(vueltas), hash: "SHA-256" },
      material,
      256
    );
    return igualSeguro(b64url(bits), resumen);
  } catch {
    return false;
  }
}
async function llaveFirma(db) {
  const fila = await db.prepare("SELECT valor FROM _config WHERE clave = 'llave_sesion'").first();
  if (fila?.valor) return fila.valor;
  const nueva = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare("INSERT INTO _config (clave, valor) VALUES ('llave_sesion', ?) ON CONFLICT(clave) DO NOTHING").bind(nueva).run();
  const otra = await db.prepare("SELECT valor FROM _config WHERE clave = 'llave_sesion'").first();
  return otra?.valor ?? nueva;
}
async function firmar(db, texto) {
  const llave = await crypto.subtle.importKey(
    "raw",
    utf8(await llaveFirma(db)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return b64url(await crypto.subtle.sign("HMAC", llave, utf8(texto)));
}
async function crearSesion(db, usuario) {
  const cuerpo = b64url(
    utf8(
      JSON.stringify({
        id: usuario.id,
        correo: usuario.correo,
        vence: Date.now() + HORAS_SESION * 36e5
      })
    )
  );
  return `${cuerpo}.${await firmar(db, cuerpo)}`;
}
async function leerSesion(db, vale) {
  if (!vale || typeof vale !== "string" || !vale.includes(".")) return null;
  const [cuerpo, firma] = vale.split(".");
  if (!igualSeguro(firma, await firmar(db, cuerpo))) return null;
  try {
    const d = JSON.parse(new TextDecoder().decode(deB64url(cuerpo)));
    if (!d.vence || Date.now() > d.vence) return null;
    return { id: d.id, correo: d.correo };
  } catch {
    return null;
  }
}
var correoValido = (c) => typeof c === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c) && c.length <= 254;
var ClaveDebil = class extends Error {
  constructor() {
    super("clave_corta");
  }
};
function revisarClave(clave) {
  if (typeof clave !== "string" || clave.length < 8) throw new ClaveDebil();
}
async function preguntarASupabase(correo, clave, env) {
  const url = env.SUPABASE_URL;
  const anon = env.SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email: correo, password: clave })
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.user?.id ? { id: d.user.id, correo: d.user.email } : null;
}
async function buscarPorCorreo(db, correo) {
  return db.prepare("SELECT * FROM usuarios WHERE correo = ?").bind(String(correo).toLowerCase().trim()).first();
}
async function entrar(db, env, correo, clave) {
  if (!correoValido(correo) || typeof clave !== "string" || !clave) {
    throw new Error("datos_incompletos");
  }
  const c = String(correo).toLowerCase().trim();
  const existente = await buscarPorCorreo(db, c);
  if (existente) {
    if (existente.activo === 0) throw new Error("cuenta_desactivada");
    if (!await claveCoincide(clave, existente.clave_cifrada)) throw new Error("credenciales_invalidas");
    await db.prepare("UPDATE usuarios SET ultimo_acceso = datetime('now') WHERE id = ?").bind(existente.id).run();
    return { usuario: existente, vale: await crearSesion(db, existente), mudado: false };
  }
  const deSupabase = await preguntarASupabase(c, clave, env);
  if (!deSupabase) throw new Error("credenciales_invalidas");
  const usuario = {
    id: deSupabase.id,
    // se conserva el MISMO id: los accesos y los datos ya lo usan
    correo: c,
    clave_cifrada: await cifrarClave(clave),
    origen: "supabase",
    activo: 1
  };
  await db.prepare(
    `INSERT INTO usuarios (id, correo, clave_cifrada, origen, activo, ultimo_acceso)
       VALUES (?, ?, ?, ?, 1, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET clave_cifrada = excluded.clave_cifrada, ultimo_acceso = datetime('now')`
  ).bind(usuario.id, usuario.correo, usuario.clave_cifrada, usuario.origen).run();
  return { usuario, vale: await crearSesion(db, usuario), mudado: true };
}
async function registrar(db, correo, clave, nombre) {
  if (!correoValido(correo)) throw new Error("correo_invalido");
  revisarClave(clave);
  const c = String(correo).toLowerCase().trim();
  if (await buscarPorCorreo(db, c)) throw new Error("correo_ya_registrado");
  const usuario = {
    id: crypto.randomUUID(),
    correo: c,
    clave_cifrada: await cifrarClave(clave),
    nombre: (nombre || "").trim() || null,
    origen: "propio",
    activo: 1
  };
  await db.prepare(
    `INSERT INTO usuarios (id, correo, clave_cifrada, nombre, origen, activo, ultimo_acceso)
       VALUES (?, ?, ?, ?, ?, 1, datetime('now'))`
  ).bind(usuario.id, usuario.correo, usuario.clave_cifrada, usuario.nombre, usuario.origen).run();
  return { usuario, vale: await crearSesion(db, usuario) };
}
async function cambiarClave(db, userId, claveActual, claveNueva) {
  revisarClave(claveNueva);
  const u = await db.prepare("SELECT * FROM usuarios WHERE id = ?").bind(userId).first();
  if (!u) throw new Error("no_existe");
  if (!await claveCoincide(claveActual, u.clave_cifrada)) throw new Error("credenciales_invalidas");
  await db.prepare("UPDATE usuarios SET clave_cifrada = ?, actualizado_en = datetime('now') WHERE id = ?").bind(await cifrarClave(claveNueva), userId).run();
  return { ok: true };
}

// src/acceso.js
var TABLAS = /* @__PURE__ */ new Map([
  ["bots", "id"],
  // la propia tienda: se filtra por su id
  ["sucursales", "bot_id"],
  ["bot_knowledge_base", "bot_id"],
  ["bot_combos", "bot_id"],
  ["bot_banners", "bot_id"],
  ["bot_coupons", "bot_id"],
  ["bot_payment_methods", "bot_id"],
  ["bot_collaborators", "bot_id"],
  ["pos_customers", "bot_id"],
  ["bot_customers", "bot_id"],
  ["documentos_comerciales", "bot_id"],
  ["documento_lineas", "bot_id"],
  ["documento_contadores", "bot_id"],
  ["bot_datos_emisor", "bot_id"],
  ["client_requests", "bot_id"],
  ["pos_registers", "bot_id"],
  ["pos_sales", "bot_id"],
  ["pos_cash_movements", "bot_id"],
  ["pos_shipments", "bot_id"],
  ["pos_devices", "bot_id"],
  ["pos_deletions", "bot_id"]
]);
var COLUMNA_OK = /^[a-z_][a-z0-9_]{0,60}$/i;
var SinTienda = class extends Error {
  constructor() {
    super("sin_tiendas: quien consulta no tiene acceso a ninguna tienda");
  }
};
var TablaNoPermitida = class extends Error {
  constructor(t) {
    super(`tabla_no_permitida: ${t}`);
  }
};
async function tiendasDe(db, userId, soloEditables = false) {
  if (!db || !userId) return [];
  const sql = soloEditables ? "SELECT bot_id FROM _acceso WHERE user_id = ? AND puede_editar = 1" : "SELECT bot_id FROM _acceso WHERE user_id = ?";
  const { results } = await db.prepare(sql).bind(userId).all();
  return (results || []).map((r) => r.bot_id);
}
function enLista(columna, valores) {
  return { sql: `${columna} IN (${valores.map(() => "?").join(",")})`, valores };
}
async function consultar(db, tiendas, opciones) {
  if (!Array.isArray(tiendas)) throw new SinTienda();
  const { tabla, columnas = "*", donde = {}, orden, limite = 200, desplazar = 0 } = opciones;
  const colTienda = TABLAS.get(tabla);
  if (!colTienda) throw new TablaNoPermitida(tabla);
  if (tiendas.length === 0) return [];
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
  const f = enLista(colTienda, tiendas);
  condiciones.push(f.sql);
  valores.push(...f.valores);
  const cols = columnas === "*" ? "*" : columnas.filter((c) => COLUMNA_OK.test(c)).join(", ") || "*";
  let sql = `SELECT ${cols} FROM ${tabla} WHERE ${condiciones.join(" AND ")}`;
  if (orden && COLUMNA_OK.test(orden.columna)) {
    sql += ` ORDER BY ${orden.columna} ${orden.desc ? "DESC" : "ASC"}`;
  }
  sql += ` LIMIT ${Math.min(Number(limite) || 200, 1e3)} OFFSET ${Math.max(Number(desplazar) || 0, 0)}`;
  const { results } = await db.prepare(sql).bind(...valores).all();
  return results || [];
}
async function insertar(db, tiendas, tabla, datos) {
  const colTienda = TABLAS.get(tabla);
  if (!colTienda) throw new TablaNoPermitida(tabla);
  if (!Array.isArray(tiendas) || tiendas.length === 0) throw new SinTienda();
  const tienda = datos[colTienda];
  if (!tienda || !tiendas.includes(tienda)) {
    throw new Error("sin_acceso_a_la_tienda");
  }
  const cols = Object.keys(datos).filter((c) => COLUMNA_OK.test(c));
  if (cols.length === 0) throw new Error("sin_datos");
  const sql = `INSERT INTO ${tabla} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
  await db.prepare(sql).bind(...cols.map((c) => datos[c])).run();
  return { ok: true, tabla, id: datos.id ?? null };
}
async function actualizar(db, tiendas, tabla, id, cambios) {
  const colTienda = TABLAS.get(tabla);
  if (!colTienda) throw new TablaNoPermitida(tabla);
  if (!Array.isArray(tiendas) || tiendas.length === 0) throw new SinTienda();
  if (!id) throw new Error("falta_id");
  const cols = Object.keys(cambios).filter((c) => COLUMNA_OK.test(c) && c !== colTienda && c !== "id");
  if (cols.length === 0) throw new Error("sin_cambios");
  const f = enLista(colTienda, tiendas);
  const sql = `UPDATE ${tabla} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND ${f.sql}`;
  const r = await db.prepare(sql).bind(...cols.map((c) => cambios[c]), id, ...f.valores).run();
  const tocadas = r.meta?.changes ?? 0;
  if (tocadas === 0) throw new Error("no_existe_o_sin_acceso");
  return { ok: true, tocadas };
}
async function borrar(db, tiendas, tabla, id) {
  const colTienda = TABLAS.get(tabla);
  if (!colTienda) throw new TablaNoPermitida(tabla);
  if (!Array.isArray(tiendas) || tiendas.length === 0) throw new SinTienda();
  const f = enLista(colTienda, tiendas);
  const r = await db.prepare(`DELETE FROM ${tabla} WHERE id = ? AND ${f.sql}`).bind(id, ...f.valores).run();
  const tocadas = r.meta?.changes ?? 0;
  if (tocadas === 0) throw new Error("no_existe_o_sin_acceso");
  return { ok: true, tocadas };
}

// src/worker.js
var SUPABASE_URL = "https://ekurbldypbygxfwbghik.supabase.co";
var SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVrdXJibGR5cGJ5Z3hmd2JnaGlrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTIwMDkyNDAsImV4cCI6MjA2NzU4NTI0MH0.rmrL9Z6FgqDCgsBJ6z2o87QoSZTVlt2M1wtoablvQDI";
var TIPOS_PERMITIDOS = /* @__PURE__ */ new Set(["image/webp", "image/jpeg", "image/png", "image/gif", "application/pdf"]);
var MAX_BYTES = 10 * 1024 * 1024;
var cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400"
};
var json = (cuerpo, status = 200) => Response.json(cuerpo, { status, headers: { ...cors, "Cache-Control": "no-store" } });
async function usuarioDe(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const anon = env.SUPABASE_ANON_KEY || SUPABASE_ANON;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: anon, Authorization: auth }
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? { id: u.id, token: auth } : null;
}
async function puedeEnTienda(botId, usuario, env) {
  const anon = env.SUPABASE_ANON_KEY || SUPABASE_ANON;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/has_bot_access`, {
    method: "POST",
    headers: { apikey: anon, Authorization: usuario.token, "Content-Type": "application/json" },
    body: JSON.stringify({ p_bot_id: botId })
  });
  if (!r.ok) return false;
  return await r.json() === true;
}
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function llaveMudanza(env) {
  if (!env.DB) return null;
  try {
    const r = await env.DB.prepare("SELECT valor FROM _config WHERE clave = 'llave_mudanza'").first();
    return r && r.valor ? String(r.valor) : null;
  } catch {
    return null;
  }
}
function igualSeguro2(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
var claveSegura = (c) => !!c && !c.includes("..") && /^[A-Za-z0-9/_.-]{3,200}$/.test(c);
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/datos/salud") {
      let db = "sin binding";
      try {
        if (env.DB) {
          const r = await env.DB.prepare("SELECT 1 AS ok").first();
          db = r && r.ok === 1 ? "ok" : "responde raro";
        }
      } catch (e) {
        db = "error: " + (e && e.message ? e.message : String(e));
      }
      const bucket = env.BUCKET ? "ok" : "sin binding";
      const estado = db === "ok" && bucket === "ok" ? "ok" : "degradado";
      return json(
        { servicio: "qrbott-datos", estado, db, bucket, hora: (/* @__PURE__ */ new Date()).toISOString() },
        estado === "ok" ? 200 : 503
      );
    }
    if (url.pathname === "/upload" && request.method === "POST") {
      if (!env.BUCKET) return json({ error: "almacenamiento_no_disponible" }, 503);
      const usuario = await usuarioDe(request, env);
      if (!usuario) return json({ error: "sesion_invalida" }, 401);
      let form;
      try {
        form = await request.formData();
      } catch {
        return json({ error: "peticion_invalida" }, 400);
      }
      const archivo = form.get("archivo");
      const botId = String(form.get("bot_id") || "");
      const carpeta = String(form.get("carpeta") || "productos");
      if (!UUID.test(botId)) return json({ error: "bot_id_invalido" }, 400);
      if (!(archivo instanceof File)) return json({ error: "falta_archivo" }, 400);
      if (!TIPOS_PERMITIDOS.has(archivo.type)) return json({ error: "tipo_no_permitido", tipo: archivo.type }, 415);
      if (archivo.size > MAX_BYTES) return json({ error: "archivo_muy_grande", max_mb: 10 }, 413);
      if (!/^[a-z0-9-]{2,40}$/.test(carpeta)) return json({ error: "carpeta_invalida" }, 400);
      if (!await puedeEnTienda(botId, usuario, env)) return json({ error: "sin_acceso_a_la_tienda" }, 403);
      const ext = (archivo.type.split("/")[1] || "bin").replace("jpeg", "jpg");
      const clave = `${botId}/${carpeta}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
      await env.BUCKET.put(clave, archivo.stream(), {
        httpMetadata: { contentType: archivo.type, cacheControl: "public, max-age=31536000, immutable" },
        customMetadata: { bot_id: botId, subido_por: usuario.id, subido_en: (/* @__PURE__ */ new Date()).toISOString() }
      });
      return json({ ok: true, clave, url: `${url.origin}/media/${clave}`, bytes: archivo.size }, 201);
    }
    if (url.pathname.startsWith("/cuentas/")) {
      if (!env.DB) return json({ error: "base_no_disponible" }, 503);
      const accion = url.pathname.slice("/cuentas/".length);
      if (accion === "yo") {
        const yo = await leerSesion(env.DB, (request.headers.get("authorization") || "").replace(/^Bearer /i, ""));
        if (!yo) return json({ error: "sesion_invalida" }, 401);
        const tiendas = await tiendasDe(env.DB, yo.id);
        return json({ ok: true, usuario: yo, tiendas });
      }
      if (request.method !== "POST") return json({ error: "metodo_no_permitido" }, 405);
      let cuerpo;
      try {
        cuerpo = await request.json();
      } catch {
        return json({ error: "peticion_invalida" }, 400);
      }
      try {
        if (accion === "entrar") {
          const r = await entrar(env.DB, { ...env, SUPABASE_URL, SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY || SUPABASE_ANON }, cuerpo.correo, cuerpo.clave);
          return json({
            ok: true,
            vale: r.vale,
            usuario: { id: r.usuario.id, correo: r.usuario.correo, nombre: r.usuario.nombre ?? null },
            mudado: r.mudado,
            tiendas: await tiendasDe(env.DB, r.usuario.id)
          });
        }
        if (accion === "registro") {
          const r = await registrar(env.DB, cuerpo.correo, cuerpo.clave, cuerpo.nombre);
          return json(
            { ok: true, vale: r.vale, usuario: { id: r.usuario.id, correo: r.usuario.correo, nombre: r.usuario.nombre } },
            201
          );
        }
        if (accion === "cambiar-clave") {
          const yo = await leerSesion(env.DB, (request.headers.get("authorization") || "").replace(/^Bearer /i, ""));
          if (!yo) return json({ error: "sesion_invalida" }, 401);
          await cambiarClave(env.DB, yo.id, cuerpo.actual, cuerpo.nueva);
          return json({ ok: true });
        }
      } catch (e) {
        const m = e?.message || "error";
        const codigo = m === "credenciales_invalidas" || m === "cuenta_desactivada" ? 401 : 400;
        return json({ error: m }, codigo);
      }
      return json({ error: "accion_desconocida" }, 404);
    }
    if (url.pathname === "/datos/consulta" && request.method === "POST") {
      if (!env.DB) return json({ error: "base_no_disponible" }, 503);
      const yo = await leerSesion(env.DB, (request.headers.get("authorization") || "").replace(/^Bearer /i, ""));
      if (!yo) return json({ error: "sesion_invalida" }, 401);
      let c;
      try {
        c = await request.json();
      } catch {
        return json({ error: "peticion_invalida" }, 400);
      }
      const soloEditables = c.operacion && c.operacion !== "leer";
      const tiendas = await tiendasDe(env.DB, yo.id, soloEditables);
      try {
        switch (c.operacion || "leer") {
          case "leer":
            return json({ ok: true, filas: await consultar(env.DB, tiendas, c) });
          case "insertar":
            return json({ ok: true, ...await insertar(env.DB, tiendas, c.tabla, c.datos) }, 201);
          case "actualizar":
            return json({ ok: true, ...await actualizar(env.DB, tiendas, c.tabla, c.id, c.cambios) });
          case "borrar":
            return json({ ok: true, ...await borrar(env.DB, tiendas, c.tabla, c.id) });
          default:
            return json({ error: "operacion_desconocida" }, 400);
        }
      } catch (e) {
        const m = e?.message || "error";
        const codigo = /sin_acceso|no_existe_o_sin_acceso|sin_tiendas/.test(m) ? 403 : 400;
        return json({ error: m }, codigo);
      }
    }
    if (url.pathname === "/migrar" && request.method === "POST") {
      if (!env.BUCKET) return json({ error: "almacenamiento_no_disponible" }, 503);
      const llave = await llaveMudanza(env);
      if (!llave) return json({ error: "mudanza_apagada" }, 403);
      const dada = (request.headers.get("x-llave-mudanza") || "").trim();
      if (!igualSeguro2(dada, llave)) return json({ error: "llave_invalida" }, 401);
      let cuerpo;
      try {
        cuerpo = await request.json();
      } catch {
        return json({ error: "peticion_invalida" }, 400);
      }
      const origen = String(cuerpo.origen || "");
      const botId = String(cuerpo.bot_id || "");
      const carpeta = String(cuerpo.carpeta || "productos");
      if (!UUID.test(botId)) return json({ error: "bot_id_invalido" }, 400);
      if (!/^[a-z0-9-]{2,40}$/.test(carpeta)) return json({ error: "carpeta_invalida" }, 400);
      if (!origen.startsWith(SUPABASE_URL + "/storage/")) return json({ error: "origen_no_permitido" }, 400);
      const res = await fetch(origen);
      if (!res.ok) return json({ error: "origen_no_responde", status: res.status }, 502);
      const tipo = res.headers.get("content-type") || "image/jpeg";
      if (!TIPOS_PERMITIDOS.has(tipo.split(";")[0].trim())) return json({ error: "tipo_no_permitido", tipo }, 415);
      const datos = await res.arrayBuffer();
      if (datos.byteLength > MAX_BYTES) return json({ error: "archivo_muy_grande" }, 413);
      const ext = (tipo.split("/")[1] || "jpg").split(";")[0].replace("jpeg", "jpg");
      const clave = `${botId}/${carpeta}/mudanza-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
      await env.BUCKET.put(clave, datos, {
        httpMetadata: { contentType: tipo, cacheControl: "public, max-age=31536000, immutable" },
        customMetadata: { bot_id: botId, mudado_de: origen, mudado_en: (/* @__PURE__ */ new Date()).toISOString() }
      });
      return json({ ok: true, clave, url: `${url.origin}/media/${clave}`, bytes: datos.byteLength }, 201);
    }
    if (url.pathname.startsWith("/media/")) {
      const clave = decodeURIComponent(url.pathname.slice("/media/".length));
      if (!claveSegura(clave)) return new Response("No encontrado", { status: 404, headers: cors });
      if (request.method === "DELETE") {
        const usuario = await usuarioDe(request, env);
        if (!usuario) return json({ error: "sesion_invalida" }, 401);
        const botId = clave.split("/")[0];
        if (!UUID.test(botId)) return json({ error: "clave_invalida" }, 400);
        if (!await puedeEnTienda(botId, usuario, env)) return json({ error: "sin_acceso_a_la_tienda" }, 403);
        await env.BUCKET.delete(clave);
        return json({ ok: true, borrado: clave });
      }
      if (!env.BUCKET) return new Response("Almacenamiento no disponible", { status: 503, headers: cors });
      const obj = await env.BUCKET.get(clave);
      if (!obj) return new Response("No encontrado", { status: 404, headers: cors });
      const h = new Headers(cors);
      obj.writeHttpMetadata(h);
      h.set("etag", obj.httpEtag);
      h.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(obj.body, { headers: h });
    }
    return env.ASSETS.fetch(request);
  }
};
export {
  worker_default as default
};
