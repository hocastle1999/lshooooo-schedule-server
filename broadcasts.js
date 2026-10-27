// broadcasts.js — 날짜별 방송 여부 (달력의 🔵/❌ 표시)
//
// 트래키파이(trackify.kr)에 공개된 이 방송의 방송 기록(시작·종료 시각)을 달 단위로 받아서
// 날짜(한국 시간 0시~24시)마다 방송이 켜져 있던 시간을 계산한다.
// 밤샘 방송은 걸쳐 있는 날짜 모두에 들어간다. 다만 자정을 30분 미만으로 넘긴 정도는 그 날짜에 넣지 않는다.
//
// 지난달 기록은 바뀌지 않으므로 한 번 받으면 store 에 저장해 두고 다시 받지 않는다.
// 이번 달은 24시간에 한 번 새로 받는다. 그래서 마지막으로 받은 날(until) 이후는 아직 모르는 날로 둔다.

const { getState, setState } = require('./store');

const STREAMER = 'lshooooo';
const STORE_KEY = 'broadcasts';
const FRESH_MS = 24 * 60 * 60 * 1000;
const MIN_MINUTES = 30;

let cache = null; // Promise → { months: { 'YYYY-MM': { fetchedAt, items: [[broadNo, startAt, endAt|null, title]] } } }
const inflight = new Map();

const pad = (n) => String(n).padStart(2, '0');
// 트래키파이 시각은 한국 시간 "YYYY-MM-DDTHH:mm:ss" 라서 같은 형식으로 다룬다.
const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19);
// "YYYY-MM-DDTHH:mm:ss"(한국 시간) → 비교·계산용 숫자(ms). 시간대는 상관없이 같은 기준이면 된다.
const ms = (s) => Date.parse(s + 'Z');
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${pad(last)}` };
}

async function fetchRange(from, to) {
  const url = `https://www.trackify.kr/api/v1/p/soop/streamer/${STREAMER}/broadcasts?from=${from}&to=${to}&size=100`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 lshooooo-schedule' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const items = (json.data || []).map((b) => [String(b.broadNo), b.startAt, b.broadDone === false ? null : b.endAt || null, b.title || '']);
  // 한 번에 30개 정도까지만 주므로, 더 있으면 기간을 반으로 나눠서 다시 받는다.
  if (json.more && from < to) {
    const mid = dayKey((ms(from + 'T00:00:00') + ms(to + 'T00:00:00')) / 2);
    const next = dayKey(ms(mid + 'T00:00:00') + 86400000);
    const [a, b] = await Promise.all([fetchRange(from, mid), fetchRange(next, to)]);
    return a.concat(b);
  }
  return items;
}

function loadCache() {
  if (!cache) {
    cache = getState(STORE_KEY, null).then((saved) => (saved && saved.months ? saved : { months: {} }));
  }
  return cache;
}

// 달이 다 끝난 뒤에 받은 기록이면 더는 바뀌지 않는다.
const isFinal = (ym, mo) => Boolean(mo) && new Date(mo.fetchedAt + 9 * 3600 * 1000).toISOString().slice(0, 10) > monthRange(ym).to;

async function getMonth(ym) {
  const c = await loadCache();
  const hit = c.months[ym];
  if (hit && (isFinal(ym, hit) || Date.now() - hit.fetchedAt < FRESH_MS)) return hit;
  if (ym > kstNow().slice(0, 7)) return { fetchedAt: Date.now(), items: [] }; // 아직 오지 않은 달
  if (!inflight.has(ym)) {
    const { from, to } = monthRange(ym);
    inflight.set(ym, fetchRange(from, to)
      .then(async (items) => {
        c.months[ym] = { fetchedAt: Date.now(), items };
        await setState(STORE_KEY, c);
        return c.months[ym];
      })
      .catch((e) => {
        console.error(`[broadcasts] ${ym} 방송 기록을 받지 못했습니다:`, e.message);
        if (hit) return hit; // 실패하면 예전에 받아 둔 기록이라도 쓴다
        throw e;
      })
      .finally(() => inflight.delete(ym)));
  }
  return inflight.get(ym);
}

// from~to 날짜마다 { minutes, titles } — 방송한 날만 들어 있다.
// until: 이 날짜 전까지는 기록이 확실하다 (기록을 받은 시각의 날짜). 그 뒤 날짜는 방송 안 함(❌)으로 단정하지 않는다.
async function daysBetween(from, to) {
  // 전날 밤에 시작해서 넘어온 방송도 잡도록 시작 하루 전 달까지 본다.
  const months = new Set();
  for (let t = ms(from + 'T00:00:00') - 86400000; t <= ms(to + 'T00:00:00'); t += 86400000) months.add(dayKey(t).slice(0, 7));
  const list = [...months];
  const seen = new Set();
  const items = [];
  let checkedAt = Date.now(); // 아직 바뀔 수 있는 달 중 가장 오래전에 받은 시각
  const fetched = [];
  for (const ym of list) fetched.push(await getMonth(ym)); // 트래키파이에 한꺼번에 요청하지 않도록 차례로
  fetched.forEach((mo, i) => {
    if (!isFinal(list[i], mo)) checkedAt = Math.min(checkedAt, mo.fetchedAt);
    // 받을 때 방송 중이던 것은 받은 시각까지만 센다
    const asOf = mo.fetchedAt + 9 * 3600 * 1000;
    for (const it of mo.items) if (!seen.has(it[0])) { seen.add(it[0]); items.push([...it, asOf]); }
  });

  const days = {};
  for (const [, startAt, endAt, title, asOf] of items) {
    const s = ms(startAt);
    const e = endAt ? ms(endAt) : asOf;
    for (let d = ms(dayKey(s) + 'T00:00:00'); d < e; d += 86400000) {
      const key = dayKey(d);
      if (key < from || key > to) continue;
      const minutes = Math.round((Math.min(e, d + 86400000) - Math.max(s, d)) / 60000);
      if (minutes <= 0) continue;
      const day = days[key] || (days[key] = { minutes: 0, titles: [] });
      day.minutes += minutes;
      if (!day.titles.includes(title)) day.titles.push(title);
    }
  }
  for (const key of Object.keys(days)) if (days[key].minutes < MIN_MINUTES) delete days[key];
  const until = new Date(checkedAt + 9 * 3600 * 1000).toISOString().slice(0, 10);
  return { days, until };
}

function mount(app) {
  app.get('/api/broadcasts', async (req, res) => {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const { from, to } = req.query;
    if (!re.test(from || '') || !re.test(to || '') || from > to || ms(to + 'T00:00:00') - ms(from + 'T00:00:00') > 62 * 86400000) {
      return res.status(400).json({ error: '기간을 확인해주세요' });
    }
    try {
      res.json(await daysBetween(from, to));
    } catch (e) {
      res.status(502).json({ error: '방송 기록을 받지 못했습니다: ' + e.message });
    }
  });
}

module.exports = { mount, daysBetween };
