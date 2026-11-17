import React from 'react';
import { Activity, Lock, Wifi } from 'lucide-react';
import type { ConnectionMetrics } from '../types/p2p';
import { formatBytes } from '../security/sanitize';

interface PerformanceMonitorProps {
  metrics: ConnectionMetrics;
  connected: boolean;
}

export const PerformanceMonitor: React.FC<PerformanceMonitorProps> = ({ metrics, connected }) => {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-3.5 sm:p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="h-4 w-4 text-sky-500" />
          Live Transport & Security Telemetry
        </h2>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
            connected
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
              : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-slate-400'}`} />
          {connected ? 'P2P Channel Open' : 'Standby'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 sm:gap-3">
        <div className="rounded-xl bg-slate-50 p-2.5 sm:p-3 min-w-0 dark:bg-slate-950/60">
          <p className="text-slate-500 dark:text-slate-400">Transport</p>
          <p className="mt-1 flex items-center gap-1 font-semibold uppercase">
            <Wifi className="h-3.5 w-3.5 text-sky-500" />
            {metrics.transport}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            ICE: {metrics.candidateType ?? 'pending'}
          </p>
        </div>

        <div className="rounded-xl bg-slate-50 p-2.5 sm:p-3 min-w-0 dark:bg-slate-950/60">
          <p className="text-slate-500 dark:text-slate-400">Latency / Quality</p>
          <p className="mt-1 font-semibold capitalize">
            {metrics.rttMs !== null ? `${metrics.rttMs} ms` : '--'} ({metrics.quality})
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            Buffer: {formatBytes(metrics.bufferedAmount)}
          </p>
        </div>

        <div className="rounded-xl bg-slate-50 p-2.5 sm:p-3 min-w-0 dark:bg-slate-950/60">
          <p className="text-slate-500 dark:text-slate-400">Encryption</p>
          <p className="mt-1 flex items-center gap-1 font-semibold text-emerald-600 dark:text-emerald-400">
            <Lock className="h-3.5 w-3.5" />
            DTLS {metrics.e2eeEnabled ? '+ AES-GCM' : ''}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            SAS: {metrics.safetyCode ?? 'Pending'}
          </p>
        </div>

        <div className="rounded-xl bg-slate-50 p-2.5 sm:p-3 min-w-0 dark:bg-slate-950/60">
          <p className="text-slate-500 dark:text-slate-400">Adaptive Chunk</p>
          <p className="mt-1 font-semibold">{formatBytes(metrics.chunkSizeBytes)}</p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            JS Heap: {metrics.memoryEstimateMb !== null ? `${metrics.memoryEstimateMb} MB` : 'N/A'}
          </p>
        </div>
      </div>
    </section>
  );
};
