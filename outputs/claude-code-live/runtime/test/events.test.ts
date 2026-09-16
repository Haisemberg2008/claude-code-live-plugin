// Durable append-only event log with sequence numbers, crash-safe recovery at
// exact byte boundaries, UTF-8 integrity, cursor replay without duplicates,
// safe previews, redaction (including chunk-spanning credentials and hidden
// blocks in any position) and derivation of the per-run files.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { EventLog, MAX_RECORD_BYTES } from '../src/events/event-log.ts';
import { deriveCompatibilityFiles } from '../src/events/derive.ts';
import { redactSensitiveText, sanitizeHiddenContent, safePrefixLength, MAX_OPEN_CANDIDATE, TextRedactionStream } from '../src/events/redaction.ts';
import { boundedPreview, PREVIEW_MAX_CHARS } from '../src/events/preview.ts';
import { makeTempRoot, type TempRoot } from './helpers/temp.ts';

let temp: TempRoot;
before(async () => { temp = await makeTempRoot('codeorquestra-events-'); });
after(async () => { await temp.cleanup(); });

const ids = { taskId: 'task-a', runId: 'run-1', threadId: 'thread-a' };

describe('EventLog', () => {
  test('assigns monotonic sequence numbers and timestamps, persisted as JSON lines', async () => {
    const file = path.join(temp.root, 'seq', 'events.jsonl');
    const log = await EventLog.open(file);
    const first = await log.append({ type: 'run_started', ...ids, data: { requestedModel: 'claude-fable-5-1' } });
    const second = await log.append({ type: 'text_delta', ...ids, data: { text: 'Olá ' } });
    const third = await log.append({ type: 'text_delta', ...ids, data: { text: 'mundo' } });
    assert.deepEqual([first.seq, second.seq, third.seq], [1, 2, 3]);
    assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(log.lastSeq, 3);
    await log.close();
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    assert.deepEqual(JSON.parse(lines[1]!).data, { text: 'Olá ' });
    const reopened = await EventLog.open(file);
    assert.equal(reopened.lastSeq, 3);
    const fourth = await reopened.append({ type: 'turn_completed', ...ids, data: {} });
    assert.equal(fourth.seq, 4);
    await reopened.close();
  });

  test('replays from a cursor without duplicates or losses and preserves UTF-8', async () => {
    const file = path.join(temp.root, 'cursor', 'events.jsonl');
    const log = await EventLog.open(file);
    for (const text of ['á', '🙂', 'fim']) await log.append({ type: 'text_delta', ...ids, data: { text } });
    const afterZero = await log.readFrom(0);
    const afterTwo = await log.readFrom(2);
    assert.deepEqual(afterZero.map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(afterTwo.map((e) => e.seq), [3]);
    assert.equal(afterZero.map((e) => (e.data as { text: string }).text).join(''), 'á🙂fim');
    assert.deepEqual(await log.readFrom(3), []);
    await log.close();
  });

  test('recovers after a crash left an incomplete last line and keeps the file valid', async () => {
    const file = path.join(temp.root, 'crash', 'events.jsonl');
    const log = await EventLog.open(file);
    await log.append({ type: 'run_started', ...ids, data: {} });
    await log.append({ type: 'text_delta', ...ids, data: { text: 'ok' } });
    await log.close();
    await appendFile(file, '{"seq":3,"ts":"2026-09-12T00:00:00.000Z","type":"text_delta","data":{"text":"trunc');
    const recovered = await EventLog.open(file);
    assert.deepEqual(recovered.recovery, { recovered: 2, droppedPartialLine: true, corruptLines: 0 });
    assert.equal(recovered.lastSeq, 2);
    const next = await recovered.append({ type: 'turn_completed', ...ids, data: {} });
    assert.equal(next.seq, 3);
    await recovered.close();
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    for (const line of lines) JSON.parse(line);
  });

  test('a valid final line without newline is kept and the next append adds the separator', async () => {
    const file = path.join(temp.root, 'no-newline', 'events.jsonl');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"seq":1,"ts":"t","type":"run_started","taskId":"a","runId":"r","data":{}}\n{"seq":2,"ts":"t","type":"text_delta","taskId":"a","runId":"r","data":{"text":"x"}}', 'utf8');
    const log = await EventLog.open(file);
    assert.deepEqual(log.recovery, { recovered: 2, droppedPartialLine: false, corruptLines: 0 });
    assert.equal(log.lastSeq, 2);
    const third = await log.append({ type: 'turn_completed', ...ids, data: {} });
    assert.equal(third.seq, 3);
    await log.close();
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
    assert.deepEqual(lines.map((line) => JSON.parse(line).seq), [1, 2, 3]);
    const reopened = await EventLog.open(file);
    assert.deepEqual(reopened.recovery, { recovered: 3, droppedPartialLine: false, corruptLines: 0 });
    await reopened.close();
  });

  test('a corrupt line in the middle is counted, its bytes are preserved and a valid unterminated tail is kept', async () => {
    const file = path.join(temp.root, 'corrupt-middle', 'events.jsonl');
    const content = '{"seq":1,"ts":"t","type":"run_started","taskId":"a","runId":"r","data":{}}\n{"seq":2 corrupt\n{"seq":3,"ts":"t","type":"turn_completed","taskId":"a","runId":"r","data":{}}';
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    const log = await EventLog.open(file);
    assert.deepEqual(log.recovery, { recovered: 2, droppedPartialLine: false, corruptLines: 1 });
    assert.equal(log.lastSeq, 3);
    assert.equal((await stat(file)).size, Buffer.byteLength(content, 'utf8'), 'no truncation when the tail is valid');
    assert.deepEqual((await log.readFrom(0)).map((event) => event.seq), [1, 3]);
    const next = await log.append({ type: 'run_ended', ...ids, data: { status: 'COMPLETED' } });
    assert.equal(next.seq, 4);
    await log.close();
    const reopened = await EventLog.open(file);
    assert.deepEqual((await reopened.readFrom(0)).map((event) => event.seq), [1, 3, 4]);
    await reopened.close();
  });

  test('an oversized unterminated record is treated as a partial line and truncated at its exact start', async () => {
    const file = path.join(temp.root, 'oversized', 'events.jsonl');
    const valid = '{"seq":1,"ts":"t","type":"run_started","taskId":"a","runId":"r","data":{}}\n';
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, valid + '{"seq":2,"data":"' + 'x'.repeat(MAX_RECORD_BYTES + 1024), 'utf8');
    const log = await EventLog.open(file);
    assert.deepEqual(log.recovery, { recovered: 1, droppedPartialLine: true, corruptLines: 0 });
    assert.equal((await stat(file)).size, Buffer.byteLength(valid, 'utf8'));
    await log.close();
  });

  test('one admission policy: a record recovery would reject is refused at append time', async () => {
    const file = path.join(temp.root, 'admission', 'events.jsonl');
    const log = await EventLog.open(file);
    const accepted = await log.append({ type: 'tool_result', ...ids, data: { preview: 'x'.repeat(MAX_RECORD_BYTES - 4096) } });
    assert.equal(accepted.seq, 1);
    await assert.rejects(
      log.append({ type: 'tool_result', ...ids, data: { preview: 'x'.repeat(MAX_RECORD_BYTES + 1) } }),
      (error: { code?: string }) => error.code === 'EVENT_RECORD_TOO_LARGE',
    );
    const next = await log.append({ type: 'turn_completed', ...ids, data: {} });
    assert.equal(next.seq, 2, 'the refused record consumed no sequence number');
    await log.close();
    const reopened = await EventLog.open(file);
    assert.equal(reopened.recovery.recovered, 2, 'everything that was accepted survives recovery');
    assert.equal(reopened.lastSeq, 2);
    await reopened.close();
  });

  test('a replay page that cannot cover the cursor reports the gap instead of losing events', async () => {
    const file = path.join(temp.root, 'gap', 'events.jsonl');
    const log = await EventLog.open(file);
    for (let index = 0; index < 30; index += 1) await log.append({ type: 'assistant_text', ...ids, data: { text: `linha ${index}` } });
    const full = await log.readPage(0, 100);
    assert.equal(full.gapped, false);
    assert.equal(full.events.length, 30);
    const limited = await log.readPage(0, 10);
    assert.equal(limited.gapped, true, 'the page could not reach the cursor');
    assert.equal(limited.events.length, 10);
    assert.equal(limited.events[0]!.seq, 21, 'the newest events are kept');
    const byBytes = await log.readPage(0, 100, 400);
    assert.equal(byBytes.gapped, true, 'the byte budget also reports a gap');
    assert.ok(byBytes.events.length < 30);
    await log.close();
  });

  test('recovery applies the byte budget to a valid final record without a newline', async () => {
    const file = path.join(temp.root, 'tail-byte-budget', 'events.jsonl');
    await mkdir(path.dirname(file), { recursive: true });
    const payload = 'x'.repeat(1024 * 1024 - 4096);
    const records = Array.from({ length: 9 }, (_, index) => JSON.stringify({
      seq: index + 1,
      ts: 't',
      type: 'assistant_text',
      taskId: 'a',
      runId: 'r',
      data: { text: payload },
    }));
    await writeFile(file, records.join('\n'), 'utf8');

    const log = await EventLog.open(file);
    const internals = log as unknown as { cache: Array<{ seq: number }>; cacheBytes: number };
    assert.ok(internals.cacheBytes <= 8 * 1024 * 1024, 'the recovered cache must remain byte bounded');
    assert.ok(internals.cache.length < records.length, 'at least one oversized history record is evicted');
    assert.equal(internals.cache.at(-1)?.seq, 9, 'the valid unterminated tail remains the newest cached event');
    await log.close();
  });

  test('append clones data so later mutation changes neither cached nor persisted records', async () => {
    const file = path.join(temp.root, 'clone', 'events.jsonl');
    const log = await EventLog.open(file);
    const data: Record<string, unknown> = { text: 'original', nested: { n: 1 } };
    const appended = await log.append({ type: 'assistant_text', ...ids, data });
    data.text = 'mutado';
    (data.nested as { n: number }).n = 2;
    (appended.data as { text: string }).text = 'mutado-retorno';
    const [cached] = await log.readFrom(0);
    assert.deepEqual(cached!.data, { text: 'original', nested: { n: 1 } });
    (cached!.data as { text: string }).text = 'mutado-cache';
    const [again] = await log.readFrom(0);
    assert.equal((again!.data as { text: string }).text, 'original');
    await log.close();
    assert.deepEqual(JSON.parse((await readFile(file, 'utf8')).trim()).data, { text: 'original', nested: { n: 1 } });
  });

  test('rejects events that carry thinking, signatures, hidden block types or raw secrets', async () => {
    const file = path.join(temp.root, 'reject', 'events.jsonl');
    const log = await EventLog.open(file);
    const rejects = async (data: Record<string, unknown>) => assert.rejects(log.append({ type: 'assistant_text', ...ids, data }), (error: { code?: string }) => error.code === 'EVENT_FORBIDDEN_FIELD');
    await rejects({ thinking: 'hidden' });
    await rejects({ signature: 'abc' });
    await rejects({ block: { type: 'redacted_thinking', data: 'x' } });
    await rejects({ event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } } });
    await rejects({ event: { type: 'content_block_delta', delta: { type: 'signature_delta' } } });
    await rejects({ headers: { authorization: 'Bearer x' } });
    await log.close();
  });
});

