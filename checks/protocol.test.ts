import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Envelope, instructionError, parseFrame, promptFor, validateDescriptor, validateEnvelope, validateReference } from '../src/protocol';

const envelope = (): Envelope => ({
  version: 1, runtimeId: randomUUID(), connectionId: randomUUID(), sessionId: randomUUID(), requestId: randomUUID(),
  instruction: '/new  Keep this unchanged. ',
  reference: { path: '/tmp/example.ts', workspace: '/tmp', start: { line: 2, column: 3 }, end: { line: 3, column: 2 }, text: '😀x\ny', kind: 'selection' },
});

test('literal instruction and exact UTF-16 selection survive envelope validation', () => {
  const e = envelope();
  validateEnvelope(e);
  assert.equal(JSON.parse(JSON.stringify(e)).reference.text, '😀x\ny');
  assert.ok(promptFor(e).startsWith('VS Code request ['));
  assert.ok(promptFor(e).includes(e.instruction));
  assert.ok(promptFor(e).includes('untrusted data'));
  assert.ok(promptFor(e).includes('verify actual current files'));
});

test('rejects malformed identity, coordinates, paths and unknown fields', () => {
  for (const patch of [{ version: 2 }, { requestId: '-'.repeat(36) }, { connectionId: 'other' }, { extra: true }]) {
    assert.throws(() => validateEnvelope({ ...envelope(), ...patch }));
  }
  for (const patch of [{ kind: ['line'] }, { path: 'relative' }, { path: '/tmp/\0x' }, { start: { line: 0, column: 1 } }, { end: { line: 1, column: 1 } }, { end: { line: 3.5, column: 1 } }]) {
    assert.throws(() => validateReference({ ...envelope().reference, ...patch }));
  }
});

test('byte limits reject rather than truncate, including serialized reference overhead', () => {
  assert.equal(instructionError('x'.repeat(8192)), undefined);
  assert.ok(instructionError('😀'.repeat(2049)));
  assert.ok(instructionError('  '));
  assert.throws(() => validateEnvelope({ ...envelope(), instruction: 'x'.repeat(8193) }));
  assert.throws(() => validateReference({ ...envelope().reference, text: 'x'.repeat(16384) }));
  assert.throws(() => validateEnvelope({ ...envelope(), instruction: '\0'.repeat(8192), reference: { ...envelope().reference, text: 'x'.repeat(16000) } }));
});

test('frames reject binary, oversized payloads and non-object JSON', () => {
  for (const [raw, binary] of [[Buffer.from('{}'), true], [Buffer.alloc(65537), false], [Buffer.from('null'), false], [Buffer.from('[]'), false]] as const) {
    assert.throws(() => parseFrame(raw, binary));
  }
});

test('discovery accepts only versioned loopback port descriptors with strong credentials', () => {
  const d = { version: 1, runtimeId: randomUUID(), token: 'a'.repeat(64), port: 12345, pid: 123, label: 'window /tmp' };
  validateDescriptor(d);
  for (const patch of [{ port: 0 }, { port: 65536 }, { token: 'short' }, { version: 2 }, { origin: 'https://elsewhere' }]) assert.throws(() => validateDescriptor({ ...d, ...patch }));
});
