/**
 * FluxDrop Ephemeral WebSocket Signaling Server
 * ---------------------------------------------------------------------------
 * - Zero external dependencies (pure Node.js RFC 6455 WebSocket implementation)
 * - Database-less: all room state is ephemeral in-memory Map entries
 * - Zero file-content handling: rejects binary frames & oversized payloads (> 64 KB)
 * - CSPRNG 6-character pairing codes (ambiguous characters 0/O/1/I/L excluded)
 * - Automatic TTL expiration & per-IP brute-force rate limiting
 */

import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DEFAULT_ROOM_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_SIGNAL_PAYLOAD_BYTES = 64 * 1024; // 64 KB max (SDP/ICE only)
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_FAILURES = 5;
const RATE_LIMIT_LOCKOUT_MS = 60 * 1000;

export function generatePairingCode(length = 6) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

function createWsAcceptKey(secWebSocketKey) {
  return crypto
    .createHash('sha1')
    .update(secWebSocketKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function encodeWsFrame(opcode, payloadBuffer) {
  const len = payloadBuffer.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuffer]);
}

class EphemeralWsClient {
  constructor(socket, remoteIp) {
    this.id = crypto.randomUUID();
    this.socket = socket;
    this.remoteIp = remoteIp;
    this.roomCode = null;
    this.role = null;
    this.deviceInfo = null;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
  }

  sendJson(obj) {
    if (this.closed || this.socket.destroyed) return;
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    this.socket.write(encodeWsFrame(0x1, data));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    if (!this.socket.destroyed) {
      const reasonBuf = Buffer.from(reason, 'utf8');
      const payload = Buffer.alloc(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);
      try {
        this.socket.write(encodeWsFrame(0x8, payload));
      } catch {
        // ignore write errors during close
      }
      this.socket.end();
    }
  }
}

