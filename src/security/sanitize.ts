const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'msi', 'bat', 'cmd', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf',
  'wsh', 'scr', 'pif', 'com', 'sh', 'bash', 'zsh', 'apk', 'dmg', 'pkg',
  'deb', 'rpm', 'appimage', 'hta', 'reg', 'dll', 'sys', 'jar'
]);

const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

export function sanitizeFilename(rawName: string): string {
  // Strip path components & traversal attempts
  const base = rawName.split(/[/\\]/).pop() ?? 'unnamed_file';
  // Remove null bytes, control chars, and unsafe filesystem chars
  let cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();

  if (!cleaned) {
    cleaned = 'unnamed_file';
  }

  const dotIdx = cleaned.lastIndexOf('.');
  const stem = dotIdx > 0 ? cleaned.slice(0, dotIdx) : cleaned;
  const ext = dotIdx > 0 ? cleaned.slice(dotIdx) : '';

  if (WINDOWS_RESERVED.has(stem.toUpperCase())) {
    cleaned = `_${stem}${ext}`;
  }

  if (cleaned.length > 240) {
    cleaned = `${stem.slice(0, 200)}${ext.slice(0, 32)}`;
  }

  return cleaned;
}

export function isPotentiallyDangerousFile(filename: string): boolean {
  const parts = filename.toLowerCase().split('.');
  if (parts.length < 2) return false;
  const ext = parts[parts.length - 1];
  return DANGEROUS_EXTENSIONS.has(ext);
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 2)} ${sizes[i]}`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '--';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}
