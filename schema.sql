-- Esquema de la base D1 del sitio `qrbott` (se ejecuta en cada publicación).
-- Todo aquí debe ser IDEMPOTENTE (IF NOT EXISTS). Las tablas se van agregando
-- por familias según MIGRACION.md PASO 4. Por ahora solo el canario.
CREATE TABLE IF NOT EXISTS _salud (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO _salud (id) VALUES (1);
