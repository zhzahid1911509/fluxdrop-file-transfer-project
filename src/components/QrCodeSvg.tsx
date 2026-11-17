import React, { useMemo } from 'react';
import { generateQrMatrix } from '../utils/qr';

interface QrCodeSvgProps {
  value: string;
  sizePx?: number;
}

export const QrCodeSvg: React.FC<QrCodeSvgProps> = ({ value, sizePx = 176 }) => {
  const { size, modules } = useMemo(() => generateQrMatrix(value), [value]);
  const quiet = 2;
  const total = size + quiet * 2;

  return (
    <svg
      width={sizePx}
      height={sizePx}
      viewBox={`0 0 ${total} ${total}`}
      className="rounded-xl bg-white p-2 shadow-sm ring-1 ring-slate-200 dark:ring-slate-700"
      role="img"
      aria-label="Session pairing QR code"
    >
      <rect width={total} height={total} fill="#ffffff" />
      {modules.map((dark, idx) => {
        if (!dark) return null;
        const r = Math.floor(idx / size) + quiet;
        const c = (idx % size) + quiet;
        return <rect key={idx} x={c} y={r} width={1} height={1} fill="#0f172a" />;
      })}
    </svg>
  );
};
