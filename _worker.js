/**
 * QRbott — servicio de datos en YaDominios Cloud (PASO 1 de MIGRACION.md).
 *
 * Este repositorio es público a propósito (YaDominios solo publica repos
 * públicos). Por eso aquí NO hay nada del panel, ni claves, ni lógica de
 * negocio: es solo la puerta de entrada a la base (env.DB) y a los archivos
 * (env.BUCKET) del sitio `qrbott`. Todo lo demás vive en el repo privado.
 *
 * Rutas (sin /api/: en YaDominios ese prefijo choca con los estáticos):
 *   GET /datos/salud  → estado de la base y del almacenamiento (canario)
 *   GET /media/<clave> → devuelve un archivo del bucket (PASO 2, imágenes)
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
      return Response.json(
        { servicio: "qrbott-datos", estado, db, bucket, hora: new Date().toISOString() },
        { status: estado === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } }
      );
    }

    if (url.pathname.startsWith("/media/")) {
      if (!env.BUCKET) return new Response("Almacenamiento no disponible", { status: 503 });
      const clave = decodeURIComponent(url.pathname.slice("/media/".length));
      if (!clave || clave.includes("..")) return new Response("No encontrado", { status: 404 });
      const obj = await env.BUCKET.get(clave);
      if (!obj) return new Response("No encontrado", { status: 404 });
      const h = new Headers();
      obj.writeHttpMetadata(h);
      h.set("etag", obj.httpEtag);
      h.set("Cache-Control", "public, max-age=31536000, immutable");
      h.set("Access-Control-Allow-Origin", "*");
      return new Response(obj.body, { headers: h });
    }

    return env.ASSETS.fetch(request);
  },
};
