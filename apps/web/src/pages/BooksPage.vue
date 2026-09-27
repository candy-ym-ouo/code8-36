<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ApiError } from '../api/client';
import { cursorQuery } from '../api/cursor';
import { booksApi } from '../api';
import { formatDateTime } from '../api/format';
import ErrorNotice from '../components/ErrorNotice.vue';
import { STATUS_LABELS, type Book, type BookStatus, type CursorPage } from '../types/domain';

interface BookFilters {
  status?: BookStatus;
  search?: string;
}

const books = ref<Book[]>([]);
const loading = ref(true);
const error = ref('');
const search = ref('');
const status = ref<'ALL' | BookStatus>('ALL');
const pageSize = 12;
const pageInfo = ref<CursorPage<BookFilters> | null>(null);

function extraParams(): Record<string, string> {
  const params: Record<string, string> = {};
  if (search.value.trim()) params.search = search.value.trim();
  if (status.value !== 'ALL') params.status = status.value;
  return params;
}

async function loadHead(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await booksApi.list(cursorQuery({ pageSize, extra: extraParams() }));
    if ('page' in result) {
      books.value = result.items;
      pageInfo.value = result.page;
    }
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '书目加载失败';
  } finally {
    loading.value = false;
  }
}

async function loadCursor(cursor: string | null): Promise<void> {
  if (!cursor) return;
  loading.value = true;
  error.value = '';
  try {
    const result = await booksApi.list(cursorQuery({ pageSize, cursor }));
    if ('page' in result) {
      books.value = result.items;
      pageInfo.value = result.page;
    }
  } catch (caught) {
    if (caught instanceof ApiError && (caught.code === 'CURSOR_INVALID' || caught.code === 'CURSOR_FILTER_MISMATCH')) {
      await loadHead();
      return;
    }
    error.value = caught instanceof ApiError ? caught.message : '书目加载失败';
  } finally {
    loading.value = false;
  }
}

function submitSearch(): void {
  void loadHead();
}

onMounted(loadHead);
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <p class="eyebrow">MY PAPER BOOKS</p>
        <h1>我的书</h1>
        <p>只记录书与你之间发生过什么。</p>
      </div>
      <RouterLink class="button button-primary" to="/books/new">添加书</RouterLink>
    </header>

    <form class="toolbar card" @submit.prevent="submitSearch">
      <label class="grow">
        搜索
        <input v-model="search" type="search" placeholder="书名或作者" />
      </label>
      <label>
        状态
        <select v-model="status" @change="submitSearch">
          <option value="ALL">全部</option>
          <option v-for="(label, value) in STATUS_LABELS" :key="value" :value="value">{{ label }}</option>
        </select>
      </label>
      <button class="button" type="submit">筛选</button>
    </form>

    <ErrorNotice :message="error" />

    <div v-if="loading" class="state-panel">正在翻阅你的书目…</div>
    <div v-else-if="books.length === 0" class="empty-state card">
      <span class="empty-mark">页</span>
      <h2>还没有记录一本纸质书</h2>
      <p>添加一本真实拥有的书，然后从某一页的折角或批注开始。</p>
      <RouterLink class="button button-primary" to="/books/new">添加第一本书</RouterLink>
    </div>
    <div v-else>
      <div class="book-grid">
        <article v-for="book in books" :key="book.id" class="book-card card">
          <div class="book-card-top">
            <img
              v-if="book.coverUrl"
              class="book-cover"
              :src="book.coverUrl"
              :alt="`${book.title} 封面`"
              loading="lazy"
              referrerpolicy="no-referrer"
            />
            <div v-else class="book-cover book-cover-placeholder" aria-hidden="true">
              {{ book.title.slice(0, 1) }}
            </div>
            <div>
              <span class="status-badge" :data-status="book.status">{{ STATUS_LABELS[book.status] }}</span>
              <h2><RouterLink :to="`/books/${book.id}`">{{ book.title }}</RouterLink></h2>
              <p class="muted">{{ book.author || '作者未填写' }}</p>
            </div>
          </div>
          <p v-if="book.lastTraceAt" class="book-last-trace">
            最近留下痕迹：{{ formatDateTime(book.lastTraceAt) }}
          </p>
          <p v-else class="muted">还没有留下阅读痕迹</p>
          <dl class="trace-summary" aria-label="痕迹数量">
            <div><dt>折角</dt><dd>{{ book.traceSummary.dogEars }}</dd></div>
            <div><dt>批注</dt><dd>{{ book.traceSummary.annotations }}</dd></div>
            <div><dt>重读页</dt><dd>{{ book.traceSummary.rereadMarks }}</dd></div>
          </dl>
          <p v-if="book.hasCompletionReflection" class="completion-hint">
            已留下读完后的感受
          </p>
          <RouterLink class="button button-block" :to="`/books/${book.id}`">查看这本书</RouterLink>
        </article>
      </div>

      <nav
        v-if="pageInfo && (pageInfo.prevCursor || pageInfo.nextCursor)"
        class="pagination"
        aria-label="书目分页"
      >
        <button
          class="button button-quiet"
          :disabled="!pageInfo.prevCursor"
          @click="loadCursor(pageInfo?.prevCursor ?? null)"
        >
          上一页
        </button>
        <button class="button button-quiet" type="button" @click="submitSearch">回到最新</button>
        <button
          class="button button-quiet"
          :disabled="!pageInfo.nextCursor"
          @click="loadCursor(pageInfo?.nextCursor ?? null)"
        >
          下一页
        </button>
      </nav>
    </div>
  </section>
</template>
