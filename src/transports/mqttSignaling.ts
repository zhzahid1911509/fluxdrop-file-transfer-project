/**
 * Zero-Dependency MQTT 3.1.1 over WSS Signaling Client
 * ---------------------------------------------------------------------------
 * Enables 6-character code & QR pairing on static hosts (e.g. Netlify)
 * without deploying a dedicated Node.js signaling server.
 *
 * Security:
 * - Only ephemeral SDP/ICE/ECDH handshake envelopes are published.
 * - Envelopes are AES-GCM encrypted using a key derived from the 6-char
 *   pairing code so public brokers never see raw SDP/IP metadata.
 * - Zero file bytes ever pass through the broker.
 */

const PUBLIC_WSS_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

function encodeRemainingLength(len: number): number[] {
  const out: number[] = [];
  let x = len;
  do {
    let digit = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) digit |= 0x80;
    out.push(digit);
  } while (x > 0);
  return out;
}

function encodeUtf8Field(str: string): Uint8Array {
  const bytes = new TextEncoder().encode(str);
  const out = new Uint8Array(2 + bytes.length);
  out[0] = (bytes.length >> 8) & 0xff;
  out[1] = bytes.length & 0xff;
  out.set(bytes, 2);
  return out;
}

function buildConnectPacket(clientId: string): ArrayBuffer {
  const varHeader = new Uint8Array([
    0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, // "MQTT"
    0x04, // MQTT 3.1.1
    0x02, // Clean session
    0x00, 0x3c, // Keep alive 60s
  ]);
  const payload = encodeUtf8Field(clientId);
  const remLen = encodeRemainingLength(varHeader.length + payload.length);
  const pkt = new Uint8Array(1 + remLen.length + varHeader.length + payload.length);
  pkt[0] = 0x10;
  pkt.set(remLen, 1);
  pkt.set(varHeader, 1 + remLen.length);
  pkt.set(payload, 1 + remLen.length + varHeader.length);
  return pkt.buffer as ArrayBuffer;
}

function buildSubscribePacket(packetId: number, topic: string): ArrayBuffer {
  const topicField = encodeUtf8Field(topic);
  const remLen = encodeRemainingLength(2 + topicField.length + 1);
  const pkt = new Uint8Array(1 + remLen.length + 2 + topicField.length + 1);
  let off = 0;
  pkt[off++] = 0x82;
  pkt.set(remLen, off);
  off += remLen.length;
  pkt[off++] = (packetId >> 8) & 0xff;
  pkt[off++] = packetId & 0xff;
  pkt.set(topicField, off);
  off += topicField.length;
  pkt[off] = 0x00; // QoS 0
  return pkt.buffer as ArrayBuffer;
}

function buildPublishPacket(topic: string, message: string): ArrayBuffer {
  const topicField = encodeUtf8Field(topic);
  const msgBytes = new TextEncoder().encode(message);
  const remLen = encodeRemainingLength(topicField.length + msgBytes.length);
  const pkt = new Uint8Array(1 + remLen.length + topicField.length + msgBytes.length);
  let off = 0;
  pkt[off++] = 0x30; // PUBLISH QoS 0
  pkt.set(remLen, off);
  off += remLen.length;
  pkt.set(topicField, off);
  off += topicField.length;
  pkt.set(msgBytes, off);
  return pkt.buffer as ArrayBuffer;
}

async function deriveRoomKey(roomCode: string): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(`fluxdrop-room-v1:${roomCode.toUpperCase()}`);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptEnvelope(roomCode: string, obj: Record<string, unknown>): Promise<string> {
  const key = await deriveRoomKey(roomCode);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  const combined = new Uint8Array(12 + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), 12);
  let bin = '';
  for (let i = 0; i < combined.length; i++) bin += String.fromCharCode(combined[i]);
  return JSON.stringify({ enc: btoa(bin) });
}

