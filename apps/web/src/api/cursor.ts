import type { CursorPage } from '../types/domain';

// 前端只做游标透传：服务端游标已内嵌快照时刻、过滤条件与边界行键，
// 前端不需要解析它。这里只负责组装查询串与识别响应形状。

export interface CursorParams {
  pageSize?: number;
  cursor?: string | null;
  extra?: Record<string, string>;
}

export function cursorQuery(params: CursorParams): URLSearchParams {
  const search = new URLSearchParams({ mode: 'cursor' });
  if (params.pageSize !== undefined) search.set('pageSize', String(params.pageSize));
  if (params.cursor) search.set('cursor', params.cursor);
  for (const [key, value] of Object.entries(params.extra ?? {})) {
    if (value !== '') search.set(key, value);
  }
  return search;
}

export function isCursorPage<F>(
  body: { page?: CursorPage<F>; pagination?: unknown }
): body is { page: CursorPage<F> } {
  return body.page !== undefined;
}
