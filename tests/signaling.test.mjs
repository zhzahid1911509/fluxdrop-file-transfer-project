import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { createSignalingServer, generatePairingCode } from '../server/signaling-server.mjs';

function connectRawWs(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        [
          'GET / HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n')
      );
    });

    let upgraded = false;
    let buf = Buffer.alloc(0);
    const queue = [];
    const waiters = [];

    function dispatch(msg) {
      if (waiters.length > 0) {
        waiters.shift()(msg);
      } else {
        queue.push(msg);
      }
    }

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        upgraded = true;
        buf = buf.subarray(idx + 4);
        resolve({
          sendJson(obj) {
            const payload = Buffer.from(JSON.stringify(obj), 'utf8');
            const mask = crypto.randomBytes(4);
            const header =
              payload.length < 126
                ? Buffer.from([0x81, 0x80 | payload.length])
                : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
            const masked = Buffer.alloc(payload.length);
            for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
            socket.write(Buffer.concat([header, mask, masked]));
          },
          sendBinary(bytes) {
            const payload = Buffer.from(bytes);
            const mask = crypto.randomBytes(4);
            const header = Buffer.from([0x82, 0x80 | payload.length]);
            const masked = Buffer.alloc(payload.length);
            for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
            socket.write(Buffer.concat([header, mask, masked]));
          },
          nextJson() {
            if (queue.length > 0) return Promise.resolve(queue.shift());
            return new Promise((res) => waiters.push(res));
          },
          close() {
            socket.destroy();
          },
        });
      }

      while (upgraded && buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (opcode === 0x1) {
          dispatch(JSON.parse(payload.toString('utf8')));
        }
      }
    });

    socket.on('error', reject);
  });
}

test('generatePairingCode produces 6 unambiguous uppercase chars', () => {
  const code = generatePairingCode(6);
  assert.equal(code.length, 6);
  assert.match(code, /^[A-HJ-NP-Z]{6}$/);
});

test('Ephemeral signaling server: room lifecycle, signal relay, binary rejection, and rate limit', async () => {
  const instance = createSignalingServer({ maxFailures: 3, lockoutMs: 5000 });
  await new Promise((res) => instance.server.listen(0, '127.0.0.1', res));
  const { port } = instance.server.address();

  const host = await connectRawWs(port);
  const guest = await connectRawWs(port);

  // 1. Host creates room
  host.sendJson({ type: 'CREATE_ROOM', deviceInfo: { name: 'HostLaptop' } });
  const created = await host.nextJson();
  assert.equal(created.type, 'ROOM_CREATED');
  assert.equal(created.code.length, 6);

  // 2. Guest joins room
  guest.sendJson({ type: 'JOIN_ROOM', code: created.code, deviceInfo: { name: 'GuestPhone' } });
  const joined = await guest.nextJson();
  assert.equal(joined.type, 'ROOM_JOINED');
  const peerJoined = await host.nextJson();
  assert.equal(peerJoined.type, 'PEER_JOINED');

  // 3. Signal relay (SDP offer)
  host.sendJson({ type: 'SIGNAL', targetId: peerJoined.peerId, payload: { type: 'offer', sdp: 'v=0...' } });
  const relayed = await guest.nextJson();
  assert.equal(relayed.type, 'SIGNAL');
  assert.equal(relayed.payload.type, 'offer');

  // 4. Binary frame rejection (file data forbidden on signaling)
  host.sendBinary([1, 2, 3, 4]);
  const binErr = await host.nextJson();
  assert.equal(binErr.type, 'ERROR');
  assert.equal(binErr.code, 'BINARY_FORBIDDEN');

  // 5. Rate limiting on brute-force pairing code attempts
  const attacker = await connectRawWs(port);
  for (let i = 0; i < 3; i++) {
    attacker.sendJson({ type: 'JOIN_ROOM', code: 'ZZZZZZ' });
    const err = await attacker.nextJson();
    assert.equal(err.code, 'ROOM_NOT_FOUND');
  }
  attacker.sendJson({ type: 'JOIN_ROOM', code: 'ZZZZZZ' });
  const locked = await attacker.nextJson();
  assert.equal(locked.code, 'RATE_LIMITED');

  // 6. Health endpoint
  const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
  const healthJson = await healthRes.json();
  assert.equal(healthJson.status, 'ok');
  assert.equal(healthJson.activeRooms, 1);

  host.close();
  guest.close();
  attacker.close();
  await instance.stop();
});
