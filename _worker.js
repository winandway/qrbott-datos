/**
 * QRbott — servicio de datos en YaDominios Cloud (PASO 2 de MIGRACION.md).
 *
 * Este repositorio es PÚBLICO a propósito (la plataforma solo publica repos
 * públicos). Por eso aquí no hay ni una clave secreta, ni el panel, ni lógica
 * de negocio: es la puerta a la base (env.DB) y al almacenamiento (env.BUCKET).
 *
 * Rutas (sin /api/: ese prefijo choca con los estáticos en esta plataforma):
 *   GET  /datos/salud    → canario: estado de la base y del almacenamiento
 *   POST /upload         → sube una imagen al almacenamiento (requiere sesión)
 *   GET  /media/<clave>  → devuelve el archivo
 *   DELETE /media/<clave>→ borra el archivo (requiere sesión y ser de esa tienda)
 *
 * SEGURIDAD DE LA SUBIDA (importante, porque este archivo se lee público):
 * no hay ninguna llave escondida. Quien sube manda su propia sesión de QRbott
 * en `Authorization: Bearer <token>`; el worker le pregunta a Supabase si esa
 * sesión es válida y si esa persona tiene acceso a esa tienda (RPC
 * `has_bot_access`, que ya respeta los permisos). Si no, 401/403 y no se
 * escribe nada. La clave anónima que se usa para preguntar es pública: es la
 * misma que ya viaja en el navegador de cualquier visitante.
 */

const SUPABASE_URL = "https://ekurbldypbygxfwbghik.supabase.co";
// Clave ANÓNIMA (pública). No da acceso a nada por sí sola: todo pasa por RLS.
const SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVrdXJibGR5cGJ5Z3hmd2JnaGlrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTIwMDkyNDAsImV4cCI6MjA2NzU4NTI0MH0.rmrL9Z6FgqDCgsBJ6z2o87QoSZTVlt2M1wtoablvQDI";

const TIPOS_PERMITIDOS = new Set(["image/webp", "image/jpeg", "image/png", "image/gif", "application/pdf"]);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB por archivo

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (cuerpo, status = 200) =>
  Response.json(cuerpo, { status, headers: { ...cors, "Cache-Control": "no-store" } });

/** Pregunta a Supabase quién es el dueño de esta sesión. null si no vale. */
async function usuarioDe(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const anon = env.SUPABASE_ANON_KEY || SUPABASE_ANON;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: anon, Authorization: auth },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? { id: u.id, token: auth } : null;
}

/** ¿Esta persona puede tocar esta tienda? Lo decide la base, no nosotros. */
async function puedeEnTienda(botId, usuario, env) {
  const anon = env.SUPABASE_ANON_KEY || SUPABASE_ANON;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/has_bot_access`, {
    method: "POST",
    headers: { apikey: anon, Authorization: usuario.token, "Content-Type": "application/json" },
    body: JSON.stringify({ p_bot_id: botId }),
  });
  if (!r.ok) return false;
  return (await r.json()) === true;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Llave de la mudanza (ruta /migrar). NO está en este archivo ni en el repo:
 * vive en la tabla `_config` de la base del sitio, que solo puede escribir
 * quien tiene el token del panel. Si no existe, /migrar queda apagada.
 */
async function llaveMudanza(env) {
  if (!env.DB) return null;
  try {
    const r = await env.DB.prepare("SELECT valor FROM _config WHERE clave = 'llave_mudanza'").first();
    return r && r.valor ? String(r.valor) : null;
  } catch {
    return null;
  }
}

/** Compara sin filtrar información por el tiempo que tarda. */
function igualSeguro(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
/** Solo letras, números, guiones, puntos y barras. Nada de "..". */
const claveSegura = (c) => !!c && !c.includes("..") && /^[A-Za-z0-9/_.-]{3,200}$/.test(c);

export default {
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
        { servicio: "qrbott-datos", estado, db, bucket, hora: new Date().toISOString() },
        estado === "ok" ? 200 : 503
      );
    }

    // ---- Subida ----
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

      if (!(await puedeEnTienda(botId, usuario, env))) return json({ error: "sin_acceso_a_la_tienda" }, 403);

      const ext = (archivo.type.split("/")[1] || "bin").replace("jpeg", "jpg");
      const clave = `${botId}/${carpeta}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;

      await env.BUCKET.put(clave, archivo.stream(), {
        httpMetadata: { contentType: archivo.type, cacheControl: "public, max-age=31536000, immutable" },
        customMetadata: { bot_id: botId, subido_por: usuario.id, subido_en: new Date().toISOString() },
      });

      return json({ ok: true, clave, url: `${url.origin}/media/${clave}`, bytes: archivo.size }, 201);
    }

    // ---- Mudanza de imágenes viejas (uso interno, una sola vez) ----
    //
    // Trae una imagen que hoy vive en Supabase y la guarda aquí. No la sube el
    // cliente: la descarga el servidor de la URL pública que ya existe. Se
    // autoriza con la llave de mudanza, que vive en la base y no en el código.
    if (url.pathname === "/migrar" && request.method === "POST") {
      if (!env.BUCKET) return json({ error: "almacenamiento_no_disponible" }, 503);
      const llave = await llaveMudanza(env);
      if (!llave) return json({ error: "mudanza_apagada" }, 403);
      const dada = (request.headers.get("x-llave-mudanza") || "").trim();
      if (!igualSeguro(dada, llave)) return json({ error: "llave_invalida" }, 401);

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
      // Solo se trae de nuestro propio Supabase: nadie puede usar esto para
      // que el servidor descargue de cualquier sitio de Internet.
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
        customMetadata: { bot_id: botId, mudado_de: origen, mudado_en: new Date().toISOString() },
      });
      return json({ ok: true, clave, url: `${url.origin}/media/${clave}`, bytes: datos.byteLength }, 201);
    }

    // ---- Lectura y borrado ----
    if (url.pathname.startsWith("/media/")) {
      const clave = decodeURIComponent(url.pathname.slice("/media/".length));
      if (!claveSegura(clave)) return new Response("No encontrado", { status: 404, headers: cors });

      if (request.method === "DELETE") {
        const usuario = await usuarioDe(request, env);
        if (!usuario) return json({ error: "sesion_invalida" }, 401);
        const botId = clave.split("/")[0];
        if (!UUID.test(botId)) return json({ error: "clave_invalida" }, 400);
        if (!(await puedeEnTienda(botId, usuario, env))) return json({ error: "sin_acceso_a_la_tienda" }, 403);
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
  },
};
