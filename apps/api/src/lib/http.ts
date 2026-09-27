import { z } from 'zod';
import { AppError } from './errors.js';

const uuidSchema = z.string().uuid();

export function parseId(value: string, field = 'id'): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(404, 'NOT_FOUND', '资源不存在', { [field]: '资源不存在' });
  }
  return parsed.data;
}

export function optionalDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new AppError(422, 'VALIDATION_ERROR', `${field} 不是有效时间`, { [field]: '无效时间' });
  }
  return date;
}
