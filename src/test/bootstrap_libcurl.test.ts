import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tarCandidates } from '../http/bootstrap_libcurl.js';

test('tarCandidates uses plain tar on non-Windows', () => {
  assert.deepEqual(tarCandidates('linux', null), [{ cmd: 'tar', extraArgs: [] }]);
  assert.deepEqual(tarCandidates('darwin', null), [{ cmd: 'tar', extraArgs: [] }]);
});

test('tarCandidates prefers System32 bsdtar on Windows, then GNU tar with --force-local', () => {
  const c = tarCandidates('win32', 'C:\\Windows');
  assert.deepEqual(c, [
    { cmd: join('C:\\Windows', 'System32', 'tar.exe'), extraArgs: [] },
    { cmd: 'tar', extraArgs: ['--force-local'] },
  ]);
});

test('tarCandidates on Windows without SystemRoot falls back to GNU tar only', () => {
  assert.deepEqual(tarCandidates('win32', null), [{ cmd: 'tar', extraArgs: ['--force-local'] }]);
});
