import React from 'react';
import { Pause, Play, X, RotateCcw, ShieldCheck, AlertCircle } from 'lucide-react';
import type { TransferProgress } from '../types/p2p';
import { formatBytes, formatDuration } from '../security/sanitize';

interface ProgressPanelProps {
  items: TransferProgress[];
  onPause: (fileIndex: number) => void;
  onResume: (fileIndex: number) => void;
  onCancel: (fileIndex: number) => void;
  onClearCompleted: () => void;
}

const STATUS_BADGE: Record<TransferProgress['status'], string> = {
  queued: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  connecting: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  handshaking: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  transmitting: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  receiving: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  paused: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  verifying: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  failed: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  cancelled: 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
};

export const ProgressPanel: React.FC<ProgressPanelProps> = ({
  items,
  onPause,
  onResume,
  onCancel,
  onClearCompleted,
}) => {
  if (items.length === 0) return null;

  const hasCompleted = items.some((i) => i.status === 'completed' || i.status === 'cancelled');

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-3.5 sm:p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold">Transfer Queue ({items.length})</h2>
        {hasCompleted && (
          <button
            type="button"
            onClick={onClearCompleted}
            className="text-xs font-medium text-sky-600 hover:underline dark:text-sky-400"
          >
            Clear completed
          </button>
        )}
      </div>

      <div className="space-y-3">
        {items.map((item) => {
          const remaining = Math.max(0, item.totalBytes - item.transferredBytes);
          const isActive = item.status === 'transmitting' || item.status === 'receiving';
          return (
            <div
              key={item.fileIndex}
              className="rounded-xl border border-slate-100 bg-slate-50 p-3 sm:p-3.5 dark:border-slate-800 dark:bg-slate-950/60"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.fileName}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {formatBytes(item.transferredBytes)} / {formatBytes(item.totalBytes)} · Remaining{' '}
                    {formatBytes(remaining)} · Chunk {formatBytes(item.chunkSize)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${
                      STATUS_BADGE[item.status]
                    }`}
                  >
                    {item.status}
                  </span>
                  {isActive && (
                    <button
                      type="button"
                      onClick={() => onPause(item.fileIndex)}
                      aria-label={`Pause ${item.fileName}`}
                      className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      <Pause className="h-4 w-4" />
                    </button>
                  )}
                  {item.status === 'paused' && (
                    <button
                      type="button"
                      onClick={() => onResume(item.fileIndex)}
                      aria-label={`Resume ${item.fileName}`}
                      className="rounded-lg p-1.5 text-sky-600 hover:bg-sky-100 dark:text-sky-400 dark:hover:bg-sky-900/40"
                    >
                      <Play className="h-4 w-4" />
                    </button>
                  )}
                  {item.status === 'failed' && (
                    <button
                      type="button"
                      onClick={() => onResume(item.fileIndex)}
                      aria-label={`Retry ${item.fileName}`}
                      className="rounded-lg p-1.5 text-amber-600 hover:bg-amber-100 dark:text-amber-400"
                    >
                      <RotateCcw className="h-4 w-4" />
                    </button>
                  )}
                  {item.status !== 'completed' && item.status !== 'cancelled' && (
                    <button
                      type="button"
                      onClick={() => onCancel(item.fileIndex)}
                      aria-label={`Cancel ${item.fileName}`}
                      className="rounded-lg p-1.5 text-rose-600 hover:bg-rose-100 dark:text-rose-400 dark:hover:bg-rose-900/40"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                <div
                  className={`h-full rounded-full transition-all duration-200 ${
                    item.status === 'completed'
                      ? 'bg-emerald-500'
                      : item.status === 'failed'
                        ? 'bg-rose-500'
                        : 'bg-sky-500 progress-stripe'
                  }`}
                  style={{ width: `${item.percentage}%` }}
                />
              </div>

              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                <span>
                  {item.percentage}% · Speed: {formatBytes(item.currentSpeedBps)}/s (Avg{' '}
                  {formatBytes(item.averageSpeedBps)}/s) · ETA: {formatDuration(item.etaSeconds)}
                </span>
                {item.integrityVerified === true && (
                  <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                    <ShieldCheck className="h-3.5 w-3.5" /> SHA-256 Verified
                  </span>
                )}
                {item.error && (
                  <span className="inline-flex items-center gap-1 font-medium text-rose-600 dark:text-rose-400">
                    <AlertCircle className="h-3.5 w-3.5" /> {item.error.message}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};
