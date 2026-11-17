/**
 * Binary Frame Protocol ("FLXD" = 0x464C5844)
 * 16-byte header + payload:
 *   [0..3]   Magic "FLXD"
 *   [4..7]   fileIndex (uint32 BE)
 *   [8..11]  chunkIndex (uint32 BE)
 *   [12..15] payloadLen (uint32 BE)
 *   [16..]   chunk bytes (raw or AES-GCM encrypted)
 */

export const FRAME_MAGIC = 0x464c5844;
export const FRAME_HEADER_BYTES = 16;

export function encodeChunkFrame(
  fileIndex: number,
  chunkIndex: number,
  payload: ArrayBuffer
): ArrayBuffer {
  const frame = new ArrayBuffer(FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(frame);
  view.setUint32(0, FRAME_MAGIC, false);
  view.setUint32(4, fileIndex, false);
  view.setUint32(8, chunkIndex, false);
  view.setUint32(12, payload.byteLength, false);
  new Uint8Array(frame, FRAME_HEADER_BYTES).set(new Uint8Array(payload));
  return frame;
}

export function decodeChunkFrame(frame: ArrayBuffer): {
  fileIndex: number;
  chunkIndex: number;
  payload: ArrayBuffer;
} {
  if (frame.byteLength < FRAME_HEADER_BYTES) {
    throw new Error('Corrupted frame: smaller than 16-byte header');
  }
  const view = new DataView(frame);
  const magic = view.getUint32(0, false);
  if (magic !== FRAME_MAGIC) {
    throw new Error('Invalid frame magic header');
  }
  const fileIndex = view.getUint32(4, false);
  const chunkIndex = view.getUint32(8, false);
  const payloadLen = view.getUint32(12, false);
  const payload = frame.slice(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + payloadLen);
  return { fileIndex, chunkIndex, payload };
}

export function computeAdaptiveChunkSize(params: {
  preferredKb: number;
  sctpMaxMessageSize?: number;
  rttMs: number | null;
  e2eeOverheadBytes?: number;
}): number {
  const minBytes = 16 * 1024;
  const sctpCap = params.sctpMaxMessageSize
    ? Math.max(minBytes, Math.min(256 * 1024, params.sctpMaxMessageSize - 1024))
    : 192 * 1024;

  let target = Math.min(Math.max(128, params.preferredKb) * 1024, sctpCap);

  if (params.rttMs !== null) {
    if (params.rttMs < 25) {
      target = Math.min(256 * 1024, sctpCap);
    } else if (params.rttMs > 200) {
      target = Math.min(64 * 1024, sctpCap);
    }
  }

  const overhead = FRAME_HEADER_BYTES + (params.e2eeOverheadBytes ?? 28);
  return Math.max(minBytes, target - overhead);
}
