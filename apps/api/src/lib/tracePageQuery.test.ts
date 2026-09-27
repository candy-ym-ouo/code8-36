import { describe, expect, it } from 'vitest';
import { TRACE_TYPES } from '@paper-book-traces/shared';
import { buildTraceCountQuery, buildTracePageQuery, type TracePageQuery } from './tracePageQuery.js';

const BASE: TracePageQuery = {
  userId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  bookId: '1f8fad5b-d9cb-469f-a165-70867728950e',
  types: TRACE_TYPES,
  limit: 21
};

function expectParamsAligned(text: string, values: unknown[]): void {
  const used = [...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  expect(Math.max(...used)).toBe(values.length);
  expect(new Set(used).size).toBe(values.length);
}

describe('trace page query builder', () => {
  it('pushes the keyset condition into every union branch', () => {
    const cursor = { at: new Date('2026-09-24T12:00:00.000Z'), id: BASE.userId };
    const { text, values } = buildTracePageQuery({ ...BASE, cursor });
    expect(text.match(/\(created_at, id\) < /g)).toHaveLength(3);
    expect(text).toContain('ORDER BY u.created_at DESC, u.id DESC');
    expect(text).toContain('LIMIT $5::integer');
    expect(text).not.toContain('OFFSET');
    expect(values).toEqual([BASE.userId, BASE.bookId, cursor.at.toISOString(), cursor.id, 21]);
    expectParamsAligned(text, values);
  });

  it('keeps the legacy offset mode on the same deterministic total order', () => {
    const { text, values } = buildTracePageQuery({ ...BASE, limit: 20, offset: 40 });
    expect(text).not.toContain('(created_at, id) <');
    expect(text).toContain('ORDER BY u.created_at DESC, u.id DESC');
    expect(text).toContain('LIMIT $3::integer');
    expect(text).toContain('OFFSET $4::integer');
    expect(values).toEqual([BASE.userId, BASE.bookId, 20, 40]);
    expectParamsAligned(text, values);
  });

  it('drops union branches excluded by the type filter', () => {
    const { text } = buildTracePageQuery({ ...BASE, types: ['ANNOTATION'] });
    expect(text).toContain('FROM annotations');
    expect(text).not.toContain('FROM dog_ears');
    expect(text).not.toContain('FROM reread_marks');
    expect(text).not.toContain('UNION ALL');
  });

  it('applies page, keyword and date filters per branch with shared params', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-02-01T00:00:00.000Z');
    const { text, values } = buildTracePageQuery({
      ...BASE,
      pageNumber: 42,
      keyword: '批注',
      from,
      to,
      cursor: { at: to, id: BASE.userId }
    });
    expect(text.match(/page_number = \$3::integer/g)).toHaveLength(2);
    expect(text).toContain('start_page <= $3::integer AND end_page >= $3::integer');
    expect(text.match(/reason ILIKE '%' \|\| \$4::text \|\| '%'/g)).toHaveLength(2);
    expect(text).toContain(`content ILIKE '%' || $4::text || '%'`);
    expect(text.match(/created_at >= \$5::timestamptz/g)).toHaveLength(3);
    expect(text.match(/created_at <= \$6::timestamptz/g)).toHaveLength(3);
    expect(values).toEqual([
      BASE.userId,
      BASE.bookId,
      42,
      '批注',
      from.toISOString(),
      to.toISOString(),
      to.toISOString(),
      BASE.userId,
      21
    ]);
    expectParamsAligned(text, values);
  });

  it('is deterministic so any page can be recomputed from the same input', () => {
    const query: TracePageQuery = {
      ...BASE,
      keyword: 'x',
      cursor: { at: new Date('2026-09-24T12:00:00.000Z'), id: BASE.bookId }
    };
    expect(buildTracePageQuery(query)).toEqual(buildTracePageQuery(query));
  });

  it('builds a count query without cursor or limit params', () => {
    const { text, values } = buildTraceCountQuery({ ...BASE, keyword: 'x' });
    expect(text).toContain('COUNT(*)::integer AS total');
    expect(text).not.toContain('LIMIT');
    expect(text).not.toContain('(created_at, id) <');
    expect(values).toEqual([BASE.userId, BASE.bookId, 'x']);
    expectParamsAligned(text, values);
  });
});
