// push.js — 방송 알림 (웹 푸시)
//
// 매니저가 작업실에서 '🔔 방송 알림'을 켜면 그 기기(브라우저)의 구독 정보를 저장해 두고,
// 서버가 방송 시작·종료·제목 변경을 알아채면 (watch.js 의 채팅 연결 상태) 구독한 기기 모두에 알림을 보낸다.
// 사이트를 닫아 둬도 알림이 온다. 아이폰은 사이트를 '홈 화면에 추가'한 뒤 그 아이콘으로 열어서 켜야 한다.
//
// VAPID 키(알림 서명 열쇠)는 환경변수(VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)가 있으면 쓰고,
// 없으면 처음 켤 때 만들어 저장소에 저장해 둔다. 키가 바뀌면 모두 다시 켜야 하므로 한 번 만든 키는 계속 쓴다.
//
// 같은 방송에 알림이 두 번 가지 않게 방송 번호(bno)로 마지막 알림을 기억한다
// (서버 재시작·채팅 재연결 때 '방송 켜짐'이 다시 잡혀도 같은 bno 면 보내지 않는다).

const webpush = require('web-push');
const { getState, setState } = require('./store');
const auth = require('./auth');

const SUBS_KEY = 'pushSubs';
const VAPID_KEY = 'vapidKeys';
const LAST_KEY = 'pushLast';
const STREAM_URL = 'https://play.sooplive.co.kr/lshooooo';
const KINDS = ['start', 'end', 'title'];
const DEFAULT_PREFS = { start: true, end: false, title: false };

let subs = null; // [{ endpoint, keys, name, ua, at, prefs }]
let last = null; // { bno, title, startedAt, ended }
let ready = null;
let publicKey = '';

function load() {
  if (!ready) {
    ready = (async () => {
      let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
      if (!pub || !priv) {
        let saved = await getState(VAPID_KEY, null);
        if (!saved || !saved.publicKey || !saved.privateKey) {
          saved = webpush.generateVAPIDKeys();
          await setState(VAPID_KEY, saved);
          console.log('[push] 알림 서명 열쇠(VAPID)를 새로 만들었습니다');
        }
        pub = saved.publicKey; priv = saved.privateKey;
      }
      webpush.setVapidDetails('https://lshooooo-schedule-server.onrender.com', pub, priv);
      publicKey = pub;
      const s = await getState(SUBS_KEY, []);
      subs = Array.isArray(s) ? s : [];
      last = (await getState(LAST_KEY, null)) || { bno: '', ended: true };
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
const saveSubs = () => setState(SUBS_KEY, subs);
const saveLast = () => setState(LAST_KEY, last);

function kstToday() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); }
function hm(ms) { const d = new Date(ms + 9 * 3600 * 1000); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); }

// 구독한 기기 중 이 종류(kind)를 켠 곳에 보낸다. 없어진 구독(404·410)은 지운다.
async function send(kind, payload, only) {
  await load();
  const targets = subs.filter((s) => (only ? s.endpoint === only : s.prefs && s.prefs[kind]));
  if (!targets.length) return { sent: 0, failed: 0 };
  const body = JSON.stringify(payload);
  let sent = 0, failed = 0;
  const gone = new Set();
  await Promise.all(targets.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: kind === 'start' ? 3 * 3600 : 3600, urgency: 'high' });
      sent++;
    } catch (e) {
      failed++;
      if (e.statusCode === 404 || e.statusCode === 410) gone.add(s.endpoint);
      else console.error('[push] 보내기 실패:', e.statusCode || '', e.body || e.message);
    }
  }));
  if (gone.size) { subs = subs.filter((s) => !gone.has(s.endpoint)); await saveSubs(); }
  console.log(`[push] ${kind} 알림: ${sent}곳 보냄${failed ? `, ${failed}곳 실패` : ''}`);
  return { sent, failed };
}

