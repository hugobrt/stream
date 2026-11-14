// Serveur de sessions : un hôte crée la session, un invité la rejoint. Ensuite tout passe en direct (WebRTC).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const GRACE_MS = 120000; // temps laissé à l'hôte pour se reconnecter

const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
    if (err) { res.writeHead(500); return res.end("index.html introuvable"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const sessions = new Map(); // code -> { host, guest, pin, timer }
const out = (ws, o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
const clean = (v) => String(v || "").trim().slice(0, 40);

wss.on("connection", (ws) => {
  ws.alive = true;
  ws.on("pong", () => (ws.alive = true));

  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const code = clean(m.room), pin = clean(m.pin);

    if (m.type === "create") {
      let s = sessions.get(code);
      if (s) {
        if (s.host === null && s.pin === pin) { clearTimeout(s.timer); s.host = ws; } // l'hôte revient
        else return out(ws, { type: "error", code: "exists" });
      } else { s = { host: ws, guest: null, pin, timer: null }; sessions.set(code, s); }
      ws.room = code; ws.isHost = true;
      out(ws, { type: "joined", polite: false, host: true });
      if (s.guest) { out(s.guest, { type: "peer-joined" }); out(ws, { type: "peer-joined" }); }
      return;
    }

    if (m.type === "join") {
      const s = sessions.get(code);
      if (!s) return out(ws, { type: "error", code: "nosession" });
      if (s.pin !== pin) return out(ws, { type: "error", code: "badpin" });
      if (s.guest && s.guest !== ws && s.guest.readyState === 1) return out(ws, { type: "error", code: "full" });
      s.guest = ws; ws.room = code; ws.isHost = false;
      out(ws, { type: "joined", polite: true, host: false });
      out(s.host, { type: "peer-joined" });
      return;
    }

    const s = sessions.get(ws.room);
    if (!s) return;

    if (m.type === "close") { // l'hôte termine la session
      if (!ws.isHost) return;
      clearTimeout(s.timer);
      out(s.guest, { type: "closed" }); out(s.host, { type: "closed" });
      sessions.delete(ws.room);
      return;
    }

    const other = ws.isHost ? s.guest : s.host; // chat, offres WebRTC, rôles...
    if (other && other.readyState === 1) other.send(raw.toString());
  });

  ws.on("close", () => {
    const s = sessions.get(ws.room);
    if (!s) return;
    if (ws.isHost && s.host === ws) {
      s.host = null;
      out(s.guest, { type: "peer-left" });
      const id = ws.room;
      s.timer = setTimeout(() => { out(s.guest, { type: "closed" }); sessions.delete(id); }, GRACE_MS);
    } else if (!ws.isHost && s.guest === ws) {
      s.guest = null;
      out(s.host, { type: "peer-left" });
    }
  });
});

// Détecte les connexions mortes et garde la ligne éveillée
setInterval(() => wss.clients.forEach((w) => { if (!w.alive) return w.terminate(); w.alive = false; w.ping(); }), 30000);

server.listen(PORT, () => console.log(`Salon prêt : http://localhost:${PORT}`));