describe('redaction and previews', () => {
  test('redacts common credential shapes and URL userinfo, leaving ordinary text intact', () => {
    assert.equal(redactSensitiveText('chave sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ fim'), 'chave [REDIGIDO] fim');
    assert.equal(redactSensitiveText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def'), 'Authorization: [REDIGIDO]');
    assert.equal(redactSensitiveText('AKIAIOSFODNN7EXAMPLE'), '[REDIGIDO]');
    assert.equal(redactSensitiveText('-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----'), '[REDIGIDO]');
    assert.equal(redactSensitiveText('password=SuperSecreta123'), 'password=[REDIGIDO]');
    assert.equal(redactSensitiveText('curl https://user:pw@example.invalid/notify'), 'curl https://[REDIGIDO]@example.invalid/notify');
    assert.equal(redactSensitiveText('Olá, o teste passou em 3 segundos.'), 'Olá, o teste passou em 3 segundos.');
  });

  test('an unresolved credential candidate is withheld until it resolves, whatever its length', () => {
    const prefix = 'Aqui está a chave usada no ambiente de testes locais desta tarefa: ';
    for (const secret of ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop.qrstuvwxyz012345']) {
      const stream = new TextRedactionStream();
      const emitted: string[] = [];
      // Feed the secret one character at a time: no chunk boundary may expose it.
      emitted.push(stream.push(prefix));
      for (const char of secret) emitted.push(stream.push(char));
      emitted.push(stream.push(' e depois segue o texto normal da resposta com detalhes suficientes.'));
      for (const text of emitted) {
        assert.ok(!text.includes(secret.slice(0, 12)), `texto ao vivo vazou um fragmento: ${text}`);
      }
      assert.ok(emitted.every((text, index) => index === 0 || text.startsWith(emitted[index - 1]!)), 'o texto público só cresce, nunca é reinterpretado');
      const final = stream.flush();
      assert.ok(final.includes('[REDIGIDO]'), `o texto final deve redigir ${secret.slice(0, 8)}`);
      assert.ok(!final.includes(secret));
      assert.ok(final.startsWith(emitted.at(-1)!), 'o texto final estende o último prefixo visível');
    }
  });

  test('a candidate longer than the lookback window still never leaks a prefix', () => {
    // Longer than the 4096-character lookback: a window-only scan would lose
    // sight of where this candidate started and publish its beginning.
    for (const secret of [`eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(6000)}.assinatura`, `ghp_${'b'.repeat(9000)}`, `https://usuario:${'c'.repeat(7000)}@example.invalid/rota`]) {
      const stream = new TextRedactionStream();
      const prefix = 'contexto antes do segredo, com texto suficiente para publicar: ';
      const emitted = [stream.push(prefix)];
      for (let index = 0; index < secret.length; index += 97) emitted.push(stream.push(secret.slice(index, index + 97)));
      emitted.push(stream.push(' e o texto normal continua depois disso tudo com folga.'));
      const marker = secret.slice(0, 40);
      for (const text of emitted) assert.ok(!text.includes(marker), `um fragmento longo vazou: ${text.slice(-80)}`);
      assert.ok(emitted.every((text, index) => index === 0 || text.startsWith(emitted[index - 1]!)), 'o texto público só cresce');
      const final = stream.flush();
      assert.ok(!final.includes(marker), 'o texto final não contém o segredo');
      assert.ok(final.includes('[REDIGIDO]'));
      assert.ok(final.startsWith(emitted.at(-1)!), 'o texto final estende o último prefixo visível');
      // Memory stays bounded: the candidate is not accumulated in full.
      assert.ok(final.length < prefix.length + MAX_OPEN_CANDIDATE + 200, `o buffer final cresceu demais: ${final.length}`);
    }
  });

  test('a candidate introduced wholly inside one huge chunk is caught before publication', () => {
    // The candidate starts far earlier in the chunk than any fixed tail window
    // would reach: scanning only the last N characters would never see its
    // introducer and would publish the whole prefix of the secret.
    for (const secret of [`https://usuario:${'c'.repeat(200)}@example.invalid/rota`, `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(200)}.assinatura`, `ghp_${'b'.repeat(200)}`]) {
      const stream = new TextRedactionStream();
      const filler = 'texto comum e inofensivo que apenas ocupa espaco. '.repeat(200);
      assert.ok(filler.length > 4096, 'o preenchimento precisa exceder a janela de varredura');
      // One single push containing filler + an INCOMPLETE candidate at the end.
      const visible = stream.push(`${filler}${secret}`);
      const marker = secret.slice(0, 40);
      assert.ok(!visible.includes(marker), `um candidato introduzido no mesmo bloco vazou: ${visible.slice(-120)}`);
      assert.ok(visible.startsWith('texto comum'), 'o texto inofensivo antes do candidato continua publicado');
      const final = stream.flush();
      assert.ok(!final.includes(marker), 'o texto final nao contem o segredo');
      assert.ok(final.includes('[REDIGIDO]'));
      assert.ok(final.startsWith(visible), 'o texto final estende o prefixo ja publicado');
    }
  });

  test('the live preview never cuts inside a complete credential near the holdback boundary', () => {
    for (const secret of [
      'https://usuario:senha-muito-secreta@example.invalid/rota',
      'eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop.qrstuvwxyz012345',
    ]) {
      const stream = new TextRedactionStream();
      const visible = stream.push(`prefixo seguro ${secret} fim`);
      assert.ok(!visible.includes(secret.slice(0, 16)), `o corte publicou parte da credencial: ${visible}`);
      assert.ok(stream.flush().includes('[REDIGIDO]'));
    }
  });

  test('the safe boundary also covers URL userinfo, key assignments and private-key blocks', () => {
    assert.equal(safePrefixLength('tudo certo aqui'), 'tudo certo aqui'.length);
    assert.ok(safePrefixLength('conectando em https://usuario:') < 'conectando em https://usuario:'.length);
    assert.ok(safePrefixLength('config password=') <= 'config '.length);
    assert.ok(safePrefixLength('inicio -----BEGIN PRIVATE KEY-----\nMIIE') <= 'inicio '.length);
    const stream = new TextRedactionStream();
    stream.push('acesse https://user:');
    const partial = stream.push('senha@example.invalid/rota');
    assert.ok(!partial.includes('user:senha'), 'userinfo incompleto permanece retido');
    assert.ok(stream.flush().includes('[REDIGIDO]@example.invalid'));
  });

  test('sanitizeHiddenContent drops thinking blocks, signatures and hidden objects in any position', () => {
    const message = {
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-fable-5-1',
        content: [
          { type: 'thinking', thinking: 'segredo interno', signature: 'sig' },
          { type: 'text', text: 'Resposta pública' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
    };
    const { sanitized, droppedThinking } = sanitizeHiddenContent(message);
    assert.equal(droppedThinking, 1);
    assert.deepEqual((sanitized as { message: { content: unknown[] } }).message.content, [
      { type: 'text', text: 'Resposta pública' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } },
    ]);
    assert.ok(!JSON.stringify(sanitized).includes('segredo interno'));
    assert.ok(!JSON.stringify(sanitized).includes('signature'));

    const start = { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'dados sintéticos' } } };
    const startResult = sanitizeHiddenContent(start);
    assert.equal(startResult.droppedThinking, 1);
    assert.deepEqual(startResult.sanitized, { type: 'stream_event', event: { type: 'content_block_start', index: 0 } });
    const delta = { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'mais' } } };
    const deltaResult = sanitizeHiddenContent(delta);
    assert.equal(deltaResult.droppedThinking, 1);
    assert.deepEqual(deltaResult.sanitized, { type: 'stream_event', event: { type: 'content_block_delta', index: 0 } });
    const signature = { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } } };
    assert.ok(!JSON.stringify(sanitizeHiddenContent(signature).sanitized).includes('abc'));
  });

  test('bounded previews truncate explicitly and expose paging', () => {
    assert.equal(PREVIEW_MAX_CHARS, 4096);
    const big = boundedPreview('x'.repeat(10000));
    assert.equal(big.preview.length, 4096);
    assert.equal(big.truncated, true);
    assert.equal(big.totalChars, 10000);
    assert.equal(big.pages, 3);
    const small = boundedPreview('pequeno');
    assert.deepEqual(small, { preview: 'pequeno', truncated: false, totalChars: 7, pages: 1 });
    const split = boundedPreview('á🙂'.repeat(3000));
    assert.ok(!split.preview.endsWith('\ud83d'), 'never cut a surrogate pair');
  });
});

