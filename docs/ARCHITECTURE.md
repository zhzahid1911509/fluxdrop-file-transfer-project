# FluxDrop P2P — System Architecture & Protocol Specification

## 1. Architectural Overview

**FluxDrop** is a serverless, database-less, privacy-first Peer-to-Peer (P2P) file transfer platform engineered for direct device-to-device transfers up to **5 GB** per file.

**Core Invariant:** File payloads never touch, pass through, or rest on any central application server or database. All file bytes travel directly between peers over encrypted P2P transports (WebRTC DataChannels or BLE GATT where supported), and all metadata/history remain strictly local to the user's browser (IndexedDB + OPFS / File System Access API).

```
+-----------------------------------------------------------------------------+
|                        CLIENT A (Sender PWA / Browser)                      |
|  UI (React/Tailwind) -> Transfer Engine (State Machine + Adaptive Chunker)  |
|  -> Security (ECDH/AES-GCM, SHA-256) -> Transport Manager (LAN/P2P/TURN/BLE)|
+--------------------------------------+--------------------------------------+
                                       |
          +----------------------------+----------------------------+
          | 1. Ephemeral Signaling (WSS)                            | 2. Direct Media/Data
          |    (SDP, ICE, Pairing Code ONLY - ZERO file bytes)      |    (DTLS + SCTP DataChannel)
          v                                                         v
+-----------------------------+                         +-----------------------------+
| Ephemeral Signaling Server  |                         |   STUN / TURN (ICE NAT)     |
| (Stateless In-Memory WS)    |                         |   TURN used ONLY if direct  |
| - 6-char pairing codes      |                         |   P2P fails (strict NAT)    |
| - Rate limit & TTL (10m)    |                         +-----------------------------+
+-----------------------------+                                     ^
          |                                                         |
          +----------------------------+----------------------------+
                                       |
                                       v
+-----------------------------------------------------------------------------+
|                       CLIENT B (Receiver PWA / Browser)                     |
|  Transport Manager -> Security (Decrypt + Verify SHA-256)                   |
|  -> Streaming Writer (File System Access API / OPFS / Blob fallback)        |
+-----------------------------------------------------------------------------+
```

---

## 2. Technology Decisions & Trade-offs

| Layer | Technology | Rationale |
| :--- | :--- | :--- |
| **Frontend** | React 18, TypeScript, Vite, Tailwind CSS | Strict type safety, fast HMR, tree-shaken PWA bundle, zero runtime CSS overhead. |
| **Internet & LAN P2P** | WebRTC `RTCDataChannel` (`ordered: true`) | Mandatory DTLS encryption, built-in SCTP congestion control, NAT traversal via ICE/STUN/TURN, and automatic host-candidate LAN routing when on the same Wi-Fi. |
| **Signaling** | Zero-dependency Node.js WebSocket (`server/signaling-server.mjs`) + Manual/QR Offline SDP fallback | Ephemeral in-memory room map with TTL eviction and brute-force rate limiting. Zero database. Offline QR SDP mode works with **no server at all**. |
| **Large File Streaming (5 GB)** | `File.slice()` -> `ArrayBuffer` + `FileSystemWritableFileStream` / OPFS | Prevents OOM by keeping RAM usage bounded (< 32 MB) regardless of file size. |
| **Integrity & E2EE** | Web Crypto API (`SHA-256`, `ECDH P-256`, `AES-GCM 256`) | Hardware-accelerated browser cryptography; zero custom crypto primitives. |
| **Local Storage** | IndexedDB (resume metadata & local history), OPFS (partial chunks), `localStorage` (UI preferences) | Complies with database-less constraint; never stores large files in `localStorage`. |
| **Bluetooth** | Web Bluetooth API (BLE GATT) | Honest capability detection; suited for small metadata/handshakes or small files on Chromium; recommends Wi-Fi/WebRTC for large files. |

---

## 3. Transport Selection & Priority

The `TransportManager` evaluates platform capabilities, network status, and ICE candidate pairs in priority order:

1. **Direct Local Wi-Fi / LAN (`host` ICE candidate)**: Lowest latency, multi-hundred Mbps throughput, zero internet required if using local signaling or Offline QR SDP exchange.
2. **Wi-Fi Direct / Native Companion (Modular Bridge)**: Exposed via `NativeCompanionBridge` interface for desktop/mobile native wrappers where browsers restrict raw TCP/mDNS sockets.
3. **Direct Internet WebRTC P2P (`srflx` / `prflx`)**: Direct NAT-punched connection across different networks using STUN.
4. **Bluetooth LE (GATT)**: Available only on supported Chromium browsers for nearby low-bandwidth transfers; automatically warns and recommends Wi-Fi for files > 5 MB.
5. **TURN-Relayed WebRTC (`relay`)**: Automatic fallback when symmetric NATs or corporate firewalls block direct UDP/TCP hole-punching.

