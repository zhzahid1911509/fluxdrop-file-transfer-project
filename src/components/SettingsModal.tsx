import React from 'react';
import { X, Trash2, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { AppSettings, BrowserCapabilities } from '../types/p2p';
import { getPwaInstallInstructions } from '../utils/capabilities';
import { formatBytes } from '../security/sanitize';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  onUpdate: (next: AppSettings) => void;
  capabilities: BrowserCapabilities | null;
  onClearAllData: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  onClose,
  settings,
  onUpdate,
  capabilities,
  onClearAllData,
}) => {
  if (!open) return null;

  const pwaSteps = capabilities ? getPwaInstallInstructions(capabilities.os) : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Settings, Capabilities & PWA</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 text-sm">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-slate-500">Device Nickname</span>
              <input
                type="text"
                value={settings.deviceNickname}
                onChange={(e) => onUpdate({ ...settings, deviceNickname: e.target.value })}
                className="mt-1 w-full rounded-xl border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-slate-500">Ephemeral Signaling URL</span>
              <input
                type="text"
                value={settings.signalingUrl}
                onChange={(e) => onUpdate({ ...settings, signalingUrl: e.target.value })}
                className="mt-1 w-full rounded-xl border border-slate-300 bg-transparent px-3 py-2 font-mono text-xs dark:border-slate-700"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-slate-500">Preferred Chunk Size (KB)</span>
              <select
                value={settings.preferredChunkSizeKb}
                onChange={(e) =>
                  onUpdate({ ...settings, preferredChunkSizeKb: Number(e.target.value) })
                }
                className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
              >
                <option value={16}>16 KB (Unstable / High Latency)</option>
                <option value={64}>64 KB (Balanced Default)</option>
                <option value={128}>128 KB (Fast Wi-Fi)</option>
                <option value={256}>256 KB (LAN Gigabit Max)</option>
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-slate-500">Max Concurrent Transfers</span>
              <select
                value={settings.maxConcurrentTransfers}
                onChange={(e) =>
                  onUpdate({ ...settings, maxConcurrentTransfers: Number(e.target.value) })
                }
                className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
              >
                <option value={1}>1 (Sequential)</option>
                <option value={2}>2 (Recommended)</option>
                <option value={3}>3</option>
                <option value={4}>4</option>
              </select>
            </label>
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.enableE2ee}
                onChange={(e) => onUpdate({ ...settings, enableE2ee: e.target.checked })}
              />
              <span>Application-Level E2EE (ECDH + AES-GCM)</span>
            </label>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.saveLocalHistory}
                onChange={(e) => onUpdate({ ...settings, saveLocalHistory: e.target.checked })}
              />
              <span>Save Local Transfer History (IndexedDB)</span>
            </label>
          </div>

          {capabilities && (
            <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                Detected Browser Capabilities ({capabilities.browser} on {capabilities.os})
              </h3>
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                {[
                  ['WebRTC DataChannel', capabilities.dataChannel],
                  ['File System Access (5 GB)', capabilities.fileSystemAccess],
                  ['OPFS Streaming', capabilities.opfs],
                  ['Web Crypto (AES/SHA)', capabilities.webCrypto],
                  ['Web Bluetooth (BLE)', capabilities.webBluetooth],
                  ['Offline PWA Worker', capabilities.serviceWorker],
                ].map(([label, ok]) => (
                  <div key={String(label)} className="flex items-center gap-1.5">
                    {ok ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                    )}
                    <span>{String(label)}</span>
                  </div>
                ))}
              </div>
              {capabilities.quotaEstimateBytes !== null && (
                <p className="mt-2 text-xs text-slate-500">
                  Browser Storage Quota: {formatBytes(capabilities.quotaEstimateBytes)} (Used:{' '}
                  {formatBytes(capabilities.usageBytes ?? 0)})
                </p>
              )}
            </div>
          )}

          {pwaSteps.length > 0 && (
            <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-950/60">
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
                Install as App ({capabilities?.os})
              </h3>
              <ol className="list-inside list-decimal space-y-1 text-xs text-slate-600 dark:text-slate-300">
                {pwaSteps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          )}

          <div className="flex items-center justify-between border-t border-slate-200 pt-4 dark:border-slate-800">
            <button
              type="button"
              onClick={onClearAllData}
              className="inline-flex items-center gap-1.5 rounded-xl bg-rose-50 px-3.5 py-2 text-xs font-medium text-rose-700 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300"
            >
              <Trash2 className="h-4 w-4" />
              Erase All Local History & Cached Chunks
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-500"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
