import { z } from 'zod';
import { AppError } from './errors.js';

/**
 * 版本化 keyset 游标。
 *
 * v1 载荷：{ v: 1, at: ISO-8601 时间戳, id: uuid }，base64url 编码。
 * 编码是确定性的：同一逻辑位置总是得到同一字符串，因此任何一页都可以
 * 由游标重新计算（可复算），且与底层物理存储顺序（如索引重建）无关。
 */
export const CURSOR_VERSION = 1;

const MAX_CURSOR_LENGTH = 512;

const cursorPayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  at: z.string().datetime({ offset: true }),
  id: z.string().uuid()
});

export interface TimeIdKey {
  at: Date;
  id: string;
}

export function encodeTimeIdCursor(key: TimeIdKey): string {
  const payload = { v: CURSOR_VERSION, at: key.at.toISOString(), id: key.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function invalidCursor(): AppError {
  return new AppError(422, 'INVALID_CURSOR', '分页游标无效，请从第一页重新加载', {
    cursor: '游标无效或已过期'
  });
}

/**
 * 解码游标。空值（undefined/null/''）表示从头开始，返回 null；
 * 其他非法输入一律抛出 422，而不是静默回到第一页（避免页项漂移被掩盖）。
 */
export function decodeTimeIdCursor(raw: unknown): TimeIdKey | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > MAX_CURSOR_LENGTH) throw invalidCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const result = cursorPayloadSchema.safeParse(parsed);
  if (!result.success) throw invalidCursor();
  const at = new Date(result.data.at);
  if (Number.isNaN(at.getTime())) throw invalidCursor();
  return { at, id: result.data.id };
}
