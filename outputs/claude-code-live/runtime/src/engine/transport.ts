// Process transport for the installed Claude Code CLI.
//
// This module is the ONLY place that starts a real Claude Code process. The
// test harness substitutes a fake process factory that speaks the same
// newline-delimited JSON protocol, so every layer above (framing, control
// correlation, session client, worker, broker, HTTP, MCP) is exercised for
// real while no authenticated CLI is ever launched.
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { CliLaunchPlan, CliFrame, HostFrame } from './protocol.ts';

export interface ClaudeProcessHandle {
  pid: number | undefined;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable | null;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): void;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

export type SpawnClaudeProcess = (plan: CliLaunchPlan) => ClaudeProcessHandle;

export const spawnInstalledClaudeProcess: SpawnClaudeProcess = (plan) => {
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return child as unknown as ClaudeProcessHandle;
};

const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export class FramingError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FramingError';
    this.code = code;
  }
}

/**
 * Reads newline-delimited JSON from a stream. Oversized or malformed lines are
 * reported through onProblem instead of silently dropped, and never crash the
 * reader: the CLI is an external process whose output we do not control.
 */
export async function* readFrames(stream: Readable, onProblem: (problem: { code: string; detail: string }) => void): AsyncGenerator<CliFrame> {
  let buffer = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream as AsyncIterable<string>) {
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
      onProblem({ code: 'FRAME_TOO_LARGE', detail: `linha acima de ${MAX_FRAME_BYTES} bytes descartada` });
      buffer = '';
      continue;
    }
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          yield JSON.parse(line) as CliFrame;
        } catch {
          onProblem({ code: 'FRAME_NOT_JSON', detail: `${line.length} caracteres ignorados` });
        }
      }
      index = buffer.indexOf('\n');
    }
  }
  const tail = buffer.trim();
  if (tail) {
    try {
      yield JSON.parse(tail) as CliFrame;
    } catch {
      onProblem({ code: 'FRAME_NOT_JSON', detail: 'linha final incompleta ignorada' });
    }
  }
}

export function writeFrame(stream: Writable, frame: HostFrame): void {
  if (!stream.writable) throw new FramingError('STDIN_CLOSED', 'A entrada do processo Claude Code já foi fechada.');
  stream.write(`${JSON.stringify(frame)}\n`);
}
