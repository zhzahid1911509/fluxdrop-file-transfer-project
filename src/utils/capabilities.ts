import type { BrowserCapabilities } from '../types/p2p';

export const MAX_SUPPORTED_FILE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

export function detectOS(): BrowserCapabilities['os'] {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Win/.test(ua)) return 'Windows';
  if (/Mac/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown';
}

export function detectBrowserName(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Edg/')) return 'Microsoft Edge';
  if (ua.includes('Chrome/') && !ua.includes('Edg/')) return 'Google Chrome';
  if (ua.includes('Firefox/')) return 'Mozilla Firefox';
  if (ua.includes('Safari/') && !ua.includes('Chrome/')) return 'Safari';
  return 'Web Browser';
}

export async function detectCapabilities(): Promise<BrowserCapabilities> {
  const hasWebRtc = typeof RTCPeerConnection !== 'undefined';
  const hasFsAccess = typeof (window as unknown as Record<string, unknown>).showSaveFilePicker === 'function';
  let hasOpfs = false;
  let quotaEstimateBytes: number | null = null;
  let usageBytes: number | null = null;

  if (navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      quotaEstimateBytes = est.quota ?? null;
      usageBytes = est.usage ?? null;
    } catch {
      // ignore
    }
  }

  if (navigator.storage?.getDirectory) {
    try {
      await navigator.storage.getDirectory();
      hasOpfs = true;
    } catch {
      hasOpfs = false;
    }
  }

  return {
    webRtc: hasWebRtc,
    dataChannel: hasWebRtc && 'createDataChannel' in RTCPeerConnection.prototype,
    fileSystemAccess: hasFsAccess,
    opfs: hasOpfs,
    webBluetooth: typeof (navigator as unknown as { bluetooth?: unknown }).bluetooth !== 'undefined',
    webCrypto: typeof crypto?.subtle !== 'undefined',
    cameraQrScan: typeof navigator.mediaDevices?.getUserMedia === 'function',
    serviceWorker: 'serviceWorker' in navigator,
    quotaEstimateBytes,
    usageBytes,
    os: detectOS(),
    browser: detectBrowserName(),
  };
}

export function getPwaInstallInstructions(os: BrowserCapabilities['os']): string[] {
  switch (os) {
    case 'Windows':
    case 'Linux':
      return [
        'Open FluxDrop in Google Chrome or Microsoft Edge.',
        'Click the Install icon (+) in the right side of the address bar.',
        'Confirm "Install" to run FluxDrop as a standalone desktop app.',
      ];
    case 'macOS':
      return [
        'In Chrome/Edge: click the Install icon (+) in the address bar.',
        'In Safari (macOS Sonoma+): click File -> Add to Dock.',
      ];
    case 'Android':
      return [
        'Open FluxDrop in Chrome for Android.',
        'Tap the three-dot menu -> "Install app" or "Add to Home screen".',
      ];
    case 'iOS':
      return [
        'Open FluxDrop in Safari on iPhone or iPad.',
        'Tap the Share button (square with upward arrow).',
        'Scroll down and tap "Add to Home Screen".',
      ];
    default:
      return ['Use your browser menu to "Install App" or "Add to Home Screen".'];
  }
}
