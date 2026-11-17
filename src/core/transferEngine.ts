import type { FileManifestItem, TransferErrorInfo, TransferProgress } from '../types/p2p';
import { computeAdaptiveChunkSize, decodeChunkFrame, encodeChunkFrame } from './chunkProtocol';
import {
  computeChunkDigest64,
  decryptChunk,
  encryptChunk,
  finalizeMerkleSha256,
} from '../security/crypto';
import { isPotentiallyDangerousFile, sanitizeFilename } from '../security/sanitize';
import {
  checkStorageAvailability,
  createStreamingWriter,
  deleteResumeMetadata,
  getResumeMetadata,
  saveResumeMetadata,
  type StreamingFileWriter,
} from '../storage/localDb';
import type { WebRtcTransport } from '../transports/webrtcTransport';

export interface QueuedSendFile {
  fileIndex: number;
  file: File;
  manifest: FileManifestItem;
  priority: number;
}

export function buildFileManifest(files: File[]): QueuedSendFile[] {
  return files.map((file, idx) => {
    const sanitizedName = sanitizeFilename(file.name);
    const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    return {
      fileIndex: idx,
      file,
      priority: 1,
      manifest: {
        fileIndex: idx,
        name: file.name,
        sanitizedName,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        lastModified: file.lastModified,
        relativePath: relPath || undefined,
        isPotentiallyDangerous: isPotentiallyDangerousFile(sanitizedName),
      },
    };
  });
}

interface ReceiverFileState {
  writer: StreamingFileWriter;
  manifest: FileManifestItem;
  chunkSize: number;
  receivedChunks: Set<number>;
  chunkDigests: Uint32Array;
  totalChunks: number;
  receivedBytes: number;
  startedAt: number;
  transferId: string;
  expectedHash: string | null;
  finalizing: boolean;
  processingChain: Promise<void>;
  lastResumeSaveAt: number;
}

export class TransferEngine {
  private transport: WebRtcTransport;
  private onProgressUpdate: (items: TransferProgress[]) => void;
  private onIncomingOffer: (
    manifest: FileManifestItem[],
    transferId: string,
    chunkSize: number
  ) => void;
  private onCompleteCallback: (entry: {
    fileName: string;
    size: number;
    direction: 'sent' | 'received';
    sha256: string | null;
    durationMs: number;
  }) => void;

  private progressMap = new Map<number, TransferProgress>();
  private sendQueue: QueuedSendFile[] = [];
  private pausedFiles = new Set<number>();
  private cancelledFiles = new Set<number>();
  private writers = new Map<number, ReceiverFileState>();
  private ackListeners = new Map<number, Array<() => void>>();

  private preferredChunkSizeKb = 128;
  private maxConcurrent = 2;
  private rttMs: number | null = null;
  private lastProgressEmitAt = 0;

  constructor(
    transport: WebRtcTransport,
    callbacks: {
      onProgressUpdate: (items: TransferProgress[]) => void;
      onIncomingOffer: (
        manifest: FileManifestItem[],
        transferId: string,
        chunkSize: number
      ) => void;
      onFileComplete: (entry: {
        fileName: string;
        size: number;
        direction: 'sent' | 'received';
        sha256: string | null;
        durationMs: number;
      }) => void;
    }
  ) {
    this.transport = transport;
    this.onProgressUpdate = callbacks.onProgressUpdate;
    this.onIncomingOffer = callbacks.onIncomingOffer;
    this.onCompleteCallback = callbacks.onFileComplete;
  }

  public configure(opts: {
    preferredChunkSizeKb: number;
    maxConcurrent: number;
    rttMs: number | null;
  }) {
    this.preferredChunkSizeKb = opts.preferredChunkSizeKb;
    this.maxConcurrent = opts.maxConcurrent;
    this.rttMs = opts.rttMs;
  }

  private emitProgress(force = false) {
    const now = performance.now();
    if (!force && now - this.lastProgressEmitAt < 90) return;
    this.lastProgressEmitAt = now;
    this.onProgressUpdate(Array.from(this.progressMap.values()));
  }

  private notifyAckWaiters(fileIndex: number) {
    const list = this.ackListeners.get(fileIndex);
    if (!list || list.length === 0) return;
    this.ackListeners.set(fileIndex, []);
    for (const fn of list) fn();
  }

  private waitForAckWindow(fileIndex: number, timeoutMs = 1500): Promise<void> {
    return new Promise((resolve) => {
      const timer = window.setTimeout(resolve, timeoutMs);
      const list = this.ackListeners.get(fileIndex) ?? [];
      list.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.ackListeners.set(fileIndex, list);
    });
  }