> **Architectural Note:** Fully serverless internet connectivity cannot be guaranteed across all symmetric NAT and strict enterprise firewall topologies; a TURN relay may be required as a fallback transport for connectivity (still encrypted end-to-end via DTLS + optional AES-GCM).

---

## 4. Signaling Protocol (Ephemeral WebSocket)

All signaling messages are JSON envelopes over `WSS` (or `WS` on local LAN). The server stores **only** `{ code, hostSocket, guestSocket, createdAt, expiresAt, failedAttempts }` in RAM.

| Message Type | Direction | Payload | Purpose |
| :--- | :--- | :--- | :--- |
| `CREATE_ROOM` | Host -> Server | `{ deviceInfo }` | Allocates a 6-char CSPRNG pairing code (10 min TTL). |
| `ROOM_CREATED` | Server -> Host | `{ code, expiresAt }` | Returns pairing code & QR payload. |
| `JOIN_ROOM` | Guest -> Server | `{ code, deviceInfo }` | Validates code (rate-limited: max 5 failures / 60s). |
| `PEER_JOINED` | Server -> Both | `{ peerId, deviceInfo, role }` | Triggers WebRTC offer creation + ECDH public key exchange. |
| `SIGNAL` | Peer -> Server -> Peer | `{ targetId, sdp \| candidate }` | Relays SDP Offer/Answer and ICE candidates. |
| `HEARTBEAT` | Client -> Server | `{ ts }` | Keeps ephemeral session alive. |
| `LEAVE_ROOM` | Client -> Server | `{}` | Immediately purges room from memory. |

---

## 5. Binary File Chunking & Control Protocol

Control messages and binary file chunks share the WebRTC DataChannel (JSON strings for control, `ArrayBuffer` frames for binary chunks):

### Binary Frame Format (16-Byte Header + Payload)
```
Offset  Size    Field
0       4 B     Magic ("FLXD" = 0x464C5844)
4       4 B     File Index (uint32, big-endian)
8       4 B     Chunk Index (uint32, big-endian)
12      4 B     Payload Length (uint32, big-endian)
16      N B     Raw File Chunk Bytes (adaptive: 16 KB – 256 KB)
```

### Adaptive Chunking & Backpressure
- Respects `dc.maxMessageSize` (clamped safely to `<= 256 KB`, default `64 KB`).
- Monitors `dc.bufferedAmount` against `HIGH_WATER_MARK` (4 MB) and `bufferedAmountLowThreshold` (1 MB) to pause reading from disk until the socket drains.
- Receiver sends `CHUNK_ACK` batches every 16 chunks (or 250 ms) containing `{ fileIndex, lastContiguousChunk, receivedBytes }`, keeping sender & receiver progress bars synchronized.

---

## 6. Transfer State Machine

```
[IDLE] -> [CONNECTING] -> [HANDSHAKE / E2EE_VERIFY] -> [QUEUED]
   -> [TRANSFERRING] <-> [PAUSED]
   -> [VERIFYING (SHA-256)] -> [COMPLETED]
   (Any active state -> [FAILED] -> [RETRYING] or [CANCELLED])
```

---

## 7. Security & Privacy Model

1. **Transport Encryption**: Mandatory WebRTC DTLS 1.2/1.3 + `WSS` signaling.
2. **Optional Application E2EE**: ECDH (P-256) key agreement over signaling/DataChannel -> HKDF-SHA-256 -> AES-GCM-256 chunk encryption + 4-symbol Safety Verification Code (SAS) displayed on both screens.
3. **Filename Sanitization**: Strips directory traversal (`../`, `..\\`), null bytes, control characters, and reserves/renames unsafe OS filenames.
4. **Dangerous File Warning**: Flags executables/scripts (`.exe`, `.msi`, `.bat`, `.cmd`, `.ps1`, `.sh`, `.apk`, `.dmg`, `.vbs`) before receiver acceptance.
5. **Integrity**: Incremental SHA-256 computed on sender and verified on receiver before marking transfer `COMPLETED`.
