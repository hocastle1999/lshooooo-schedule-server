// watch.js — 지금 방송에 들어와 있는 참여자 확인
//   - 참여자 중 최근 제재 이력이 많은 사람 (제재 이력 참여자 페이지)
//   - 참여자 중 매니저 (작업실 오른쪽 위 "방송 중 매니저")
//
// 채팅 감시 시스템(soop-chat-monitor)과 같은 방식으로 두 가지 데이터를 합친다.
//   1) 참여자 목록: 채팅방에 들어가면 채팅 서버가 지금 들어와 있는 (로그인한) 참여자
//      전체 목록을 svc 4 로 보내주고, 이후 입장/퇴장도 svc 4 로 알려준다.
//      각 참여자에 붙어 오는 flag 의 256 비트가 매니저 표시다.
//   2) 제재 이력: 트래키파이(trackify.kr)에 공개된 이 방송의 강퇴·채금 기록.
//      최근 90일치를 받아 store 에 저장해 두고, 15분마다 새 기록만 이어받는다.
//
// 서버가 켜져 있는 동안 항상 채팅방에 붙어 있는다. 방송이 꺼져 있으면 1분마다 다시
// 확인하다가 방송이 켜지면 자동으로 들어간다. 그래서 서버가 잠들지 않게 한다 (keepawake.js).

const { SoopChat } = require('./soop-chat');
const { getState, setState } = require('./store');
const keepAwake = require('./keepawake');

const STREAMER = 'lshooooo';
const SANCTIONS_KEY = 'sanctions';
const KEEP_DAYS = 90;
const SYNC_EVERY_MS = 15 * 60 * 1000;
const PAGE_DELAY_MS = 700; // 트래키파이 서버 부담을 줄이기 위한 요청 간격
const FLAG_MANAGER = 1 << 8;

let chat = null;
let chatStatus = { state: 'connecting', message: '연결 준비 중', title: '' };
let connectedAt = 0;
// 채팅 서버가 주는 아이디 그대로("abc(2)" = 같은 아이디의 두 번째 접속) → { id, nick, manager, joinedAt }
const viewers = new Map();

let sanctions = { syncedAt: 0, items: [] }; // items: [userId, nick, type(K|M), createdAt(KST), actorNick]
let byUser = new Map(); // userId → items (최신순)
let syncing = false;
let syncError = '';
let loading = null;

