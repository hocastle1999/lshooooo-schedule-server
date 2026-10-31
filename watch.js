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
const KEEP_DAYS = 90; // 1·2페이지와 🔍 라벨이 보는 기간
// 저장은 트래키파이에 남아 있는 기록 시작 무렵부터 전부 한다 (3페이지 '전체 기간' 순위용).
const STORE_FROM = '2025-01-01';
const SYNC_EVERY_MS = 15 * 60 * 1000;
const FLAG_MANAGER = 1 << 8;

let chat = null;
let chatStatus = { state: 'connecting', message: '연결 준비 중', title: '' };
let connectedAt = 0;
// 채팅 서버가 주는 아이디 그대로("abc(2)" = 같은 아이디의 두 번째 접속) → { id, nick, manager, joinedAt }
const viewers = new Map();

let sanctions = { syncedAt: 0, items: [], complete: false }; // items: [userId, nick, type(K|M), createdAt(KST), actorNick] (최신순)
// complete: STORE_FROM 까지 예전 기록을 다 받았는지
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

// 저장 형식: 기록이 수만 건이라 JSON 배열 대신 '탭으로 나눈 줄' 하나의 문자열로 저장해서 크기를 줄인다.
// (Upstash 무료 플랜은 한 번에 저장할 수 있는 크기에 한도가 있다)
function packRows(items) {
  return items.map((it) => it.map((v) => String(v).replace(/[\t\n]/g, ' ')).join('\t')).join('\n');
}
function unpackRows(text) {
  return text ? text.split('\n').map((line) => line.split('\t')) : [];
}
async function saveSanctions() {
  await setState(SANCTIONS_KEY, { syncedAt: sanctions.syncedAt, complete: Boolean(sanctions.complete), rows: packRows(sanctions.items) });
}

// 최신순 목록에서 since 이후 개수
function countSince(items, since) {
  let n = 0;
  for (const it of items) { if (it[3] < since) break; n++; }
  return n;
}

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

const toRow = (it) => [normId(it.userId), it.userNick || '', it.type === 'K' ? 'K' : 'M', it.createdAt || '', it.actorUserNick || ''];
const rowKey = (it) => it[2] + '|' + it[0] + '|' + it[3];

// 새로 받은 기록을 합친다 (같은 제재는 한 번만). 합친 개수를 돌려준다.
function mergeRows(rows) {
  const seen = new Set(sanctions.items.map(rowKey));
  const items = sanctions.items.slice();
  let added = 0;
  for (const r of rows) {
    if (!r[0] || seen.has(rowKey(r))) continue;
    seen.add(rowKey(r));
    items.push(r);
    added++;
  }
  if (added) {
    items.sort((a, b) => (a[3] < b[3] ? 1 : a[3] > b[3] ? -1 : 0));
    sanctions = { ...sanctions, items };
    rebuildIndex();
  }
  return added;
}

// 최신 기록부터 받다가 이미 가진 기록만 나오면 멈춘다. 처음이면 끝까지 다 받는다.
async function syncSanctions() {
  if (syncing) return;
  syncing = true;
  try {
    const seen = new Set(sanctions.items.map(rowKey));
    const rows = [];
    let cursor = '';
    let dupPages = 0;
    let reachedEnd = false;
    for (let page = 1; page <= 3000; page++) {
      const json = await fetchPage(STORE_FROM, kstString(1).slice(0, 10), cursor);
      let newHere = 0;
      for (const it of json.items || []) {
        const row = toRow(it);
        if (!row[0] || seen.has(rowKey(row))) continue;
        seen.add(rowKey(row));
        rows.push(row);
        newHere++;
      }
      dupPages = newHere === 0 ? dupPages + 1 : 0;
      if (!json.hasMore || !json.nextCursor) { reachedEnd = true; break; }
      if (dupPages >= 2) break;
      cursor = json.nextCursor;
    }
    const added = mergeRows(rows);
    // 끝까지 받았다면 STORE_FROM 부터 지금까지 빠짐없이 가진 것
    sanctions = { ...sanctions, syncedAt: Date.now(), complete: sanctions.complete || reachedEnd };
    syncError = '';
    await saveSanctions();
    console.log(`[watch] 제재 기록 +${added}건 (저장 ${sanctions.items.length}건)`);
  } catch (e) {
    syncError = '제재 기록을 받지 못했습니다: ' + e.message;
    console.error('[watch]', syncError);
  } finally {
    syncing = false;
  }
  backfillSanctions();
}

