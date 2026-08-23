# qrbott-datos

Servicio de datos de [QRbott](https://qrbott.com) en YaDominios Cloud. Repositorio
público **a propósito** (la plataforma solo publica repos públicos): aquí no hay
claves, ni panel, ni lógica de negocio — solo `_worker.js` (puerta a la base y a
los archivos del sitio), `schema.sql` (tablas, idempotente) y una portada vacía.

El código del producto vive en el repositorio privado. Plan de mudanza:
`MIGRACION.md` de ese repo.

- `GET /datos/salud` → `{ estado: "ok" | "degradado", db, bucket }`
- `GET /media/<clave>` → archivo del bucket (imágenes de las tiendas, PASO 2)

© Windoce LLC.
