import { AppError } from './errors.js';

// 快照 + 复合键 keyset 分页。
//
// 为什么不是 OFFSET：并发写入、软删除或索引重建会让行在结果集中漂移，
// 深翻页还要先扫描并丢弃前 N 行。keyset 用上一页最后一条不可变排序键
// (createdAt/occurredAt/updatedAt, id) 直接定位，扫描量恒为 pageSize+1，
// 不重不漏；快照时刻 s 冻结“行集合”，并发写入只影响回到第一页的结果。
//
// 游标是不透明 base64url 字符串，但内含的全部信息足以在任何时候复算：
// 过滤条件、快照时刻、方向、边界行键值。历史游标即使来自旧版本客户端
// 也能继续使用（page/pageSize 的 OFFSET 入参仍然保留）。

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export type PageDirection = 'next' | 'prev';

export interface CursorToken<F = Record<string, unknown>> {
  v: 1;
  /** 结果集快照时刻（ISO），所有页都钉在这一时刻 */
  s: string;
  /** 本游标继续翻页的方向：next=向更旧，prev=向更新 */
  d: PageDirection;
  /** 冻结在游标里的过滤条件，翻页中途不再读取 query 上的过滤参数 */
  f: F;
  /** 边界行排序列值（ISO 时间） */
  t: string;
  /** 边界行 id，复合键决胜列 */
  i: string;
}

export interface OffsetPageQuery {
  mode: 'offset';
  page: number;
  pageSize: number;
  skip: number;
}

export interface CursorHeadPageQuery {
  mode: 'cursor';
  pageSize: number;
  cursor: undefined;
}

export interface CursorNextPageQuery<F = Record<string, unknown>> {
  mode: 'cursor';
  pageSize: number;
  cursor: CursorToken<F>;
}

export type PageQuery<F = Record<string, unknown>> = OffsetPageQuery | CursorHeadPageQuery | CursorNextPageQuery<F>;

export interface KeyBoundary {
  at: Date;
  id: string;
}

