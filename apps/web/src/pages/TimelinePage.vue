<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError } from '../api/client';
import { cursorQuery } from '../api/cursor';
import { booksApi, timelineApi } from '../api';
import { formatDateTime } from '../api/format';
import ErrorNotice from '../components/ErrorNotice.vue';
import {
  ACTION_LABELS,
  ENTITY_LABELS,
  MOOD_LABELS,
  type ActivityAction,
  type ActivityEntityType,
  type Book,
  type CursorPage,
  type MoodTag,
  type TimelineEvent
} from '../types/domain';

interface TimelineFilters {
  bookId?: string;
  action?: ActivityAction;
  entityType?: ActivityEntityType;
  from?: string;
  to?: string;
}

const events = ref<TimelineEvent[]>([]);
const books = ref<Book[]>([]);
const loading = ref(true);
const error = ref('');
const bookId = ref('');
const action = ref<'ALL' | ActivityAction>('ALL');
const entityType = ref<'ALL' | ActivityEntityType>('ALL');
const from = ref('');
const to = ref('');
const pageSize = 30;
const pageInfo = ref<CursorPage<TimelineFilters> | null>(null);

function extraParams(): Record<string, string> {
  const params: Record<string, string> = {};
  if (bookId.value) params.bookId = bookId.value;
  if (action.value !== 'ALL') params.eventType = action.value;
  if (entityType.value !== 'ALL') params.entityType = entityType.value;
  if (from.value) params.from = new Date(`${from.value}T00:00:00`).toISOString();
  if (to.value) params.to = new Date(`${to.value}T23:59:59.999`).toISOString();
  return params;
}

async function loadHead(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await timelineApi.list(cursorQuery({ pageSize, extra: extraParams() }));
    if ('page' in result) {
      events.value = result.items;
      pageInfo.value = result.page;
    }
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '时间线加载失败';
  } finally {
    loading.value = false;
  }
}

async function loadCursor(cursor: string | null): Promise<void> {
  if (!cursor) return;
  loading.value = true;
  error.value = '';
  try {
    // 游标已冻结过滤条件，只透传 pageSize 与游标，避免快照被新谓词撕裂
    const result = await timelineApi.list(cursorQuery({ pageSize, cursor }));
    if ('page' in result) {
      events.value = result.items;
      pageInfo.value = result.page;
    }
  } catch (caught) {
    if (caught instanceof ApiError && (caught.code === 'CURSOR_INVALID' || caught.code === 'CURSOR_FILTER_MISMATCH')) {
      await loadHead();
      return;
    }
    error.value = caught instanceof ApiError ? caught.message : '时间线加载失败';
  } finally {
    loading.value = false;
  }
}

async function loadBooks(): Promise<void> {
  try {
    const result = await booksApi.list(cursorQuery({ pageSize: 100 }));
    if ('items' in result) books.value = result.items;
  } catch {
    books.value = [];
  }
}

function filter(): void {
  void loadHead();
}

const snapshotLabel = computed(() =>
  pageInfo.value ? `本页快照：${formatDateTime(pageInfo.value.snapshotAt)}（翻页期间新变化不会扰动当前列表）` : ''
);

function summary(event: TimelineEvent): string {
  const payload = event.payload;
  if (typeof payload.pageNumber === 'number') return `第 ${payload.pageNumber} 页`;
  if (typeof payload.startPage === 'number') {
    return `第 ${payload.startPage}–${typeof payload.endPage === 'number' ? payload.endPage : payload.startPage} 页`;
  }
  if (Array.isArray(payload.moodTags)) {
    return payload.moodTags.map((tag) => MOOD_LABELS[tag as MoodTag] ?? tag).join('、');
  }
  if (typeof payload.previousStatus === 'string' && typeof payload.nextStatus === 'string') {
    return `${payload.previousStatus} → ${payload.nextStatus}`;
  }
  if (typeof payload.summary === 'string') return payload.summary;
  return '';
}

onMounted(async () => {
  await Promise.all([loadBooks(), loadHead()]);
});
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <p class="eyebrow">TIME, NOT SPEED</p>
        <h1>时间线</h1>
        <p>不是阅读进度，而是这些书在什么时刻发生过变化。</p>
      </div>
    </header>

    <form class="card filter-grid" @submit.prevent="filter">
      <label>
        书目
        <select v-model="bookId">
          <option value="">全部书目</option>
          <option v-for="book in books" :key="book.id" :value="book.id">{{ book.title }}</option>
        </select>
      </label>
      <label>
        动作
        <select v-model="action">
          <option value="ALL">全部</option>
          <option v-for="(label, value) in ACTION_LABELS" :key="value" :value="value">{{ label }}</option>
        </select>
      </label>
      <label>
        对象
        <select v-model="entityType">
          <option value="ALL">全部</option>
          <option v-for="(label, value) in ENTITY_LABELS" :key="value" :value="value">{{ label }}</option>
        </select>
      </label>
      <label>开始日期<input v-model="from" type="date" /></label>
      <label>结束日期<input v-model="to" type="date" /></label>
      <button class="button button-primary" type="submit">筛选</button>
    </form>

    <ErrorNotice :message="error" />
    <div v-if="loading" class="state-panel">正在整理时间线…</div>
    <div v-else-if="events.length === 0" class="empty-state card">
      <h2>这个范围内还没有变化</h2>
      <p>创建书目或留下第一处阅读痕迹后，时间会从这里开始。</p>
    </div>
    <template v-else>
      <p v-if="snapshotLabel" class="muted snapshot-hint">{{ snapshotLabel }}</p>
      <div class="timeline-page-list">
        <article v-for="event in events" :key="event.id" class="timeline-item card">
          <span class="timeline-dot" aria-hidden="true" />
          <div class="timeline-content">
            <div class="timeline-heading">
              <strong>{{ ACTION_LABELS[event.action] }} · {{ ENTITY_LABELS[event.entityType] }}</strong>
              <time :datetime="event.occurredAt">{{ formatDateTime(event.occurredAt) }}</time>
            </div>
            <p>
              <RouterLink v-if="event.bookId" :to="`/books/${event.bookId}`">{{ event.bookTitle }}</RouterLink>
              <span v-else>{{ event.bookTitle }}</span>
              <span v-if="summary(event)"> · {{ summary(event) }}</span>
            </p>
          </div>
        </article>
      </div>

      <nav v-if="pageInfo && (pageInfo.prevCursor || pageInfo.nextCursor)" class="pagination" aria-label="时间线分页">
        <button
          class="button button-quiet"
          :disabled="!pageInfo.prevCursor"
          @click="loadCursor(pageInfo?.prevCursor ?? null)"
        >
          上一页
        </button>
        <button class="button button-quiet" type="button" @click="filter">回到最新</button>
        <button
          class="button button-quiet"
          :disabled="!pageInfo.nextCursor"
          @click="loadCursor(pageInfo?.nextCursor ?? null)"
        >
          下一页
        </button>
      </nav>
    </template>
  </section>
</template>
