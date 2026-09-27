-- 分页全序索引：支撑 (created_at, id) / (occurred_at, id) 的 keyset 翻页，
-- 让每页都是索引范围扫描，物理存储顺序变化（如索引重建）不影响逻辑顺序。

CREATE INDEX IF NOT EXISTS "dog_ears_active_user_book_created_id_idx"
  ON "dog_ears" ("user_id", "book_id", "created_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "annotations_active_user_book_created_id_idx"
  ON "annotations" ("user_id", "book_id", "created_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "reread_marks_active_user_book_created_id_idx"
  ON "reread_marks" ("user_id", "book_id", "created_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "activity_events_user_occurred_id_idx"
  ON "activity_events" ("user_id", "occurred_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "activity_events_user_book_occurred_id_idx"
  ON "activity_events" ("user_id", "book_id", "occurred_at" DESC, "id" DESC);