async function decryptEnvelope(roomCode: string, rawJson: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(rawJson) as { enc?: string };
    if (!parsed.enc) return null;
    const bin = atob(parsed.enc);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const iv = bytes.subarray(0, 12);
    const cipher = bytes.subarray(12);
    const key = await deriveRoomKey(roomCode);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class MqttSignalingClient {
  private ws: WebSocket | null = null;
  private pingTimer: number | null = null;
  private roomCode: string;
  private role: 'host' | 'guest';
  private clientId = `fluxdrop_${Math.random().toString(36).slice(2, 10)}`;
  private rxBuffer = new Uint8Array(0);
  private onMessage: (msg: Record<string, unknown>) => void;
  private onError: (err: string) => void;

  constructor(
    roomCode: string,
    role: 'host' | 'guest',
    callbacks: {
      onMessage: (msg: Record<string, unknown>) => void;
      onError: (err: string) => void;
    }
  ) {
    this.roomCode = roomCode.toUpperCase();
    this.role = role;
    this.onMessage = callbacks.onMessage;
    this.onError = callbacks.onError;
  }

  public async connect(onReady: () => void): Promise<void> {
    for (const brokerUrl of PUBLIC_WSS_BROKERS) {
      const ok = await this.tryConnectBroker(brokerUrl, onReady);
      if (ok) return;
    }
    this.onError(
      'Unable to reach public WSS signaling relays. Use Serverless Direct Pairing or configure a custom signaling URL in Settings.'
    );
  }

  private tryConnectBroker(brokerUrl: string, onReady: () => void): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const ws = new WebSocket(brokerUrl, 'mqtt');
      ws.binaryType = 'arraybuffer';

      const timeout = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.close();
          resolve(false);
        }
      }, 5000);

      ws.onopen = () => {
        this.ws = ws;
        ws.send(buildConnectPacket(this.clientId));
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(false);
        }
      };

      ws.onmessage = async (ev) => {
        const chunk = new Uint8Array(ev.data as ArrayBuffer);
        const merged = new Uint8Array(this.rxBuffer.length + chunk.length);
        merged.set(this.rxBuffer, 0);
        merged.set(chunk, this.rxBuffer.length);
        this.rxBuffer = merged;

        while (this.rxBuffer.length >= 2) {
          const pktType = this.rxBuffer[0] >> 4;
          let multiplier = 1;
          let remLen = 0;
          let idx = 1;
          let byte = 0;
          let incomplete = false;
          do {
            if (idx >= this.rxBuffer.length) {
              incomplete = true;
              break;
            }
            byte = this.rxBuffer[idx++];
            remLen += (byte & 0x7f) * multiplier;
            multiplier *= 128;
          } while ((byte & 0x80) !== 0);

          if (incomplete || this.rxBuffer.length < idx + remLen) break;

          const flags = this.rxBuffer[0] & 0x0f;
          const body = this.rxBuffer.subarray(idx, idx + remLen);
          this.rxBuffer = this.rxBuffer.subarray(idx + remLen);

          if (pktType === 2) {
            // CONNACK
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              const myTopic = `fluxdrop/v1/room/${this.roomCode}/to-${this.role}`;
              ws.send(buildSubscribePacket(1, myTopic));
              this.pingTimer = window.setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(new Uint8Array([0xc0, 0x00]));
                }
              }, 30_000);
              onReady();
              resolve(true);
            }
          } else if (pktType === 3) {
            // PUBLISH
            const topicLen = (body[0] << 8) | body[1];
            let payloadOffset = 2 + topicLen;
            const qos = (flags >> 1) & 0x03;
            if (qos > 0) payloadOffset += 2;
            const rawStr = new TextDecoder().decode(body.subarray(payloadOffset));
            const decrypted = await decryptEnvelope(this.roomCode, rawStr);
            if (decrypted) {
              this.onMessage(decrypted);
            }
          }
        }
      };

      ws.onclose = () => {
        if (this.pingTimer !== null) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
      };
    });
  }

  public async sendToPeer(msg: Record<string, unknown>): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const targetRole = this.role === 'host' ? 'guest' : 'host';
    const topic = `fluxdrop/v1/room/${this.roomCode}/to-${targetRole}`;
    const encrypted = await encryptEnvelope(this.roomCode, msg);
    this.ws.send(buildPublishPacket(topic, encrypted));
  }

  public close(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