// ---- 방송 상태 → 알림 (watch.js 가 부른다) ----
async function onStatus(s) {
  try {
    await load();
    if (s.state === 'live' && s.bno) {
      if (String(s.bno) === String(last.bno)) return; // 같은 방송: 재연결·재시작
      last = { bno: String(s.bno), title: s.title || '', startedAt: Date.now(), ended: false };
      await saveLast();
      const events = (await getState('events', {}))[kstToday()] || [];
      const today = events.map((e) => (e.time ? e.time + ' ' : '') + e.title).join(' · ');
      await send('start', {
        title: '🔴 이상호 방송 시작',
        body: (s.title || '방송이 켜졌어요') + (today ? '\n📅 오늘 일정: ' + today : ''),
        tag: 'live-' + s.bno, url: STREAM_URL,
      });
    } else if (s.state === 'offline' && last.bno && !last.ended) {
      last.ended = true;
      await saveLast();
      const mins = last.startedAt ? Math.round((Date.now() - last.startedAt) / 60000) : 0;
      await send('end', {
        title: '⚫ 이상호 방송 종료',
        body: (last.title || '방송이 끝났어요') + (mins ? `\n${hm(last.startedAt)}부터 약 ${mins >= 60 ? Math.floor(mins / 60) + '시간 ' : ''}${mins % 60}분` : ''),
        tag: 'end-' + last.bno, url: '/',
      });
    }
  } catch (e) { console.error('[push] 상태 알림 실패:', e.message); }
}
async function onTitle(title) {
  try {
    await load();
    if (!last.bno || last.ended || !title || title === last.title) return;
    last.title = title;
    await saveLast();
    await send('title', { title: '✏️ 방송 제목 변경', body: title, tag: 'title-' + last.bno, url: STREAM_URL });
  } catch (e) { console.error('[push] 제목 알림 실패:', e.message); }
}

function cleanPrefs(p) {
  const out = {};
  for (const k of KINDS) out[k] = p && p[k] !== undefined ? Boolean(p[k]) : DEFAULT_PREFS[k];
  return out;
}

function mount(app) {
  app.get('/api/push/key', async (req, res) => {
    await load();
    res.json({ publicKey });
  });
  // 이 기기의 설정 (endpoint 로 찾는다)
  app.post('/api/push/me', async (req, res) => {
    await load();
    const ep = String((req.body || {}).endpoint || '');
    const s = subs.find((x) => x.endpoint === ep);
    res.json({ subscribed: Boolean(s), prefs: s ? s.prefs : DEFAULT_PREFS, count: subs.length });
  });
  app.post('/api/push/subscribe', async (req, res) => {
    await load();
    const sub = (req.body || {}).subscription || {};
    if (!sub.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ error: '알림 구독 정보가 올바르지 않아요' });
    }
    const prefs = cleanPrefs((req.body || {}).prefs);
    const name = auth.who(req) || '';
    const ua = String(req.get('user-agent') || '').slice(0, 160);
    const old = subs.find((x) => x.endpoint === sub.endpoint);
    if (old) Object.assign(old, { keys: sub.keys, prefs, name: name || old.name, ua });
    else {
      if (subs.length >= 200) return res.status(400).json({ error: '알림 받는 기기가 너무 많아요 (200대까지)' });
      subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, name, ua, at: Date.now(), prefs });
    }
    await saveSubs();
    res.json({ ok: true, prefs, count: subs.length });
  });
  app.post('/api/push/unsubscribe', async (req, res) => {
    await load();
    const ep = String((req.body || {}).endpoint || '');
    subs = subs.filter((x) => x.endpoint !== ep);
    await saveSubs();
    res.json({ ok: true, count: subs.length });
  });
  // 이 기기에만 시험 알림
  app.post('/api/push/test', async (req, res) => {
    await load();
    const ep = String((req.body || {}).endpoint || '');
    if (!subs.some((x) => x.endpoint === ep)) return res.status(404).json({ error: '이 기기는 아직 알림을 켜지 않았어요' });
    const r = await send('test', { title: '🔔 알림 테스트', body: '방송 알림이 이렇게 와요. 누르면 작업실이 열려요.', tag: 'test', url: '/' }, ep);
    if (!r.sent) return res.status(502).json({ error: '알림을 보내지 못했어요. 알림을 껐다가 다시 켜 보세요.' });
    res.json({ ok: true });
  });
}

module.exports = { mount, onStatus, onTitle, load };