function invalidCursor(): AppError {
  return new AppError(422, 'CURSOR_INVALID', '分页游标无效，请返回第一页重新开始');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asIsoDate(value: unknown): string {
  if (typeof value !== 'string') throw invalidCursor();
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw invalidCursor();
  return new Date(time).toISOString();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor<F>(token: CursorToken<F>): string {
  return Buffer.from(JSON.stringify(token), 'utf8').toString('base64url');
}

export function decodeCursor<F = Record<string, unknown>>(raw: string): CursorToken<F> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (!isRecord(parsed) || parsed.v !== 1) throw invalidCursor();
  const direction = parsed.d === 'next' || parsed.d === 'prev' ? parsed.d : null;
  if (!direction) throw invalidCursor();
  if (typeof parsed.i !== 'string' || !UUID_RE.test(parsed.i)) throw invalidCursor();
  if (!isRecord(parsed.f)) throw invalidCursor();
  return {
    v: 1,
    s: asIsoDate(parsed.s),
    d: direction,
    f: parsed.f as F,
    t: asIsoDate(parsed.t),
    i: parsed.i
  };
}

export function makeCursor<F>(input: {
  snapshotAt: Date;
  direction: PageDirection;
  filters: F;
  boundary: KeyBoundary;
}): CursorToken<F> {
  return {
    v: 1,
    s: input.snapshotAt.toISOString(),
    d: input.direction,
    f: input.filters,
    t: input.boundary.at.toISOString(),
    i: input.boundary.id
  };
}

function parsePageSize(query: Record<string, unknown>): number {
  const raw = Number(query.pageSize ?? DEFAULT_PAGE_SIZE);
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
}

/**
 * 兼容两种入参：
 * - 历史客户端：page/pageSize（OFFSET），行为与旧版完全一致；
 * - 新客户端：mode=cursor，首页不带 cursor，后续页带上一页返回的游标。
 */
export function parsePageQuery<F = Record<string, unknown>>(
  query: Record<string, unknown>
): PageQuery<F> {
  const pageSize = parsePageSize(query);
  if (query.mode === 'cursor') {
    const rawCursor = query.cursor;
    if (rawCursor === undefined || rawCursor === '') {
      return { mode: 'cursor', pageSize, cursor: undefined };
    }
    if (typeof rawCursor !== 'string') throw invalidCursor();
    return { mode: 'cursor', pageSize, cursor: decodeCursor<F>(rawCursor) };
  }
  if (query.cursor !== undefined) {
    // 旧客户端误带 cursor 时按游标处理，忽略 page
    if (typeof query.cursor !== 'string' || query.cursor === '') throw invalidCursor();
    return { mode: 'cursor', pageSize, cursor: decodeCursor<F>(query.cursor) };
  }
  const rawPage = Number(query.page ?? 1);
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  return { mode: 'offset', page, pageSize, skip: (page - 1) * pageSize };
}

/** 第一页在请求开始时取快照；后续页沿用游标内嵌的快照时刻。 */
export function snapshotFor(cursor: CursorToken | undefined): Date {
  return cursor ? new Date(cursor.s) : new Date();
}

/**
 * 游标内嵌的过滤条件必须与本次请求声明的过滤条件一致，否则同一快照会被
 * 两组谓词撕裂。直接报错让客户端回到新条件下的第一页。
 */
export function assertSameFilters<F>(current: F, frozen: F): void {
  if (JSON.stringify(current) !== JSON.stringify(frozen)) {
    throw new AppError(
      422,
      'CURSOR_FILTER_MISMATCH',
      '筛选条件已变化，请返回第一页重新开始'
    );
  }
}

export interface CursorPageInfo<F> {
  pageSize: number;
  snapshotAt: string;
  /** 请求方向上是否还有更多数据（next=更旧，prev=更新） */
  hasMore: boolean;
  nextCursor: string | null;
  prevCursor: string | null;
  /** 回传游标内冻结的过滤条件，便于调用方核对与响应调试 */
  filters: F;
}

/**
 * 由本页首/尾行键值和“多取的一行”组装分页信息。rows 必须已是最终下发
 * 顺序（desc），且长度不超过 pageSize；hasMore 表示请求方向上多取到了一行。
 */
export function buildCursorPage<F>(input: {
  snapshotAt: Date;
  direction: PageDirection;
  pageSize: number;
  filters: F;
  rows: KeyBoundary[];
  hasMore: boolean;
  isHeadPage: boolean;
}): CursorPageInfo<F> {
  const { rows, snapshotAt, pageSize, filters, direction } = input;
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) {
    return { pageSize, snapshotAt: snapshotAt.toISOString(), hasMore: false, nextCursor: null, prevCursor: null, filters };
  }

  let nextCursor: string | null = null;
  let prevCursor: string | null = null;

  if (direction === 'next') {
    // 向更旧翻页：多取到一行才存在更早的下一页
    if (input.hasMore) {
      nextCursor = encodeCursor(makeCursor({ snapshotAt, direction: 'next', filters, boundary: last }));
    }
    // 首页之外，首行之前一定有更新的内容；首页没有上一页
    if (!input.isHeadPage) {
      prevCursor = encodeCursor(makeCursor({ snapshotAt, direction: 'prev', filters, boundary: first }));
    }
  } else {
    // 向更新翻页：多取到一行才存在更新的上一页；否则已到头部
    if (input.hasMore) {
      prevCursor = encodeCursor(makeCursor({ snapshotAt, direction: 'prev', filters, boundary: first }));
    }
    // 能从更旧的位置往回翻，末行之后必然存在更旧内容（含上游标边界行）
    nextCursor = encodeCursor(makeCursor({ snapshotAt, direction: 'next', filters, boundary: last }));
  }

  return { pageSize, snapshotAt: snapshotAt.toISOString(), hasMore: input.hasMore, nextCursor, prevCursor, filters };
}