  public async enqueueAndOffer(files: QueuedSendFile[], transferId: string): Promise<void> {
    this.sendQueue = [...files].sort((a, b) => b.priority - a.priority);
    const chunkSize = computeAdaptiveChunkSize({
      preferredKb: this.preferredChunkSizeKb,
      sctpMaxMessageSize: this.transport.getMaxMessageSize(),
      rttMs: this.rttMs,
    });

    for (const item of this.sendQueue) {
      const totalChunks = Math.max(1, Math.ceil(item.file.size / chunkSize));
      this.progressMap.set(item.fileIndex, {
        fileIndex: item.fileIndex,
        fileName: item.manifest.sanitizedName,
        totalBytes: item.file.size,
        transferredBytes: 0,
        ackedBytes: 0,
        percentage: 0,
        currentSpeedBps: 0,
        averageSpeedBps: 0,
        etaSeconds: null,
        status: 'queued',
        integrityVerified: null,
        priority: item.priority,
        chunkSize,
        totalChunks,
        completedChunks: 0,
      });
    }
    this.emitProgress(true);

    this.transport.sendControl({
      type: 'TRANSFER_OFFER',
      transferId,
      chunkSize,
      files: this.sendQueue.map((q) => q.manifest),
    });
  }

  public async acceptIncomingOffer(
    transferId: string,
    files: FileManifestItem[],
    offerChunkSize: number
  ): Promise<void> {
    const chunkSize = offerChunkSize > 0 ? offerChunkSize : this.preferredChunkSizeKb * 1024;

    // 1. Open streaming writers FIRST while transient user click activation is still active
    const createdWriters = new Map<number, StreamingFileWriter>();
    for (const f of files) {
      const writer = await createStreamingWriter(transferId, f.sanitizedName, f.size);
      createdWriters.set(f.fileIndex, writer);
    }

    // 2. Check quota if writers are using browser OPFS storage
    const usesOpfs = Array.from(createdWriters.values()).some((w) => w.mode === 'opfs');
    if (usesOpfs) {
      const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
      const storageCheck = await checkStorageAvailability(totalBytes);
      if (!storageCheck.ok) {
        for (const w of createdWriters.values()) await w.abort();
        const err: TransferErrorInfo = {
          code: 'INSUFFICIENT_STORAGE',
          message: 'Insufficient browser storage quota for this transfer.',
          suggestion: 'Free up disk space or use Chrome/Edge on Desktop for direct disk streaming.',
          recoverable: false,
        };
        this.transport.sendControl({ type: 'TRANSFER_REJECT', transferId, reason: err.message });
        throw new Error(err.message);
      }
    }

    const resumeOffsets: Record<number, number[]> = {};
    for (const f of files) {
      const totalChunks = Math.max(1, Math.ceil(f.size / chunkSize));
      const writer = createdWriters.get(f.fileIndex)!;
      const existingResume = await getResumeMetadata(`${transferId}:${f.fileIndex}`);
      const receivedSet = new Set<number>(existingResume?.receivedChunkIndices ?? []);
      if (receivedSet.size > 0) {
        resumeOffsets[f.fileIndex] = Array.from(receivedSet);
      }

      this.writers.set(f.fileIndex, {
        writer,
        manifest: f,
        chunkSize,
        receivedChunks: receivedSet,
        chunkDigests: new Uint32Array(totalChunks * 2),
        totalChunks,
        receivedBytes: Math.min(f.size, receivedSet.size * chunkSize),
        startedAt: Date.now(),
        transferId,
        expectedHash: null,
        finalizing: false,
        processingChain: Promise.resolve(),
        lastResumeSaveAt: Date.now(),
      });

      this.progressMap.set(f.fileIndex, {
        fileIndex: f.fileIndex,
        fileName: f.sanitizedName,
        totalBytes: f.size,
        transferredBytes: Math.min(f.size, receivedSet.size * chunkSize),
        ackedBytes: Math.min(f.size, receivedSet.size * chunkSize),
        percentage: f.size === 0 ? 100 : Math.round((receivedSet.size / totalChunks) * 100),
        currentSpeedBps: 0,
        averageSpeedBps: 0,
        etaSeconds: null,
        status: 'receiving',
        integrityVerified: null,
        priority: 1,
        chunkSize,
        totalChunks,
        completedChunks: receivedSet.size,
      });
    }
    this.emitProgress(true);

    this.transport.sendControl({
      type: 'TRANSFER_ACCEPT',
      transferId,
      resumeChunks: resumeOffsets,
    });
  }

