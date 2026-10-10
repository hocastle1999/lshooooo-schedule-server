const express = require('express');
const path = require('path');
const { runCrawl } = require('./crawler');
const { getState, setState, deleteState } = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;      // 파일 1개당 최대 5MB
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;   // 전체 첨부 합계 최대 100MB (Upstash 무료 한도 ~256MB 안쪽)
const MAX_FILE_COUNT = 50;
const CRAWL_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2시간마다 자동 갱신

const DEFAULT_META = {
  streamer: '이상호',
  boardUrl: 'https://www.sooplive.com/station/lshooooo/board',
  crawledAtLabel: '아직 크롤링 전입니다',
};

// 파일 업로드 경로는 base64로 인코딩된 파일이 들어오므로 본문 크기 제한을 넉넉히 둡니다.
// (파일 1개 최대 5MB -> base64로 약 6.7MB. Upstash 무료 플랜의 요청 크기 한도는 10MB)
// 이 파서를 전역 express.json()보다 먼저 등록해야 기본 100kb 제한에 안 걸립니다.
app.use('/api/files', express.json({ limit: '9mb' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', async (req, res) => {
  const [events, notices, unscheduled, memo, meta, files] = await Promise.all([
    getState('events', {}),
    getState('notices', []),
    getState('unscheduled', []),
    getState('memo', ''),
    getState('meta', DEFAULT_META),
    getState('files', []),
  ]);
  // files에는 이름/크기/날짜 같은 목록 정보만 있고, 파일 내용 자체는 따로 저장되어 있습니다
  // (20초마다 이 API를 부르기 때문에 파일 내용을 같이 보내면 안 됩니다).
  res.json({ events, notices, unscheduled, memo, meta, files });
});

// 명령어 매크로 및 채팅 공지 메모 (자유 텍스트)
app.post('/api/memo', async (req, res) => {
  const { text } = req.body || {};
  const memo = typeof text === 'string' ? text : '';
  await setState('memo', memo);
  res.json({ ok: true, memo });
});

// 날짜가 아직 정해지지 않은 일정(TBD) 목록
app.post('/api/unscheduled', async (req, res) => {
  const { id, title, memo } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'title은 필수입니다' });
  }
  const list = await getState('unscheduled', []);
  if (id) {
    let found = false;
    const updated = list.map((item) => {
      if (item.id === id) { found = true; return { ...item, title: title.trim(), memo: (memo || '').trim() }; }
      return item;
    });
    if (!found) return res.status(404).json({ error: '해당 항목을 찾을 수 없습니다' });
    await setState('unscheduled', updated);
    return res.json({ ok: true, unscheduled: updated });
  }
  const newId = 'u' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  list.push({ id: newId, title: title.trim(), memo: (memo || '').trim(), createdAt: Date.now() });
  await setState('unscheduled', list);
  res.json({ ok: true, unscheduled: list });
});

app.delete('/api/unscheduled/:id', async (req, res) => {
  const { id } = req.params;
  const list = await getState('unscheduled', []);
  const next = list.filter((item) => item.id !== id);
  await setState('unscheduled', next);
  res.json({ ok: true, unscheduled: next });
});

// 날짜 미정 항목에 날짜를 정해서 캘린더 일정으로 옮기기
app.post('/api/unscheduled/:id/schedule', async (req, res) => {
  const { id } = req.params;
  const { dateKey, time } = req.body || {};
  if (!dateKey) return res.status(400).json({ error: 'dateKey는 필수입니다' });
  const list = await getState('unscheduled', []);
  const item = list.find((x) => x.id === id);
  if (!item) return res.status(404).json({ error: '해당 항목을 찾을 수 없습니다' });

  const events = await getState('events', {});
  if (!events[dateKey]) events[dateKey] = [];
  const newId = 'ev' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  events[dateKey].push({ id: newId, time: time || '', title: item.title, memo: item.memo || '' });
  events[dateKey].sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
  await setState('events', events);

  const next = list.filter((x) => x.id !== id);
  await setState('unscheduled', next);

  res.json({ ok: true, events, unscheduled: next });
});

app.post('/api/events', async (req, res) => {
  const { dateKey, id, time, title, memo } = req.body || {};
  if (!dateKey || !title || !String(title).trim()) {
    return res.status(400).json({ error: 'dateKey, title은 필수입니다' });
  }
  const events = await getState('events', {});
  if (!events[dateKey]) events[dateKey] = [];
  if (id) {
    let found = false;
    events[dateKey] = events[dateKey].map((e) => {
      if (e.id === id) { found = true; return { ...e, time: time || '', title: title.trim(), memo: (memo || '').trim() }; }
      return e;
    });
    if (!found) return res.status(404).json({ error: '해당 일정을 찾을 수 없습니다' });
  } else {
    const newId = 'ev' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    events[dateKey].push({ id: newId, time: time || '', title: title.trim(), memo: (memo || '').trim() });
  }
  events[dateKey].sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
  await setState('events', events);
  res.json({ ok: true, events });
});

