/*
 * Globule — serveur de signalisation
 * ----------------------------------
 * Petit serveur WebSocket qui met en relation le diffuseur (app PC)
 * et les spectateurs (site web) au sein de "séances" identifiées par
 * un code à 6 caractères. Il relaie les messages WebRTC (offer,
 * answer, candidates ICE) ; la vidéo elle-même circule en direct
 * de PC à PC (pair à pair), ce serveur ne la voit jamais.
 *
 * Déploiement : Render / Railway / Fly.io / VPS — voir GUIDE.md.
 * Port : process.env.PORT (fourni par l'hébergeur), sinon 8080.
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

/* ------------------------------------------------------------------ */
/* Page d'accueil + sonde de santé (utile pour surveiller le serveur)  */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()), rooms: rooms.size, clients: clientsCount() }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    '<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Globule — serveur de signalisation</title>' +
    '<style>body{background:#0b0e1a;color:#e8e9f3;font-family:system-ui,sans-serif;display:flex;min-height:100vh;' +
    'align-items:center;justify-content:center;margin:0}div{text-align:center}b{font-size:1.4rem;background:' +
    'linear-gradient(90deg,#4cc9f0,#7c5cff);-webkit-background-clip:text;background-clip:text;color:transparent}</style>' +
    '<div><b>Globule</b><p>Serveur de signalisation en ligne.<br>Rien à voir ici — ouvrez votre site de visionnage.</p></div></html>'
  );
});

const wss = new WebSocketServer({ server });

/* ------------------------------------------------------------------ */
/* État                                                                */
/* ------------------------------------------------------------------ */

// Une "séance" : { streamer: <connexion|null>, viewers: Map<id, connexion> }
const rooms = new Map();
let seq = 1;

function clientsCount() {
  let n = 0;
  rooms.forEach((r) => { n += r.viewers.size + (r.streamer ? 1 : 0); });
  return n;
}

function makeId() {
  return 'x' + (seq++).toString(36) + Math.random().toString(36).slice(2, 5);
}

function send(conn, obj) {
  if (conn && conn.readyState === conn.OPEN) {
    try { conn.send(JSON.stringify(obj)); } catch (e) { /* connexion morte : ignoré */ }
  }
}

function broadcastToViewers(room, obj, exceptId) {
  room.viewers.forEach((conn, id) => {
    if (id !== exceptId) send(conn, obj);
  });
}

// Normalise un code de séance : majuscules, sans caractères ambigus
function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function roomSummary(room) {
  return { viewerCount: room.viewers.size, streamerOnline: !!room.streamer };
}

/* ------------------------------------------------------------------ */
/* Cycle de vie des connexions                                         */
/* ------------------------------------------------------------------ */

