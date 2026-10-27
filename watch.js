// watch.js — 지금 방송에 들어와 있는 참여자 중 최근 제재 이력이 많은 사람 찾기
//
// 채팅 감시 시스템(soop-chat-monitor)과 같은 방식으로 두 가지 데이터를 합친다.
//   1) 참여자 목록: 채팅방에 들어가면 채팅 서버가 지금 들어와 있는 (로그인한) 참여자
//      전체 목록을 svc 4 로 보내주고, 이후 입장/퇴장도 svc 4 로 알려준다.
//   2) 제재 이력: 트래키파이(trackify.kr)에 공개된 이 방송의 강퇴·채금 기록.
//      최근 90일치를 받아 store 에 저장해 두고, 켜져 있는 동안 15분마다 새 기록만 이어받는다.

const { SoopChat } = require('./soop-chat');
const { getState, setState } = require('./store');
const keepAwake = require('./keepawake');

const STREAMER = 'lshooooo';
const STATE_KEY = 'watch';
const SANCTIONS_KEY = 'sanctions';
const KEEP_DAYS = 90;
const SYNC_EVERY_MS = 15 * 60 * 1000;
const PAGE_DELAY_MS = 700; // 트래키파이 서버 부담을 줄이기 위한 요청 간격

let active = false;
let chat = null;
let chatStatus = { state: 'idle', message: '꺼져 있음', title: '' };
let connectedAt = 0;
// 채팅 서버가 주는 아이디 그대로("abc(2)" = 같은 아이디의 두 번째 접속) → { id, nick, joinedAt }
const viewers = new Map();

let sanctions = { syncedAt: 0, items: [] }; // items: [userId, nick, type(K|M), createdAt(KST), actorNick]
let byUser = new Map(); // userId → items (최신순)
let syncing = false;
let syncError = '';
let syncTimer = null;
let loading = null;

const normId = (id) => String(id || '').replace(/\(\d+\)$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 트래키파이 시각은 한국 시간 "YYYY-MM-DDTHH:mm:ss" 라서 같은 형식으로 비교한다.
function kstString(offsetDays = 0) {
  return new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 19);
}

// ---- 제재 이력 ----

function rebuildIndex() {
  byUser = new Map();
  for (const it of sanctions.items) {
    let list = byUser.get(it[0]);
    if (!list) byUser.set(it[0], (list = []));
    list.push(it);
  }
}

async function fetchPage(from, to, cursor) {
  const url =
    `https://www.trackify.kr/api/v1/p/soop/streamer/${STREAMER}/sanctions?from=${from}&to=${to}&size=100` +
    (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 lshooooo-schedule' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(3000 * attempt);
    }
  }
}

// 최신 기록부터 받다가 이미 가진 기록만 나오면 멈춘다 (처음엔 90일치 전부).
async function syncSanctions() {
  if (syncing) return;
  syncing = true;
  try {
    const cutoff = kstString(-KEEP_DAYS);
    const keyOf = (it) => it[2] + '|' + it[0] + '|' + it[3];
    const seen = new Set(sanctions.items.map(keyOf));
    const added = [];
    let cursor = '';
    let dupPages = 0;
    for (let page = 1; page <= 200; page++) {
      const json = await fetchPage(cutoff.slice(0, 10), kstString(1).slice(0, 10), cursor);
      let newHere = 0;
      for (const it of json.items || []) {
        const row = [normId(it.userId), it.userNick || '', it.type === 'K' ? 'K' : 'M', it.createdAt || '', it.actorUserNick || ''];
        if (!row[0] || seen.has(keyOf(row))) continue;
        seen.add(keyOf(row));
        added.push(row);
        newHere++;
      }
      dupPages = newHere === 0 ? dupPages + 1 : 0;
      if (!json.hasMore || !json.nextCursor || dupPages >= 2) break;
      cursor = json.nextCursor;
      await sleep(PAGE_DELAY_MS);
    }
    const items = sanctions.items.concat(added).filter((it) => it[3] >= cutoff);
    items.sort((a, b) => (a[3] < b[3] ? 1 : a[3] > b[3] ? -1 : 0));
    sanctions = { syncedAt: Date.now(), items };
    rebuildIndex();
    syncError = '';
    await setState(SANCTIONS_KEY, sanctions);
    console.log(`[watch] 제재 기록 +${added.length}건 (최근 ${KEEP_DAYS}일 ${items.length}건)`);
  } catch (e) {
    syncError = '제재 기록을 받지 못했습니다: ' + e.message;
    console.error('[watch]', syncError);
  } finally {
    syncing = false;
  }
}

// ---- 참여자 목록 ----

