/**
 * Centralized debug logging for RemoteStorageFileSystem.
 * Set window.__RS_DEBUG = true in browser console to enable.
 */

const isDebug = () =>
  (typeof window !== 'undefined' && (window as any).__RS_DEBUG) ||
  (typeof process !== 'undefined' && process.env?.RS_DEBUG === 'true');

function truncate(data: unknown, max = 200): string {
  let s: string;
  try {
    s = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    s = String(data);
  }
  if (s === undefined) s = 'undefined';
  if (s.length > max) return s.slice(0, max) + '...';
  return s;
}

/**
 * Create a logger bound to a specific backend name.
 * All log output will be prefixed with `[RS:backendName]` so that
 * multiple RemoteStorage instances (primary, replica, etc.) are
 * distinguishable in the console.
 */
export function createLogger(backendName: string) {
  const log = (method: string, path: string, detail?: Record<string, unknown>) => {
    if (!isDebug()) return;
    const parts = [`[RS:${backendName}] ${method} path=${path}`];
    if (detail) {
      for (const [k, v] of Object.entries(detail)) {
        parts.push(`${k}=${truncate(v)}`);
      }
    }
    console.log(parts.join(' '));
  };

  const logResult = (method: string, path: string, result: unknown, ok = true) => {
    if (!isDebug()) return;
    const status = ok ? 'OK' : 'ERR';
    console.log(`[RS:${backendName}] ${method} path=${path} → ${status} ${truncate(result)}`);
  };

  return { log, logResult };
}

// Backward-compatible standalone functions (no backend name in prefix)
export function rsLog(method: string, path: string, detail?: Record<string, unknown>) {
  if (!isDebug()) return;
  const parts = [`[RS] ${method} path=${path}`];
  if (detail) {
    for (const [k, v] of Object.entries(detail)) {
      parts.push(`${k}=${truncate(v)}`);
    }
  }
  console.log(parts.join(' '));
}

export function rsLogResult(method: string, path: string, result: unknown, ok = true) {
  if (!isDebug()) return;
  const status = ok ? 'OK' : 'ERR';
  console.log(`[RS] ${method} path=${path} → ${status} ${truncate(result)}`);
}
