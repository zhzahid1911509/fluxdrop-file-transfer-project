export type TransportType =
  | 'lan-webrtc'
  | 'internet-webrtc'
  | 'turn-webrtc'
  | 'offline-qr-webrtc'
  | 'ble-gatt'
  | 'native-wifi-direct';

export type ConnectionQuality = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';

export type TransferStatus =
  | 'queued'
  | 'connecting'
  | 'handshaking'
  | 'transmitting'
  | 'receiving'
  | 'paused'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DeviceInfo {
  id: string;
  nickname: string;
  platform: string;
  browser: string;
  supportsOpfs: boolean;
  supportsFileSystemAccess: boolean;
  supportsBluetooth: boolean;
}

export interface FileManifestItem {
  fileIndex: number;
  name: string;
  sanitizedName: string;
  size: number;
  mimeType: string;
  lastModified: number;
  relativePath?: string;
  sha256?: string;
  isPotentiallyDangerous: boolean;
}

export interface TransferProgress {
  fileIndex: number;
  fileName: string;
  totalBytes: number;
  transferredBytes: number;
  ackedBytes: number;
  percentage: number;
  currentSpeedBps: number;
  averageSpeedBps: number;
  etaSeconds: number | null;
  status: TransferStatus;
  integrityVerified: boolean | null;
  error?: TransferErrorInfo;
  priority: number;
  chunkSize: number;
  totalChunks: number;
  completedChunks: number;
}

export interface TransferErrorInfo {
  code: string;
  message: string;
  suggestion: string;
  recoverable: boolean;
}

export interface ConnectionMetrics {
  transport: TransportType;
  quality: ConnectionQuality;
  rttMs: number | null;
  candidateType: string | null;
  dtlsEncrypted: boolean;
  e2eeEnabled: boolean;
  safetyCode: string | null;
  bufferedAmount: number;
  chunkSizeBytes: number;
  memoryEstimateMb: number | null;
}

export interface BrowserCapabilities {
  webRtc: boolean;
  dataChannel: boolean;
  fileSystemAccess: boolean;
  opfs: boolean;
  webBluetooth: boolean;
  webCrypto: boolean;
  cameraQrScan: boolean;
  serviceWorker: boolean;
  quotaEstimateBytes: number | null;
  usageBytes: number | null;
  os: 'Windows' | 'macOS' | 'Linux' | 'Android' | 'iOS' | 'Unknown';
  browser: string;
}

export interface AppSettings {
  deviceNickname: string;
  signalingUrl: string;
  stunUrls: string[];
  turnConfig: {
    url: string;
    username: string;
    credential: string;
  } | null;
  preferredTransport: 'auto' | TransportType;
  maxConcurrentTransfers: number;
  preferredChunkSizeKb: number;
  enableE2ee: boolean;
  saveLocalHistory: boolean;
  theme: 'dark' | 'light';
  notificationsEnabled: boolean;
}

export interface TransferHistoryEntry {
  id: string;
  direction: 'sent' | 'received';
  peerNickname: string;
  fileName: string;
  fileSize: number;
  transport: TransportType;
  sha256: string | null;
  status: 'completed' | 'failed' | 'cancelled';
  timestamp: number;
  durationMs: number;
}

export interface ResumeMetadata {
  transferId: string;
  fileName: string;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  receivedChunkIndices: number[];
  updatedAt: number;
}
