# FluxDrop P2P — Serverless & Database-less File Transfer Platform

**FluxDrop** is a privacy-first, Peer-to-Peer (P2P) Progressive Web App (PWA) for transferring files up to **5 GB** directly between devices without a database or centralized file storage.

## Key Capabilities

- **Zero Central File Storage & Database-less**: File bytes travel directly between peers over WebRTC DataChannels (DTLS 1.2/1.3).
- **Optional Application-Level E2EE**: ECDH (P-256) key exchange + HKDF + AES-GCM-256 per-chunk encryption with a 4-symbol Safety Verification Code (SAS).
- **5 GB Bounded-RAM Streaming**: Reads via `File.slice()` and writes directly to disk via the File System Access API (`showSaveFilePicker`) or OPFS (`navigator.storage.getDirectory()`).
- **Adaptive Chunking & Backpressure**: Dynamically sizes chunks (16 KB – 256 KB) based on `sctp.maxMessageSize` and RTT while respecting `bufferedAmountLowThreshold`.
- **Resumable & Controllable**: Pause, resume, cancel, retry, multi-file & folder selection, and SHA-256 integrity verification.
- **Ephemeral Signaling Server**: Zero-dependency Node.js WebSocket server (`server/signaling-server.mjs`) with CSPRNG 6-character pairing codes, 10-minute room TTL, per-IP rate limiting, and binary-frame rejection.
- **Offline / Local Wi-Fi**: Works on the same Wi-Fi/hotspot using LAN `host` ICE candidates without internet.
- **Honest Capability Detection**: Dynamically detects WebRTC, File System Access, OPFS, Web Crypto, and Web Bluetooth support.

## Quick Start

### 1. Start the Ephemeral Signaling Server (Zero Dependencies)
```bash
node server/signaling-server.mjs
```
The server prints both `ws://localhost:8787` and your local LAN IP (`ws://192.168.x.x:8787`) for offline same-Wi-Fi transfers.

### 2. Install & Run the Frontend PWA
```bash
npm install
npm run dev
```

### 3. Production Build
```bash
npm run build
npm run preview
```

### 4. Run Automated Tests
```bash
npm test
```

## STUN / TURN Configuration

- **Same Wi-Fi / LAN**: No STUN/TURN required; WebRTC uses `host` candidates directly.
- **Different Networks**: Uses configurable STUN servers (default `stun:stun.l.google.com:19302`).
- **Strict Symmetric NAT / Corporate Firewalls**: Configure a TURN relay in **Settings** (`turn:your-turn-server:3478`). Note that fully serverless internet connectivity cannot be guaranteed across all symmetric NATs without a TURN relay.

## Documentation

- [System Architecture & Protocols](docs/ARCHITECTURE.md)
- [Browser & Platform Compatibility](docs/COMPATIBILITY.md)