function onPacket({ code, parts }) {
  if (code !== 4) return;
  if (parts.length > 9) {
    // 입장 직후 받는 참여자 목록: 1 | 아이디 | 닉네임 | flag | 아이디 | 닉네임 | flag ...
    for (let i = 1; i + 2 < parts.length; i += 3) {
      if (parts[i] === '-1' || !parts[i]) continue;
      if (!viewers.has(parts[i])) viewers.set(parts[i], { id: normId(parts[i]), nick: parts[i + 1], joinedAt: 0 });
    }
  } else if (parts[0] === '1' && parts[1]) {
    viewers.set(parts[1], { id: normId(parts[1]), nick: parts[2] || '', joinedAt: Date.now() });
  } else if (parts[0] === '-1' && parts[1]) {
    viewers.delete(parts[1]); // 일반 퇴장·강퇴 모두
  }
}

function startChat() {
  stopChat();
  viewers.clear();
  chatStatus = { state: 'connecting', message: '연결 준비 중', title: '' };
  chat = new SoopChat(STREAMER).start();
  chat.on('status', (s) => {
    // 끊겼다가 다시 들어가면 참여자 목록을 처음부터 다시 받는다.
    if (s.state !== 'live') viewers.clear();
    else connectedAt = Date.now();
    chatStatus = { state: s.state, message: s.message, title: s.title || '' };
    console.log(`[watch] ${STREAMER}: ${s.state} - ${s.message}`);
  });
  chat.on('packet', onPacket);
  keepAwake.acquire('watch');
  clearInterval(syncTimer);
  syncTimer = setInterval(syncSanctions, SYNC_EVERY_MS);
  syncSanctions();
}

function stopChat() {
  keepAwake.release('watch');
  clearInterval(syncTimer);
  syncTimer = null;
  viewers.clear();
  if (chat) {
    chat.removeAllListeners();
    chat.stop();
    chat = null;
  }
}

// ---- 결과 ----

function snapshot(days, min) {
  const cutoff = kstString(-days);
  const present = new Map(); // id → { nick, joinedAt }
  for (const v of viewers.values()) {
    const prev = present.get(v.id);
    if (!prev) present.set(v.id, { nick: v.nick, joinedAt: v.joinedAt });
    else if (prev.joinedAt && (!v.joinedAt || v.joinedAt < prev.joinedAt)) prev.joinedAt = v.joinedAt;
  }

  const list = [];
  for (const [id, v] of present) {
    const all = byUser.get(id);
    if (!all) continue;
    const recent = all.filter((it) => it[3] >= cutoff);
    if (recent.length < min) continue;
    const kicks = recent.filter((it) => it[2] === 'K').length;
    list.push({
      id,
      nick: v.nick || recent[0][1],
      total: recent.length,
      kicks,
      mutes: recent.length - kicks,
      allTime: all.length,
      last: recent[0][3],
      joinedAt: v.joinedAt,
      recent: recent.slice(0, 15).map((it) => ({ type: it[2], at: it[3], by: it[4] })),
    });
  }
  list.sort((a, b) => b.total - a.total || (a.last < b.last ? 1 : -1));

  return {
    active,
    streamer: STREAMER,
    status: active ? chatStatus : { state: 'idle', message: '꺼져 있음', title: '' },
    connectedAt: active ? connectedAt : 0,
    viewerCount: present.size,
    days,
    min,
    sanctions: {
      syncedAt: sanctions.syncedAt,
      count: sanctions.items.length,
      keepDays: KEEP_DAYS,
      syncing,
      error: syncError,
    },
    list,
  };
}

function ensureLoaded() {
  if (!loading) {
    loading = (async () => {
      const saved = await getState(SANCTIONS_KEY, null);
      if (saved && Array.isArray(saved.items)) {
        sanctions = saved;
        rebuildIndex();
      }
      const st = await getState(STATE_KEY, null);
      active = Boolean(st && st.active);
    })();
  }
  return loading;
}

// 서버가 켜질 때 호출: 켜져 있던 상태였으면 다시 접속한다.
async function resume() {
  await ensureLoaded();
  if (active) {
    console.log('[watch] 이전에 켜져 있던 제재 이력 참여자 확인을 다시 시작합니다.');
    startChat();
  }
}

function mount(app) {
  app.get('/api/watch', async (req, res) => {
    await ensureLoaded();
    const days = Math.min(KEEP_DAYS, Math.max(1, parseInt(req.query.days, 10) || 30));
    const min = Math.max(1, parseInt(req.query.min, 10) || 10);
    res.json(snapshot(days, min));
  });

  app.post('/api/watch/start', async (req, res) => {
    await ensureLoaded();
    active = true;
    startChat();
    await setState(STATE_KEY, { active });
    res.json({ ok: true });
  });

  app.post('/api/watch/stop', async (req, res) => {
    await ensureLoaded();
    active = false;
    stopChat();
    chatStatus = { state: 'idle', message: '꺼져 있음', title: '' };
    await setState(STATE_KEY, { active });
    res.json({ ok: true });
  });
}

module.exports = { mount, resume, onPacket, _viewers: viewers };
