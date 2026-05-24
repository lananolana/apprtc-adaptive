// signaling.js — minimal WebRTC signaling server.
// Functionally substitutes the Collider component of AppRTC (Go) with a
// small Node.js WebSocket service so that the prototype can be deployed on
// free hosting tiers (Render.com / Fly.io / Railway).
//
// Protocol (JSON over WS):
//   { type: 'join',  roomId }                    — register, server replies with 'joined' incl. role
//   { type: 'peers', roomId, peers: [...] }      — broadcast on join/leave
//   { type: 'offer', roomId, sdp }               — forward to other peer in the room
//   { type: 'answer', roomId, sdp }              — forward to other peer in the room
//   { type: 'candidate', roomId, candidate }     — forward to other peer in the room
//   { type: 'bye',   roomId }                    — forward, close
//
// A "room" holds up to 2 sockets. Third joiner is rejected with 'full'.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_DIR = path.resolve(__dirname, '..', 'client');

const PORT = process.env.PORT || 8080;

// --- static file server for the client ---------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon'
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  // health-check endpoint for free-tier keepalive pingers
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  const filePath = path.join(CLIENT_DIR, urlPath);
  if (!filePath.startsWith(CLIENT_DIR)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// --- signaling ---------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' });

/** @type {Map<string, Set<WebSocket>>} */
const rooms = new Map();

function broadcast(roomId, fromSocket, payload) {
  const peers = rooms.get(roomId);
  if (!peers) return;
  const msg = JSON.stringify(payload);
  for (const peer of peers) {
    if (peer !== fromSocket && peer.readyState === peer.OPEN) peer.send(msg);
  }
}

function leaveRoom(socket) {
  const roomId = socket.roomId;
  if (!roomId) return;
  const peers = rooms.get(roomId);
  if (!peers) return;
  peers.delete(socket);
  if (peers.size === 0) {
    rooms.delete(roomId);
  } else {
    broadcast(roomId, socket, { type: 'peers', roomId, count: peers.size });
  }
  socket.roomId = null;
}

wss.on('connection', (socket) => {
  socket.roomId = null;
  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'join') {
      const roomId = String(msg.roomId || '').trim();
      if (!roomId) {
        socket.send(JSON.stringify({ type: 'error', reason: 'roomId required' }));
        return;
      }
      let peers = rooms.get(roomId);
      if (!peers) { peers = new Set(); rooms.set(roomId, peers); }
      if (peers.size >= 2) {
        socket.send(JSON.stringify({ type: 'full', roomId }));
        return;
      }
      peers.add(socket);
      socket.roomId = roomId;
      const role = peers.size === 1 ? 'caller' : 'callee';
      socket.send(JSON.stringify({ type: 'joined', roomId, role, count: peers.size }));
      broadcast(roomId, socket, { type: 'peers', roomId, count: peers.size });
      return;
    }

    // forwarded message types
    if (['offer', 'answer', 'candidate', 'bye'].includes(msg.type) && socket.roomId) {
      broadcast(socket.roomId, socket, msg);
      if (msg.type === 'bye') leaveRoom(socket);
    }
  });

  socket.on('close', () => leaveRoom(socket));
  socket.on('error', () => leaveRoom(socket));
});

server.listen(PORT, () => {
  console.log(`[signaling] listening on http://localhost:${PORT}  (ws path: /ws)`);
});
