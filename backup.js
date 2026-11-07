// backup.js — 자동 백업과 되돌리기
//
// 매니저가 직접 쓰는 데이터(일정, 날짜 미정 일정, 메모장, 제재 기준, 주의 시청자)를
// 하루에 한 번(한국 시간 날짜가 바뀌면) 통째로 복사해 둔다. 자동 백업은 최근 7일치만 남긴다.
// 되돌리기 전에는 지금 상태를 '되돌리기 전' 백업으로 먼저 남겨서, 되돌린 것도 다시 되돌릴 수 있다.
// 첨부 파일·제재 기록·룰렛 명단은 크기가 크거나 따로 다시 받을 수 있어서 넣지 않는다.

const { getState, setState, deleteState } = require('./store');
const audit = require('./audit');
const auth = require('./auth');

const INDEX_KEY = 'backups';
const KEYS = ['events', 'unscheduled', 'memos', 'sanctionRules', 'watchlist'];
const LABELS = { events: '일정', unscheduled: '날짜 미정 일정', memos: '메모장', sanctionRules: '제재 기준', watchlist: '주의 시청자' };
const KEEP = { auto: 7, manual: 5, 'before-restore': 3 };
const CHECK_EVERY_MS = 60 * 60 * 1000;

const kstDate = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
let afterRestore = async () => {}; // 메모리에 들고 있는 데이터(주의 시청자)를 다시 읽게 하는 함수 (server.js 가 넣어줌)
let busy = Promise.resolve();

// 한 번에 하나씩만 (백업·되돌리기가 겹치지 않게)
function serial(fn) {
  const run = busy.then(fn, fn);
  busy = run.catch(() => {});
  return run;
}

function summarize(data) {
  const ev = data.events || {};
  return {
    events: Object.values(ev).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0),
    unscheduled: (data.unscheduled || []).length,
    memos: (data.memos || []).length,
    sanctionRules: data.sanctionRules && data.sanctionRules.text ? data.sanctionRules.text.length : 0,
    watchlist: (data.watchlist || []).length,
  };
}

async function makeBackup(kind, by) {
  const data = {};
  for (const k of KEYS) data[k] = await getState(k, null);
  const at = Date.now();
  const id = `${kind}-${kstDate()}-${at}`;
  await setState('backup:' + id, { id, at, kind, by, data });
  const index = (await getState(INDEX_KEY, [])) || [];
  index.unshift({ id, at, date: kstDate(), kind, by, counts: summarize(data) });
  // 종류별로 오래된 것 정리
  const keep = [];
  const seen = {};
  for (const b of index) {
    seen[b.kind] = (seen[b.kind] || 0) + 1;
    if (seen[b.kind] <= (KEEP[b.kind] || 3)) keep.push(b);
    else await deleteState('backup:' + b.id);
  }
  await setState(INDEX_KEY, keep);
  console.log(`[backup] ${kind} 백업 ${id}`);
  return keep[0];
}

// 오늘 자동 백업이 없으면 만든다
async function dailyCheck() {
  return serial(async () => {
    const index = (await getState(INDEX_KEY, [])) || [];
    if (index.some((b) => b.kind === 'auto' && b.date === kstDate())) return;
    await makeBackup('auto', '자동');
  }).catch((e) => console.error('[backup] 자동 백업 실패:', e.message));
}

function start({ onRestore } = {}) {
  if (onRestore) afterRestore = onRestore;
  setTimeout(dailyCheck, 30 * 1000); // 켜지고 잠시 뒤 (다른 시작 작업과 겹치지 않게)
  setInterval(dailyCheck, CHECK_EVERY_MS);
}

function mount(app) {
  app.get('/api/backups', async (req, res) => {
    res.json({ list: (await getState(INDEX_KEY, [])) || [], labels: LABELS });
  });

  app.post('/api/backups', async (req, res) => {
    try {
      const who = auth.who(req) || '이름 없음';
      const b = await serial(() => makeBackup('manual', who));
      audit.record(who, '지금 백업', b.date).catch(() => {});
      res.json({ ok: true, backup: b, list: await getState(INDEX_KEY, []) });
    } catch (e) {
      res.status(500).json({ error: '백업 실패: ' + e.message });
    }
  });

  app.get('/api/backups/:id/download', async (req, res) => {
    const b = await getState('backup:' + req.params.id, null);
    if (!b) return res.status(404).json({ error: '백업을 찾을 수 없어요' });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="backup-${b.id}.json"`);
    res.send(JSON.stringify(b, null, 2));
  });

  // 되돌리기: keys 를 주면 그 항목만 (예: ['memos']), 없으면 전부
  app.post('/api/backups/:id/restore', async (req, res) => {
    const who = auth.who(req) || '이름 없음';
    try {
      const result = await serial(async () => {
        const b = await getState('backup:' + req.params.id, null);
        if (!b) throw Object.assign(new Error('백업을 찾을 수 없어요'), { status: 404 });
        const want = Array.isArray((req.body || {}).keys) ? req.body.keys.filter((k) => KEYS.includes(k)) : KEYS;
        if (!want.length) throw Object.assign(new Error('되돌릴 항목을 골라주세요'), { status: 400 });
        await makeBackup('before-restore', who); // 되돌리기 전 지금 상태
        for (const k of want) if (b.data[k] !== null && b.data[k] !== undefined) await setState(k, b.data[k]);
        await afterRestore(want);
        return { b, want };
      });
      const what = result.want.map((k) => LABELS[k]).join(', ');
      audit.record(who, '백업으로 되돌리기', `${new Date(result.b.at + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')} 백업 · ${what}`).catch(() => {});
      res.json({ ok: true, restored: result.want, list: await getState(INDEX_KEY, []) });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });
}

module.exports = { mount, start, dailyCheck };
