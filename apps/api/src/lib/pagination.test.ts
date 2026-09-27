import { describe, expect, it } from 'vitest';
import { decodeTimeIdCursor, encodeTimeIdCursor } from './pagination.js';
import { AppError } from './errors.js';

const KEY = { at: new Date('2026-09-24T12:34:56.789Z'), id: '0f8fad5b-d9cb-469f-a165-70867728950e' };

function encodeRaw(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

describe('time-id cursor codec', () => {
  it('round-trips a cursor deterministically', () => {
    const cursor = encodeTimeIdCursor(KEY);
    expect(encodeTimeIdCursor(KEY)).toBe(cursor);
    const decoded = decodeTimeIdCursor(cursor);
    expect(decoded?.at.getTime()).toBe(KEY.at.getTime());
    expect(decoded?.id).toBe(KEY.id);
  });

  it('treats empty input as the head of the list', () => {
    expect(decodeTimeIdCursor(undefined)).toBeNull();
    expect(decodeTimeIdCursor(null)).toBeNull();
    expect(decodeTimeIdCursor('')).toBeNull();
  });

  it('rejects malformed cursors with 422 instead of drifting to page one', () => {
    const invalid = [
      'not-a-cursor',
      Buffer.from('not json', 'utf8').toString('base64url'),
      encodeRaw({ v: 2, at: KEY.at.toISOString(), id: KEY.id }),
      encodeRaw({ v: 1, at: 'not-a-date', id: KEY.id }),
      encodeRaw({ v: 1, at: KEY.at.toISOString(), id: 'not-a-uuid' }),
      encodeRaw({ v: 1, at: KEY.at.toISOString() }),
      encodeRaw(['v1']),
      'x'.repeat(600),
      42
    ];
    for (const raw of invalid) {
      expect(() => decodeTimeIdCursor(raw)).toThrow(AppError);
      try {
        decodeTimeIdCursor(raw);
      } catch (error) {
        expect((error as AppError).statusCode).toBe(422);
        expect((error as AppError).code).toBe('INVALID_CURSOR');
      }
    }
  });
});
