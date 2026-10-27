// roulette.js — 후원 룰렛 명단 (soopchat-roulette.exe 를 사이트로 옮긴 것)
//
// SOOP 채팅에 접속해서 별풍선 / 애드벌룬 / 도전미션 / 대결미션 후원을 받을 때마다
// 후원자 닉네임(아이디)별로 누적하고, lazygyu/roulette 이름 입력창에 그대로
// 붙여넣을 수 있는 "닉네임(아이디)*배수,..." 명단을 만든다.
//
// exe 와 다른 점:
//   - 집계/설정은 store(Upstash)에 저장돼서, 서버가 재시작되거나 재배포돼도
//     명단이 그대로 남고 수집 중이었으면 자동으로 다시 접속한다.
//   - 수집 중지/다른 스트리머로 변경이 된다 (exe 는 실행당 한 번만 연결 가능했음).
//   - Render 무료 플랜은 15분간 접속이 없으면 잠들어서 채팅 연결도 끊기므로,
//     수집 중에는 10분마다 자기 자신에게 요청을 보내 깨어 있게 한다.

const { SoopChat } = require('./soop-chat');
const { getState, setState } = require('./store');

const CATEGORIES = ['별풍선', '애드벌룬', '도전미션', '대결미션'];
const STATE_KEY = 'roulette';
const LOG_KEY = 'roulette_log';
const MAX_LOG_ROWS = 3000;
const SAVE_DELAY_MS = 1500;
const KEEP_AWAKE_MS = 10 * 60 * 1000;

// svc 121(미션 별풍선)의 type 값 — 2026-09-19 실제 방송 로그로 확인됨.
const MISSION_CHALLENGE = 'CHALLENGE_GIFT'; // 도전미션
const MISSION_BATTLE = 'GIFT'; // 대결미션

function defaultEnabled() {
  const m = {};
  CATEGORIES.forEach((c) => { m[c] = true; });
  return m;
}

let state = {
  active: false,
  streamer: 'lshooooo',
  unit: 1,
  bonus: true,
  enabled: defaultEnabled(),
  entries: [], // [{ key, id, name, counts: { 카테고리: 개수 } }]
};
let log = []; // [[시간, 종류, 아이디, 닉네임, 개수, 미션제목, 미션원본유형]]
let chat = null;
let chatStatus = { state: 'idle', message: '대기 중', title: '' };
let saveTimer = null;
let keepAwakeTimer = null;
let loading = null;

// ---- 계산 (aggregator.go 와 동일) ----

function totalOf(entry, enabled) {
  let sum = 0;
  for (const [cat, v] of Object.entries(entry.counts)) if (enabled[cat]) sum += v;
  return sum;
}

// 기준 개수(unit)로 나눈 몫이 기본 배수. bonus 면 기본 배수 10마다 +1 (ManPinball 방식).
// 예: 기준 10개, 250개 → 25 + 2 = 27. 기준에 못 미치면 0(명단 제외).
function multiplierOf(count, unit, bonus) {
  unit = Math.max(1, unit | 0);
  let base = Math.floor(count / unit);
  if (base < 1) return 0;
  if (bonus) base += Math.floor(base / 10);
  return base;
}

// lazygyu/roulette 가 구분자로 쓰는 쉼표/줄바꿈이 이름에 섞이지 않게 한다.
function sanitize(s) {
  return String(s || '').replace(/[,\r\n]/g, ' ').trim();
}

function formatName(e) {
  if (!e.id || e.id === e.name) return sanitize(e.name);
  return sanitize(e.name) + '(' + sanitize(e.id) + ')';
}

function rouletteText() {
  return state.entries
    .map((e) => ({ e, m: multiplierOf(totalOf(e, state.enabled), state.unit, state.bonus) }))
    .filter((x) => x.m >= 1)
    .map((x) => formatName(x.e) + '*' + x.m)
    .join(',');
}

