/**
 * Empaqueta el worker en UN solo archivo.
 *
 * YaDominios Cloud publica lo que hay en el repositorio: no corre ningún build.
 * Y su runtime exige un `_worker.js` autónomo — con `import` de otros archivos
 * el sitio se queda sin backend y todas las rutas responden 404 (pasado de
 * verdad el 26-08-2026).
 *
 * Por eso el código fuente vive en `src/` y el resultado empaquetado se
 * commitea como `_worker.js`. Tras cada cambio:  node construir.mjs
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/worker.js'],
  outfile: '_worker.js',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  legalComments: 'none',
  banner: {
    js: '// GENERADO por construir.mjs — no editar a mano. El código está en src/.',
  },
});
console.log('_worker.js empaquetado.');
