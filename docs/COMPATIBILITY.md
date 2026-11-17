# Browser & Platform Compatibility Matrix

| Feature | Chrome / Edge (Desktop) | Chrome (Android) | Firefox (Desktop) | Safari (macOS) | Safari (iOS) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **WebRTC DataChannels (DTLS)** | Full | Full | Full | Full | Full |
| **5 GB Streaming (File System Access)** | Full (Direct Disk) | OPFS Streaming | OPFS Streaming | OPFS Streaming | OPFS Streaming* |
| **Web Crypto (ECDH + AES-GCM + SHA-256)** | Full | Full | Full | Full | Full |
| **PWA Installable** | Full (Desktop App) | Full (APK/WebAPK) | Partial | Add to Dock | Add to Home Screen |
| **Web Bluetooth (BLE GATT)** | Supported | Supported | **Unsupported** | **Unsupported** | **Unsupported** |

\* *Note on iOS Safari & Mobile Storage Quotas:* While FluxDrop's streaming chunk engine keeps JavaScript RAM usage bounded under 32 MB, mobile browsers enforce per-origin OPFS storage quotas (typically 10%–60% of free device storage). FluxDrop checks `navigator.storage.estimate()` before accepting incoming transfers and warns if available quota is lower than the incoming file size.

## Native Companion Architecture (Where Browsers Are Restricted)

Browsers intentionally sandbox raw TCP/UDP sockets, mDNS LAN broadcasting, Wi-Fi Direct group ownership, and Bluetooth Classic OBEX. For those native-only transports, FluxDrop defines a modular transport abstraction (`src/transports/`) so a lightweight Tauri/Electron/Capacitor companion can plug in without modifying the UI or chunking engine.