const normId = (id) => String(id || '').replace(/\(\d+\)$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isManager = (flag) => (Number(String(flag || '').split('|')[0]) & FLAG_MANAGER) !== 0;

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

// ---- 트래키파이 요청 줄 세우기 ----
// 짧은 시간에 여러 번 요청하면 "요청이 너무 많습니다(429)"로 막혀서, 모든 요청을 한 줄로 세워
// 1.1초 간격으로 하나씩 보낸다. 사람이 직접 누른 🔍 조회는 줄 맨 앞에 끼워 넣는다.
const TK_GAP_MS = 1100;
const tkQueue = [];
let tkBusy = false;
function tkFetch(url, { urgent = false } = {}) {
  return new Promise((resolve, reject) => {
    const job = { url, resolve, reject, tries: 0 };
    if (urgent) tkQueue.unshift(job); else tkQueue.push(job);
    tkPump();
  });
}
async function tkPump() {
  if (tkBusy) return;
  const job = tkQueue.shift();
  if (!job) return;
  tkBusy = true;
  let wait = TK_GAP_MS;
  try {
    const res = await fetch(job.url, { headers: { 'User-Agent': 'Mozilla/5.0 lshooooo-schedule' }, signal: AbortSignal.timeout(20000) });
    if (res.status === 429 && job.tries++ < 4) {
      tkQueue.unshift(job); // 잠깐 쉬었다가 같은 요청을 다시
      wait = 3000;
    } else if (!res.ok) {
      job.reject(new Error('HTTP ' + res.status));
    } else {
      job.resolve(await res.json());
    }
  } catch (e) {
    job.reject(e);
  }
  setTimeout(() => { tkBusy = false; tkPump(); }, wait);
}

async function fetchPage(from, to, cursor, urgent = false) {
  const url =
    `https://www.trackify.kr/api/v1/p/soop/streamer/${STREAMER}/sanctions?from=${from}&to=${to}&size=100` +
    (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
  for (let attempt = 1; ; attempt++) {
    try {
      return await tkFetch(url, { urgent });
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

// 매니저 아이디 목록. 참여자 한 명 한 명의 입장 알림에는 매니저 표시가 빠져서 오는 경우가 있어서
// (방송 도중 들어오거나 새로고침으로 다시 들어온 매니저), 사람마다가 아니라 아이디로 따로 기억한다.
// 방송 중에는 3분마다 잠깐 새로 접속해서 처음 받는 전체 참여자 목록(여기엔 매니저 표시가 정확히 들어 있다)으로
// 이 목록을 통째로 다시 만든다.
const RESYNC_MS = 3 * 60 * 1000;
let managerIds = new Set();
let lastResync = { at: 0, ok: false, count: 0 };
let resyncing = false;
function resyncManagers() {
  if (resyncing || chatStatus.state !== 'live') return;
  resyncing = true;
  const fresh = new Set();
  let gotList = false;
  const tmp = new SoopChat(STREAMER, { offlineRetryMs: 24 * 3600 * 1000 }).start();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    tmp.removeAllListeners();
    tmp.stop();
    resyncing = false;
    lastResync = { at: Date.now(), ok: gotList, count: fresh.size };
    if (!gotList || chatStatus.state !== 'live') {
      console.log('[watch] 매니저 다시 맞추기 실패 (참여자 목록을 받지 못함)');
      return;
    }
    managerIds = fresh;
  };
  tmp.on('packet', ({ code, parts }) => {
    if (code !== 4 || parts.length <= 9) return;
    gotList = true;
    for (let i = 1; i + 2 < parts.length; i += 3) if (isManager(parts[i + 2])) fresh.add(normId(parts[i]));
  });
  tmp.on('status', (st) => { if (st.state !== 'live' && st.state !== 'connecting') finish(); });
  setTimeout(finish, 20000); // 목록은 접속 후 몇 초 안에 다 온다
}

function onPacket({ code, parts }) {
  if (code === 12) {
    // 권한 변경: flag | 아이디 | 닉네임 | 0 | 0 | flag (바뀌기 전·후 flag 두 개)
    // 방송 도중 들어온 매니저는 입장 알림에 매니저 표시가 없고, 이 알림으로 나중에 붙는다.
    // 두 flag 중 어느 쪽이 새 값인지 확실하지 않아서 매니저 표시는 붙이기만 하고, 떼는 건 3분마다 다시 맞출 때 한다.
    if (parts[1] && (isManager(parts[0]) || isManager(parts[5]))) managerIds.add(normId(parts[1]));
    return;
  }
  if (code !== 4) return;
  if (parts.length > 9) {
    // 입장 직후 받는 참여자 목록: 1 | 아이디 | 닉네임 | flag | 아이디 | 닉네임 | flag ...
    for (let i = 1; i + 2 < parts.length; i += 3) {
      if (parts[i] === '-1' || !parts[i]) continue;
      if (!viewers.has(parts[i])) {
        viewers.set(parts[i], { id: normId(parts[i]), nick: parts[i + 1], joinedAt: 0 });
        if (isManager(parts[i + 2])) managerIds.add(normId(parts[i]));
      }
    }
  } else if (parts[0] === '1' && parts[1]) {
    // 입장: 1 | 아이디 | 닉네임 | flag
    viewers.set(parts[1], { id: normId(parts[1]), nick: parts[2] || '', joinedAt: Date.now() });
    if (isManager(parts[3])) managerIds.add(normId(parts[1])); // 표시가 없이 들어와도 매니저 목록에서 빼지는 않는다
  } else if (parts[0] === '-1' && parts[1]) {
    viewers.delete(parts[1]); // 일반 퇴장·강퇴 모두
  }
}

function startChat() {
  viewers.clear();
  chat = new SoopChat(STREAMER).start();
  chat.on('status', (s) => {
    // 끊겼다가 다시 들어가면 참여자 목록을 처음부터 다시 받는다.
    if (s.state !== 'live') { viewers.clear(); managerIds = new Set(); }
    else connectedAt = Date.now();
    chatStatus = { state: s.state, message: s.message, title: s.title || '' };
    console.log(`[watch] ${STREAMER}: ${s.state} - ${s.message}`);
  });
  chat.on('packet', onPacket);
  keepAwake.acquire('watch');
  setInterval(resyncManagers, RESYNC_MS);
  setInterval(syncSanctions, SYNC_EVERY_MS);
  syncSanctions();
}

// 같은 아이디로 여러 번 접속한 경우("abc", "abc(2)") 한 명으로 묶는다.
function presentUsers() {
  const present = new Map(); // id → { nick, joinedAt }
  for (const v of viewers.values()) {
    const prev = present.get(v.id);
    if (!prev) present.set(v.id, { nick: v.nick, joinedAt: v.joinedAt });
    else {
      if (prev.joinedAt && (!v.joinedAt || v.joinedAt < prev.joinedAt)) prev.joinedAt = v.joinedAt;
    }
  }
  return present;
}

// ---- 결과 ----

function snapshot(days, min) {
  const cutoff = kstString(-days);
  const present = presentUsers();

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
    streamer: STREAMER,
    status: chatStatus,
    connectedAt,
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

// 작업실 제목 아래 "방송 참여 중 매니저" 표시용. 먼저 들어와 있던 순서대로.
function managers() {
  const list = [];
  for (const [id, v] of presentUsers()) {
    if (managerIds.has(id)) list.push({ id, nick: v.nick, joinedAt: v.joinedAt || connectedAt });
  }
  list.sort((a, b) => a.joinedAt - b.joinedAt);
  return { live: chatStatus.state === 'live', state: chatStatus.state, list, checkedAt: lastResync.at, checkOk: lastResync.ok };
}

function ensureLoaded() {
  if (!loading) {
    loading = (async () => {
      const saved = await getState(SANCTIONS_KEY, null);
      if (saved && Array.isArray(saved.items)) {
        sanctions = saved;
        rebuildIndex();
      }
    })();
  }
  return loading;
}

// 서버가 켜질 때 호출: 채팅방에 들어가 참여자 확인을 시작한다.
async function resume() {
  await ensureLoaded();
  startChat();
}

// ---- 하루 동안 제재당한 시청자 (제재 이력 참여자 2페이지) ----
// 트래키파이의 그날 제재 기록을 그대로 쓴다. 제재 직전 채팅(recentMessages)이 같이 들어 있다.
// 오늘 기록은 1분, 지난 날짜는 1시간 동안 같은 결과를 다시 쓴다.
const dayCache = new Map(); // 날짜 → { at, items }
async function fetchDay(date) {
  const hit = dayCache.get(date);
  const ttl = date === kstString().slice(0, 10) ? 60 * 1000 : 60 * 60 * 1000;
  if (hit && Date.now() - hit.at < ttl) return hit.items;
  const next = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const items = [];
  let cursor = '';
  for (let page = 1; page <= 20; page++) {
    const json = await fetchPage(date, next, cursor, true); // 화면에서 기다리는 요청이라 줄 앞으로
    for (const it of json.items || []) if (String(it.createdAt || '').startsWith(date)) items.push(it);
    if (!json.hasMore || !json.nextCursor) break;
    cursor = json.nextCursor;
    await sleep(PAGE_DELAY_MS);
  }
  dayCache.set(date, { at: Date.now(), items });
  if (dayCache.size > 20) dayCache.delete(dayCache.keys().next().value);
  return items;
}

// 시청자별로 묶어서, 마지막으로 제재당한 순서대로.
// ---- 사람별 이상호 방송 제재 횟수 (전체 기간, 🔍 창과 같은 기준) ----
// 오늘 제재당한 시청자 카드의 라벨용. 트래키파이에 사람마다 한 번씩 물어봐야 해서 줄 맨 뒤에서 천천히 채우고,
// 받은 결과는 저장해 둔다. 그 사람이 받은 마지막 제재보다 먼저 센 결과면 다시 센다.
const CH_KEY = 'channelCounts';
let chCounts = null; // id → { k, m, at(KST 문자열: 센 시각) }
const chPending = new Set();
let chSaveTimer = null;
async function loadChCounts() {
  if (!chCounts) chCounts = (await getState(CH_KEY, null)) || {};
  return chCounts;
}
function saveChCountsSoon() {
  if (chSaveTimer) return;
  chSaveTimer = setTimeout(async () => {
    chSaveTimer = null;
    const ids = Object.keys(chCounts);
    if (ids.length > 5000) { // 오래 안 본 사람부터 정리
      ids.sort((a, b) => (chCounts[a].at < chCounts[b].at ? -1 : 1)).slice(0, ids.length - 5000).forEach((id) => delete chCounts[id]);
    }
    try { await setState(CH_KEY, chCounts); } catch (e) { console.error('[watch] 제재 횟수 저장 실패:', e.message); }
  }, 10000);
}
async function countChannel(id, urgent = false) {
  let k = 0, m = 0;
  const at = kstString();
  for (let page = 1; page <= 20; page++) {
    const json = await tkFetch(`https://www.trackify.kr/api/v1/p/soop/sanctions?userId=${encodeURIComponent(id)}&broadUserId=${STREAMER}&page=${page}&size=50`, { urgent });
    for (const it of json.data || []) {
      if (it.broadUserId && it.broadUserId !== STREAMER) continue;
      if (it.type === 'K') k++; else m++;
    }
    if (!json.more) break;
  }
  chCounts[id] = { k, m, at };
  saveChCountsSoon();
  return chCounts[id];
}
// 아직 안 셌거나, 센 뒤에 새로 제재를 받은 사람만 줄에 세운다
function wantChCount(id, lastSanctionAt) {
  const c = chCounts[id];
  if (c && c.at >= lastSanctionAt) return c;
  if (!chPending.has(id)) {
    chPending.add(id);
    countChannel(id).catch((e) => console.error('[watch] 제재 횟수 세기 실패', id, e.message)).finally(() => chPending.delete(id));
  }
  return c && { ...c, stale: true };
}

async function daySanctions(date) {
  await loadChCounts();
  const present = chatStatus.state === 'live' ? presentUsers() : new Map();
  const byId = new Map();
  for (const it of await fetchDay(date)) {
    const id = normId(it.userId);
    if (!id) continue;
    let u = byId.get(id);
    if (!u) byId.set(id, (u = { id, nick: it.userNick || id, kicks: 0, mutes: 0, last: '', sanctions: [] }));
    if (it.type === 'K') u.kicks++; else u.mutes++;
    if (it.createdAt > u.last) { u.last = it.createdAt; u.nick = it.userNick || u.nick; }
    u.sanctions.push({
      type: it.type === 'K' ? 'K' : 'M',
      at: it.createdAt,
      by: it.actorUserNick || '',
      muteSeconds: it.muteSeconds || 0,
      messages: (it.recentMessages || []).map((m) => ({ at: m.at, text: m.text })),
    });
  }
  const list = [...byId.values()].map((u) => {
    u.sanctions.sort((a, b) => (a.at < b.at ? 1 : -1));
    u.inRoom = present.has(u.id);
    // 이 방송 최근 90일: 저장해 둔 기록(15분마다 갱신)에 아직 안 들어온 그날 제재까지 합쳐서 센다
    const seen = new Set();
    let k90 = 0, m90 = 0;
    const count = (type, at) => {
      if (seen.has(type + '|' + at)) return;
      seen.add(type + '|' + at);
      if (type === 'K') k90++; else m90++;
    };
    for (const it of byUser.get(u.id) || []) count(it[2], it[3]);
    for (const x of u.sanctions) count(x.type, x.at);
    u.kicks90 = k90;
    u.mutes90 = m90;
    u.total90 = k90 + m90;
    const ch = wantChCount(u.id, u.last);
    u.channel = ch ? { kicks: ch.k, mutes: ch.m, total: ch.k + ch.m, updating: Boolean(ch.stale) } : null;
    return u;
  });
  list.sort((a, b) => (a.last < b.last ? 1 : -1));
  const total = list.reduce((s, u) => s + u.kicks + u.mutes, 0);
  return { date, today: kstString().slice(0, 10), total, people: list.length, list };
}

function mount(app) {
  // 🔍 버튼: 트래키파이 '유저 제재 이력 부검'과 같은 데이터. 다른 방송에서 받은 제재까지 전부, 제재 직전 채팅 포함.
  // page 는 1부터. 첫 페이지일 때만 요약(총 제재·스트리머별 횟수)을 같이 준다. 같은 요청은 2분 동안 다시 쓴다.
  const lookupCache = new Map();
  const TRACKIFY = 'https://www.trackify.kr/api/v1/p/soop';
  async function trackifyGet(path) {
    const hit = lookupCache.get(path);
    if (hit && Date.now() - hit.at < 2 * 60 * 1000) return hit.json;
    const json = await tkFetch(TRACKIFY + path, { urgent: true });
    lookupCache.set(path, { at: Date.now(), json });
    if (lookupCache.size > 200) lookupCache.delete(lookupCache.keys().next().value);
    return json;
  }
  app.get('/api/sanctions/lookup', async (req, res) => {
    const id = normId(String(req.query.id || '').trim());
    if (!/^[A-Za-z0-9_]{1,40}$/.test(id)) return res.status(400).json({ error: '아이디를 확인해주세요' });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const onlyHere = req.query.channel === '1'; // 이상호 방송에서 받은 제재만
    try {
      if (onlyHere) await loadChCounts();
      const [summary, list, here] = await Promise.all([
        page === 1 ? trackifyGet(`/sanctions/user/${id}/summary`) : null,
        trackifyGet(`/sanctions?userId=${id}&page=${page}&size=20` + (onlyHere ? `&broadUserId=${STREAMER}` : '')),
        onlyHere && page === 1 ? countChannel(id, true) : null,
      ]);
      res.json({
        id,
        page,
        total: list.total || 0,
        more: Boolean(list.more),
        inRoom: chatStatus.state === 'live' && presentUsers().has(id),
        channel: here && { total: here.k + here.m, kicks: here.k, mutes: here.m },
        summary: summary && {
          nick: summary.userNick || '',
          total: summary.total || 0,
          kicks: summary.kick || 0,
          mutes: summary.mute || 0,
          streamerCount: summary.streamerCount || 0,
          topStreamers: (summary.topStreamers || []).map((s) => ({ id: s.broadUserId, nick: s.nick, count: s.cnt })),
        },
        items: (list.data || []).map((it) => ({
          at: it.createdAt,
          type: it.type === 'K' ? 'K' : 'M',
          streamerId: it.broadUserId,
          streamer: it.broadUserNick || it.broadUserId,
          by: it.actorUserNick || '',
          muteSeconds: it.muteSeconds || 0,
          nick: it.userNick || '',
          messages: (it.recentMessages || []).map((m) => ({ at: m.at, text: m.text })),
        })),
      });
    } catch (e) {
      res.status(502).json({ error: '트래키파이에서 제재 이력을 받지 못했습니다: ' + e.message });
    }
  });

  // 이 방송에서 받은 최근 90일 제재만 (저장해 둔 기록에서).
  app.get('/api/sanctions/user', async (req, res) => {
    await ensureLoaded();
    const id = normId(String(req.query.id || '').trim());
    if (!id) return res.status(400).json({ error: '아이디가 필요합니다' });
    const items = byUser.get(id) || [];
    const kicks = items.filter((it) => it[2] === 'K').length;
    res.json({
      id,
      nick: items.length ? items[0][1] : '',
      keepDays: KEEP_DAYS,
      syncedAt: sanctions.syncedAt,
      kicks,
      mutes: items.length - kicks,
      inRoom: chatStatus.state === 'live' && presentUsers().has(id),
      items: items.map((it) => ({ type: it[2], at: it[3], by: it[4] })),
    });
  });

  app.get('/api/sanctions/day', async (req, res) => {
    await ensureLoaded();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : kstString().slice(0, 10);
    try {
      res.json(await daySanctions(date));
    } catch (e) {
      res.status(502).json({ error: '트래키파이에서 제재 기록을 받지 못했습니다: ' + e.message });
    }
  });

  app.get('/api/watch', async (req, res) => {
    await ensureLoaded();
    const days = Math.min(KEEP_DAYS, Math.max(1, parseInt(req.query.days, 10) || 30));
    const min = Math.max(1, parseInt(req.query.min, 10) || 10);
    res.json(snapshot(days, min));
  });
}

module.exports = { mount, resume, managers, onPacket, resyncManagers };
