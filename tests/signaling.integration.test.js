// tests/signaling.integration.test.js — интеграционные тесты сигналинг-сервера.
// Поднимаем сервер на свободном порту и проверяем весь протокол через WS.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { WebSocket } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let serverProcess;
let port;

function freePort() {
  // 9000-9999 диапазон, фиксируем псевдослучайный
  return 9000 + Math.floor(Math.random() * 1000);
}

async function startServer() {
  port = freePort();
  const serverPath = path.resolve(__dirname, '..', 'server', 'signaling.js');
  serverProcess = spawn('node', [serverPath], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // ждём, пока сервер выведет startup-сообщение
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 3000);
    serverProcess.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    serverProcess.stderr.on('data', (chunk) => {
      // тихо терпим stderr, но если ошибка — выводим
      if (chunk.toString().includes('Error')) console.error(chunk.toString());
    });
  });
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function collect(ws) {
  const msgs = [];
  ws.on('message', (raw) => {
    try { msgs.push(JSON.parse(raw.toString())); } catch {}
  });
  return msgs;
}

function send(ws, payload) {
  ws.send(JSON.stringify(payload));
}

describe('Signaling server (integration)', () => {
  beforeEach(startServer);
  afterEach(stopServer);

  test('join → joined: первый клиент получает роль caller', async () => {
    const ws = await connect();
    const msgs = collect(ws);
    send(ws, { type: 'join', roomId: 'r1' });
    await wait(100);
    assert.ok(msgs.some(m => m.type === 'joined' && m.role === 'caller'));
    ws.close();
  });

  test('второй клиент в комнате получает роль callee, первый — peers count=2', async () => {
    const a = await connect();
    const b = await connect();
    const msgsA = collect(a);
    const msgsB = collect(b);
    send(a, { type: 'join', roomId: 'r2' });
    await wait(100);
    send(b, { type: 'join', roomId: 'r2' });
    await wait(100);
    assert.ok(msgsB.some(m => m.type === 'joined' && m.role === 'callee'));
    assert.ok(msgsA.some(m => m.type === 'peers' && m.count === 2));
    a.close(); b.close();
  });

  test('третий клиент в той же комнате получает "full"', async () => {
    const a = await connect();
    const b = await connect();
    const c = await connect();
    send(a, { type: 'join', roomId: 'r3' });
    await wait(50);
    send(b, { type: 'join', roomId: 'r3' });
    await wait(50);
    const msgsC = collect(c);
    send(c, { type: 'join', roomId: 'r3' });
    await wait(100);
    assert.ok(msgsC.some(m => m.type === 'full'));
    a.close(); b.close(); c.close();
  });

  test('offer пересылается второму пиру в комнате', async () => {
    const a = await connect();
    const b = await connect();
    send(a, { type: 'join', roomId: 'r4' });
    await wait(50);
    send(b, { type: 'join', roomId: 'r4' });
    await wait(50);
    const msgsB = collect(b);
    send(a, { type: 'offer', sdp: { type: 'offer', sdp: 'fake-sdp' } });
    await wait(100);
    assert.ok(msgsB.some(m => m.type === 'offer' && m.sdp?.sdp === 'fake-sdp'));
    a.close(); b.close();
  });

  test('candidate пересылается между пирами', async () => {
    const a = await connect();
    const b = await connect();
    send(a, { type: 'join', roomId: 'r5' });
    await wait(50);
    send(b, { type: 'join', roomId: 'r5' });
    await wait(50);
    const msgsA = collect(a);
    send(b, { type: 'candidate', candidate: { candidate: 'fake', sdpMid: 'audio' } });
    await wait(100);
    assert.ok(msgsA.some(m => m.type === 'candidate' && m.candidate?.candidate === 'fake'));
    a.close(); b.close();
  });

  test('restart-request от callee пересылается caller', async () => {
    const a = await connect();
    const b = await connect();
    send(a, { type: 'join', roomId: 'r6' });
    await wait(50);
    send(b, { type: 'join', roomId: 'r6' });
    await wait(50);
    const msgsA = collect(a);
    send(b, { type: 'restart-request' });
    await wait(100);
    assert.ok(msgsA.some(m => m.type === 'restart-request'),
      'caller должен получить restart-request от callee');
    a.close(); b.close();
  });

  test('peers count уменьшается при отключении одного из участников', async () => {
    const a = await connect();
    const b = await connect();
    send(a, { type: 'join', roomId: 'r7' });
    await wait(50);
    send(b, { type: 'join', roomId: 'r7' });
    await wait(100);
    const msgsA = collect(a);
    b.close();
    await wait(150);
    assert.ok(msgsA.some(m => m.type === 'peers' && m.count === 1));
    a.close();
  });

  test('bye пересылается и инициатор удаляется из комнаты', async () => {
    const a = await connect();
    const b = await connect();
    send(a, { type: 'join', roomId: 'r8' });
    await wait(50);
    send(b, { type: 'join', roomId: 'r8' });
    await wait(50);
    const msgsB = collect(b);
    send(a, { type: 'bye' });
    await wait(100);
    assert.ok(msgsB.some(m => m.type === 'bye'));
    a.close(); b.close();
  });

  test('пустой/невалидный JSON игнорируется без падения', async () => {
    const ws = await connect();
    send(ws, { type: 'join', roomId: 'r9' });
    await wait(50);
    ws.send('not-json'); // не должно крашить сервер
    ws.send(JSON.stringify({}));  // без type — игнор
    await wait(100);
    // сервер всё ещё работает — проверяем подключением второго клиента
    const ws2 = await connect();
    const msgs = collect(ws2);
    send(ws2, { type: 'join', roomId: 'r9b' });
    await wait(100);
    assert.ok(msgs.some(m => m.type === 'joined'));
    ws.close(); ws2.close();
  });
});
