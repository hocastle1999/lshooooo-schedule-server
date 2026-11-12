// audit.js — 변경 기록 (누가, 언제, 무엇을 바꿨는지)
//
// 데이터를 바꾸는 요청(POST·DELETE)이 성공하면 한 줄씩 남긴다. 이름은 로그인한 매니저 이름(auth.js).
// 지우는 요청은 지우기 전에 무엇이었는지(일정 제목 등)를 먼저 찾아 둔다.
// 메모 자동 저장처럼 자주 오는 것은 같은 사람이 같은 것을 30분 안에 또 바꾸면 한 줄로 합친다.
// 최근 500줄만 저장한다.

const { getState, setState } = require('./store');
const auth = require('./auth');

const KEY = 'auditLog';
const MAX = 500;
const MERGE_MS = 30 * 60 * 1000;

let log = null; // [{ ts, who, action, detail, count }] 최신이 앞
let saveTimer = null;
let loading = null;

function load() {
  if (!loading) loading = getState(KEY, []).then((v) => { log = Array.isArray(v) ? v : []; });
  return loading;
}
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try { await setState(KEY, log.slice(0, MAX)); } catch (e) { console.error('[audit] 저장 실패:', e.message); }
  }, 3000);
}

// 다른 모듈(백업 되돌리기 등)에서 직접 남길 때도 쓴다
async function record(who, action, detail, { merge = false } = {}) {
  await load();
  const now = Date.now();
  const top = log[0];
  if (merge && top && top.who === who && top.action === action && top.detail === detail && now - top.ts < MERGE_MS) {
    top.ts = now;
    top.count = (top.count || 1) + 1;
  } else {
    log.unshift({ ts: now, who, action, detail: String(detail || '').slice(0, 200) });
    if (log.length > MAX) log.length = MAX;
  }
  saveSoon();
}

const short = (s, n = 40) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// 요청 → [무엇을, 자세히, 합칠지]. 기록하지 않을 요청이면 null.
async function describe(req) {
  const b = req.body || {};
  const p = req.path;
  const m = req.method;
  let x;
  if (m === 'POST' && p === '/api/events') return [b.id ? '일정 수정' : '일정 추가', `${b.dateKey} ${short(b.title)}`];
  if (m === 'DELETE' && (x = p.match(/^\/api\/events\/([^/]+)\/([^/]+)$/))) {
    const ev = ((await getState('events', {}))[x[1]] || []).find((e) => e.id === x[2]);
    return ['일정 삭제', `${x[1]} ${short(ev && ev.title)}`];
  }
  if (m === 'POST' && p === '/api/unscheduled') return [b.id ? '날짜 미정 일정 수정' : '날짜 미정 일정 추가', short(b.title)];
  if (m === 'DELETE' && (x = p.match(/^\/api\/unscheduled\/([^/]+)$/))) {
    const it = (await getState('unscheduled', [])).find((u) => u.id === x[1]);
    return ['날짜 미정 일정 삭제', short(it && it.title)];
  }
  if (m === 'POST' && (x = p.match(/^\/api\/unscheduled\/([^/]+)\/schedule$/))) {
    const it = (await getState('unscheduled', [])).find((u) => u.id === x[1]);
    return ['날짜 미정 → 달력 배정', `${b.dateKey} ${short(it && it.title)}`];
  }
  if (m === 'POST' && p === '/api/memos') return ['메모 페이지 추가', short(b.title)];
  if ((m === 'POST' || m === 'DELETE') && (x = p.match(/^\/api\/memos\/([^/]+)$/))) {
    const page = ((await getState('memos', [])) || []).find((pg) => pg.id === x[1]);
    const title = short(page && page.title, 20);
    if (m === 'DELETE') return ['메모 페이지 삭제', title];
    if (b.title !== undefined && page && b.title !== page.title) return ['메모 페이지 이름 변경', `${title} → ${short(b.title, 20)}`];
    return ['메모 수정', title, true];
  }
  if (m === 'POST' && p === '/api/memo-order') return ['메모 탭 순서 변경', '', true];
  if (m === 'POST' && p === '/api/files') return ['첨부 파일 올림', short(b.name)];
  if (m === 'DELETE' && (x = p.match(/^\/api\/files\/([^/]+)$/))) {
    const f = (await getState('files', [])).find((it) => it.id === x[1]);
    return ['첨부 파일 삭제', short(f && f.name)];
  }
  if (m === 'POST' && p === '/api/sanction-rules') return ['제재 기준 수정', '', true];
  if (m === 'POST' && p === '/api/patch-notes') return ['패치 노트 수정', '', true];
  if (m === 'POST' && p === '/api/refresh') return ['공지 새로고침', '', true];
  if (m === 'POST' && p === '/api/roulette/start') return ['후원 룰렛 수집 시작', short(b.streamer)];
  if (m === 'POST' && p === '/api/roulette/stop') return ['후원 룰렛 수집 중지', ''];
  if (m === 'POST' && p === '/api/roulette/reset') return ['후원 룰렛 명단 초기화', ''];
  if (m === 'POST' && p === '/api/roulette/filter') return ['후원 룰렛 설정 변경', `기준 ${b.unit || 1}개${b.bonus === false ? '' : ' · 보너스'}`, true];
  if (m === 'POST' && p === '/api/watchlist') return ['주의 시청자 추가', short(b.q) + (b.memo ? ` (${short(b.memo, 30)})` : '')];
  if (m === 'DELETE' && p === '/api/watchlist/alerts') return ['채팅 알림 전체 지우기', ''];
  if (m === 'DELETE' && p.startsWith('/api/watchlist/alerts/')) return ['채팅 알림 지우기', '', true];
  if (m === 'POST' && (x = p.match(/^\/api\/watchlist\/([^/]+)$/))) return ['주의 시청자 메모', `${x[1]}: ${short(b.memo, 30)}`];
  if (m === 'DELETE' && (x = p.match(/^\/api\/watchlist\/([^/]+)$/))) return ['주의 시청자 빼기', x[1]];
  return null;
}

function mount(app) {
  // 바꾸는 요청을 지켜보다가 성공하면 남긴다 (express.json() 다음, 각 API 보다 먼저 등록)
  app.use(async (req, res, next) => {
    if (req.method === 'GET' || !req.path.startsWith('/api/')) return next();
    let info = null;
    try { info = await describe(req); } catch (e) { info = null; }
    if (info) {
      const who = auth.who(req) || '이름 없음';
      res.on('finish', () => {
        if (res.statusCode < 400) record(who, info[0], info[1], { merge: Boolean(info[2]) }).catch(() => {});
      });
    }
    next();
  });

  // 지우기: 한 줄(ts) / 전체. 전체를 지우면 "누가 지웠는지" 한 줄만 새로 남긴다.
  app.delete('/api/audit', async (req, res) => {
    await load();
    log = [];
    await record(auth.who(req) || '이름 없음', '변경 기록 전체 삭제', '');
    res.json({ ok: true, total: log.length, list: log.slice(0, 200) });
  });
  app.delete('/api/audit/:ts', async (req, res) => {
    await load();
    const ts = Number(req.params.ts);
    log = log.filter((r) => r.ts !== ts);
    saveSoon();
    res.json({ ok: true, total: log.length, list: log.slice(0, 200) });
  });

  app.get('/api/audit', async (req, res) => {
    await load();
    const limit = Math.min(MAX, Math.max(1, parseInt(req.query.limit, 10) || 50));
    res.json({ total: log.length, list: log.slice(0, limit) });
  });
}

module.exports = { mount, record };