app.delete('/api/events/:dateKey/:id', async (req, res) => {
  const { dateKey, id } = req.params;
  const events = await getState('events', {});
  if (events[dateKey]) {
    events[dateKey] = events[dateKey].filter((e) => e.id !== id);
    if (!events[dateKey].length) delete events[dateKey];
  }
  await setState('events', events);
  res.json({ ok: true, events });
});

// ---- 첨부 파일 ----
const FILE_ID_RE = /^f[A-Za-z0-9-]+$/;

app.post('/api/files', async (req, res) => {
  try {
    const { name, type, data } = req.body || {};
    if (!name || typeof data !== 'string' || !data) {
      return res.status(400).json({ error: '파일 이름과 내용이 필요합니다' });
    }
    const buf = Buffer.from(data, 'base64');
    if (buf.length === 0) return res.status(400).json({ error: '빈 파일은 올릴 수 없습니다' });
    if (buf.length > MAX_FILE_BYTES) {
      return res.status(413).json({ error: '파일이 너무 큽니다 (최대 5MB)' });
    }
    const list = await getState('files', []);
    if (list.length >= MAX_FILE_COUNT) {
      return res.status(400).json({ error: '첨부 파일은 최대 ' + MAX_FILE_COUNT + '개까지 올릴 수 있어요. 안 쓰는 파일을 먼저 삭제해주세요.' });
    }
    const total = list.reduce((sum, f) => sum + (f.size || 0), 0);
    if (total + buf.length > MAX_TOTAL_BYTES) {
      return res.status(400).json({ error: '저장 공간이 부족합니다. 안 쓰는 파일을 먼저 삭제해주세요.' });
    }
    const id = 'f' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    await setState('file_' + id, { data });
    const meta = {
      id,
      name: String(name).slice(0, 200),
      type: String(type || 'application/octet-stream').slice(0, 100),
      size: buf.length,
      uploadedAt: Date.now(),
    };
    list.push(meta);
    await setState('files', list);
    res.json({ ok: true, files: list });
  } catch (e) {
    console.error('[files] 업로드 실패:', e.message);
    res.status(500).json({ error: '업로드에 실패했습니다: ' + e.message });
  }
});

app.get('/api/files/:id', async (req, res) => {
  const { id } = req.params;
  if (!FILE_ID_RE.test(id)) return res.status(400).json({ error: '잘못된 파일 id' });
  const list = await getState('files', []);
  const meta = list.find((f) => f.id === id);
  if (!meta) return res.status(404).json({ error: '파일을 찾을 수 없습니다' });
  const stored = await getState('file_' + id, null);
  if (!stored || !stored.data) return res.status(404).json({ error: '파일 내용을 찾을 수 없습니다' });
  const buf = Buffer.from(stored.data, 'base64');
  res.setHeader('Content-Type', meta.type || 'application/octet-stream');
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(meta.name));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(buf);
});

app.delete('/api/files/:id', async (req, res) => {
  const { id } = req.params;
  if (!FILE_ID_RE.test(id)) return res.status(400).json({ error: '잘못된 파일 id' });
  const list = await getState('files', []);
  const next = list.filter((f) => f.id !== id);
  await setState('files', next);
  await deleteState('file_' + id);
  res.json({ ok: true, files: next });
});

let crawling = false;
async function doCrawl(reason) {
  if (crawling) return { skipped: true };
  crawling = true;
  try {
    const result = await runCrawl();
    await setState('notices', result.notices);
    await setState('meta', result.meta);
    console.log(`[crawler] (${reason}) 공지 ${result.notices.length}개 갱신 - ${result.meta.crawledAtLabel}`);
    return { ok: true, count: result.notices.length, meta: result.meta };
  } catch (e) {
    console.error(`[crawler] (${reason}) 실패:`, e.message);
    return { ok: false, error: e.message };
  } finally {
    crawling = false;
  }
}

app.post('/api/refresh', async (req, res) => {
  if (crawling) return res.status(429).json({ error: '이미 크롤링 중입니다. 잠시 후 다시 시도해주세요.' });
  const result = await doCrawl('수동 새로고침');
  if (result.ok) res.json(result);
  else res.status(500).json(result);
});

app.listen(PORT, () => {
  console.log('==========================================');
  console.log(' 이상호 방송 일정 서버 실행 중');
  console.log(' http://localhost:' + PORT);
  console.log(' 이 창을 닫으면 서버가 멈춥니다. (로컬 실행 시)');
  console.log('==========================================');
  doCrawl('시작 시 초기 크롤링');
  setInterval(() => doCrawl('정기 자동 갱신'), CRAWL_INTERVAL_MS);
});
