// Street ASCII : sert le jeu, relaie les joueurs (WebSocket /ws), gère les comptes,
// les sauvegardes et le monde persistant (gangs et territoires) dans une base permanente.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const store = require('./store');
const PORT = process.env.PORT || 8080;
const PUB = path.join(__dirname, 'public');
const INDEX = path.join(PUB, 'index.html');
const MAX_ROOM = 24, MAX_MSG = 4096, TICK = 90;
const NPC_TAGS = ['TIG', 'LOT', 'NAG'], NPC_NOMS = ['tigres de lumphini', 'lotus noir', 'naga du fleuve'];
const RACKET_PTS = 12, INF_MAX = 250, INF_CD = 20000, DECAY_H = 3, SESSION_J = 120;

// ---------------------------------------------------------------- utilitaires
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rnd = n => crypto.randomBytes(n).toString('hex');
const now = () => Date.now();
const lc = s => String(s || '').trim().toLowerCase();
const propre = (s, max) => String(s || '').replace(/[^\p{L}\p{N} -]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max);
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
function lireCorps(req, max = 3_000_000) {
  return new Promise((ok, ko) => {
    let n = 0; const b = [];
    req.on('data', c => { n += c.length; if (n > max) { ko(new Error('trop gros')); req.destroy(); } else b.push(c); });
    req.on('end', () => { try { ok(b.length ? JSON.parse(Buffer.concat(b).toString('utf8')) : {}); } catch (e) { ko(e); } });
    req.on('error', ko);
  });
}
// limiteur : n essais par fenêtre
const essais = new Map();
function limite(cle, n, ms) {
  const t = now(); let a = (essais.get(cle) || []).filter(x => t - x < ms);
  if (a.length >= n) { essais.set(cle, a); return false; }
  a.push(t); essais.set(cle, a); return true;
}
setInterval(() => { const t = now(); for (const [k, a] of essais) { const b = a.filter(x => t - x < 3_600_000); if (b.length) essais.set(k, b); else essais.delete(k); } }, 600_000);

// ---------------------------------------------------------------- comptes
const hacher = (pw, sel) => crypto.scryptSync(String(pw), sel, 32).toString('hex');
function userParNom(nom) { const id = store.get('nom:' + lc(nom)); return id ? store.get('user:' + id) : null; }
function creerSession(uid) {
  const tok = rnd(24);
  store.set('sess:' + sha(tok), { uid, exp: now() + SESSION_J * 86400000 });
  return tok;
}
function auth(req, url) {
  let tok = '';
  const h = req.headers.authorization || '';
  if (/^Bearer /.test(h)) tok = h.slice(7).trim();
  else if (url && url.searchParams.get('t')) tok = url.searchParams.get('t');
  if (!tok) return null;
  const s = store.get('sess:' + sha(tok));
  if (!s || s.exp < now()) return null;
  const u = store.get('user:' + s.uid);
  return u || null;
}
const vueUser = u => ({ uid: u.id, nom: u.nom, gid: u.gid || '' });

// ---------------------------------------------------------------- monde persistant : gangs et influence
function monde() {
  let w = store.get('world');
  if (!w) { w = { gangs: {}, infl: {}, decayT: now() }; store.set('world', w); }
  return w;
}
function decroit(w) {
  const pas = Math.floor((now() - (w.decayT || now())) / (DECAY_H * 3600000));
  if (pas < 1) return false;
  w.decayT = (w.decayT || now()) + pas * DECAY_H * 3600000;
  for (const d in w.infl) {
    for (const g in w.infl[d]) { w.infl[d][g] -= pas; if (w.infl[d][g] <= 0) delete w.infl[d][g]; }
    if (!Object.keys(w.infl[d]).length) delete w.infl[d];
  }
  store.set('world', w); return true;
}
const vueMonde = (w, u) => ({ gangs: Object.fromEntries(Object.entries(w.gangs).map(([id, g]) => [id, { id, nom: g.nom, tag: g.tag, col: g.col, n: Object.keys(g.membres).length }])), infl: w.infl, me: u ? (u.gid || '') : '', t: now() });
function quitterGang(u) {
  const w = monde(); const g = w.gangs[u.gid];
  if (g) {
    delete g.membres[u.id];
    if (!Object.keys(g.membres).length) { delete w.gangs[u.gid]; for (const d in w.infl) { delete w.infl[d][u.gid]; if (!Object.keys(w.infl[d]).length) delete w.infl[d]; } }
    store.set('world', w);
  }
  u.gid = ''; store.set('user:' + u.id, u);
}
const invitations = new Map(); // uidDestinataire -> {gid, de, exp}

