import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppSettings,
  BrowserCapabilities,
  ConnectionMetrics,
  FileManifestItem,
  TransferHistoryEntry,
  TransferProgress,
} from '../types/p2p';
import {
  addHistoryEntry,
  clearAllLocalData,
  getHistoryEntries,
  loadSettings,
  saveSettings,
} from '../storage/localDb';
import { detectCapabilities } from '../utils/capabilities';
import { WebRtcTransport } from '../transports/webrtcTransport';
import { buildFileManifest, TransferEngine } from '../core/transferEngine';
import { generateSecurePairingCode, generateSessionId } from '../security/crypto';
import { MqttSignalingClient } from '../transports/mqttSignaling';

export function useP2pSession() {
  const [settings, setSettingsState] = useState<AppSettings>(() => loadSettings());
  const [capabilities, setCapabilities] = useState<BrowserCapabilities | null>(null);
  const [history, setHistory] = useState<TransferHistoryEntry[]>([]);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [roomExpiresAt, setRoomExpiresAt] = useState<number | null>(null);
  const [peerNickname, setPeerNickname] = useState<string | null>(null);
  const [channelOpen, setChannelOpen] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [progressItems, setProgressItems] = useState<TransferProgress[]>([]);
  const [incomingOffer, setIncomingOffer] = useState<{
    transferId: string;
    files: FileManifestItem[];
    chunkSize: number;
  } | null>(null);

  const [metrics, setMetrics] = useState<ConnectionMetrics>({
    transport: 'internet-webrtc',
    quality: 'unknown',
    rttMs: null,
    candidateType: null,
    dtlsEncrypted: true,
    e2eeEnabled: settings.enableE2ee,
    safetyCode: null,
    bufferedAmount: 0,
    chunkSizeBytes: settings.preferredChunkSizeKb * 1024,
    memoryEstimateMb: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const mqttRef = useRef<MqttSignalingClient | null>(null);
  const rtcRef = useRef<WebRtcTransport | null>(null);
  const engineRef = useRef<TransferEngine | null>(null);
  const targetPeerIdRef = useRef<string | null>(null);

  useEffect(() => {
    void detectCapabilities().then(setCapabilities);
    void getHistoryEntries().then(setHistory).catch(() => {});
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', settings.theme === 'dark');
  }, [settings.theme]);

  const updateSettings = useCallback((next: AppSettings) => {
    setSettingsState(next);
    saveSettings(next);
  }, []);

  const setupTransport = useCallback(
    (saltText: string, onSignalOut: (payload: Record<string, unknown>) => void) => {
      rtcRef.current?.close();
      const rtc = new WebRtcTransport(settings, saltText, {
        onSignalOut,
        onDataChannelOpen: () => setChannelOpen(true),
        onDataChannelClose: () => setChannelOpen(false),
        onControlMessage: (msg) => void engineRef.current?.handleControlMessage(msg),
        onBinaryChunk: (buf) => void engineRef.current?.handleBinaryChunk(buf),
        onMetricsUpdate: (partial) => setMetrics((prev) => ({ ...prev, ...partial })),
        onError: (err) => setErrorBanner(err.message),
      });

      const engine = new TransferEngine(rtc, {
        onProgressUpdate: (items) => setProgressItems(items),
        onIncomingOffer: (files, transferId, chunkSize) =>
          setIncomingOffer({ files, transferId, chunkSize }),
        onFileComplete: (entry) => {
          if (!settings.saveLocalHistory) return;
          const record: TransferHistoryEntry = {
            id: generateSessionId(),
            direction: entry.direction,
            peerNickname: peerNickname ?? 'Peer Device',
            fileName: entry.fileName,
            fileSize: entry.size,
            transport: metrics.transport,
            sha256: entry.sha256,
            status: 'completed',
            timestamp: Date.now(),
            durationMs: entry.durationMs,
          };
          void addHistoryEntry(record).then(() => getHistoryEntries().then(setHistory));
        },
      });
      engine.configure({
        preferredChunkSizeKb: settings.preferredChunkSizeKb,
        maxConcurrent: settings.maxConcurrentTransfers,
        rttMs: metrics.rttMs,
      });

      rtcRef.current = rtc;
      engineRef.current = engine;
      return rtc;
    },
    [metrics.rttMs, metrics.transport, peerNickname, settings]
  );

  const connectSignaling = useCallback(
    (mode: 'host' | 'guest', joinCode?: string) => {
      setErrorBanner(null);
      wsRef.current?.close();
      mqttRef.current?.close();

      const useServerlessMqtt =
        typeof window !== 'undefined' &&
        window.location.hostname !== 'localhost' &&
        window.location.hostname !== '127.0.0.1' &&
        (settings.signalingUrl.includes('localhost') ||
          settings.signalingUrl.includes('127.0.0.1'));

      if (useServerlessMqtt) {
        const code =
          mode === 'host'
            ? generateSecurePairingCode(6)
            : String(joinCode ?? '').trim().toUpperCase();
        if (!code || code.length < 4) {
          setErrorBanner('Enter a valid 6-character pairing code.');
          return;
        }
        const client = new MqttSignalingClient(code, mode, {
          onError: (msg) => setErrorBanner(msg),
          onMessage: async (msg) => {
            if (msg.type === 'PEER_JOINED' && mode === 'host') {
              setPeerNickname(
                String((msg.deviceInfo as { name?: string })?.name ?? 'Receiver')
              );
              const rtc = setupTransport(code, (payload) => {
                void client.sendToPeer({ type: 'SIGNAL', payload });
              });
              const offer = await rtc.createOffer();
              await client.sendToPeer({
                type: 'SIGNAL',
                payload: { type: 'offer', sdp: offer },
              });
            } else if (msg.type === 'SIGNAL') {
              await rtcRef.current?.handleSignal(msg.payload as Record<string, unknown>);
            }
          },
        });
        mqttRef.current = client;
        void client.connect(() => {
          setRoomCode(code);
          setRoomExpiresAt(Date.now() + 10 * 60_000);
          if (mode === 'guest') {
            setPeerNickname('Sender');
            setupTransport(code, (payload) => {
              void client.sendToPeer({ type: 'SIGNAL', payload });
            });
            void client.sendToPeer({
              type: 'PEER_JOINED',
              deviceInfo: { name: settings.deviceNickname },
            });
          }
        });
        return;
      }

      const ws = new WebSocket(settings.signalingUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (mode === 'host') {
          ws.send(
            JSON.stringify({
              type: 'CREATE_ROOM',
              deviceInfo: { name: settings.deviceNickname },
            })
          );
        } else if (joinCode) {
          ws.send(
            JSON.stringify({
              type: 'JOIN_ROOM',
              code: joinCode.trim().toUpperCase(),
              deviceInfo: { name: settings.deviceNickname },
            })
          );
        }
      };

      ws.onerror = () => {
        setErrorBanner(
          `Cannot reach signaling server at ${settings.signalingUrl}. Start it with "npm run dev:signaling" or use Serverless Direct Pairing.`
        );
      };

      ws.onmessage = async (ev) => {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === 'ERROR') {
          setErrorBanner(msg.message);
          return;
        }
        if (msg.type === 'ROOM_CREATED') {
          setRoomCode(msg.code);
          setRoomExpiresAt(msg.expiresAt);
        } else if (msg.type === 'PEER_JOINED') {
          targetPeerIdRef.current = msg.peerId;
          setPeerNickname(msg.deviceInfo?.name ?? 'Receiver');
          const rtc = setupTransport(roomCode ?? 'fluxdrop', (payload) => {
            ws.send(JSON.stringify({ type: 'SIGNAL', targetId: msg.peerId, payload }));
          });
          const offer = await rtc.createOffer();
          ws.send(
            JSON.stringify({
              type: 'SIGNAL',
              targetId: msg.peerId,
              payload: { type: 'offer', sdp: offer },
            })
          );
        } else if (msg.type === 'ROOM_JOINED') {
          targetPeerIdRef.current = msg.hostId;
          setRoomCode(msg.code);
          setRoomExpiresAt(msg.expiresAt);
          setPeerNickname(msg.hostDeviceInfo?.name ?? 'Sender');
          setupTransport(msg.code, (payload) => {
            ws.send(JSON.stringify({ type: 'SIGNAL', targetId: msg.hostId, payload }));
          });
        } else if (msg.type === 'SIGNAL') {
          await rtcRef.current?.handleSignal(msg.payload);
        } else if (msg.type === 'ROOM_CLOSED' || msg.type === 'ROOM_EXPIRED') {
          setErrorBanner('Session expired or peer disconnected.');
          setChannelOpen(false);
        }
      };
    },
    [roomCode, settings.deviceNickname, settings.signalingUrl, setupTransport]
  );

  const sendFiles = useCallback(
    async (files: File[]) => {
      if (!engineRef.current || !channelOpen) {
        setErrorBanner('Connect to a peer before starting a file transfer.');
        return;
      }
      const manifest = buildFileManifest(files);
      await engineRef.current.enqueueAndOffer(manifest, generateSessionId());
    },
    [channelOpen]
  );

  const acceptOffer = useCallback(async () => {
    if (!incomingOffer || !engineRef.current) return;
    try {
      await engineRef.current.acceptIncomingOffer(
        incomingOffer.transferId,
        incomingOffer.files,
        incomingOffer.chunkSize
      );
      setIncomingOffer(null);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to accept transfer');
    }
  }, [incomingOffer]);

  const rejectOffer = useCallback(() => {
    if (!incomingOffer || !engineRef.current) return;
    engineRef.current.rejectIncomingOffer(incomingOffer.transferId);
    setIncomingOffer(null);
  }, [incomingOffer]);

  const clearLocalData = useCallback(async () => {
    await clearAllLocalData();
    setHistory([]);
  }, []);

  const createOfflineOffer = useCallback(async (): Promise<string> => {
    setErrorBanner(null);
    const rtc = setupTransport('offline-direct', () => {});
    const sdpJson = await rtc.gatherCompleteLocalSdp(true);
    return btoa(unescape(encodeURIComponent(sdpJson)));
  }, [setupTransport]);

  const acceptOfflineOffer = useCallback(
    async (encodedOffer: string): Promise<string> => {
      setErrorBanner(null);
      const sdpObj = JSON.parse(decodeURIComponent(escape(atob(encodedOffer.trim()))));
      const rtc = setupTransport('offline-direct', () => {});
      await rtc.handleSignal({ type: 'offer', sdp: sdpObj });
      const answerJson = await rtc.gatherCompleteLocalSdp(false);
      setPeerNickname('Direct Peer');
      return btoa(unescape(encodeURIComponent(answerJson)));
    },
    [setupTransport]
  );

  const acceptOfflineAnswer = useCallback(async (encodedAnswer: string): Promise<void> => {
    setErrorBanner(null);
    const sdpObj = JSON.parse(decodeURIComponent(escape(atob(encodedAnswer.trim()))));
    await rtcRef.current?.handleSignal({ type: 'answer', sdp: sdpObj });
    setPeerNickname('Direct Peer');
  }, []);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    mqttRef.current?.close();
    rtcRef.current?.close();
    setRoomCode(null);
    setRoomExpiresAt(null);
    setPeerNickname(null);
    setChannelOpen(false);
  }, []);

  return {
    settings,
    updateSettings,
    capabilities,
    history,
    roomCode,
    roomExpiresAt,
    peerNickname,
    channelOpen,
    errorBanner,
    setErrorBanner,
    progressItems,
    incomingOffer,
    metrics,
    connectSignaling,
    sendFiles,
    acceptOffer,
    rejectOffer,
    pauseFile: (idx: number) => engineRef.current?.pauseFile(idx),
    resumeFile: (idx: number) => engineRef.current?.resumeFile(idx),
    cancelFile: (idx: number) => engineRef.current?.cancelFile(idx),
    clearCompleted: () =>
      setProgressItems((prev) =>
        prev.filter((p) => p.status !== 'completed' && p.status !== 'cancelled')
      ),
    clearLocalData,
    createOfflineOffer,
    acceptOfflineOffer,
    acceptOfflineAnswer,
    disconnect,
    setupTransport,
  };
}
