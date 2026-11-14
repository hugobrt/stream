// Serveur de signalisation : met les 2 personnes en relation, puis tout passe en direct (WebRTC).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
    if (err) { res.writeHead(500); return res.end("index.html introuvable"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();
const out = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "join") {
      const room = rooms.get(m.room) || new Set();
      if (room.size >= 2) return out(ws, { type: "full" });
      rooms.set(m.room, room);
      room.add(ws); ws.room = m.room;
      out(ws, { type: "joined", polite: room.size === 2 });
      room.forEach((p) => p !== ws && out(p, { type: "peer-joined" }));
      return;
    }
    const room = rooms.get(ws.room);
    if (room) room.forEach((p) => p !== ws && p.readyState === 1 && p.send(raw.toString()));
  });
  ws.on("close", () => {
    const room = rooms.get(ws.room);
    if (!room) return;
    room.delete(ws);
    room.forEach((p) => out(p, { type: "peer-left" }));
    if (!room.size) rooms.delete(ws.room);
  });
});

server.listen(PORT, () => console.log(`Salon prêt : http://localhost:${PORT}`));
