/**
 * Web Bluetooth API (BLE GATT) Transport
 * ---------------------------------------------------------------------------
 * Important technical constraint documented in UI & architecture:
 * - Browsers only expose BLE GATT (not Bluetooth Classic OBEX).
 * - BLE GATT throughput is typically 20–100 KB/s; suitable for small files (< 5 MB)
 *   or out-of-band pairing handshakes. Large transfers automatically recommend
 *   Local Wi-Fi / Wi-Fi Direct / WebRTC.
 */

const FLUXDROP_BLE_SERVICE_UUID = '0000fd99-0000-1000-8000-00805f9b34fb';
const FLUXDROP_BLE_CHAR_UUID = '0000fd9a-0000-1000-8000-00805f9b34fb';

export interface BleDeviceHandle {
  id: string;
  name: string;
  connected: boolean;
}

export class BluetoothTransport {
  public static isSupported(): boolean {
    return typeof (navigator as unknown as { bluetooth?: unknown }).bluetooth !== 'undefined';
  }

  public static shouldRecommendWifiInstead(totalBytes: number): boolean {
    return totalBytes > 5 * 1024 * 1024; // > 5 MB
  }

  public async requestNearbyDevice(): Promise<BleDeviceHandle> {
    if (!BluetoothTransport.isSupported()) {
      throw new Error(
        'Web Bluetooth API is not supported in this browser (unavailable on Safari, iOS, and Firefox). Use Chrome or Edge on Desktop/Android, or switch to Local Wi-Fi / QR.'
      );
    }

    const navBle = (navigator as unknown as {
      bluetooth: {
        requestDevice: (opts: unknown) => Promise<{
          id: string;
          name?: string;
          gatt?: { connect: () => Promise<{ connected: boolean }> };
        }>;
      };
    }).bluetooth;

    const device = await navBle.requestDevice({
      acceptAllDevices: true,
      optionalServices: [FLUXDROP_BLE_SERVICE_UUID, FLUXDROP_BLE_CHAR_UUID],
    });

    let connected = false;
    if (device.gatt) {
      const server = await device.gatt.connect();
      connected = server.connected;
    }

    return {
      id: device.id,
      name: device.name || 'Unnamed BLE Device',
      connected,
    };
  }
}