// 예전에 90일치만 받아 두던 저장소를 STORE_FROM 까지 채운다. 중간에 끊겨도 다음에 이어서 받는다.
let backfilling = false;
async function backfillSanctions() {
  if (backfilling || sanctions.complete || !sanctions.items.length) return;
  backfilling = true;
  try {
    const oldest = sanctions.items[sanctions.items.length - 1][3].slice(0, 10);
    const to = new Date(Date.parse(oldest + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    console.log(`[watch] 예전 제재 기록 받기 시작 (${STORE_FROM} ~ ${oldest})`);
    let cursor = '';
    let buf = [];
    for (let page = 1; page <= 3000; page++) {
      const json = await fetchPage(STORE_FROM, to, cursor);
      for (const it of json.items || []) buf.push(toRow(it));
      const end = !json.hasMore || !json.nextCursor;
      if (page % 50 === 0 || end) {
        const added = mergeRows(buf);
        buf = [];
        if (end) sanctions = { ...sanctions, complete: true };
        await saveSanctions();
        console.log(`[watch] 예전 제재 기록 +${added}건 (저장 ${sanctions.items.length}건)`);
      }
      if (end) break;
      cursor = json.nextCursor;
    }
  } catch (e) {
    console.error('[watch] 예전 제재 기록 받기 실패 (다음 갱신 때 이어서):', e.message);
  } finally {
    backfilling = false;
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
      allTime: countSince(all, kstString(-KEEP_DAYS)),
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
      count: countSince(sanctions.items, kstString(-KEEP_DAYS)),
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
      if (saved && (typeof saved.rows === 'string' || Array.isArray(saved.items))) {
        sanctions = {
          syncedAt: saved.syncedAt || 0,
          complete: Boolean(saved.complete),
          items: typeof saved.rows === 'string' ? unpackRows(saved.rows) : saved.items, // 예전 형식(items 배열)도 읽는다
        };
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
  }
  dayCache.set(date, { at: Date.now(), items });
  if (dayCache.size > 20) dayCache.delete(dayCache.keys().next().value);
  return items;
}

// 시청자별로 묶어서, 마지막으로 제재당한 순서대로.
// ---- 사람별 이상호 방송 제재 횟수 (전체 기간, 🔍 창과 같은 기준) ----
// 오늘 제재당한 시청자 카드의 라벨용. 트래키파이에 사람마다 한 번씩 물어봐야 해서 줄 맨 뒤에서 천천히 채우고,
// 받은 결과는 저장해 둔다. 그 사람이 받은 마지막 제재보다 먼저 센 결과면 다시 센다.
// ---- 사람별 '모든 방송' 제재 요약 (3페이지 '전체 방송' 순위용) ----
// 트래키파이에 사람마다 물어봐야 해서, 순위 화면을 누군가 보고 있을 때만 한 번에 몇 명씩 천천히 채운다.
// 받은 결과는 저장해 두고 하루가 지나면 다시 받는다.
const SUM_KEY = 'userSummaries';
const SUM_TTL_MS = 24 * 3600 * 1000;
const SUM_BATCH = 5; // 한 번에 줄 세우는 최대 인원
let sums = null; // id → { t, k, m, s(제재한 스트리머 수), at }
const sumPending = new Set();
let sumSaveTimer = null;
async function loadSums() {
  if (!sums) sums = (await getState(SUM_KEY, null)) || {};
  return sums;
}
function saveSumsSoon() {
  if (sumSaveTimer) return;
  sumSaveTimer = setTimeout(async () => {
    sumSaveTimer = null;
    const ids = Object.keys(sums);
    if (ids.length > 5000) ids.sort((a, b) => sums[a].at - sums[b].at).slice(0, ids.length - 5000).forEach((id) => delete sums[id]);
    try { await setState(SUM_KEY, sums); } catch (e) { console.error('[watch] 요약 저장 실패:', e.message); }
  }, 10000);
}
function wantSummary(id) {
  const c = sums[id];
  if (c && Date.now() - c.at < SUM_TTL_MS) return c;
  if (!sumPending.has(id) && sumPending.size < SUM_BATCH) {
    sumPending.add(id);
    tkFetch(`https://www.trackify.kr/api/v1/p/soop/sanctions/user/${encodeURIComponent(id)}/summary`)
      .then((j) => { sums[id] = { t: j.total || 0, k: j.kick || 0, m: j.mute || 0, s: j.streamerCount || 0, at: Date.now() }; saveSumsSoon(); })
      .catch((e) => console.error('[watch] 요약 받기 실패', id, e.message))
      .finally(() => sumPending.delete(id));
  }
  return c || null; // 오래된 값이라도 있으면 일단 쓴다
}

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
    const since90 = kstString(-KEEP_DAYS);
    for (const it of byUser.get(u.id) || []) { if (it[3] < since90) break; count(it[2], it[3]); }
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

  // 제재 순위 (3페이지): 저장해 둔 이 방송 제재 기록(최근 90일)에서 기간 안의 제재를 사람별로 센다.
  // days=all 이면 저장해 둔 전체 기간. scope=all 이면 '모든 방송' 숫자로 순위를 매긴다:
  // 이 기간에 이상호 방송에서 제재받은 사람 중 이상호 방송 제재가 많은 상위 RANK_POOL 명을 후보로,
  // 그 사람들이 모든 방송에서 받은 제재(트래키파이 요약)로 다시 정렬한다. 요약은 천천히 채워진다.
  const RANK_POOL = 300;
  app.get('/api/sanctions/ranking', async (req, res) => {
    await ensureLoaded();
    const allTime = req.query.days === 'all';
    const days = allTime ? 'all' : Math.min(KEEP_DAYS, Math.max(1, parseInt(req.query.days, 10) || 30));
    const scope = req.query.scope === 'all' ? 'all' : 'here';
    const sort = ['total', 'kicks', 'mutes'].includes(req.query.sort) ? req.query.sort : 'total';
    const limit = Math.min(500, Math.max(10, parseInt(req.query.limit, 10) || 100));
    const cutoff = allTime ? STORE_FROM : kstString(-days);
    const present = chatStatus.state === 'live' ? presentUsers() : new Map();
    let rows = [];
    let sanctionCount = 0;
    for (const [id, items] of byUser) {
      let kicks = 0, mutes = 0, last = '', nick = '';
      for (const it of items) { // 최신순
        if (it[3] < cutoff) break;
        if (it[2] === 'K') kicks++; else mutes++;
        if (!last) { last = it[3]; nick = it[1]; }
      }
      const total = kicks + mutes;
      if (!total) continue;
      sanctionCount += total;
      rows.push({ id, nick: nick || id, total, kicks, mutes, last, inRoom: present.has(id) });
    }
    let progress = null;
    if (scope === 'all') {
      await loadSums();
      rows.sort((a, b) => b.total - a.total || (a.last < b.last ? 1 : -1));
      const pool = rows.slice(0, RANK_POOL);
      const ranked = [];
      for (const r of pool) {
        const sm = wantSummary(r.id);
        if (!sm) continue;
        // 이상호 방송 숫자는 here 로 따로 남기고, 순위용 숫자는 모든 방송 기준으로 바꾼다
        ranked.push({ ...r, here: { total: r.total, kicks: r.kicks, mutes: r.mutes }, total: sm.t, kicks: sm.k, mutes: sm.m, streamers: sm.s });
      }
      progress = { checked: ranked.length, pool: pool.length };
      rows = ranked;
    }
    // 고른 기준 → 전체 → 최근 제재 순으로 정렬. 같은 숫자면 같은 순위.
    rows.sort((a, b) => b[sort] - a[sort] || b.total - a.total || (a.last < b.last ? 1 : -1));
    let rank = 0, prev = null;
    rows.forEach((r, i) => { if (r[sort] !== prev) { rank = i + 1; prev = r[sort]; } r.rank = rank; });
    const oldest = sanctions.items.length ? sanctions.items[sanctions.items.length - 1][3].slice(0, 10) : '';
    res.json({
      days, sort, scope, syncedAt: sanctions.syncedAt, people: scope === 'all' ? progress.pool : rows.length, sanctions: sanctionCount,
      progress, history: { from: oldest, complete: Boolean(sanctions.complete), filling: backfilling },
      list: rows.slice(0, limit),
    });
  });

  // 이 방송에서 받은 최근 90일 제재만 (저장해 둔 기록에서).
  app.get('/api/sanctions/user', async (req, res) => {
    await ensureLoaded();
    const id = normId(String(req.query.id || '').trim());
    if (!id) return res.status(400).json({ error: '아이디가 필요합니다' });
    const since90 = kstString(-KEEP_DAYS);
    const items = (byUser.get(id) || []).filter((it) => it[3] >= since90);
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
