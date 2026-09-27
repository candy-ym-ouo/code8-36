import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { ACTIVITY_ACTIONS, ACTIVITY_ENTITY_TYPES, type ActivityAction, type ActivityEntityType } from '@paper-book-traces/shared';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { optionalDate, parseId } from '../../lib/http.js';
import { assertSameFilters, buildCursorPage, parsePageQuery } from '../../lib/cursor.js';

interface TimelineFilters {
  bookId?: string;
  action?: ActivityAction;
  entityType?: ActivityEntityType;
  from?: string;
  to?: string;
}

export const timelineRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/timeline', async (request) => {
    const query = request.query as Record<string, unknown>;
    const userId = currentUser(request).id;
    const pageQuery = parsePageQuery<TimelineFilters>(query);
    const filters = readFilters(query);

    if (pageQuery.mode === 'offset') {
      const where: Prisma.ActivityEventWhereInput = {
        userId,
        ...(filters.bookId ? { bookId: filters.bookId } : {}),
        ...(filters.action ? { action: filters.action } : {}),
        ...(filters.entityType ? { entityType: filters.entityType } : {}),
        ...(filters.from || filters.to
          ? {
              occurredAt: {
                ...(filters.from ? { gte: new Date(filters.from) } : {}),
                ...(filters.to ? { lte: new Date(filters.to) } : {})
              }
            }
          : {})
      };
      const [total, events] = await Promise.all([
        prisma.activityEvent.count({ where }),
        prisma.activityEvent.findMany({
          where,
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          skip: pageQuery.skip,
          take: pageQuery.pageSize,
          include: { book: { select: { title: true } } }
        })
      ]);
      return {
        items: events.map(serializeEvent),
        pagination: { page: pageQuery.page, pageSize: pageQuery.pageSize, total }
      };
    }

    // 快照键集分页：事件流只追加，用 occurredAt 上界冻结行集合，
    // 复合键 (occurredAt, id) 决胜，并发写入也不会让页项漂移。
    const activeFilters = pageQuery.cursor ? pageQuery.cursor.f : filters;
    if (pageQuery.cursor) assertSameFilters(filters, activeFilters);
    const direction = pageQuery.cursor?.d ?? 'next';
    const snapshotAt = pageQuery.cursor ? new Date(pageQuery.cursor.s) : new Date();

    const clauses: Prisma.ActivityEventWhereInput[] = [
      {
        userId,
        ...(activeFilters.bookId ? { bookId: activeFilters.bookId } : {}),
        ...(activeFilters.action ? { action: activeFilters.action } : {}),
        ...(activeFilters.entityType ? { entityType: activeFilters.entityType } : {})
      },
      {
        // 三个时间谓词独立求交：快照上界不能被用户的 to 覆盖，
        // 否则 to 晚于快照时刻时并发新事件会泄漏进旧快照
        AND: [
          { occurredAt: { lte: snapshotAt } },
          ...(activeFilters.from ? [{ occurredAt: { gte: new Date(activeFilters.from) } }] : []),
          ...(activeFilters.to ? [{ occurredAt: { lte: new Date(activeFilters.to) } }] : [])
        ]
      }
    ];

    if (pageQuery.cursor) {
      const boundaryAt = new Date(pageQuery.cursor.t);
      const boundaryId = pageQuery.cursor.i;
      clauses.push(
        pageQuery.cursor.d === 'next'
          ? {
              OR: [
                { occurredAt: { lt: boundaryAt } },
                { occurredAt: boundaryAt, id: { lt: boundaryId } }
              ]
            }
          : {
              OR: [
                { occurredAt: { gt: boundaryAt } },
                { occurredAt: boundaryAt, id: { gt: boundaryId } }
              ]
            }
      );
    }

    const found = await prisma.activityEvent.findMany({
      where: { AND: clauses },
      orderBy:
        direction === 'next'
          ? [{ occurredAt: 'desc' }, { id: 'desc' }]
          : [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: pageQuery.pageSize + 1,
      include: { book: { select: { title: true } } }
    });

    const hasMore = found.length > pageQuery.pageSize;
    const events = found.slice(0, pageQuery.pageSize);
    if (direction === 'prev') events.reverse();

    const page = buildCursorPage({
      snapshotAt,
      direction,
      pageSize: pageQuery.pageSize,
      filters: activeFilters,
      rows: events.map((event) => ({ at: event.occurredAt, id: event.id })),
      hasMore,
      isHeadPage: !pageQuery.cursor
    });

    return { items: events.map(serializeEvent), page };
  });
};

function readFilters(query: Record<string, unknown>): TimelineFilters {
  const bookId = typeof query.bookId === 'string' && query.bookId ? parseId(query.bookId, 'bookId') : undefined;
  const action = typeof query.eventType === 'string' && query.eventType !== 'ALL' ? query.eventType : undefined;
  const entityType =
    typeof query.entityType === 'string' && query.entityType !== 'ALL' ? query.entityType : undefined;
  const from = optionalDate(query.from, 'from');
  const to = optionalDate(query.to, 'to');

  if (action && !ACTIVITY_ACTIONS.includes(action as ActivityAction)) {
    throw new AppError(422, 'VALIDATION_ERROR', '事件类型无效');
  }
  if (entityType && !ACTIVITY_ENTITY_TYPES.includes(entityType as ActivityEntityType)) {
    throw new AppError(422, 'VALIDATION_ERROR', '对象类型无效');
  }

  // 固定键顺序构造，游标内外用同一函数产出可比较的过滤快照
  const filters: TimelineFilters = {};
  if (bookId) filters.bookId = bookId;
  if (action) filters.action = action as ActivityAction;
  if (entityType) filters.entityType = entityType as ActivityEntityType;
  if (from) filters.from = from.toISOString();
  if (to) filters.to = to.toISOString();
  return filters;
}

function serializeEvent(event: {
  id: string;
  bookId: string | null;
  book?: { title: string } | null;
  entityType: ActivityEntityType;
  entityId: string | null;
  action: ActivityAction;
  payloadJson: Prisma.JsonValue;
  occurredAt: Date;
}) {
  return {
    id: event.id,
    bookId: event.bookId,
    bookTitle: event.book?.title ?? '已删除书目',
    entityType: event.entityType,
    entityId: event.entityId,
    action: event.action,
    payload: event.payloadJson,
    occurredAt: event.occurredAt
  };
}
