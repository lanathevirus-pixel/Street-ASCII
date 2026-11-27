// Street ASCII : sert le jeu et relaie les positions des joueurs (aucune partie n'est stockée).
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 8080;
const INDEX = path.join(__dirname, 'public', 'index.html');
const MAX_ROOM = 24, MAX_MSG = 4096, TICK = 120;

const srv = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (req.url.split('?')[0] === '/' || req.url.startsWith('/index')) {
    fs.readFile(INDEX, (e, d) => {
      if (e) { res.writeHead(500); return res.end('index manquant'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(d);
    });
    return;
  }
  res.writeHead(404); res.end('404');
});

const wss = new WebSocketServer({ server: srv, path: '/ws', maxPayload: MAX_MSG });
const rooms = new Map(); // nom -> Set<client>
let nextId = 1;

wss.on('connection', (ws) => {
  ws.id = 'p' + (nextId++); ws.room = null; ws.state = null; ws.alive = true; ws.budget = 30; ws.last = 0;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => {
    if (--ws.budget < 0) return;                       // anti-flood
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

// diffusion : chaque client reçoit la liste de la salle
setInterval(() => {
  for (const [, set] of rooms) {
    const peers = [];
    for (const c of set) if (c.state) peers.push({ id: c.id, presence: c.state });
    if (!peers.length) continue;
    const out = JSON.stringify({ t: 'peers', peers });
    for (const c of set) if (c.readyState === 1) c.send(out);
  }
}, TICK);
setInterval(() => { for (const c of wss.clients) { c.budget = 30; if (!c.alive) { c.terminate(); continue; } c.alive = false; try { c.ping(); } catch (e) {} } }, 5000);

srv.listen(PORT, () => console.log('Street ASCII sur le port ' + PORT));
