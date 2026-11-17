import type { AppSettings, ConnectionMetrics, ConnectionQuality, TransportType } from '../types/p2p';
import {
  deriveSessionAesKey,
  exportPublicKeyJwk,
  generateEcdhKeyPair,
  importPublicKeyJwk,
} from '../security/crypto';

export interface WebRtcCallbacks {
  onSignalOut: (payload: Record<string, unknown>) => void;
  onDataChannelOpen: () => void;
  onDataChannelClose: () => void;
  onControlMessage: (msg: Record<string, unknown>) => void;
  onBinaryChunk: (buf: ArrayBuffer) => void;
  onMetricsUpdate: (metrics: Partial<ConnectionMetrics>) => void;
  onError: (err: Error) => void;
}

export class WebRtcTransport {
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private callbacks: WebRtcCallbacks;
  private ecdhKeys: CryptoKeyPair | null = null;
  private aesKey: CryptoKey | null = null;
  private safetyCode: string | null = null;
  private statsTimer: number | null = null;
  private saltText: string;
  private enableE2ee: boolean;

  constructor(settings: AppSettings, saltText: string, callbacks: WebRtcCallbacks) {
    this.callbacks = callbacks;
    this.saltText = saltText;
    this.enableE2ee = settings.enableE2ee;

    const iceServers: RTCIceServer[] = settings.stunUrls.map((url) => ({ urls: url }));
    if (settings.turnConfig?.url) {
      iceServers.push({
        urls: settings.turnConfig.url,
        username: settings.turnConfig.username,
        credential: settings.turnConfig.credential,
      });
    }

    this.pc = new RTCPeerConnection({ iceServers });

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.callbacks.onSignalOut({ type: 'ice', candidate: ev.candidate.toJSON() });
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed') {
        this.callbacks.onError(
          new Error('WebRTC connection failed. Strict NAT/firewall may require a TURN relay.')
        );
      }
    };

    this.pc.ondatachannel = (ev) => {
      this.attachDataChannel(ev.channel);
    };
  }

  public getAesKey(): CryptoKey | null {
    return this.aesKey;
  }

  public getSafetyCode(): string | null {
    return this.safetyCode;
  }

  public getMaxMessageSize(): number {
    return this.pc.sctp?.maxMessageSize ?? 196608;
  }

  public getBufferedAmount(): number {
    return this.dc?.bufferedAmount ?? 0;
  }

  public async createOffer(): Promise<RTCSessionDescriptionInit> {
    const channel = this.pc.createDataChannel('fluxdrop-data', {
      ordered: true,
    });
    this.attachDataChannel(channel);

    if (this.enableE2ee) {
      this.ecdhKeys = await generateEcdhKeyPair();
      const pubJwk = await exportPublicKeyJwk(this.ecdhKeys.publicKey);
      this.callbacks.onSignalOut({ type: 'e2ee-pub', jwk: pubJwk });
    }

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  public async handleSignal(payload: Record<string, unknown>): Promise<void> {
    if (payload.type === 'offer') {
      await this.pc.setRemoteDescription(
        new RTCSessionDescription(payload.sdp as RTCSessionDescriptionInit)
      );
      if (this.enableE2ee && !this.ecdhKeys) {
        this.ecdhKeys = await generateEcdhKeyPair();
        const pubJwk = await exportPublicKeyJwk(this.ecdhKeys.publicKey);
        this.callbacks.onSignalOut({ type: 'e2ee-pub', jwk: pubJwk });
      }
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.callbacks.onSignalOut({ type: 'answer', sdp: answer });
    } else if (payload.type === 'answer') {
      await this.pc.setRemoteDescription(
        new RTCSessionDescription(payload.sdp as RTCSessionDescriptionInit)
      );
    } else if (payload.type === 'ice' && payload.candidate) {
      await this.pc.addIceCandidate(new RTCIceCandidate(payload.candidate as RTCIceCandidateInit));
    } else if (payload.type === 'e2ee-pub' && payload.jwk) {
      if (!this.ecdhKeys) {
        this.ecdhKeys = await generateEcdhKeyPair();
        const pubJwk = await exportPublicKeyJwk(this.ecdhKeys.publicKey);
        this.callbacks.onSignalOut({ type: 'e2ee-pub', jwk: pubJwk });
      }
      const peerPub = await importPublicKeyJwk(payload.jwk as JsonWebKey);
      const derived = await deriveSessionAesKey(
        this.ecdhKeys.privateKey,
        peerPub,
        this.saltText
      );
      this.aesKey = derived.aesKey;
      this.safetyCode = derived.safetyCode;
      this.callbacks.onMetricsUpdate({
        e2eeEnabled: true,
        safetyCode: this.safetyCode,
      });
    }
  }

  /**
   * Zero-Server Offline Local Wi-Fi / Hotspot SDP Exchange:
   * Gathers all ICE candidates into a single self-contained SDP string for QR/text copy.
   */
  public async gatherCompleteLocalSdp(isOffer: boolean): Promise<string> {
    if (isOffer) {
      await this.createOffer();
    }
    await new Promise<void>((resolve) => {
      if (this.pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      const check = () => {
        if (this.pc.iceGatheringState === 'complete') {
          this.pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      this.pc.addEventListener('icegatheringstatechange', check);
      setTimeout(resolve, 2500);
    });
    return JSON.stringify(this.pc.localDescription);
  }

  private attachDataChannel(channel: RTCDataChannel): void {
    this.dc = channel;
    this.dc.binaryType = 'arraybuffer';
    this.dc.bufferedAmountLowThreshold = 2 * 1024 * 1024; // 2 MB low-water mark

    this.dc.onopen = () => {
      this.startStatsPolling();
      this.callbacks.onDataChannelOpen();
    };

    this.dc.onclose = () => {
      this.stopStatsPolling();
      this.callbacks.onDataChannelClose();
    };

    this.dc.onerror = () => {
      this.callbacks.onError(new Error('WebRTC DataChannel error occurred.'));
    };

    this.dc.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          this.callbacks.onControlMessage(JSON.parse(ev.data));
        } catch {
          // ignore malformed control JSON
        }
      } else if (ev.data instanceof ArrayBuffer) {
        this.callbacks.onBinaryChunk(ev.data);
      }
    };
  }

  public sendControl(msg: Record<string, unknown>): void {
    if (this.dc?.readyState === 'open') {
      this.dc.send(JSON.stringify(msg));
    }
  }

  public async sendBinaryWithBackpressure(frame: ArrayBuffer): Promise<void> {
    if (!this.dc || this.dc.readyState !== 'open') {
      throw new Error('DataChannel is not open');
    }
    const HIGH_WATER_MARK = 8 * 1024 * 1024; // 8 MB high-throughput buffer
    if (this.dc.bufferedAmount > HIGH_WATER_MARK) {
      await new Promise<void>((resolve) => {
        const dc = this.dc!;
        const onLow = () => {
          dc.removeEventListener('bufferedamountlow', onLow);
          resolve();
        };
        dc.addEventListener('bufferedamountlow', onLow);
      });
    }
    this.dc.send(frame);
  }

  private startStatsPolling(): void {
    this.statsTimer = window.setInterval(async () => {
      try {
        const stats = await this.pc.getStats();
        let rttMs: number | null = null;
        let candidateType: string | null = null;
        let transport: TransportType = 'internet-webrtc';

        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            if (typeof report.currentRoundTripTime === 'number') {
              rttMs = Math.round(report.currentRoundTripTime * 1000);
            }
            const localCand = stats.get(report.localCandidateId);
            if (localCand?.candidateType) {
              candidateType = localCand.candidateType;
              if (candidateType === 'host') transport = 'lan-webrtc';
              else if (candidateType === 'relay') transport = 'turn-webrtc';
              else transport = 'internet-webrtc';
            }
          }
        });

        let quality: ConnectionQuality = 'unknown';
        if (rttMs !== null) {
          if (rttMs < 25) quality = 'excellent';
          else if (rttMs < 80) quality = 'good';
          else if (rttMs < 180) quality = 'fair';
          else quality = 'poor';
        }

        const memInfo = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        const memoryEstimateMb = memInfo ? Math.round(memInfo.usedJSHeapSize / (1024 * 1024)) : null;

        this.callbacks.onMetricsUpdate({
          transport,
          quality,
          rttMs,
          candidateType,
          dtlsEncrypted: true,
          bufferedAmount: this.dc?.bufferedAmount ?? 0,
          memoryEstimateMb,
        });
      } catch {
        // ignore stats errors
      }
    }, 1000);
  }

  private stopStatsPolling(): void {
    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  public close(): void {
    this.stopStatsPolling();
    this.dc?.close();
    this.pc.close();
  }
}