function snapshot() {
  return {
    active: state.active,
    streamer: state.streamer,
    unit: state.unit,
    bonus: state.bonus,
    enabled: state.enabled,
    categories: CATEGORIES,
    status: state.active ? chatStatus : { state: 'idle', message: '수집 중지됨', title: '' },
    entries: state.entries.map((e) => {
      const total = totalOf(e, state.enabled);
      return { id: e.id, name: e.name, counts: e.counts, total, multiplier: multiplierOf(total, state.unit, state.bonus) };
    }),
    rouletteText: rouletteText(),
    logCount: log.length,
  };
}

// ---- 저장 ----

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
}

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    await setState(STATE_KEY, state);
    await setState(LOG_KEY, log);
  } catch (e) {
    console.error('[roulette] 저장 실패:', e.message);
  }
}

function nowLabel() {
  // Render 서버 시간대는 UTC 라서 한국 시간으로 맞춘다.
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function addLog(category, id, name, count, title, rawType) {
  log.push([nowLabel(), category, id || '', name || '', count, title || '', rawType || '']);
  if (log.length > MAX_LOG_ROWS) log = log.slice(-MAX_LOG_ROWS);
}

// ---- 후원 처리 ----

function addDonation(category, id, name, count, title, rawType) {
  id = String(id || '').replace(/\(\d+\)$/, ''); // "abc(2)" 다중 접속 표시 제거
  name = String(name || '').trim() || id;
  const key = id || name;
  if (!key) return;
  count = count > 0 ? count : 1;

  let e = state.entries.find((x) => x.key === key);
  if (!e) {
    e = { key, id, name, counts: {} };
    state.entries.push(e);
  }
  e.name = name; // 닉네임이 바뀌었을 수 있으니 최신 값으로
  if (id) e.id = id;
  e.counts[category] = (e.counts[category] || 0) + count;

  addLog(category, id, name, count, title, rawType);
  console.log(`[roulette] [${category}] ${name}(${id}) x${count}`);
  scheduleSave();
}

// parts 는 soop-chat.js 의 parsePacket 결과 (헤더 다음 \f 부터 나눈 필드).
// 필드 위치는 halfdogs/soopchat 의 parseBalloon / parseAdballoon 과 같다
// (그쪽은 헤더까지 포함해서 나누므로 인덱스가 1씩 크다).
function onPacket({ code, parts }) {
  if (code === 18) {
    // 별풍선: bjId | userId | nick | count | ...
    const count = parseInt(parts[3], 10);
    if (parts[1] && Number.isFinite(count)) addDonation('별풍선', parts[1], parts[2], count);
  } else if (code === 87) {
    // 애드벌룬: - | - | userId | nick | ... | count(9)
    const count = parseInt(parts[9], 10);
    if (parts[2] && Number.isFinite(count)) addDonation('애드벌룬', parts[2], parts[3], count);
  } else if (code === 121) {
    // 미션 별풍선: JSON. 후원이 아닌 알림(CHALLENGE_NOTICE 등)도 오므로 필드를 꼭 확인한다.
    let data;
    try { data = JSON.parse(parts[0]); } catch { return; }
    if (!data || typeof data !== 'object') return;
    const count = parseInt(data.gift_count, 10);
    if (!(count > 0)) return;
    const id = typeof data.user_id === 'string' ? data.user_id : '';
    const nick = typeof data.user_nick === 'string' ? data.user_nick : '';
    if (!id && !nick) return;
    const type = typeof data.type === 'string' ? data.type : '';
    // 확인되지 않은 새 type 은 일단 대결미션으로 잠정 분류 (로그에 원본 type 이 남는다)
    const category = type.toUpperCase() === MISSION_CHALLENGE ? '도전미션' : '대결미션';
    if (type && type.toUpperCase() !== MISSION_CHALLENGE && type.toUpperCase() !== MISSION_BATTLE) {
      console.log(`[roulette] 처음 보는 미션 유형 type=${type} → 대결미션으로 분류`);
    }
    addDonation(category, id || nick, nick || id, count, data.title, type);
  }
}

// ---- 채팅 연결 ----

function startChat() {
  stopChat();
  chatStatus = { state: 'connecting', message: '연결 준비 중', title: '' };
  chat = new SoopChat(state.streamer).start();
  chat.on('status', (s) => {
    chatStatus = { state: s.state, message: s.message, title: s.title || chatStatus.title || '' };
    console.log(`[roulette] ${state.streamer}: ${s.state} - ${s.message}`);
  });
  chat.on('packet', onPacket);

  clearInterval(keepAwakeTimer);
  const selfUrl = process.env.RENDER_EXTERNAL_URL;
  if (selfUrl) {
    keepAwakeTimer = setInterval(() => {
      fetch(selfUrl + '/api/roulette/ping', { signal: AbortSignal.timeout(15000) }).catch(() => {});
    }, KEEP_AWAKE_MS);
  }
}

function stopChat() {
  clearInterval(keepAwakeTimer);
  keepAwakeTimer = null;
  if (chat) {
    chat.removeAllListeners();
    chat.stop();
    chat = null;
  }
}

function cleanSettings(body) {
  const unit = Math.max(1, parseInt(body.unit, 10) || 1);
  const bonus = body.bonus !== false;
  const enabled = {};
  CATEGORIES.forEach((c) => { enabled[c] = !body.enabled || body.enabled[c] !== false; });
  return { unit, bonus, enabled };
}

function ensureLoaded() {
  if (!loading) {
    loading = (async () => {
      const saved = await getState(STATE_KEY, null);
      if (saved && typeof saved === 'object') state = { ...state, ...saved, enabled: { ...defaultEnabled(), ...(saved.enabled || {}) } };
      const savedLog = await getState(LOG_KEY, []);
      if (Array.isArray(savedLog)) log = savedLog;
    })();
  }
  return loading;
}

// 서버가 켜질 때 호출: 수집 중이던 상태였으면 다시 접속한다.
async function resume() {
  await ensureLoaded();
  if (state.active) {
    console.log(`[roulette] 이전에 수집 중이던 ${state.streamer} 채팅에 다시 접속합니다.`);
    startChat();
  }
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function mount(app) {
  app.get('/api/roulette/ping', (req, res) => res.json({ ok: true }));

  app.get('/api/roulette', async (req, res) => {
    await ensureLoaded();
    res.json(snapshot());
  });

  app.post('/api/roulette/start', async (req, res) => {
    await ensureLoaded();
    const body = req.body || {};
    const streamer = String(body.streamer || '').trim();
    if (!/^[A-Za-z0-9_]{2,40}$/.test(streamer)) {
      return res.status(400).json({ error: '스트리머(BJ) 아이디를 확인해주세요' });
    }
    Object.assign(state, cleanSettings(body), { streamer, active: true });
    startChat();
    await saveNow();
    res.json(snapshot());
  });

  app.post('/api/roulette/stop', async (req, res) => {
    await ensureLoaded();
    state.active = false;
    stopChat();
    chatStatus = { state: 'idle', message: '수집 중지됨', title: '' };
    await saveNow();
    res.json(snapshot());
  });

  // 기준 개수 / 보너스 / 체크박스는 언제든 바꿀 수 있고 바로 다시 계산된다.
  app.post('/api/roulette/filter', async (req, res) => {
    await ensureLoaded();
    Object.assign(state, cleanSettings(req.body || {}));
    scheduleSave();
    res.json(snapshot());
  });

  // 다음 라운드용으로 집계만 지운다 (채팅 연결은 유지).
  app.post('/api/roulette/reset', async (req, res) => {
    await ensureLoaded();
    state.entries = [];
    addLog('리셋', '', '', 0, '', '');
    await saveNow();
    res.json(snapshot());
  });

  app.get('/api/roulette/log.csv', async (req, res) => {
    await ensureLoaded();
    const header = ['시간', '종류', '아이디', '닉네임', '개수', '미션제목', '미션원본유형'];
    const body = [header, ...log].map((row) => row.map(csvCell).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('후원기록.csv'));
    res.send('﻿' + body + '\r\n'); // BOM: 엑셀에서 한글이 안 깨지게
  });
}

module.exports = { mount, resume, multiplierOf, onPacket, _state: () => state };
