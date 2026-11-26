// gggl.js — SOOP e스포츠(GGGL) 대회 대진표 (작업실 '날짜 미정 일정' 아래 카드)
//
// esports.sooplive.com 대회 페이지가 쓰는 공개 API(ggglapi.sooplive.com)를 그대로 부른다.
//   info {idx}                          → 대회 이름
//   match/stage {ggglIdx}               → 단계 (예선 1차, 본선 8강 …), closestYn = 지금 진행 중
//   match/group {ggglIdx, stageIdx}     → 조 (A조, B조 …)
//   match/round-match {…, groupIdx}     → 라운드별 경기 (exposeSort 양수 = 승자 쪽, 음수 = 패자 쪽)
// 5분마다 전부 다시 받아 저장한다 (대회 하나에 요청 10여 개). 실패하면 예전 데이터를 그대로 둔다.
// 대회는 작업실 카드의 '대회 바꾸기'에서 대회 페이지 주소를 붙여 넣어 바꾼다.

const { getState, setState } = require('./store');

const KEY = 'gggl';
const API = 'https://ggglapi.sooplive.com/api/v1/gggl/';
const DEFAULT_IDX = 3017; // Whiff 2026 LoL 멸망전 시즌2
const EVERY_MS = 5 * 60 * 1000;

let busy = false;

async function post(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(path + ' HTTP ' + res.status);
  const j = await res.json();
  if (j.result !== 1) throw new Error(path + ' ' + (j.message || '실패'));
  return j.data || [];
}

function kstLabel() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} 기준`;
}

// 경기 하나 → 화면에 필요한 것만 (팀원 목록 등은 버린다)
function slimMatch(m) {
  return {
    date: m.matchDate || '',
    label: m.etcInfo || '',
    finish: Boolean(m.finishYn),
    bye: Boolean(m.byeYn),
    bo: m.totalMatchCnt || null,
    teams: (m.matchTeamList || []).sort((a, b) => a.sort - b.sort).map((t) => ({
      name: t.teamTitle || '',
      score: typeof t.score === 'number' ? t.score : null,
      win: t.status === 1, // 1 승, 2 패, 0 아직
      lose: t.status === 2,
    })),
  };
}

async function fetchAll(ggglIdx) {
  const info = (await post('info', { idx: ggglIdx }))[0] || {};
  const stages = await post('match/stage', { ggglIdx });
  const out = [];
  for (const s of stages.sort((a, b) => a.sort - b.sort)) {
    const groups = await post('match/group', { ggglIdx, stageIdx: s.idx });
    const gOut = [];
    for (const g of groups.filter((x) => x.exposeYn !== false).sort((a, b) => a.sort - b.sort)) {
      const rounds = await post('match/round-match', { ggglIdx, stageIdx: s.idx, groupIdx: g.idx });
      gOut.push({
        title: g.groupTitle || '',
        closest: Boolean(g.closestYn),
        rounds: rounds
          .filter((r) => (r.matchList || []).length)
          .map((r) => ({
            expose: r.exposeSort,
            final: Boolean(r.finalMatchYn),
            third: Boolean(r.thirdPlaceMatchYn),
            bo: r.totalMatchCnt || null,
            from: r.minMatchDate || '',
            to: r.maxMatchDate || '',
            matches: r.matchList.sort((a, b) => a.sort - b.sort).map(slimMatch),
          })),
      });
    }
    out.push({ title: s.stageTitle || '', type: s.stageType || '', closest: Boolean(s.closestYn), groups: gOut });
  }
  return {
    ggglIdx,
    title: info.title || '',
    url: `https://esports.sooplive.com/gggl/tournament/lolbjmatch/${ggglIdx}/table`,
    status: info.status || '',
    updatedAt: Date.now(),
    updatedLabel: kstLabel(),
    stages: out,
  };
}

async function refresh(reason) {
  if (busy) return { skipped: true };
  busy = true;
  try {
    const cur = await getState(KEY, null);
    const idx = (cur && cur.ggglIdx) || DEFAULT_IDX;
    const data = await fetchAll(idx);
    if (!data.stages.length) throw new Error('대진표가 비어 있어서 예전 것을 그대로 둡니다');
    await setState(KEY, data);
    console.log(`[gggl] (${reason}) ${data.title} 단계 ${data.stages.length}개 갱신`);
    return { ok: true };
  } catch (e) {
    console.error(`[gggl] (${reason}) 실패:`, e.message);
    return { ok: false, error: e.message };
  } finally {
    busy = false;
  }
}

function start() {
  setTimeout(() => refresh('시작'), 20 * 1000);
  setInterval(() => refresh('정기 갱신'), EVERY_MS);
}

function mount(app) {
  // 대회 바꾸기: 대회 페이지 주소나 번호를 받는다
  app.post('/api/gggl', async (req, res) => {
    const raw = String((req.body || {}).url || '').trim();
    const m = raw.match(/tournament\/[^/]+\/(\d+)/) || raw.match(/^(\d{1,7})$/);
    if (!m) return res.status(400).json({ error: '대회 페이지 주소를 확인해주세요 (예: https://esports.sooplive.com/gggl/tournament/lolbjmatch/3017/table)' });
    const idx = Number(m[1]);
    try {
      const data = await fetchAll(idx);
      if (!data.stages.length) return res.status(404).json({ error: '그 대회에는 아직 대진표가 없어요' });
      await setState(KEY, data);
      res.json({ ok: true, gggl: data });
    } catch (e) {
      res.status(502).json({ error: '대진표를 가져오지 못했어요: ' + e.message });
    }
  });
  app.post('/api/gggl/refresh', async (req, res) => {
    const r = await refresh('수동 새로고침');
    if (!r.ok && !r.skipped) return res.status(502).json({ error: r.error });
    res.json({ ok: true, gggl: await getState(KEY, null) });
  });
}

module.exports = { mount, start, refresh, KEY };
