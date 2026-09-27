import { describe, expect, it } from 'vitest';
import {
  buildCursorPage,
  decodeCursor,
  encodeCursor,
  makeCursor,
  parsePageQuery,
  snapshotFor,
  assertSameFilters,
  type KeyBoundary
} from './cursor.js';
import { AppError } from './errors.js';

const id = (suffix: string): string => `00000000-0000-4000-8000-0000000000${suffix}`;
const rows = (count: number, startMinute = 0): KeyBoundary[] =>
  Array.from({ length: count }, (_unused, index) => ({
    id: id(String(index).padStart(2, '0')),
    at: new Date(`2026-09-27T10:${String(startMinute + index).padStart(2, '0')}:00.000Z`)
  }));
const filters = { type: 'ANNOTATION' as const, keyword: '第' };
const snapshot = new Date('2026-09-27T12:00:00.000Z');

describe('cursor token', () => {
  it('round trips through base64url without leaking ambiguous chars', () => {
    const token = makeCursor({
      snapshotAt: snapshot,
      direction: 'next',
      filters: { q: 'a/b?c' },
      boundary: rows(1)[0]!
    });
    const encoded = encodeCursor(token);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(decodeCursor(encoded)).toEqual(token);
  });

  it('rejects malformed, tampered and legacy-foreign cursors', () => {
    expect(() => decodeCursor('not-base64-json')).toThrow(AppError);
    expect(() => decodeCursor('not-base64-json')).toThrow('分页游标无效');
    const token = encodeCursor(makeCursor({ snapshotAt: snapshot, direction: 'next', filters: {}, boundary: rows(1)[0]! }));
    expect(() => decodeCursor(`${token}xx`)).toThrow(AppError);
    const tampered = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    tampered.i = 'not-a-uuid';
    expect(() => decodeCursor(Buffer.from(JSON.stringify(tampered)).toString('base64url'))).toThrow(AppError);
    const oldVersion = { v: 9, s: token, d: 'next', f: {}, t: token, i: id('01') };
    expect(() => decodeCursor(Buffer.from(JSON.stringify(oldVersion)).toString('base64url'))).toThrow(AppError);
  });

  it('normalizes parseable timestamp strings back to ISO so cursors stay recomputable', () => {
    const raw = Buffer.from(
      JSON.stringify({
        v: 1,
        s: new Date(1_790_000_000_000).toISOString(),
        d: 'next',
        f: {},
        t: '2026-09-27 10:00:00Z',
        i: id('01')
      })
    ).toString('base64url');
    const decoded = decodeCursor(raw);
    expect(decoded.s).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(decoded.t).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
});

describe('parsePageQuery', () => {
  it('keeps historical page/pageSize OFFSET requests unchanged', () => {
    expect(parsePageQuery({ page: '3', pageSize: '25' })).toEqual({
      mode: 'offset',
      page: 3,
      pageSize: 25,
      skip: 50
    });
  });

  it('defaults and clamps page size', () => {
    expect(parsePageQuery({ page: '1', pageSize: '9999' })).toMatchObject({ mode: 'offset', pageSize: 100 });
    expect(parsePageQuery({})).toMatchObject({ mode: 'offset', page: 1, pageSize: 20, skip: 0 });
  });

  it('prefers cursor over page when both are supplied', () => {
    const encoded = encodeCursor(
      makeCursor({ snapshotAt: snapshot, direction: 'next', filters, boundary: rows(1)[0]! })
    );
    const parsed = parsePageQuery<typeof filters>({ page: '9', pageSize: '10', cursor: encoded });
    expect(parsed.mode).toBe('cursor');
    if (parsed.mode === 'cursor') {
      expect(parsed.pageSize).toBe(10);
      expect(parsed.cursor?.f).toEqual(filters);
      expect(snapshotFor(parsed.cursor).getTime()).toBe(snapshot.getTime());
    }
  });

  it('mode=cursor without a cursor token starts a fresh snapshot head page', () => {
    const parsed = parsePageQuery({ mode: 'cursor', pageSize: '50' });
    expect(parsed).toEqual({ mode: 'cursor', pageSize: 50, cursor: undefined });
  });
});

describe('assertSameFilters', () => {
  it('passes for canonical-equivalent filters and rejects divergent ones', () => {
    expect(() => assertSameFilters(filters, { ...filters })).not.toThrow();
    expect(() => assertSameFilters(filters, { ...filters, keyword: '别的' })).toThrow(AppError);
    expect(() => assertSameFilters(filters, { ...filters, keyword: '别的' })).toThrow('筛选条件已变化');
  });
});

describe('buildCursorPage', () => {
  it('head page with more rows exposes only a next cursor', () => {
    const info = buildCursorPage({
      snapshotAt: snapshot,
      direction: 'next',
      pageSize: 3,
      filters,
      rows: rows(3),
      hasMore: true,
      isHeadPage: true
    });
    expect(info.hasMore).toBe(true);
    expect(info.nextCursor).toBeTruthy();
    expect(info.prevCursor).toBeNull();
  });

  it('head last page exposes neither cursor', () => {
    const info = buildCursorPage({
      snapshotAt: snapshot,
      direction: 'next',
      pageSize: 3,
      filters,
      rows: rows(2),
      hasMore: false,
      isHeadPage: true
    });
    expect(info.nextCursor).toBeNull();
    expect(info.prevCursor).toBeNull();
  });

  it('middle page links both directions and each cursor pins the snapshot', () => {
    const info = buildCursorPage({
      snapshotAt: snapshot,
      direction: 'next',
      pageSize: 3,
      filters,
      rows: rows(3),
      hasMore: true,
      isHeadPage: false
    });
    const next = decodeCursor(info.nextCursor!);
    const prev = decodeCursor(info.prevCursor!);
    expect(next.s).toBe(snapshot.toISOString());
    expect(prev.s).toBe(snapshot.toISOString());
    expect(next.d).toBe('next');
    expect(prev.d).toBe('prev');
    expect(next.i).toBe(rows(3)[2]!.id);
    expect(prev.i).toBe(rows(3)[0]!.id);
  });

  it('prev page that reached the head drops prevCursor but still points forward', () => {
    const info = buildCursorPage({
      snapshotAt: snapshot,
      direction: 'prev',
      pageSize: 3,
      filters,
      rows: rows(2),
      hasMore: false,
      isHeadPage: false
    });
    expect(info.prevCursor).toBeNull();
    expect(info.nextCursor).toBeTruthy();
  });

  it('empty result page returns no cursors', () => {
    const info = buildCursorPage({
      snapshotAt: snapshot,
      direction: 'next',
      pageSize: 3,
      filters,
      rows: [],
      hasMore: false,
      isHeadPage: true
    });
    expect(info).toMatchObject({ hasMore: false, nextCursor: null, prevCursor: null });
  });
});