describe('deriveCompatibilityFiles', () => {
  test('derives status/result/acompanhamento without double-counting text', async () => {
    const file = path.join(temp.root, 'derive', 'events.jsonl');
    const log = await EventLog.open(file);
    const base = { ...ids };
    await log.append({ type: 'run_started', ...base, data: { startedAt: '2026-09-12T10:00:00.000Z', requestedModel: 'claude-fable-5-1', modelReason: 'capacidade', effort: 'xhigh', workspace: 'C:\\ws', profile: 'development', contractVersion: 2, coordination: { phase: 'execution', scopeId: 's', approvalRevision: 1, planSummary: 'p', planApproved: true, responsibilities: { planning: 'codex', inspection: 'claude', implementation: 'claude', testing: 'claude', review: 'codex', commit: 'codex', push: 'codex', deploy: 'not_applicable' } } } });
    await log.append({ type: 'session_init', ...base, data: { sessionId: 'sess-1', observedModel: 'claude-fable-5-1' } });
    await log.append({ type: 'turn_started', ...base, data: { turn: 1 } });
    await log.append({ type: 'assistant_text', ...base, data: { text: 'Olá mundo' } });
    await log.append({ type: 'tool_start', ...base, toolUseId: 'toolu_1', data: { name: 'Read', input: { file_path: 'a.ts' } } });
    await log.append({ type: 'tool_result', ...base, toolUseId: 'toolu_1', data: { isError: true, preview: 'ENOENT' } });
    await log.append({ type: 'turn_completed', ...base, data: { turn: 1, resultText: 'Olá mundo' } });
    await log.append({ type: 'run_ended', ...base, data: { status: 'COMPLETED', endedAt: '2026-09-12T10:05:00.000Z', exitCode: 0 } });
    const derived = deriveCompatibilityFiles(await log.readFrom(0));
    await log.close();

    assert.equal(derived.status.status, 'COMPLETED');
    assert.equal(derived.status.sessionId, 'sess-1');
    assert.equal(derived.status.codexThreadId, 'thread-a');
    assert.equal(derived.status.requestedModel, 'claude-fable-5-1');
    assert.equal(derived.status.model, 'claude-fable-5-1');
    assert.equal(derived.status.effort, 'xhigh');
    assert.equal(derived.status.effortConfirmed, null);
    assert.deepEqual(derived.status.toolCalls, ['Read']);
    assert.equal(derived.status.toolErrors, 1);
    assert.equal(derived.status.permissionDenials, 0);
    assert.equal(derived.status.elapsedSeconds, 300);
    assert.equal(derived.status.contractVersion, 2);
    assert.equal(derived.result.result, 'Olá mundo');
    assert.equal(derived.result.exitCode, 0);
    assert.equal(derived.acompanhamento.split('Olá mundo').length - 1, 1, 'completed message text appears exactly once');
    assert.ok(derived.acompanhamento.includes('[Ferramenta] Read'));
    assert.ok(!JSON.stringify(derived).includes('thinking'));
  });

  test('marks an unfinished run as uncertain when the log ends without a terminal event', async () => {
    const file = path.join(temp.root, 'uncertain', 'events.jsonl');
    const log = await EventLog.open(file);
    await log.append({ type: 'run_started', ...ids, data: { startedAt: '2026-09-12T10:00:00.000Z', requestedModel: 'claude-opus-5', effort: 'xhigh', workspace: 'C:\\ws', profile: 'development', contractVersion: 2 } });
    await log.append({ type: 'tool_start', ...ids, toolUseId: 't1', data: { name: 'Bash', input: { command: 'npm test' } } });
    const derived = deriveCompatibilityFiles(await log.readFrom(0), { now: '2026-09-12T10:01:00.000Z', processAlive: false });
    await log.close();
    assert.equal(derived.status.status, 'UNCERTAIN');
    assert.equal(derived.status.requiresReview, true);
    assert.equal(derived.status.currentTool, 'Bash');
  });
});
