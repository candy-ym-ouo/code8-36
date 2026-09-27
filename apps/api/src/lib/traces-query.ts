import { Prisma } from '@prisma/client';
import type { TraceType } from '@paper-book-traces/shared';
import { prisma } from './prisma.js';
import type { PageDirection } from './cursor.js';

// GET /books/:bookId/traces 的列表查询。
//
// 旧实现把三张痕迹表整体 findMany 到应用内存再合并、排序、切片，
// 痕迹量大时内存与延迟同时失控。这里改为查询 book_trace_rows 统一视图：
// 每个 UNION 分支各自按索引只取 pageSize+1 行，数据库内合并，
// 应用层最多处理 3*(pageSize+1) 行；快照时刻冻结软删除行集合，
// (created_at, id) 复合键定位，索引重建或并发写入都不会产生页项漂移。

export interface TraceListFilters {
  userId: string;
  bookId: string;
  type?: TraceType;
  pageNumber?: number;
  keyword?: string;
  from?: string;
  to?: string;
}

export interface TraceRow {
  id: string;
  userId: string;
  bookId: string;
  version: number;
  pageNumber: number | null;
  startPage: number | null;
  endPage: number | null;
  content: string | null;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  traceType: TraceType;
}

type Sql = Prisma.Sql;

function escapeLike(value: string): string {
  // 与 ILIKE ... ESCAPE '\' 配合，先转义反斜杠本身
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function filterSql(filters: TraceListFilters, snapshotAt: Date): Sql[] {
  const where: Sql[] = [
    Prisma.sql`user_id = ${filters.userId}::uuid`,
    Prisma.sql`book_id = ${filters.bookId}::uuid`,
    // 快照可见性：创建于快照之前，且在快照时刻仍未删除
    Prisma.sql`created_at <= ${snapshotAt}::timestamptz`,
    Prisma.sql`(deleted_at IS NULL OR deleted_at > ${snapshotAt}::timestamptz)`
  ];
  if (filters.type) where.push(Prisma.sql`trace_type = ${filters.type}`);
  if (filters.pageNumber !== undefined) {
    where.push(
      Prisma.sql`(
        (trace_type IN ('DOG_EAR', 'REREAD_MARK') AND page_number = ${filters.pageNumber})
        OR (trace_type = 'ANNOTATION' AND start_page <= ${filters.pageNumber} AND end_page >= ${filters.pageNumber})
      )`
    );
  }
  if (filters.keyword) {
    const like = `%${escapeLike(filters.keyword)}%`;
    where.push(
      Prisma.sql`(
        (trace_type = 'ANNOTATION' AND content ILIKE ${like} ESCAPE '\\')
        OR (trace_type <> 'ANNOTATION' AND reason ILIKE ${like} ESCAPE '\\')
      )`
    );
  }
  if (filters.from) where.push(Prisma.sql`created_at >= ${filters.from}::timestamptz`);
  if (filters.to) where.push(Prisma.sql`created_at <= ${filters.to}::timestamptz`);
  return where;
}

async function countTraceRows(filters: TraceListFilters, snapshotAt: Date): Promise<number> {
  const where = Prisma.join(filterSql(filters, snapshotAt), " AND ");
  const result = await prisma.$queryRaw<Array<{ total: bigint }>>(
    Prisma.sql`SELECT count(*)::bigint AS total FROM book_trace_rows WHERE ${where}`
  );
  return Number(result[0]?.total ?? 0);
}

export async function countTracesLegacy(filters: TraceListFilters): Promise<number> {
  // 旧版 OFFSET 模式不引入快照，保持与历史响应一致
  return countTraceRows(filters, new Date('9999-12-31T00:00:00Z'));
}

interface TracePageArgs {
  filters: TraceListFilters;
  pageSize: number;
  snapshotAt: Date;
  direction: PageDirection;
  boundary?: { at: Date; id: string } | undefined;
}

/**
 * 每个分支各取 pageSize+1，外层合并归并后再取 pageSize+1，
 * 保证扫描量与单表行数无关。
 */
export async function findTracePage(args: TracePageArgs): Promise<TraceRow[]> {
  const { filters, pageSize, snapshotAt, direction, boundary } = args;
  const perBranch = pageSize + 1;

  const typeClauses: Sql[] = [];
  const allTypes: TraceType[] = ['DOG_EAR', 'ANNOTATION', 'REREAD_MARK'];
  for (const type of filters.type ? [filters.type] : allTypes) {
    const branchWhere = filterSql({ ...filters, type }, snapshotAt);
    if (boundary) {
      const boundAt = Prisma.sql`${boundary.at.toISOString()}::timestamptz`;
      const boundId = Prisma.sql`${boundary.id}::uuid`;
      const comparator =
        direction === 'next'
          ? Prisma.sql`(created_at < ${boundAt} OR (created_at = ${boundAt} AND id < ${boundId}))`
          : Prisma.sql`(created_at > ${boundAt} OR (created_at = ${boundAt} AND id > ${boundId}))`;
      branchWhere.push(comparator);
    }
    const branchOrder =
      direction === 'next'
        ? Prisma.sql`created_at DESC, id DESC`
        : Prisma.sql`created_at ASC, id ASC`;
    typeClauses.push(
      Prisma.sql`(SELECT * FROM book_trace_rows WHERE ${Prisma.join(branchWhere, ' AND ')}
                 ORDER BY ${branchOrder} LIMIT ${perBranch})`
    );
  }

  const union = Prisma.join(typeClauses, ' UNION ALL ');
  const mergeOrder =
    direction === 'next'
      ? Prisma.sql`created_at DESC, id DESC`
      : Prisma.sql`created_at ASC, id ASC`;
  const rows = await prisma.$queryRaw<RawTraceRow[]>(
    Prisma.sql`SELECT * FROM (${union}) AS branch
               ORDER BY ${mergeOrder}
               LIMIT ${perBranch}`
  );
  return rows.map(mapTraceRow);
}

export async function findTracesOffset(
  filters: TraceListFilters,
  page: number,
  pageSize: number
): Promise<TraceRow[]> {
  const where = Prisma.join(filterSql(filters, new Date('9999-12-31T00:00:00Z')), " AND ");
  const rows = await prisma.$queryRaw<RawTraceRow[]>(
    Prisma.sql`SELECT * FROM book_trace_rows
               WHERE ${where}
               ORDER BY created_at DESC, id DESC
               LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`
  );
  return rows.map(mapTraceRow);
}

interface RawTraceRow {
  id: string;
  user_id: string;
  book_id: string;
  version: number;
  page_number: number | null;
  start_page: number | null;
  end_page: number | null;
  content: string | null;
  reason: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  trace_type: TraceType;
}

function mapTraceRow(row: RawTraceRow): TraceRow {
  return {
    id: row.id,
    userId: row.user_id,
    bookId: row.book_id,
    version: Number(row.version),
    pageNumber: row.page_number,
    startPage: row.start_page,
    endPage: row.end_page,
    content: row.content,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    traceType: row.trace_type
  };
}