  public rejectIncomingOffer(transferId: string): void {
    this.transport.sendControl({
      type: 'TRANSFER_REJECT',
      transferId,
      reason: 'Declined by receiver',
    });
  }

  public pauseFile(fileIndex: number): void {
    this.pausedFiles.add(fileIndex);
    const p = this.progressMap.get(fileIndex);
    if (p) {
      p.status = 'paused';
      this.emitProgress(true);
    }
    this.transport.sendControl({ type: 'PAUSE_FILE', fileIndex });
  }

  public resumeFile(fileIndex: number): void {
    this.pausedFiles.delete(fileIndex);
    const item = this.sendQueue.find((q) => q.fileIndex === fileIndex);
    if (item) {
      void this.streamFileToPeer(item);
    }
    this.transport.sendControl({ type: 'RESUME_FILE', fileIndex });
  }

  public cancelFile(fileIndex: number): void {
    this.cancelledFiles.add(fileIndex);
    this.pausedFiles.delete(fileIndex);
    this.notifyAckWaiters(fileIndex);
    const p = this.progressMap.get(fileIndex);
    if (p) {
      p.status = 'cancelled';
      this.emitProgress(true);
    }
    const w = this.writers.get(fileIndex);
    if (w) {
      void w.writer.abort();
      this.writers.delete(fileIndex);
    }
    this.transport.sendControl({ type: 'CANCEL_FILE', fileIndex });
  }