wss.on('connection', (conn) => {
  conn.id = makeId();
  conn.roomCode = null;
  conn.role = null;
  conn.isAlive = true;

  conn.on('pong', () => { conn.isAlive = true; });

  conn.on('message', (data) => {
    if (data.length > 512 * 1024) return; // garde-fou
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }

    const type = msg && msg.type;

    /* ---- Entrée dans une séance ------------------------------------ */
    if (type === 'join') {
      const code = normalizeCode(msg.code);
      if (!code || code.length < 3) {
        send(conn, { type: 'error', message: 'Code de séance invalide (3 caractères minimum).' });
        return;
      }
      if (code.length > 12) {
        send(conn, { type: 'error', message: 'Code de séance trop long.' });
        return;
      }

      conn.roomCode = code;
      conn.role = msg.role === 'streamer' ? 'streamer' : 'viewer';
      let room = rooms.get(code);

      if (conn.role === 'streamer') {
        if (!room) { room = { streamer: null, viewers: new Map() }; rooms.set(code, room); }

        // Un redémarrage de l'app remplace l'ancien diffuseur
        if (room.streamer && room.streamer !== conn && room.streamer.readyState === room.streamer.OPEN) {
          send(room.streamer, { type: 'error', message: 'Un autre diffuseur a repris cette séance.' });
          try { room.streamer.close(); } catch (e) {}
        }
        room.streamer = conn;

        send(conn, { type: 'joined', role: 'streamer', code, id: conn.id, ...roomSummary(room) });

        // Liste des spectateurs déjà présents (rafraîchissement de page, etc.)
        const list = [];
        room.viewers.forEach((v, id) => list.push(id));
        if (list.length) send(conn, { type: 'viewers', list });

        // Les spectateurs attendent un diffuseur : prévenons-les
        broadcastToViewers(room, { type: 'streamer-online' });
      } else {
        if (!room) { room = { streamer: null, viewers: new Map() }; rooms.set(code, room); }
        room.viewers.set(conn.id, conn);

        send(conn, { type: 'joined', role: 'viewer', code, id: conn.id, ...roomSummary(room) });

        if (room.streamer && room.streamer.readyState === room.streamer.OPEN) {
          send(conn, { type: 'streamer-online' });
          send(room.streamer, { type: 'viewer-joined', viewerId: conn.id, ...roomSummary(room) });
        }
      }
      return;
    }

    /* ---- Relais WebRTC et messages de service ---------------------- */
    const room = rooms.get(conn.roomCode);
    if (!room) return;

    if (type === 'offer' || type === 'answer' || type === 'ice') {
      if (!msg.to) return;
      const target = (room.streamer && room.streamer.id === msg.to) ? room.streamer : room.viewers.get(msg.to);
      if (!target) return; // destinataire parti : tant pis, il se reconnectera
      send(target, { type, from: conn.id, payload: msg.payload });
      return;
    }

    // Message libre du diffuseur vers tous ses spectateurs (fin de séance, etc.)
    if (type === 'notice') {
      if (conn.role === 'streamer' && msg.notice) {
        broadcastToViewers(room, { type: 'notice', notice: String(msg.notice).slice(0, 200) });
      }
      return;
    }

    // Le diffuseur demande qui est là (après une reconnexion par ex.)
    if (type === 'who') {
      if (conn.role === 'streamer') {
        const list = [];
        room.viewers.forEach((v, id) => list.push(id));
        send(conn, { type: 'viewers', list, ...roomSummary(room) });
      }
      return;
    }

    // Ping applicatif : garde le lien actif (et réveille les hébergeurs
    // gratuits comme Render qui endorment les services inoccupés)
    if (type === 'ping') {
      send(conn, { type: 'pong', t: msg.t });
      return;
    }
  });

  conn.on('close', () => cleanup(conn));
  conn.on('error', () => { try { conn.close(); } catch (e) {} });
});

function cleanup(conn) {
  const code = conn.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;

  if (room.streamer === conn) {
    room.streamer = null;
    broadcastToViewers(room, { type: 'streamer-offline' });
    if (room.viewers.size === 0) rooms.delete(code);
    return;
  }

  if (room.viewers.delete(conn.id)) {
    if (room.streamer) {
      send(room.streamer, {
        type: 'viewer-left', viewerId: conn.id, viewerCount: room.viewers.size
      });
    }
    if (room.viewers.size === 0 && !room.streamer) rooms.delete(code);
  }
}

/* ------------------------------------------------------------------ */
/* Battements de cœur (détection des connexions mortes)                */
/* ------------------------------------------------------------------ */

const heartbeat = setInterval(() => {
  wss.clients.forEach((conn) => {
    if (conn.isAlive === false) { try { conn.terminate(); } catch (e) {} return; }
    conn.isAlive = false;
    try { conn.ping(); } catch (e) {}
  });
}, 30000);

server.listen(PORT, () => {
  console.log('[Globule] Serveur de signalisation en ligne sur le port ' + PORT);
});

process.on('SIGTERM', () => {
  clearInterval(heartbeat);
  wss.clients.forEach((c) => { try { c.close(); } catch (e) {} });
  server.close(() => process.exit(0));
});
