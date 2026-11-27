// Stockage clé/valeur permanent.
//  - DATABASE_URL défini  -> PostgreSQL (Neon, Supabase, Render Postgres…) : permanent, survit aux redéploiements.
//  - sinon                -> fichier JSON dans DATA_DIR (disque persistant Render monté sur /data, ou ./data en local).
// Toutes les données sont aussi gardées en mémoire : lire est instantané, écrire est « write-through ».
const fs = require('fs'), path = require('path');
const mem = new Map();
let mode = 'fichier', pool = null, file = null, tmr = null, dirty = new Set(), writing = false;

async function init() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = require(process.env.PG_MODULE || 'pg');
    pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) || process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false }, max: 4 });
    try { await pool.query('CREATE TABLE kv (k text PRIMARY KEY, v jsonb NOT NULL)'); } catch (e) { if (!/exist/i.test(e.message)) throw e; }
    const r = await pool.query('SELECT k, v FROM kv');
    for (const row of r.rows) mem.set(row.k, row.v);
    mode = 'postgres';
  } else {
    const dir = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    file = path.join(dir, 'street-ascii-data.json');
    try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); for (const k in o) mem.set(k, o[k]); } catch (e) {}
    mode = 'fichier';
  }
  return mode;
}
const get = k => mem.get(k);
function set(k, v) { mem.set(k, v); dirty.add(k); plan(); }
function del(k) { mem.delete(k); dirty.add(k); plan(); }
function plan() { if (!tmr) tmr = setTimeout(flush, 1200); }
async function flush() {
  tmr = null;
  if (writing) { plan(); return; }
  writing = true;
  const ks = [...dirty]; dirty = new Set();
  try {
    if (pool) {
      for (const k of ks) {
        if (mem.has(k)) await pool.query('INSERT INTO kv (k, v) VALUES ($1, $2::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', [k, JSON.stringify(mem.get(k))]);
        else await pool.query('DELETE FROM kv WHERE k = $1', [k]);
      }
    } else {
      const o = {}; for (const [k, v] of mem) o[k] = v;
      const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(o)); fs.renameSync(tmp, file);
    }
  } catch (e) { console.error('écriture impossible :', e.message); for (const k of ks) dirty.add(k); setTimeout(plan, 5000); }
  writing = false;
}
async function close() { if (tmr) clearTimeout(tmr); await flush(); if (pool) await pool.end(); }
module.exports = { init, get, set, del, flush, close, mode: () => mode };