export function createSignalingServer(options = {}) {
  const roomTtlMs = options.roomTtlMs ?? DEFAULT_ROOM_TTL_MS;
  const maxFailures = options.maxFailures ?? RATE_LIMIT_MAX_FAILURES;
  const lockoutMs = options.lockoutMs ?? RATE_LIMIT_LOCKOUT_MS;

  /** @type {Map<string, { code: string, host: EphemeralWsClient, guests: Map<string, EphemeralWsClient>, expiresAt: number }>} */
  const rooms = new Map();
  const clients = new Set();

  /** @type {Map<string, { failures: number[], lockedUntil: number }>} */
  const rateLimits = new Map();

  function isRateLimited(ip) {
    const now = Date.now();
    const record = rateLimits.get(ip);
    if (!record) return { limited: false, retryAfterMs: 0 };
    if (record.lockedUntil > now) {
      return { limited: true, retryAfterMs: record.lockedUntil - now };
    }
    record.failures = record.failures.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
    return { limited: false, retryAfterMs: 0 };
  }

  function recordFailure(ip) {
    const now = Date.now();
    const record = rateLimits.get(ip) ?? { failures: [], lockedUntil: 0 };
    record.failures = record.failures.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
    record.failures.push(now);
    if (record.failures.length >= maxFailures) {
      record.lockedUntil = now + lockoutMs;
      record.failures = [];
    }
    rateLimits.set(ip, record);
  }

  function leaveCurrentRoom(client) {
    if (!client.roomCode) return;
    const room = rooms.get(client.roomCode);
    if (!room) {
      client.roomCode = null;
      return;
    }

    if (room.host === client) {
      for (const guest of room.guests.values()) {
        guest.sendJson({ type: 'ROOM_CLOSED', reason: 'Host disconnected' });
        guest.roomCode = null;
      }
      rooms.delete(client.roomCode);
    } else if (room.guests.has(client.id)) {
      room.guests.delete(client.id);
      room.host.sendJson({ type: 'PEER_LEFT', peerId: client.id });
    }
    client.roomCode = null;
    client.role = null;
  }

  function handleMessage(client, rawText) {
    let msg;
    try {
      msg = JSON.parse(rawText);
    } catch {
      client.sendJson({ type: 'ERROR', code: 'INVALID_JSON', message: 'Malformed signaling message.' });
      return;
    }

    if (!msg || typeof msg.type !== 'string') {
      client.sendJson({ type: 'ERROR', code: 'INVALID_TYPE', message: 'Missing message type.' });
      return;
    }

    switch (msg.type) {
      case 'CREATE_ROOM': {
        leaveCurrentRoom(client);
        let code = generatePairingCode(6);
        while (rooms.has(code)) {
          code = generatePairingCode(6);
        }
        const ttl = typeof msg.ttlMs === 'number' && msg.ttlMs > 10_000 && msg.ttlMs <= 30 * 60_000
          ? msg.ttlMs
          : roomTtlMs;
        const expiresAt = Date.now() + ttl;
        client.roomCode = code;
        client.role = 'host';
        client.deviceInfo = msg.deviceInfo ?? { name: 'Sender Device' };

        rooms.set(code, {
          code,
          host: client,
          guests: new Map(),
          expiresAt,
        });

        client.sendJson({
          type: 'ROOM_CREATED',
          code,
          peerId: client.id,
          expiresAt,
        });
        break;
      }

      case 'JOIN_ROOM': {
        const { limited, retryAfterMs } = isRateLimited(client.remoteIp);
        if (limited) {
          client.sendJson({
            type: 'ERROR',
            code: 'RATE_LIMITED',
            message: `Too many invalid attempts. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`,
            retryAfterMs,
          });
          return;
        }

        const code = String(msg.code ?? '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room || room.expiresAt <= Date.now()) {
          if (room) rooms.delete(code);
          recordFailure(client.remoteIp);
          client.sendJson({
            type: 'ERROR',
            code: 'ROOM_NOT_FOUND',
            message: 'Pairing code is invalid or expired.',
          });
          return;
        }

        leaveCurrentRoom(client);
        client.roomCode = code;
        client.role = 'guest';
        client.deviceInfo = msg.deviceInfo ?? { name: 'Receiver Device' };
        room.guests.set(client.id, client);

        client.sendJson({
          type: 'ROOM_JOINED',
          code,
          peerId: client.id,
          hostId: room.host.id,
          hostDeviceInfo: room.host.deviceInfo,
          expiresAt: room.expiresAt,
        });

        room.host.sendJson({
          type: 'PEER_JOINED',
          peerId: client.id,
          deviceInfo: client.deviceInfo,
        });
        break;
      }

      case 'SIGNAL': {
        if (!client.roomCode) {
          client.sendJson({ type: 'ERROR', code: 'NOT_IN_ROOM', message: 'Join a room before signaling.' });
          return;
        }
        const room = rooms.get(client.roomCode);
        if (!room) return;

        // Strictly relay only SDP/ICE/E2EE public-key handshake fields
        const target =
          msg.targetId === room.host.id
            ? room.host
            : room.guests.get(msg.targetId);

        if (!target) {
          client.sendJson({ type: 'ERROR', code: 'PEER_NOT_FOUND', message: 'Target peer disconnected.' });
          return;
        }

        target.sendJson({
          type: 'SIGNAL',
          fromId: client.id,
          payload: msg.payload,
        });
        break;
      }

      case 'HEARTBEAT': {
        if (client.roomCode) {
          const room = rooms.get(client.roomCode);
          if (room && room.expiresAt > Date.now()) {
            client.sendJson({ type: 'HEARTBEAT_ACK', ts: Date.now(), expiresAt: room.expiresAt });
          }
        }
        break;
      }

      case 'LEAVE_ROOM': {
        leaveCurrentRoom(client);
        break;
      }

      default:
        client.sendJson({ type: 'ERROR', code: 'UNKNOWN_TYPE', message: `Unsupported message: ${msg.type}` });
    }
  }

  function parseFrames(client) {
    while (client.buffer.length >= 2) {
      const firstByte = client.buffer[0];
      const secondByte = client.buffer[1];
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (client.buffer.length < 4) return;
        payloadLen = client.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (client.buffer.length < 10) return;
        const bigLen = client.buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(MAX_SIGNAL_PAYLOAD_BYTES)) {
          client.close(1009, 'Payload too large for signaling');
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > MAX_SIGNAL_PAYLOAD_BYTES) {
        client.close(1009, 'File payloads are forbidden on signaling server');
        return;
      }

      const maskLen = masked ? 4 : 0;
      if (client.buffer.length < offset + maskLen + payloadLen) return;

      const maskKey = masked ? client.buffer.subarray(offset, offset + 4) : null;
      offset += maskLen;

      const payload = Buffer.from(client.buffer.subarray(offset, offset + payloadLen));
      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      client.buffer = client.buffer.subarray(offset + payloadLen);

      if (opcode === 0x8) {
        leaveCurrentRoom(client);
        client.close(1000, 'Normal closure');
        return;
      } else if (opcode === 0x9) {
        // Ping -> Pong
        client.socket.write(encodeWsFrame(0xA, payload));
      } else if (opcode === 0x2) {
        // Binary frames are explicitly rejected — signaling is JSON-only
        client.sendJson({
          type: 'ERROR',
          code: 'BINARY_FORBIDDEN',
          message: 'Binary file data must travel P2P, never through signaling.',
        });
      } else if (opcode === 0x1) {
        handleMessage(client, payload.toString('utf8'));
      }
    }
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'fluxdrop-ephemeral-signaling',
          activeRooms: rooms.size,
          uptimeSec: Math.floor(process.uptime()),
        })
      );
      return;
    }
    res.writeHead(404);
    res.end('FluxDrop Ephemeral Signaling Endpoint (WebSocket only)');
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    const acceptKey = createWsAcceptKey(key);
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '',
        '',
      ].join('\r\n')
    );

    const remoteIp =
      req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
      socket.remoteAddress ||
      'unknown';

    const client = new EphemeralWsClient(socket, remoteIp);
    clients.add(client);

    socket.on('data', (chunk) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      parseFrames(client);
    });

    socket.on('close', () => {
      clients.delete(client);
      client.closed = true;
      leaveCurrentRoom(client);
    });

    socket.on('error', () => {
      client.closed = true;
      leaveCurrentRoom(client);
    });
  });

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms.entries()) {
      if (room.expiresAt <= now) {
        room.host.sendJson({ type: 'ROOM_EXPIRED', code });
        room.host.roomCode = null;
        for (const guest of room.guests.values()) {
          guest.sendJson({ type: 'ROOM_EXPIRED', code });
          guest.roomCode = null;
        }
        rooms.delete(code);
      }
    }
    for (const [ip, record] of rateLimits.entries()) {
      if (record.lockedUntil <= now && record.failures.length === 0) {
        rateLimits.delete(ip);
      }
    }
  }, 15_000);
  cleanupInterval.unref();

  return {
    server,
    rooms,
    stop: () => {
      clearInterval(cleanupInterval);
      for (const c of clients) { c.socket.destroy(); } server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve));
    },
  };
}

function getLanAddresses() {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  return addresses;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8787);
  const { server } = createSignalingServer();
  server.listen(port, '0.0.0.0', () => {
    const lanIps = getLanAddresses();
    console.log(`[FluxDrop Signaling] Ephemeral WS listening on ws://localhost:${port}`);
    for (const ip of lanIps) {
      console.log(`[FluxDrop Signaling] LAN endpoint: ws://${ip}:${port}`);
    }
  });
}