// ---------------------------------------------------------------- API
async function api(req, res, url) {
  const p = url.pathname;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
  if (p === '/api/config') {
    const u = String(process.env.SUPPORT_URL || '').trim();
    const ok = /^https?:\/\/[^\s<>"']+$/i.test(u);
    return json(res, 200, { support: ok ? { url: u, label: String(process.env.SUPPORT_LABEL || 'Soutenir la créatrice').slice(0, 40) } : null });
  }
  if (p === '/api/ping') return json(res, 200, { ok: 1, acc: 1, db: store.mode() });
  let b = {};
  if (req.method === 'POST' || req.method === 'PUT') { try { b = await lireCorps(req); } catch (e) { return json(res, 400, { err: 'requête illisible' }); } }

  if (p === '/api/register' && req.method === 'POST') {
    if (!limite('reg:' + ip, 6, 3600000)) return json(res, 429, { err: 'Trop de créations de compte, réessaie plus tard.' });
    const nom = propre(b.nom, 14), pw = String(b.pw || '');
    if (nom.length < 3) return json(res, 400, { err: 'Pseudo : 3 caractères minimum.' });
    if (pw.length < 4 || pw.length > 64) return json(res, 400, { err: 'Mot de passe : 4 caractères minimum.' });
    if (userParNom(nom)) return json(res, 409, { err: 'Ce pseudo est déjà pris.' });
    const id = 'u' + rnd(5), sel = rnd(8);
    const u = { id, nom, sel, hash: hacher(pw, sel), cree: now(), gid: '' };
    store.set('user:' + id, u); store.set('nom:' + lc(nom), id);
    return json(res, 200, { tok: creerSession(id), ...vueUser(u) });
  }
  if (p === '/api/login' && req.method === 'POST') {
    if (!limite('log:' + ip, 12, 600000)) return json(res, 429, { err: 'Trop d’essais, patiente quelques minutes.' });
    const u = userParNom(b.nom);
    if (!u || hacher(b.pw, u.sel) !== u.hash) return json(res, 401, { err: 'Pseudo ou mot de passe incorrect.' });
    return json(res, 200, { tok: creerSession(u.id), ...vueUser(u) });
  }
  if (p === '/api/world' && req.method === 'GET') {
    const w = monde(); decroit(w);
    return json(res, 200, vueMonde(w, auth(req, url)));
  }
  const u = auth(req, url);
  if (!u) return json(res, 401, { err: 'Connexion requise.' });

  if (p === '/api/save') {
    if (req.method === 'GET') return json(res, 200, { ...vueUser(u), data: store.get('save:' + u.id) || '', maj: (store.get('savet:' + u.id) || 0) });
    if (typeof b.data !== 'string' || b.data.length > 2_000_000) return json(res, 400, { err: 'sauvegarde invalide' });
    try { JSON.parse(b.data); } catch (e) { return json(res, 400, { err: 'sauvegarde invalide' }); }
    store.set('save:' + u.id, b.data); store.set('savet:' + u.id, now());
    return json(res, 200, { ok: 1 });
  }
  if (p === '/api/gang/create' && req.method === 'POST') {
    const nom = propre(b.nom, 16), tag = String(b.tag || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4);
    const col = /^#[0-9a-f]{6}$/i.test(b.col || '') ? b.col : '#ff3fb4';
    if (nom.length < 3 || tag.length < 2) return json(res, 400, { err: 'Nom (3+) et sigle (2 à 4) requis.' });
    if (NPC_TAGS.includes(tag) || NPC_NOMS.includes(lc(nom))) return json(res, 409, { err: 'Ce nom est pris par un gang de la ville.' });
    const w = monde();
    for (const g of Object.values(w.gangs)) if (g.tag === tag || lc(g.nom) === lc(nom)) return json(res, 409, { err: 'Un gang porte déjà ce nom ou ce sigle.' });
    if (u.gid) quitterGang(u);
    const id = 'g' + rnd(5);
    w.gangs[id] = { id, nom, tag, col, chef: u.id, cree: now(), membres: { [u.id]: u.nom } };
    store.set('world', w); u.gid = id; store.set('user:' + u.id, u);
    return json(res, 200, vueMonde(w, u));
  }
  if (p === '/api/gang/invite' && req.method === 'POST') {
    const w = monde(); const g = w.gangs[u.gid];
    if (!g) return json(res, 400, { err: 'Tu n’as pas de gang.' });
    const to = String(b.to || '').replace(/[^a-z0-9]/gi, '').slice(0, 12);
    if (!to) return json(res, 400, { err: 'destinataire invalide' });
    invitations.set(to, { gid: g.id, de: u.id, exp: now() + 300000 });
    return json(res, 200, { ok: 1 });
  }
  if (p === '/api/gang/join' && req.method === 'POST') {
    const w = monde(); const inv = invitations.get(u.id);
    if (!inv || inv.exp < now() || inv.gid !== b.gid || !w.gangs[inv.gid]) return json(res, 403, { err: 'Invitation expirée ou inconnue.' });
    if (u.gid === inv.gid) return json(res, 200, vueMonde(w, u));
    if (u.gid) quitterGang(u);
    const g = monde().gangs[inv.gid]; if (!g) return json(res, 403, { err: 'Ce gang n’existe plus.' });
    g.membres[u.id] = u.nom; store.set('world', monde()); u.gid = g.id; store.set('user:' + u.id, u);
    invitations.delete(u.id);
    return json(res, 200, vueMonde(monde(), u));
  }
  if (p === '/api/gang/leave' && req.method === 'POST') {
    if (u.gid) quitterGang(u);
    return json(res, 200, vueMonde(monde(), u));
  }
  if (p === '/api/gang/inf' && req.method === 'POST') {
    const w = monde(); decroit(w);
    const g = w.gangs[u.gid]; const d = b.d | 0;
    if (!g || d < 0 || d > 9) return json(res, 400, { err: 'Impossible.' });
    if (!limite('inf:' + u.id, 1, INF_CD)) return json(res, 429, { err: 'Trop rapide.' });
    const pts = Math.max(8, Math.min(20, b.pts | 0 || RACKET_PTS));
    const m = w.infl[d] || (w.infl[d] = {});
    m[g.id] = Math.min(INF_MAX, (m[g.id] || 0) + pts);
    store.set('world', w);
    return json(res, 200, vueMonde(w, u));
  }
  return json(res, 404, { err: 'inconnu' });
}

// ---------------------------------------------------------------- HTTP
const TYPES = { '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer(async (req, res) => {
  let url; try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) return await api(req, res, url);
    if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (p === '/count') {
      const salles = {};
      for (const [n, set] of rooms) { const r = n.replace(/^rue-/, ''); if (r === 'krung-thep' || r.startsWith('pub-')) salles[r] = set.size; }
      return json(res, 200, { salles });
    }
    if (p === '/info') {
      return fs.readFile(INDEX, (e, d) => json(res, 200, e ? { err: String(e) } : { octets: d.length, ok: d.toString('utf8').trimEnd().endsWith('</html>'), sha: sha(d).slice(0, 12), db: store.mode() }));
    }
    const stat = { '/og.png': 'og.png', '/favicon.png': 'favicon.png', '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png', '/icon-maskable.png': 'icon-maskable.png', '/apple-touch-icon.png': 'apple-touch-icon.png', '/manifest.webmanifest': 'manifest.webmanifest' }[p];
    if (stat) return fs.readFile(path.join(PUB, stat), (e, d) => {
      if (e) { res.writeHead(404); return res.end('404'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(stat)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' }); res.end(d);
    });
    if (p === '/' || p.startsWith('/index')) {
      return fs.readFile(INDEX, (e, d) => {
        if (e) { res.writeHead(500); return res.end('index manquant'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(d);
      });
    }
    res.writeHead(404); res.end('404');
  } catch (e) { console.error(e); if (!res.headersSent) json(res, 500, { err: 'erreur serveur' }); }
});

// ---------------------------------------------------------------- relais multijoueur
const wss = new WebSocketServer({ server: srv, path: '/ws', maxPayload: MAX_MSG });
const rooms = new Map(); // nom -> Set<client>
let nextId = 1;
wss.on('connection', (ws) => {
  ws.id = 'p' + (nextId++); ws.room = null; ws.state = null; ws.alive = true; ws.budget = 80; ws.last = 0;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => {
    if (--ws.budget < 0) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'join') {
      const name = String(m.room || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
      if (!name || ws.room) return;
      let set = rooms.get(name); if (!set) { set = new Set(); rooms.set(name, set); }
      if (set.size >= MAX_ROOM) { ws.send(JSON.stringify({ t: 'full' })); return; }
      set.add(ws); ws.room = name;
      ws.send(JSON.stringify({ t: 'joined', id: ws.id }));
    } else if (m.t === 'p' && ws.room && m.s && typeof m.s === 'object') {
      ws.state = m.s;
    }
  });
  ws.on('close', () => { if (ws.room) { const s = rooms.get(ws.room); if (s) { s.delete(ws); if (!s.size) rooms.delete(ws.room); } } });
  ws.on('error', () => {});
});
setInterval(() => {
  for (const [, set] of rooms) {
    const peers = [];
    for (const c of set) if (c.state) peers.push({ id: c.id, presence: c.state });
    if (!peers.length) continue;
    const out = JSON.stringify({ t: 'peers', peers });
    for (const c of set) if (c.readyState === 1) c.send(out);
  }
}, TICK);
setInterval(() => { for (const c of wss.clients) { c.budget = 80; if (!c.alive) { c.terminate(); continue; } c.alive = false; try { c.ping(); } catch (e) {} } }, 5000);

// ---------------------------------------------------------------- démarrage / arrêt propre
store.init().then(m => {
  console.log('Base de données : ' + m + (m === 'fichier' ? ' (définis DATABASE_URL pour une base PostgreSQL permanente)' : ''));
  srv.listen(PORT, () => console.log('Street ASCII sur le port ' + PORT));
}).catch(e => { console.error('Base de données inaccessible :', e.message); process.exit(1); });
const fin = async () => { try { await store.close(); } catch (e) {} process.exit(0); };
process.on('SIGTERM', fin); process.on('SIGINT', fin);
