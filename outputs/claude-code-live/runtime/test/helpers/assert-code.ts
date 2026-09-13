import assert from 'node:assert/strict';

/** Asserts that fn throws an error carrying the given machine-readable code. */
export function assertThrowsCode(fn: () => unknown, code: string, because?: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown !== undefined, `Expected a thrown error with code ${code}${because ? ` because ${because}` : ''}`);
  const actual = (thrown as { code?: unknown }).code;
  assert.equal(actual, code, `Expected code ${code}${because ? ` because ${because}` : ''}; received ${String(actual)}: ${(thrown as Error).message}`);
}

export async function assertRejectsCode(promise: Promise<unknown>, code: string, because?: string): Promise<unknown> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown !== undefined, `Expected rejection with code ${code}${because ? ` because ${because}` : ''}`);
  const actual = (thrown as { code?: unknown }).code;
  assert.equal(actual, code, `Expected code ${code}${because ? ` because ${because}` : ''}; received ${String(actual)}: ${(thrown as Error).message}`);
  return thrown;
}
