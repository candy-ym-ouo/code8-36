-- 超大痕迹量下的稳定分页：
-- 1. 列表索引与 keyset 排序键 (sort_col DESC, id DESC) 对齐，避免 OFFSET 深翻页；
-- 2. 新增只读 UNION 视图，把三类痕迹统一成一组列，分页时每分支只取 limit+1 行，
--    不再把整张表装入应用内存。

-- 时间线：排序键为 (occurred_at DESC, id DESC)
DROP INDEX IF EXISTS "activity_events_user_id_occurred_at_idx";
CREATE INDEX "activity_events_user_id_occurred_at_id_idx"
  ON "activity_events" ("user_id", "occurred_at" DESC, "id" DESC);

DROP INDEX IF EXISTS "activity_events_user_id_book_id_occurred_at_idx";
CREATE INDEX "activity_events_user_id_book_id_occurred_at_id_idx"
  ON "activity_events" ("user_id", "book_id", "occurred_at" DESC, "id" DESC);

DROP INDEX IF EXISTS "activity_events_user_id_entity_type_occurred_at_idx";
CREATE INDEX "activity_events_user_id_entity_type_occurred_at_id_idx"
  ON "activity_events" ("user_id", "entity_type", "occurred_at" DESC, "id" DESC);

-- 痕迹列表始终按 (created_at DESC, id DESC) keyset 翻页，且限定在某本书内
DROP INDEX IF EXISTS "dog_ears_user_id_deleted_at_created_at_idx";
CREATE INDEX "dog_ears_user_id_book_id_created_at_id_idx"
  ON "dog_ears" ("user_id", "book_id", "created_at" DESC, "id" DESC);

DROP INDEX IF EXISTS "annotations_user_id_deleted_at_created_at_idx";
CREATE INDEX "annotations_user_id_book_id_created_at_id_idx"
  ON "annotations" ("user_id", "book_id", "created_at" DESC, "id" DESC);

DROP INDEX IF EXISTS "reread_marks_user_id_deleted_at_created_at_idx";
CREATE INDEX "reread_marks_user_id_book_id_created_at_id_idx"
  ON "reread_marks" ("user_id", "book_id", "created_at" DESC, "id" DESC);

-- 书目列表的 keyset 排序键为 (updated_at DESC, id DESC)
CREATE INDEX "books_user_id_updated_at_id_idx"
  ON "books" ("user_id", "updated_at" DESC, "id" DESC);

-- 三类痕迹的统一行形状，供服务端单条 SQL 合并、过滤与分页。
-- 视图不做任何快照过滤；deleted_at 是否可见由查询语句按快照时刻决定，
-- 这样同一条历史游标在索引重建或并发软删除后仍能复算出相同结果。
CREATE VIEW "book_trace_rows" AS
SELECT
  "id",
  "user_id",
  "book_id",
  "version",
  "page_number",
  NULL::INTEGER AS "start_page",
  NULL::INTEGER AS "end_page",
  NULL::TEXT AS "content",
  "reason"::TEXT AS "reason",
  "created_at",
  "updated_at",
  "deleted_at",
  'DOG_EAR'::TEXT AS "trace_type"
FROM "dog_ears"
UNION ALL
SELECT
  "id",
  "user_id",
  "book_id",
  "version",
  NULL::INTEGER AS "page_number",
  "start_page",
  "end_page",
  "content",
  NULL::TEXT AS "reason",
  "created_at",
  "updated_at",
  "deleted_at",
  'ANNOTATION'::TEXT AS "trace_type"
FROM "annotations"
UNION ALL
SELECT
  "id",
  "user_id",
  "book_id",
  "version",
  "page_number",
  NULL::INTEGER AS "start_page",
  NULL::INTEGER AS "end_page",
  NULL::TEXT AS "content",
  "reason"::TEXT AS "reason",
  "created_at",
  "updated_at",
  "deleted_at",
  'REREAD_MARK'::TEXT AS "trace_type"
FROM "reread_marks";
