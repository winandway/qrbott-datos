/**
 * Copia a la base nueva quién puede ver qué tienda.
 *
 * Es la pieza de la que depende TODA la seguridad de la mudanza: `acceso.js`
 * lee esta tabla para saber qué filtrar. Si se copia mal, o alguien ve lo que
 * no debe, o nadie ve nada.
 *
 * Se puede correr las veces que haga falta: primero borra y vuelve a poner,
 * así refleja siempre lo que dice Supabase (que sigue siendo la verdad hasta
 * que termine la mudanza).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';

const ejecutar = promisify(execFile);
const PSQL = '/opt/homebrew/opt/libpq/bin/psql';
const CONN = 'host=db.ekurbldypbygxfwbghik.supabase.co port=5432 dbname=postgres user=postgres sslmode=require';
const SEP = '~|~';

const TOKEN = process.env.TOKEN_YAD;
if (!TOKEN) {
  console.error('Falta TOKEN_YAD (el token del sitio en YaDominios).');
  process.exit(1);
}

async function d1(sql, params = []) {
  const r = await fetch('https://yapanel.yadominios.com/api/hosting/db/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sitio: 'qrbott', token: TOKEN, sql, params }),
  });
  const d = await r.json();
  if (d.error) throw new Error(`${d.error} | ${sql.slice(0, 80)}`);
  return d;
}

// Dueños de tienda + colaboradores, con su rol y si pueden editar.
const SQL = `
select user_id, id as bot_id, 'dueno' as rol, 1 as editar
from public.bots where user_id is not null
union
select bc.user_id, bc.bot_id, coalesce(bc.role,'vendedor'),
       case when coalesce(bc.role,'') in ('socio','admin') then 1 else 0 end
from public.bot_collaborators bc where bc.user_id is not null`;

const { stdout } = await ejecutar(PSQL, [CONN, '-At', '-F', SEP, '-c', SQL], { maxBuffer: 16 * 1024 * 1024 });
const filas = stdout
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [user_id, bot_id, rol, editar] = l.split(SEP);
    return { user_id, bot_id, rol, editar: Number(editar) };
  });

console.log(`Accesos en Supabase: ${filas.length}`);

await d1('DELETE FROM _acceso');
for (const f of filas) {
  await d1(
    'INSERT INTO _acceso (user_id, bot_id, rol, puede_editar) VALUES (?, ?, ?, ?)',
    [f.user_id, f.bot_id, f.rol, f.editar],
  );
}

const { results } = await d1('SELECT count(*) AS n FROM _acceso');
console.log(`Copiados a la base nueva: ${results[0].n}`);

// Comprobación: cada persona ve exactamente las tiendas que le tocan.
const porUsuario = {};
for (const f of filas) (porUsuario[f.user_id] ||= []).push(f.bot_id);
const alguien = Object.keys(porUsuario)[0];
const { results: suyas } = await d1('SELECT bot_id FROM _acceso WHERE user_id = ?', [alguien]);
const esperadas = porUsuario[alguien].sort().join(',');
const obtenidas = suyas.map((r) => r.bot_id).sort().join(',');
console.log(
  esperadas === obtenidas
    ? `Comprobado: ${alguien.slice(0, 8)}… ve sus ${suyas.length} tienda(s) y ninguna más.`
    : `MAL: esperaba ${esperadas} y hay ${obtenidas}`,
);
process.exit(esperadas === obtenidas ? 0 : 1);
