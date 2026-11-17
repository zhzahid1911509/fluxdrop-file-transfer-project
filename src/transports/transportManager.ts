import type { AppSettings, BrowserCapabilities, TransportType } from '../types/p2p';

export interface TransportRecommendation {
  selected: TransportType;
  reason: string;
  warning: string | null;
}

export function selectOptimalTransport(params: {
  capabilities: BrowserCapabilities;
  settings: AppSettings;
  isOnline: boolean;
  totalBytes: number;
}): TransportRecommendation {
  const { capabilities, settings, isOnline, totalBytes } = params;

  if (settings.preferredTransport !== 'auto') {
    if (settings.preferredTransport === 'ble-gatt') {
      if (!capabilities.webBluetooth) {
        return {
          selected: isOnline ? 'internet-webrtc' : 'offline-qr-webrtc',
          reason: 'Web Bluetooth is unavailable in this browser; falling back to WebRTC.',
          warning: 'Bluetooth GATT is unsupported on this browser.',
        };
      }
      if (totalBytes > 5 * 1024 * 1024) {
        return {
          selected: 'ble-gatt',
          reason: 'Manual BLE GATT selected.',
          warning: 'Transfer exceeds 5 MB. Local Wi-Fi / WebRTC is strongly recommended for speed.',
        };
      }
    }
    return {
      selected: settings.preferredTransport,
      reason: `Manual transport selected: ${settings.preferredTransport}`,
      warning: null,
    };
  }

  if (!isOnline) {
    return {
      selected: 'offline-qr-webrtc',
      reason: 'Internet offline detected — using Local Wi-Fi / Hotspot WebRTC (LAN or Offline QR SDP).',
      warning: null,
    };
  }

  if (capabilities.webRtc && capabilities.dataChannel) {
    return {
      selected: 'internet-webrtc',
      reason: 'WebRTC DataChannel selected (prefers direct LAN host candidates, then STUN P2P, then TURN relay).',
      warning: null,
    };
  }

  return {
    selected: 'ble-gatt',
    reason: 'WebRTC unavailable; attempting BLE GATT.',
    warning: 'Your browser lacks WebRTC DataChannels.',
  };
}