  public async handleControlMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'TRANSFER_OFFER': {
        const offerChunkSize = Number(msg.chunkSize) || 131072;
        this.onIncomingOffer(
          msg.files as FileManifestItem[],
          String(msg.transferId),
          offerChunkSize
        );
        break;
      }
      case 'TRANSFER_ACCEPT': {
        const resumeChunks = (msg.resumeChunks as Record<string, number[]>) ?? {};
        await this.startSendingQueue(resumeChunks);
        break;
      }
      case 'TRANSFER_REJECT': {
        for (const p of this.progressMap.values()) {
          p.status = 'cancelled';
          p.error = {
            code: 'REJECTED',
            message: String(msg.reason || 'Transfer declined by receiver.'),
            suggestion: 'Ask the recipient to accept the incoming request.',
            recoverable: true,
          };
        }
        this.emitProgress(true);
        break;
      }
      case 'CHUNK_ACK': {
        const fileIndex = Number(msg.fileIndex);
        const ackedBytes = Number(msg.receivedBytes);
        const p = this.progressMap.get(fileIndex);
        if (p) {
          p.ackedBytes = ackedBytes;
          p.percentage =
            p.totalBytes === 0
              ? 100
              : Math.min(99, Math.round((ackedBytes / p.totalBytes) * 100));
          this.emitProgress(false);
        }
        this.notifyAckWaiters(fileIndex);
        break;
      }
      case 'FILE_HASH': {
        const fileIndex = Number(msg.fileIndex);
        const expectedHash = String(msg.sha256);
        const entry = this.writers.get(fileIndex);
        if (!entry) break;
        entry.expectedHash = expectedHash;
        entry.processingChain = entry.processingChain.then(() =>
          this.tryFinalizeReceivedFile(fileIndex)
        );
        await entry.processingChain;
        break;
      }
      case 'FILE_VERIFIED': {
        const fileIndex = Number(msg.fileIndex);
        const ok = Boolean(msg.verified);
        const p = this.progressMap.get(fileIndex);
        if (p) {
          p.integrityVerified = ok;
          p.status = ok ? 'completed' : 'failed';
          p.percentage = ok ? 100 : p.percentage;
          this.emitProgress(true);
          if (ok) {
            this.onCompleteCallback({
              fileName: p.fileName,
              size: p.totalBytes,
              direction: 'sent',
              sha256: null,
              durationMs: 0,
            });
          }
        }
        break;
      }
      case 'PAUSE_FILE': {
        this.pausedFiles.add(Number(msg.fileIndex));
        const p = this.progressMap.get(Number(msg.fileIndex));
        if (p) {
          p.status = 'paused';
          this.emitProgress(true);
        }
        break;
      }
      case 'CANCEL_FILE': {
        this.cancelFile(Number(msg.fileIndex));
        break;
      }
    }
  }

  public handleBinaryChunk(frameBuffer: ArrayBuffer): Promise<void> {
    const { fileIndex, chunkIndex, payload } = decodeChunkFrame(frameBuffer);
    const entry = this.writers.get(fileIndex);
    if (!entry || this.cancelledFiles.has(fileIndex)) return Promise.resolve();

    entry.processingChain = entry.processingChain.then(async () => {
      if (this.cancelledFiles.has(fileIndex) || entry.receivedChunks.has(chunkIndex)) return;

      const aesKey = this.transport.getAesKey();
      const plaintext = aesKey ? await decryptChunk(aesKey, payload) : payload;

      // Synchronous 64-bit chunk digest (< 0.03 ms) + coalesced write
      const [d0, d1] = computeChunkDigest64(plaintext);
      entry.chunkDigests[chunkIndex * 2] = d0;
      entry.chunkDigests[chunkIndex * 2 + 1] = d1;

      const offset = chunkIndex * entry.chunkSize;
      await entry.writer.writeAt(offset, plaintext);

      entry.receivedChunks.add(chunkIndex);
      entry.receivedBytes = Math.min(
        entry.manifest.size,
        entry.receivedBytes + plaintext.byteLength
      );

      const elapsedSec = Math.max(0.05, (Date.now() - entry.startedAt) / 1000);
      const avgSpeed = entry.receivedBytes / elapsedSec;
      const remaining = Math.max(0, entry.manifest.size - entry.receivedBytes);

      const p = this.progressMap.get(fileIndex);
      if (p) {
        p.transferredBytes = entry.receivedBytes;
        p.ackedBytes = entry.receivedBytes;
        p.completedChunks = entry.receivedChunks.size;
        p.currentSpeedBps = avgSpeed;
        p.averageSpeedBps = avgSpeed;
        p.etaSeconds = avgSpeed > 0 ? remaining / avgSpeed : null;
        p.percentage =
          entry.manifest.size === 0
            ? 100
            : Math.min(99, Math.round((entry.receivedBytes / entry.manifest.size) * 100));
        if (p.status !== 'verifying' && p.status !== 'completed') {
          p.status = 'receiving';
        }
        this.emitProgress(false);
      }

      if (
        entry.receivedChunks.size % 16 === 0 ||
        entry.receivedChunks.size === entry.totalChunks
      ) {
        this.transport.sendControl({
          type: 'CHUNK_ACK',
          fileIndex,
          receivedBytes: entry.receivedBytes,
        });
      }

      const now = Date.now();
      if (now - entry.lastResumeSaveAt > 3000) {
        entry.lastResumeSaveAt = now;
        void saveResumeMetadata({
          transferId: `${entry.transferId}:${fileIndex}`,
          fileName: entry.manifest.sanitizedName,
          fileSize: entry.manifest.size,
          chunkSize: entry.chunkSize,
          totalChunks: entry.totalChunks,
          receivedChunkIndices: Array.from(entry.receivedChunks),
          updatedAt: now,
        });
      }

      await this.tryFinalizeReceivedFile(fileIndex);
    });

    return entry.processingChain;
  }

  private async startSendingQueue(resumeChunks: Record<string, number[]>): Promise<void> {
    const queue = [...this.sendQueue];
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(this.maxConcurrent, queue.length); i++) {
      workers.push(
        (async () => {
          while (queue.length > 0) {
            const next = queue.shift();
            if (!next) break;
            const skip = new Set(resumeChunks[String(next.fileIndex)] ?? []);
            await this.streamFileToPeer(next, skip);
          }
        })()
      );
    }
    await Promise.all(workers);
  }

  private async streamFileToPeer(
    item: QueuedSendFile,
    skipChunks: Set<number> = new Set()
  ): Promise<void> {
    const p = this.progressMap.get(item.fileIndex);
    if (!p) return;

    p.status = 'transmitting';
    this.emitProgress(true);
    const startedAt = Date.now();
    const aesKey = this.transport.getAesKey();
    const chunkDigests = new Uint32Array(p.totalChunks * 2);

    const SLAB_CHUNKS = 32; // Read ~4 MB slabs per File.slice() call
    const slabByteSize = p.chunkSize * SLAB_CHUNKS;
    const MAX_UNACKED_WINDOW = 24 * 1024 * 1024; // 24 MB sliding window keeps receiver memory & disk in sync

    for (let baseChunk = 0; baseChunk < p.totalChunks; baseChunk += SLAB_CHUNKS) {
      if (this.cancelledFiles.has(item.fileIndex)) return;

      const slabStartByte = baseChunk * p.chunkSize;
      const slabEndByte = Math.min(slabStartByte + slabByteSize, item.file.size);
      const slabBuffer = await item.file.slice(slabStartByte, slabEndByte).arrayBuffer();
      const maxChunkInSlab = Math.min(p.totalChunks, baseChunk + SLAB_CHUNKS);

      for (let chunkIdx = baseChunk; chunkIdx < maxChunkInSlab; chunkIdx++) {
        if (this.cancelledFiles.has(item.fileIndex)) return;
        while (this.pausedFiles.has(item.fileIndex)) {
          await new Promise((r) => setTimeout(r, 150));
          if (this.cancelledFiles.has(item.fileIndex)) return;
        }

        const localStart = (chunkIdx - baseChunk) * p.chunkSize;
        const localEnd = Math.min(localStart + p.chunkSize, slabBuffer.byteLength);
        const rawBuf = slabBuffer.slice(localStart, localEnd);

        const [d0, d1] = computeChunkDigest64(rawBuf);
        chunkDigests[chunkIdx * 2] = d0;
        chunkDigests[chunkIdx * 2 + 1] = d1;

        if (skipChunks.has(chunkIdx)) {
          p.completedChunks++;
          p.transferredBytes = Math.min(item.file.size, p.completedChunks * p.chunkSize);
          continue;
        }

        // Sliding window flow control: prevent sender from outrunning receiver disk on 1.5–5 GB files
        if (p.transferredBytes - p.ackedBytes > MAX_UNACKED_WINDOW) {
          await this.waitForAckWindow(item.fileIndex, 600);
        }

        const payload = aesKey ? await encryptChunk(aesKey, rawBuf) : rawBuf;
        const frame = encodeChunkFrame(item.fileIndex, chunkIdx, payload);
        await this.transport.sendBinaryWithBackpressure(frame);

        p.completedChunks++;
        p.transferredBytes = Math.min(item.file.size, slabStartByte + localEnd);
        const elapsedSec = Math.max(0.05, (Date.now() - startedAt) / 1000);
        p.averageSpeedBps = p.transferredBytes / elapsedSec;
        p.currentSpeedBps = p.averageSpeedBps;
        p.etaSeconds =
          p.averageSpeedBps > 0
            ? (item.file.size - p.transferredBytes) / p.averageSpeedBps
            : null;

        this.emitProgress(chunkIdx === p.totalChunks - 1);
      }
    }

    p.status = 'verifying';
    this.emitProgress(true);
    const sha256 = await finalizeMerkleSha256(chunkDigests);
    this.transport.sendControl({
      type: 'FILE_HASH',
      fileIndex: item.fileIndex,
      sha256,
    });
  }

  private async tryFinalizeReceivedFile(fileIndex: number): Promise<void> {
    const entry = this.writers.get(fileIndex);
    const p = this.progressMap.get(fileIndex);
    if (!entry || !p || entry.finalizing) return;

    if (entry.receivedChunks.size < entry.totalChunks || !entry.expectedHash) {
      return;
    }

    entry.finalizing = true;
    p.status = 'verifying';
    this.emitProgress(true);

    // 1. Verify Merkle SHA-256 over all chunks in < 1 ms (before disk close/save dialog)
    const actualHash = await finalizeMerkleSha256(entry.chunkDigests);
    const verified = actualHash === entry.expectedHash;

    // 2. Immediately notify sender so neither device waits on browser save/flush
    this.transport.sendControl({
      type: 'FILE_VERIFIED',
      fileIndex,
      verified,
    });

    p.integrityVerified = verified;
    p.status = verified ? 'completed' : 'failed';
    p.percentage = verified ? 100 : p.percentage;
    if (!verified) {
      p.error = {
        code: 'HASH_MISMATCH',
        message: 'SHA-256 integrity check failed.',
        suggestion: 'Retry the transfer to ensure uncorrupted delivery.',
        recoverable: true,
      };
    }
    this.emitProgress(true);

    // 3. Flush final coalesced buffer and trigger file save
    await entry.writer.closeAndSave(entry.manifest.sanitizedName);
    await deleteResumeMetadata(`${entry.transferId}:${fileIndex}`).catch(() => {});

    if (verified) {
      this.onCompleteCallback({
        fileName: entry.manifest.sanitizedName,
        size: entry.manifest.size,
        direction: 'received',
        sha256: entry.expectedHash,
        durationMs: Date.now() - entry.startedAt,
      });
    }
  }
}
