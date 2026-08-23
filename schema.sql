-- Esquema de la base D1 del sitio `qrbott` (se ejecuta en cada publicación).
-- Todo aquí debe ser IDEMPOTENTE (IF NOT EXISTS). Las tablas se van agregando
-- por familias según MIGRACION.md PASO 4. Por ahora solo el canario.
CREATE TABLE IF NOT EXISTS _salud (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO _salud (id) VALUES (1);

-- Ajustes internos del servicio (por ahora: la llave de la mudanza de
-- imágenes). Se escribe desde el panel con el token del sitio, nunca desde
-- el código: por eso el repositorio puede ser público sin exponer nada.
CREATE TABLE IF NOT EXISTS _config (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL,
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
