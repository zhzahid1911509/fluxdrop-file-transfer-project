import React, { useEffect, useRef, useState } from 'react';
import {
  Upload,
  Download,
  Settings,
  Sun,
  Moon,
  Shield,
  Bluetooth,
  WifiOff,
  FolderOpen,
  AlertTriangle,
  History,
  Check,
  Copy,
  RefreshCw,
  Smartphone,
  Monitor,
  Share,
  X,
} from 'lucide-react';
import { useP2pSession } from './hooks/useP2pSession';
import { QrCodeSvg } from './components/QrCodeSvg';
import { ProgressPanel } from './components/ProgressPanel';
import { PerformanceMonitor } from './components/PerformanceMonitor';
import { SettingsModal } from './components/SettingsModal';
import { formatBytes } from './security/sanitize';
import { MAX_SUPPORTED_FILE_BYTES } from './utils/capabilities';
import { BluetoothTransport } from './transports/bluetoothTransport';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export function App() {
  const {
    settings,
    updateSettings,
    capabilities,
    history,
    roomCode,
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
    pauseFile,
    resumeFile,
    cancelFile,
    clearCompleted,
    clearLocalData,
    createOfflineOffer,
    acceptOfflineOffer,
    acceptOfflineAnswer,
    disconnect,
  } = useP2pSession();

  const [activeTab, setActiveTab] = useState<'send' | 'receive' | 'history'>('send');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [installTab, setInstallTab] = useState<'android' | 'ios' | 'windows'>('android');
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalledPwa, setIsInstalledPwa] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [bleStatus, setBleStatus] = useState<string | null>(null);
  const [offlineOfferToken, setOfflineOfferToken] = useState<string>('');
  const [offlineAnswerInput, setOfflineAnswerInput] = useState<string>('');
  const [offlineOfferInput, setOfflineOfferInput] = useState<string>('');
  const [offlineAnswerToken, setOfflineAnswerToken] = useState<string>('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const join = params.get('join');
    if (join && join.trim().length >= 4) {
      const code = join.trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
      if (code.length >= 4) {
        setActiveTab('receive');
        setJoinCodeInput(code);
        connectSignaling('guest', code);
      }
    }
  }, []);

  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      Boolean((window.navigator as unknown as { standalone?: boolean }).standalone);
    setIsInstalledPwa(standalone);

    const ua = navigator.userAgent;
    if (/iPad|iPhone|iPod/.test(ua)) setInstallTab('ios');
    else if (/Win/.test(ua)) setInstallTab('windows');
    else setInstallTab('android');

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setIsInstalledPwa(true);
      setDeferredPrompt(null);
      setInstallModalOpen(false);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        setDeferredPrompt(null);
      }
    } else {
      setInstallModalOpen(true);
    }
  };

  const totalSelectedSize = selectedFiles.reduce((acc, f) => acc + f.size, 0);
  const hasOversizedFile = selectedFiles.some((f) => f.size > MAX_SUPPORTED_FILE_BYTES);
  const isUsingServerlessMqtt =
    typeof window !== 'undefined' &&
    window.location.hostname !== 'localhost' &&
    window.location.hostname !== '127.0.0.1' &&
    (settings.signalingUrl.includes('localhost') || settings.signalingUrl.includes('127.0.0.1'));

  const handleFilesAdded = (fileList: FileList | null) => {
    if (!fileList) return;
    const arr = Array.from(fileList);
    setSelectedFiles((prev) => [...prev, ...arr]);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    handleFilesAdded(e.dataTransfer.files);
  };

  const handleCopyCode = () => {
    if (!roomCode) return;
    void navigator.clipboard.writeText(roomCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 1800);
  };

  const handleBluetoothScan = async () => {
    try {
      setBleStatus('Scanning nearby BLE devices...');
      const ble = new BluetoothTransport();
      const dev = await ble.requestNearbyDevice();
      setBleStatus(`Paired BLE device: ${dev.name} (${dev.connected ? 'Connected' : 'Ready'})`);
    } catch (err) {
      setBleStatus(null);
      setErrorBanner(err instanceof Error ? err.message : 'Bluetooth pairing failed');
    }
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-slate-50 text-slate-900 transition-colors dark:bg-slate-950 dark:text-slate-100">
      {/* Top Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/85 backdrop-blur-md dark:border-slate-800/80 dark:bg-slate-950/85">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-3 py-2.5 sm:px-4 sm:py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-blue-600 text-white shadow-sm sm:h-9 sm:w-9">
              <Upload className="h-4 w-4 sm:h-5 sm:w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-bold tracking-tight sm:text-base">
                FluxDrop P2P
              </h1>
              <p className="truncate text-[10px] text-slate-500 dark:text-slate-400 sm:text-[11px]">
                Serverless · Up to 5 GB Direct
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {!isInstalledPwa && (
              <button
                type="button"
                onClick={() => void handleInstallClick()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-sky-600 px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-sky-500 sm:px-3"
              >
                <Smartphone className="h-3.5 w-3.5" />
                <span>Install App</span>
              </button>
            )}
            {channelOpen && (
              <button
                type="button"
                onClick={disconnect}
                className="max-w-[130px] truncate rounded-xl border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300 sm:max-w-none"
              >
                Disconnect ({peerNickname ?? 'Peer'})
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                updateSettings({
                  ...settings,
                  theme: settings.theme === 'dark' ? 'light' : 'dark',
                })
              }
              aria-label="Toggle theme"
              className="rounded-xl border border-slate-200 p-2 hover:bg-slate-100 dark:border-slate-800 dark:hover:bg-slate-900"
            >
              {settings.theme === 'dark' ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Open settings"
              className="rounded-xl border border-slate-200 p-2 hover:bg-slate-100 dark:border-slate-800 dark:hover:bg-slate-900"
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-3 py-4 sm:space-y-6 sm:px-4 sm:py-6">
        {errorBanner && (
          <div className="flex items-start justify-between gap-2 rounded-2xl border border-rose-200 bg-rose-50 p-3.5 text-xs text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200 sm:p-4 sm:text-sm">
            <div className="flex min-w-0 items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="break-words">{errorBanner}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="shrink-0 text-xs font-semibold underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Mode Switcher — Responsive Grid on Small Screens */}
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="grid w-full grid-cols-3 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:w-auto sm:inline-flex">
            <button
              type="button"
              onClick={() => setActiveTab('send')}
              className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-medium transition sm:px-4 sm:text-sm ${
                activeTab === 'send'
                  ? 'bg-sky-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
            >
              <Upload className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span>Send</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('receive')}
              className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-medium transition sm:px-4 sm:text-sm ${
                activeTab === 'receive'
                  ? 'bg-sky-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
            >
              <Download className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span>Receive</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('history')}
              className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-medium transition sm:px-4 sm:text-sm ${
                activeTab === 'history'
                  ? 'bg-sky-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
            >
              <History className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span>History ({history.length})</span>
            </button>
          </div>

          <div className="flex items-center justify-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 sm:justify-end sm:text-xs">
            <Shield className="h-3.5 w-3.5 shrink-0 text-emerald-500 sm:h-4 sm:w-4" />
            <span>Zero central storage · DTLS encrypted</span>
          </div>
        </div>

        {/* SEND TAB */}
        {activeTab === 'send' && (
          <div className="grid gap-4 sm:gap-6 lg:grid-cols-3">
            <div className="space-y-4 lg:col-span-2">
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDrop}
                className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-white p-5 text-center transition hover:border-sky-500 dark:border-slate-700 dark:bg-slate-900 sm:p-10"
              >
                <div className="mb-2.5 rounded-2xl bg-sky-50 p-2.5 text-sky-600 dark:bg-sky-950/60 dark:text-sky-400 sm:mb-3 sm:p-3">
                  <Upload className="h-6 w-6 sm:h-7 sm:w-7" />
                </div>
                <p className="text-sm font-semibold sm:text-base">
                  Tap to select or drag & drop files
                </p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Streamed directly via WebRTC DataChannels without loading into RAM (up to 5 GB per file).
                </p>

                <div className="mt-4 flex w-full flex-col justify-center gap-2 sm:mt-5 sm:w-auto sm:flex-row sm:gap-3">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full rounded-xl bg-sky-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-sky-500 sm:w-auto sm:py-2 sm:text-sm"
                  >
                    Select Files
                  </button>
                  <button
                    type="button"
                    onClick={() => folderInputRef.current?.click()}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-slate-300 px-4 py-2.5 text-xs font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800 sm:w-auto sm:py-2 sm:text-sm"
                  >
                    <FolderOpen className="h-4 w-4" /> Select Folder
                  </button>
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => handleFilesAdded(e.target.files)}
                />
                <input
                  ref={folderInputRef}
                  type="file"
                  multiple
                  // @ts-expect-error webkitdirectory is standard in Chromium/Firefox/Safari
                  webkitdirectory=""
                  className="hidden"
                  onChange={(e) => handleFilesAdded(e.target.files)}
                />
              </div>

              {selectedFiles.length > 0 && (
                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h3 className="truncate text-xs font-semibold sm:text-sm">
                      Selected ({selectedFiles.length} files · {formatBytes(totalSelectedSize)})
                    </h3>
                    <button
                      type="button"
                      onClick={() => setSelectedFiles([])}
                      className="shrink-0 text-xs text-slate-500 hover:underline"
                    >
                      Clear
                    </button>
                  </div>
                  <ul className="max-h-44 space-y-1.5 overflow-y-auto text-xs">
                    {selectedFiles.map((f, idx) => (
                      <li
                        key={`${f.name}-${idx}`}
                        className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-950/60"
                      >
                        <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                        <span className="shrink-0 text-slate-500">{formatBytes(f.size)}</span>
                      </li>
                    ))}
                  </ul>
                  {hasOversizedFile && (
                    <p className="mt-2 text-xs text-rose-500">
                      One or more files exceed the 5 GB per-file limit.
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={!channelOpen || hasOversizedFile}
                    onClick={() => void sendFiles(selectedFiles)}
                    className="mt-4 w-full rounded-xl bg-emerald-600 py-2.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm"
                  >
                    {channelOpen
                      ? `Send ${selectedFiles.length} File(s) to ${peerNickname ?? 'Peer'}`
                      : 'Pair with Receiver First'}
                  </button>
                </div>
              )}
            </div>

            {/* Pairing Card */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5">
              <h2 className="text-sm font-semibold">Pair Receiver Device</h2>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Generate a temporary 6-letter code & QR session.
              </p>

              {isUsingServerlessMqtt && (
                <p className="mt-2 rounded-lg bg-sky-50 px-2.5 py-1.5 text-[11px] text-sky-700 dark:bg-sky-950/50 dark:text-sky-300">
                  Serverless Encrypted WSS Relay active
                </p>
              )}
              {!roomCode ? (
                <button
                  type="button"
                  onClick={() => connectSignaling('host')}
                  className="mt-4 w-full rounded-xl bg-sky-600 py-2.5 text-xs font-semibold text-white hover:bg-sky-500 sm:text-sm"
                >
                  Create Pairing Session
                </button>
              ) : (
                <div className="mt-4 flex flex-col items-center space-y-3.5">
                  <QrCodeSvg value={`${window.location.origin}/?join=${roomCode}`} sizePx={156} />
                  <div className="flex items-center gap-2 rounded-xl bg-slate-100 px-3.5 py-2 dark:bg-slate-950">
                    <span className="font-mono text-xl font-bold tracking-widest text-sky-600 dark:text-sky-400 sm:text-2xl">
                      {roomCode}
                    </span>
                    <button
                      type="button"
                      onClick={handleCopyCode}
                      aria-label="Copy pairing code"
                      className="rounded-lg p-1.5 hover:bg-slate-200 dark:hover:bg-slate-800"
                    >
                      {copiedCode ? (
                        <Check className="h-4 w-4 text-emerald-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => connectSignaling('host')}
                    className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Regenerate Code
                  </button>
                </div>
              )}

              <div className="mt-4 space-y-2 border-t border-slate-200 pt-3.5 dark:border-slate-800">
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Serverless Direct Pairing (No Server Needed)
                </p>
                {!offlineOfferToken ? (
                  <button
                    type="button"
                    onClick={() =>
                      void createOfflineOffer()
                        .then(setOfflineOfferToken)
                        .catch((e) => setErrorBanner(e.message))
                    }
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                  >
                    Generate Direct Offer Token
                  </button>
                ) : (
                  <div className="space-y-2">
                    <textarea
                      readOnly
                      rows={2}
                      value={offlineOfferToken}
                      onClick={(e) => (e.target as HTMLTextAreaElement).select()}
                      className="w-full rounded-lg border border-slate-300 bg-slate-50 p-2 font-mono text-[10px] dark:border-slate-700 dark:bg-slate-950"
                    />
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        placeholder="Paste Receiver Answer Token"
                        value={offlineAnswerInput}
                        onChange={(e) => setOfflineAnswerInput(e.target.value)}
                        className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-transparent px-2.5 py-1.5 font-mono text-[10px] dark:border-slate-700"
                      />
                      <button
                        type="button"
                        disabled={!offlineAnswerInput.trim()}
                        onClick={() =>
                          void acceptOfflineAnswer(offlineAnswerInput).catch((e) =>
                            setErrorBanner(e.message)
                          )
                        }
                        className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                      >
                        Link
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-4 border-t border-slate-200 pt-3.5 dark:border-slate-800">
                <button
                  type="button"
                  disabled={!capabilities?.webBluetooth}
                  onClick={() => void handleBluetoothScan()}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-xs font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  <Bluetooth className="h-4 w-4 shrink-0 text-sky-500" />
                  <span className="truncate">
                    {capabilities?.webBluetooth
                      ? 'Pair via Bluetooth LE'
                      : 'Web Bluetooth Unavailable'}
                  </span>
                </button>
                {bleStatus && <p className="mt-2 text-xs text-emerald-500">{bleStatus}</p>}
              </div>
            </div>
          </div>
        )}

        {/* RECEIVE TAB */}
        {activeTab === 'receive' && (
          <div className="grid gap-4 sm:gap-6 md:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-6">
              <h2 className="text-sm font-semibold sm:text-base">
                Enter 6-Letter Pairing Code
              </h2>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Enter the capital-letter code shown on the sender&apos;s screen.
              </p>
              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  maxLength={6}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  pattern="[A-Z]{6}"
                  placeholder="ABCDEF"
                  value={joinCodeInput}
                  onChange={(e) =>
                    setJoinCodeInput(
                      e.target.value
                        .toUpperCase()
                        .replace(/[^A-Z]/g, '')
                        .slice(0, 6)
                    )
                  }
                  className="w-full rounded-xl border border-slate-300 bg-transparent px-4 py-2.5 text-center font-mono text-lg uppercase tracking-widest dark:border-slate-700 sm:flex-1 sm:text-left"
                />
                <button
                  type="button"
                  disabled={joinCodeInput.trim().length < 4}
                  onClick={() => connectSignaling('guest', joinCodeInput)}
                  className="w-full rounded-xl bg-sky-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-50 sm:w-auto sm:text-sm"
                >
                  Connect
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-6">
              <h2 className="flex items-center gap-2 text-sm font-semibold sm:text-base">
                <WifiOff className="h-4 w-4 shrink-0 text-amber-500" />
                <span>Serverless Direct Pairing</span>
              </h2>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Paste the Sender&apos;s Offer Token below to generate an Answer Token with zero backend.
              </p>
              <div className="mt-3 space-y-2">
                <textarea
                  rows={2}
                  placeholder="Paste Sender Offer Token here..."
                  value={offlineOfferInput}
                  onChange={(e) => setOfflineOfferInput(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-transparent p-2.5 font-mono text-[11px] dark:border-slate-700"
                />
                <button
                  type="button"
                  disabled={!offlineOfferInput.trim()}
                  onClick={() =>
                    void acceptOfflineOffer(offlineOfferInput)
                      .then(setOfflineAnswerToken)
                      .catch((e) => setErrorBanner(e.message))
                  }
                  className="w-full rounded-xl bg-emerald-600 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  Generate Answer Token
                </button>
                {offlineAnswerToken && (
                  <textarea
                    readOnly
                    rows={2}
                    value={offlineAnswerToken}
                    onClick={(e) => (e.target as HTMLTextAreaElement).select()}
                    className="w-full rounded-xl border border-emerald-300 bg-emerald-50/40 p-2 font-mono text-[10px] dark:border-emerald-800 dark:bg-emerald-950/30"
                  />
                )}
              </div>
            </div>
          </div>
        )}

        {/* HISTORY TAB */}
        {activeTab === 'history' && (
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5">
            <h2 className="mb-3 text-sm font-semibold sm:text-base">
              Local Transfer History (IndexedDB Only)
            </h2>
            {history.length === 0 ? (
              <p className="text-xs text-slate-500 sm:text-sm">
                No local transfers recorded yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                      <th className="py-2 pr-3">File</th>
                      <th className="py-2 pr-3">Direction</th>
                      <th className="py-2 pr-3">Size</th>
                      <th className="py-2 pr-3">Transport</th>
                      <th className="py-2">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr
                        key={h.id}
                        className="border-b border-slate-100 dark:border-slate-800/60"
                      >
                        <td className="max-w-[140px] truncate py-2 pr-3 font-medium sm:max-w-xs">
                          {h.fileName}
                        </td>
                        <td className="py-2 pr-3 capitalize">{h.direction}</td>
                        <td className="whitespace-nowrap py-2 pr-3">
                          {formatBytes(h.fileSize)}
                        </td>
                        <td className="py-2 pr-3 uppercase">{h.transport}</td>
                        <td className="whitespace-nowrap py-2">
                          {new Date(h.timestamp).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* Live Telemetry & Active Transfers */}
        <PerformanceMonitor metrics={metrics} connected={channelOpen} />
        <ProgressPanel
          items={progressItems}
          onPause={pauseFile}
          onResume={resumeFile}
          onCancel={cancelFile}
          onClearCompleted={clearCompleted}
        />
      </main>

      {/* Incoming Transfer Consent Modal */}
      {incomingOffer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-3 backdrop-blur-sm sm:p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-4 shadow-xl dark:border-slate-800 dark:bg-slate-900 sm:p-6">
            <h2 className="text-base font-semibold sm:text-lg">Incoming File Transfer</h2>
            <p className="mt-1 text-xs text-slate-500">
              From {peerNickname ?? 'Connected Peer'} · {incomingOffer.files.length} file(s)
            </p>
            <ul className="mt-3.5 max-h-44 space-y-2 overflow-y-auto text-xs">
              {incomingOffer.files.map((f) => (
                <li
                  key={f.fileIndex}
                  className="rounded-xl bg-slate-50 p-2.5 dark:bg-slate-950/60 sm:p-3"
                >
                  <div className="flex justify-between gap-2 font-medium">
                    <span className="truncate">{f.sanitizedName}</span>
                    <span className="shrink-0">{formatBytes(f.size)}</span>
                  </div>
                  {f.isPotentiallyDangerous && (
                    <p className="mt-1 flex items-center gap-1 text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Executable/script file — verify sender before opening.
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-col-reverse gap-2 sm:mt-5 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={rejectOffer}
                className="w-full rounded-xl border border-slate-300 px-4 py-2 text-xs font-medium dark:border-slate-700 sm:w-auto"
              >
                Decline
              </button>
              <button
                type="button"
                onClick={() => void acceptOffer()}
                className="w-full rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 sm:w-auto"
              >
                Accept & Stream to Disk
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Install App Modal (Android / iOS / Windows) */}
      {installModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-3 backdrop-blur-sm sm:p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-4 shadow-xl dark:border-slate-800 dark:bg-slate-900 sm:p-6">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Install FluxDrop App</h2>
              <button
                type="button"
                onClick={() => setInstallModalOpen(false)}
                className="rounded-lg p-1 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mb-4 grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1 text-xs font-medium dark:bg-slate-950">
              <button
                type="button"
                onClick={() => setInstallTab('android')}
                className={`rounded-lg py-1.5 ${
                  installTab === 'android'
                    ? 'bg-sky-600 text-white'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                Android
              </button>
              <button
                type="button"
                onClick={() => setInstallTab('ios')}
                className={`rounded-lg py-1.5 ${
                  installTab === 'ios'
                    ? 'bg-sky-600 text-white'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                iOS (iPhone/iPad)
              </button>
              <button
                type="button"
                onClick={() => setInstallTab('windows')}
                className={`rounded-lg py-1.5 ${
                  installTab === 'windows'
                    ? 'bg-sky-600 text-white'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                Windows / Mac
              </button>
            </div>

            {installTab === 'android' && (
              <ol className="list-inside list-decimal space-y-2 text-xs text-slate-600 dark:text-slate-300">
                <li>Open FluxDrop in <strong>Google Chrome</strong> on Android.</li>
                <li>Tap the <strong>three-dot menu (⋮)</strong> in the top-right corner.</li>
                <li>Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>
              </ol>
            )}

            {installTab === 'ios' && (
              <ol className="list-inside list-decimal space-y-2 text-xs text-slate-600 dark:text-slate-300">
                <li>Open FluxDrop in <strong>Safari</strong> on your iPhone or iPad.</li>
                <li className="flex items-center gap-1.5">
                  <span>1. Tap the <strong>Share</strong> button</span>
                  <Share className="inline h-3.5 w-3.5 text-sky-500" />
                  <span>at the bottom of Safari.</span>
                </li>
                <li>Scroll down and tap <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.</li>
              </ol>
            )}

            {installTab === 'windows' && (
              <ol className="list-inside list-decimal space-y-2 text-xs text-slate-600 dark:text-slate-300">
                <li className="flex items-center gap-1.5">
                  <Monitor className="inline h-3.5 w-3.5 shrink-0 text-sky-500" />
                  <span>Open FluxDrop in <strong>Chrome</strong> or <strong>Microsoft Edge</strong> on Windows.</span>
                </li>
                <li>Click the <strong>Install FluxDrop</strong> icon on the right side of the address bar.</li>
                <li>Click <strong>Install</strong> to launch it as a standalone Windows desktop app.</li>
              </ol>
            )}

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setInstallModalOpen(false)}
                className="rounded-xl bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-500"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onUpdate={updateSettings}
        capabilities={capabilities}
        onClearAllData={() => void clearLocalData()}
      />
    </div>
  );
}

export default App;
