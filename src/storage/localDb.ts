import type { AppSettings, ResumeMetadata, TransferHistoryEntry } from '../types/p2p';

const DB_NAME = 'fluxdrop_local_db';
const DB_VERSION = 1;
const STORE_HISTORY = 'transfer_history';
const STORE_RESUME = 'resume_metadata';
const SETTINGS_KEY = 'fluxdrop_settings_v2';

export const DEFAULT_SETTINGS: AppSettings = {
  deviceNickname: `Device-${Math.floor(1000 + Math.random() * 9000)}`,
  signalingUrl:
    (typeof import.meta !== 'undefined' &&
      (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_SIGNALING_URL) ||
    (typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
      ? `ws://${window.location.hostname}:8787`
      : 'ws://localhost:8787'),
  stunUrls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
  turnConfig: null,
  preferredTransport: 'auto',
  maxConcurrentTransfers: 2,
  preferredChunkSizeKb: 128,
  enableE2ee: false, // WebRTC DataChannels already enforce native C++ DTLS 1.3 encryption
  saveLocalHistory: true,
  theme: 'dark',
  notificationsEnabled: true,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    const envUrl =
      (typeof import.meta !== 'undefined' &&
        (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_SIGNALING_URL) ||
      '';
    if (envUrl) parsed.signalingUrl = envUrl;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // ignore storage quota errors on small preferences
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        db.createObjectStore(STORE_HISTORY, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_RESUME)) {
        db.createObjectStore(STORE_RESUME, { keyPath: 'transferId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function addHistoryEntry(entry: TransferHistoryEntry): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readwrite');
    tx.objectStore(STORE_HISTORY).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getHistoryEntries(): Promise<TransferHistoryEntry[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readonly');
    const req = tx.objectStore(STORE_HISTORY).getAll();
    req.onsuccess = () => {
      const items = (req.result as TransferHistoryEntry[]) ?? [];
      resolve(items.sort((a, b) => b.timestamp - a.timestamp));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveResumeMetadata(meta: ResumeMetadata): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RESUME, 'readwrite');
    tx.objectStore(STORE_RESUME).put(meta);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getResumeMetadata(transferId: string): Promise<ResumeMetadata | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RESUME, 'readonly');
    const req = tx.objectStore(STORE_RESUME).get(transferId);
    req.onsuccess = () => resolve((req.result as ResumeMetadata) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteResumeMetadata(transferId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RESUME, 'readwrite');
    tx.objectStore(STORE_RESUME).delete(transferId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAllLocalData(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_HISTORY, STORE_RESUME], 'readwrite');
    tx.objectStore(STORE_HISTORY).clear();
    tx.objectStore(STORE_RESUME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  if (navigator.storage?.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory();
      const entries = (
        root as unknown as { values: () => AsyncIterable<{ name: string }> }
      ).values();
      for await (const entry of entries) {
        if (entry.name.startsWith('fluxdrop_part_')) {
          await root.removeEntry(entry.name);
        }
      }
    } catch {
      // ignore
    }
  }
}

export interface StreamingFileWriter {
  mode: 'fs-access' | 'opfs' | 'blob';
  writeAt(offset: number, data: ArrayBuffer): Promise<void>;
  closeAndSave(sanitizedName: string): Promise<File | Blob | null>;
  abort(): Promise<void>;
}

export async function checkStorageAvailability(requiredBytes: number): Promise<{
  ok: boolean;
  availableBytes: number | null;
}> {
  if (!navigator.storage?.estimate) {
    return { ok: true, availableBytes: null };
  }
  try {
    const est = await navigator.storage.estimate();
    if (typeof est.quota === 'number' && typeof est.usage === 'number') {
      const available = est.quota - est.usage;
      return { ok: available >= requiredBytes, availableBytes: available };
    }
  } catch {
    // ignore
  }
  return { ok: true, availableBytes: null };
}

/**
 * Wraps a FileSystemWritableFileStream with a 4 MB write-coalescing buffer and
 * sequential cursor tracking so contiguous writes use fast sequential append
 * instead of slow random-access seek calls on 1.5–5 GB files.
 */
function createBufferedStreamWriter(
  mode: 'fs-access' | 'opfs',
  writable: FileSystemWritableFileStream,
  onFinalize: (name: string) => Promise<File | Blob | null>,
  onAbortCleanup?: () => Promise<void>
): StreamingFileWriter {
  const FLUSH_THRESHOLD = 4 * 1024 * 1024; // 4 MB coalesced disk writes
  let pendingStartOffset = -1;
  let pendingExpectedNext = -1;
  let pendingParts: Uint8Array[] = [];
  let pendingBytes = 0;
  let streamCursor = 0;
  let writeChain = Promise.resolve();

  const flushBuffered = (): Promise<void> => {
    if (pendingBytes === 0) return Promise.resolve();
    const startOffset = pendingStartOffset;
    const totalLen = pendingBytes;
    const parts = pendingParts;

    pendingStartOffset = -1;
    pendingExpectedNext = -1;
    pendingParts = [];
    pendingBytes = 0;

    const merged = new Uint8Array(totalLen);
    let pos = 0;
    for (const part of parts) {
      merged.set(part, pos);
      pos += part.byteLength;
    }

    writeChain = writeChain.then(async () => {
      if (startOffset === streamCursor) {
        await writable.write(merged.buffer as ArrayBuffer);
        streamCursor += totalLen;
      } else {
        await writable.write({
          type: 'write',
          position: startOffset,
          data: merged.buffer as ArrayBuffer,
        });
        streamCursor = startOffset + totalLen;
      }
    });
    return writeChain;
  };

  return {
    mode,
    writeAt(offset: number, data: ArrayBuffer): Promise<void> {
      const view = new Uint8Array(data);
      if (pendingBytes > 0 && offset !== pendingExpectedNext) {
        void flushBuffered();
      }
      if (pendingBytes === 0) {
        pendingStartOffset = offset;
        pendingExpectedNext = offset;
      }
      pendingParts.push(view);
      pendingBytes += view.byteLength;
      pendingExpectedNext += view.byteLength;

      if (pendingBytes >= FLUSH_THRESHOLD) {
        return flushBuffered();
      }
      return Promise.resolve();
    },
    async closeAndSave(name: string) {
      await flushBuffered();
      await writeChain;
      await writable.close();
      return await onFinalize(name);
    },
    async abort() {
      pendingParts = [];
      pendingBytes = 0;
      await writeChain.catch(() => {});
      await writable.abort().catch(() => {});
      await onAbortCleanup?.();
    },
  };
}

export async function createStreamingWriter(
  transferId: string,
  sanitizedName: string,
  expectedSize: number
): Promise<StreamingFileWriter> {
  // 1. Call showSaveFilePicker FIRST while transient user activation is still fresh!
  const win = window as unknown as {
    showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>;
  };
  if (typeof win.showSaveFilePicker === 'function' && expectedSize > 32 * 1024 * 1024) {
    try {
      const handle = await win.showSaveFilePicker({ suggestedName: sanitizedName });
      const writable = await handle.createWritable();
      return createBufferedStreamWriter('fs-access', writable, async () => handle.getFile());
    } catch {
      // User dismissed picker or browser blocked — fall through to Blob / OPFS
    }
  }

  // 2. Fast in-memory Blob assembly for files up to 512 MB (instant completion, zero disk flush delay)
  if (expectedSize <= 512 * 1024 * 1024) {
    const chunks: Map<number, ArrayBuffer> = new Map();
    return {
      mode: 'blob',
      async writeAt(offset, data) {
        chunks.set(offset, data);
      },
      async closeAndSave(name) {
        const ordered = Array.from(chunks.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, buf]) => buf);
        const blob = new Blob(ordered);
        chunks.clear();
        triggerBrowserDownload(blob, name);
        return blob;
      },
      async abort() {
        chunks.clear();
      },
    };
  }

  // 3. OPFS buffered streaming for large files (> 512 MB up to 5 GB) on browsers without showSaveFilePicker
  if (navigator.storage?.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory();
      const opfsName = `fluxdrop_part_${transferId}_${sanitizedName}`;
      const fileHandle = await root.getFileHandle(opfsName, { create: true });
      const writable = await fileHandle.createWritable();
      return createBufferedStreamWriter(
        'opfs',
        writable,
        async (name) => {
          const file = await fileHandle.getFile();
          triggerBrowserDownload(file, name);
          setTimeout(() => {
            root.removeEntry(opfsName).catch(() => {});
          }, 30_000);
          return file;
        },
        async () => {
          await root.removeEntry(opfsName).catch(() => {});
        }
      );
    } catch {
      // Fall through
    }
  }

  // 4. Last-resort chunked Blob array fallback
  const fallbackChunks: Map<number, ArrayBuffer> = new Map();
  return {
    mode: 'blob',
    async writeAt(offset, data) {
      fallbackChunks.set(offset, data);
    },
    async closeAndSave(name) {
      const ordered = Array.from(fallbackChunks.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, buf]) => buf);
      const blob = new Blob(ordered);
      fallbackChunks.clear();
      triggerBrowserDownload(blob, name);
      return blob;
    },
    async abort() {
      fallbackChunks.clear();
    },
  };
}

export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
