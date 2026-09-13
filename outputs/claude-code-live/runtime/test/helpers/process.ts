import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import readline from 'node:readline';

export interface SpawnedRuntime {
  child: ChildProcess;
  pid: number | undefined;
  stdoutLines: string[];
  stderrText: string;
  exited: Promise<number | null>;
  waitForLine(match: (line: string) => boolean, timeoutMs?: number, description?: string): Promise<string>;
  stop(): Promise<void>;
}

/**
 * Spawns a TypeScript entrypoint with Node's built-in type stripping so tests
 * exercise real separate processes (broker, worker, MCP adapter).
 */
export function spawnNode(
  scriptPath: string,
  args: string[],
  options: { env?: Record<string, string>; cwd?: string; stdin?: 'pipe' | 'ignore'; inheritEnv?: boolean } = {},
): SpawnedRuntime {
  const env = options.inheritEnv === false ? { ...(options.env ?? {}) } : { ...process.env, ...(options.env ?? {}) };
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    scriptPath,
    ...args,
  ], {
    env,
    cwd: options.cwd,
    stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdoutLines: string[] = [];
  const waiters: Array<{ match: (line: string) => boolean; resolve: (line: string) => void }> = [];
  let stderrText = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderrText += chunk; });
  const reader = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
  reader.on('line', (line) => {
    stdoutLines.push(line);
    for (const waiter of [...waiters]) {
      if (waiter.match(line)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(line);
      }
    }
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });
  return {
    child,
    pid: child.pid,
    stdoutLines,
    get stderrText() { return stderrText; },
    exited,
    waitForLine(match, timeoutMs = 20000, description = 'expected output line') {
      const existing = stdoutLines.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise<string>((resolve, reject) => {
        const waiter = { match, resolve: (line: string) => { clearTimeout(timer); resolve(line); } };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for ${description}. stdout: ${stdoutLines.slice(-10).join('\n')} stderr: ${stderrText.slice(-2000)}`));
        }, timeoutMs);
        waiters.push(waiter);
        void exited.then((code) => {
          if (!stdoutLines.some(match)) {
            clearTimeout(timer);
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error(`Process exited (${code}) before ${description}. stderr: ${stderrText.slice(-2000)}`));
          }
        });
      });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    },
  };
}

export interface JsonResponse {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

export async function fetchJson(url: string, init: RequestInit = {}): Promise<JsonResponse> {
  const response = await fetch(url, { redirect: 'manual', ...init });
  const text = await response.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: response.status, headers: response.headers, body, text };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Sends a raw HTTP/1.1 request (lets tests control forbidden headers such as Host). */
export function rawHttpRequest(port: number, requestText: string, timeoutMs = 5000): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('raw request timed out')); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(requestText));
    socket.on('data', (chunk: string) => { data += chunk; });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('close', () => {
      clearTimeout(timer);
      const [head, ...rest] = data.split('\r\n\r\n');
      const lines = (head ?? '').split('\r\n');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '')?.[1] ?? 0);
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const index = line.indexOf(':');
        if (index > 0) headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
      }
      resolve({ status, headers, body: rest.join('\r\n\r\n') });
    });
  });
}
