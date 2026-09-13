// PowerShell 7 helpers used to reproduce Windows sharing-mode behaviour that
// Node itself cannot reproduce: libuv always opens files with
// FILE_SHARE_DELETE, while PowerShell's Get-Content and [IO.File]::Open with
// FileShare.ReadWrite do not, which blocks File.Move(tmp, target, overwrite).
// Every helper cleans up its own process when startup fails.
import { spawn, type ChildProcess } from 'node:child_process';

export interface HeldResource {
  pid: number | undefined;
  /** Signals the holder to release and waits for the process to exit. */
  release(): Promise<void>;
}

const FILE_HOLDER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$stream = [IO.File]::Open($env:CODEORQUESTRA_HOLD_PATH, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)',
  "[Console]::Out.WriteLine('HELD'); [Console]::Out.Flush()",
  '$null = [Console]::In.ReadLine()',
  '$stream.Dispose()',
  "[Console]::Out.WriteLine('RELEASED'); [Console]::Out.Flush()",
].join('; ');

const MUTEX_HOLDER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$mutex = [Threading.Mutex]::new($false, $env:CODEORQUESTRA_HOLD_MUTEX)',
  'try { $held = $mutex.WaitOne(5000) } catch [Threading.AbandonedMutexException] { $held = $true }',
  "if (-not $held) { [Console]::Out.WriteLine('TIMEOUT'); [Console]::Out.Flush(); exit 2 }",
  "[Console]::Out.WriteLine('HELD'); [Console]::Out.Flush()",
  '$null = [Console]::In.ReadLine()',
  '$mutex.ReleaseMutex(); $mutex.Dispose()',
  "[Console]::Out.WriteLine('RELEASED'); [Console]::Out.Flush()",
].join('; ');

let availability: Promise<boolean> | undefined;

/** True when pwsh (PowerShell 7) can be started on this machine. */
export function isPwshAvailable(): Promise<boolean> {
  availability ??= new Promise<boolean>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 20000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
  return availability;
}

async function spawnHolder(script: string, env: Record<string, string>): Promise<HeldResource> {
  const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });
  const release = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.stdin.write('release\n');
        child.stdin.end();
      } catch {
        // stdin may already be closed
      }
      const killer = setTimeout(() => child.kill(), 10000);
      await exited;
      clearTimeout(killer);
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`pwsh holder did not report HELD in time. stderr: ${stderr}`)), 30000);
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (stdout.includes('HELD')) { clearTimeout(timer); resolve(); }
        if (stdout.includes('TIMEOUT')) { clearTimeout(timer); reject(new Error('pwsh holder could not acquire the resource')); }
      });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      void exited.then((code) => { clearTimeout(timer); reject(new Error(`pwsh holder exited early (${code}). stderr: ${stderr}`)); });
    });
  } catch (error) {
    // Failed start: terminate the exact holder we spawned and surface diagnostics.
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    throw error;
  }
  return { pid: child.pid, release };
}

/** Opens `filePath` for reading with FileShare.ReadWrite (no Delete share) and holds it. */
export function holdFileWithoutDeleteShare(filePath: string): Promise<HeldResource> {
  return spawnHolder(FILE_HOLDER_SCRIPT, { CODEORQUESTRA_HOLD_PATH: filePath });
}

/** Acquires a Windows named mutex from a PowerShell process and holds it. */
export function holdNamedMutex(name: string): Promise<HeldResource> {
  return spawnHolder(MUTEX_HOLDER_SCRIPT, { CODEORQUESTRA_HOLD_MUTEX: name });
}

export interface PwshResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs an inline PowerShell command with extra environment variables. */
export function runPwsh(command: string, env: Record<string, string> = {}, timeoutMs = 120000): Promise<PwshResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`pwsh timed out after ${timeoutMs}ms: ${command.slice(0, 120)}`)); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
