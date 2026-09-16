// The loop detector names two shapes in the recent tool history and decides
// nothing. It must stay silent on routine repetition (re-reading a file) and
// speak on the shapes a person would call a loop.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectThrashing, TRAIL_LIMIT, ERROR_STORM_LENGTH, REPEAT_FAILING_MIN, REPEAT_ANY_MIN, type ToolTrailEntry } from '../src/broker/thrashing.ts';

let counter = 0;
function call(name: string, hash: string, error: boolean | null, preview = `{"x":"${hash}"}`): ToolTrailEntry {
  counter += 1;
  return { toolUseId: `toolu_${counter}`, sig: `${name}:${hash}`, name, inputPreview: preview, error };
}

describe('loop detection', () => {
  test('literal thresholds', () => {
    assert.deepEqual({ TRAIL_LIMIT, ERROR_STORM_LENGTH, REPEAT_FAILING_MIN, REPEAT_ANY_MIN }, { TRAIL_LIMIT: 20, ERROR_STORM_LENGTH: 5, REPEAT_FAILING_MIN: 3, REPEAT_ANY_MIN: 5 });
  });

  test('an empty or healthy trail is silent', () => {
    assert.equal(detectThrashing([]), null);
    assert.equal(detectThrashing([call('Read', 'a', false), call('Edit', 'b', false), call('Bash', 'c', false), call('Read', 'd', false)]), null);
  });

  test('re-reading the same file a few times is routine, not a loop', () => {
    const trail = [call('Read', 'same', false), call('Edit', 'x', false), call('Read', 'same', false), call('Bash', 'y', false), call('Read', 'same', false)];
    assert.equal(detectThrashing(trail), null, 'three successful identical reads stay silent');
  });

  test('the same failing call three times is a retry loop, with the evidence attached', () => {
    const trail = [call('Read', 'ok', false), call('Bash', 'npm-test', true, '{"command":"npm test"}'), call('Edit', 'x', false), call('Bash', 'npm-test', true, '{"command":"npm test"}'), call('Bash', 'npm-test', true, '{"command":"npm test"}')];
    const verdict = detectThrashing(trail);
    assert.deepEqual(verdict, { pattern: 'repeat', tool: 'Bash', inputPreview: '{"command":"npm test"}', count: 3, sig: 'Bash:npm-test' });
  });

  test('a failing call that then succeeds is not a loop', () => {
    const trail = [call('Bash', 'npm-test', true), call('Bash', 'npm-test', true), call('Bash', 'npm-test', false)];
    assert.equal(detectThrashing(trail), null);
  });

  test('five identical calls are a loop whatever their outcome', () => {
    const trail = [call('Read', 'same', false), call('Read', 'same', false), call('Read', 'same', false), call('Read', 'same', false), call('Read', 'same', false)];
    const verdict = detectThrashing(trail);
    assert.equal(verdict?.pattern, 'repeat');
    assert.equal(verdict?.count, 5);
    assert.equal(verdict?.tool, 'Read');
  });

  test('five consecutive failures of different calls are an error storm', () => {
    const trail = [call('Bash', 'a', true), call('Edit', 'b', true), call('Bash', 'c', true), call('Write', 'd', true), call('Bash', 'e', true, '{"command":"last"}')];
    const verdict = detectThrashing(trail);
    assert.equal(verdict?.pattern, 'error_storm');
    assert.equal(verdict?.count, 5);
    assert.equal(verdict?.tool, 'Bash');
    assert.equal(verdict?.inputPreview, '{"command":"last"}');
    // One success inside the last five breaks the storm.
    assert.equal(detectThrashing([...trail.slice(0, 2), call('Read', 'ok', false), ...trail.slice(3)]), null);
  });

  test('open calls have no outcome and are never counted', () => {
    const trail = [call('Bash', 'a', true), call('Bash', 'a', true), call('Bash', 'a', null)];
    assert.equal(detectThrashing(trail), null, 'two failures plus one still running is not three failures');
  });

  test('a loop older than the window is forgotten', () => {
    const old = Array.from({ length: 5 }, () => call('Read', 'same', false));
    const fresh = Array.from({ length: 10 }, (_, index) => call('Read', `distinct-${index}`, false));
    assert.equal(detectThrashing([...old, ...fresh]), null);
  });
});
