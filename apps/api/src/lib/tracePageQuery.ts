import type { TraceType } from '@paper-book-traces/shared';
import type { TimeIdKey } from './pagination.js';

/**
 * 三类痕迹（折角/批注/重读页）合并分页的 SQL 构建器。
 *
 * 三表 UNION ALL 后按 (created_at DESC, id DESC) 全序排列：
 * - 游标模式：每个分支下推 (created_at, id) < (?, ?) keyset 条件，LIMIT pageSize+1，
 *   内存与延迟都只与页大小相关，与痕迹总量无关；
 * - 历史 page 模式：同一全序上的 LIMIT/OFFSET，响应结构与旧版一致；
 * - 所有动态值都走位置参数，构建器是纯函数，相同输入必然得到相同 SQL 与参数（可复算）。
 */
export interface TracePageFilters {
  userId: string;
  bookId: string;
  types: readonly TraceType[];
  pageNumber?: number;
  keyword?: string;
  from?: Date;
  to?: Date;
}

export interface TracePageQuery extends TracePageFilters {
  limit: number;
  cursor?: TimeIdKey | null;
  offset?: number;
}

export interface BuiltQuery {
  text: string;
  values: unknown[];
}

interface ParamIndex {
  userId: number;
  bookId: number;
  pageNumber?: number;
  keyword?: number;
  from?: number;
  to?: number;
  cursorAt?: number;
  cursorId?: number;
  limit?: number;
  offset?: number;
}

function collectParams(query: TracePageQuery, forCount: boolean): { values: unknown[]; idx: ParamIndex } {
  const values: unknown[] = [query.userId, query.bookId];
  const idx: ParamIndex = { userId: 1, bookId: 2 };
  if (query.pageNumber !== undefined) {
    values.push(query.pageNumber);
    idx.pageNumber = values.length;
  }
  if (query.keyword) {
    values.push(query.keyword);
    idx.keyword = values.length;
  }
  if (query.from) {
    values.push(query.from.toISOString());
    idx.from = values.length;
  }
  if (query.to) {
    values.push(query.to.toISOString());
    idx.to = values.length;
  }
  if (!forCount && query.cursor) {
    values.push(query.cursor.at.toISOString(), query.cursor.id);
    idx.cursorAt = values.length - 1;
    idx.cursorId = values.length;
  }
  if (!forCount) {
    values.push(query.limit);
    idx.limit = values.length;
    if (query.offset !== undefined) {
      values.push(query.offset);
      idx.offset = values.length;
    }
  }
  return { values, idx };
}

const TRACE_TABLE: Record<TraceType, string> = {
  DOG_EAR: 'dog_ears',
  ANNOTATION: 'annotations',
  REREAD_MARK: 'reread_marks'
};

function branchWhere(type: TraceType, idx: ParamIndex): string {
  const clauses = [
    `user_id = $${idx.userId}::uuid`,
    `book_id = $${idx.bookId}::uuid`,
    'deleted_at IS NULL'
  ];
  if (idx.pageNumber !== undefined) {
    if (type === 'ANNOTATION') {
      clauses.push(`start_page <= $${idx.pageNumber}::integer`, `end_page >= $${idx.pageNumber}::integer`);
    } else {
      clauses.push(`page_number = $${idx.pageNumber}::integer`);
    }
  }
  if (idx.keyword !== undefined) {
    const column = type === 'ANNOTATION' ? 'content' : 'reason';
    clauses.push(`${column} ILIKE '%' || $${idx.keyword}::text || '%'`);
  }
  if (idx.from !== undefined) clauses.push(`created_at >= $${idx.from}::timestamptz`);
  if (idx.to !== undefined) clauses.push(`created_at <= $${idx.to}::timestamptz`);
  if (idx.cursorAt !== undefined && idx.cursorId !== undefined) {
    clauses.push(`(created_at, id) < ($${idx.cursorAt}::timestamptz, $${idx.cursorId}::uuid)`);
  }
  return clauses.join(' AND ');
}

function branchSelect(type: TraceType, idx: ParamIndex, columnsOnly: boolean): string {
  const selectList = columnsOnly
    ? 'id'
    : type === 'ANNOTATION'
      ? `'ANNOTATION'::text AS type, id, book_id, version, NULL::integer AS page_number, start_page, end_page, NULL::text AS reason, content, created_at, updated_at`
      : `'${type}'::text AS type, id, book_id, version, page_number, NULL::integer AS start_page, NULL::integer AS end_page, reason, NULL::text AS content, created_at, updated_at`;
  return `SELECT ${selectList} FROM ${TRACE_TABLE[type]} WHERE ${branchWhere(type, idx)}`;
}

export function buildTracePageQuery(query: TracePageQuery): BuiltQuery {
  const { values, idx } = collectParams(query, false);
  const union = query.types.map((type) => branchSelect(type, idx, false)).join('\nUNION ALL\n');
  const offset = idx.offset !== undefined ? `\nOFFSET $${idx.offset}::integer` : '';
  const text =
    `SELECT u.type, u.id, u.book_id, u.version, u.page_number, u.start_page, u.end_page, u.reason, u.content, u.created_at, u.updated_at\n` +
    `FROM (\n${union}\n) AS u\n` +
    `ORDER BY u.created_at DESC, u.id DESC\n` +
    `LIMIT $${idx.limit}::integer${offset}`;
  return { text, values };
}

export function buildTraceCountQuery(filters: TracePageFilters): BuiltQuery {
  const { values, idx } = collectParams({ ...filters, limit: 0 }, true);
  const union = filters.types.map((type) => branchSelect(type, idx, true)).join('\nUNION ALL\n');
  const text = `SELECT COUNT(*)::integer AS total\nFROM (\n${union}\n) AS u`;
  return { text, values };
}

export interface TraceRow {
  type: TraceType;
  id: string;
  book_id: string;
  version: number;
  page_number: number | null;
  start_page: number | null;
  end_page: number | null;
  reason: string | null;
  content: string | null;
  created_at: Date;
  updated_at: Date;
}
