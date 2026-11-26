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
      id: t.teamIdx || 0, // 대진 상세(팀원) 볼 때 쓴다
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

// ---- 대진 상세: 두 팀의 팀원과 포지션 (경기를 누를 때만 받아 온다, 10분 동안 다시 씀) ----
const ROLE_ORDER = ['탑', '정글', '미드', '원딜', '서폿'];
const versusCache = new Map(); // "a-b" → { at, data }
async function versus(a, b) {
  const key = a + '-' + b;
  const hit = versusCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
  const raw = await post('participation/team/member/versus/list', { teamIdx: a, versusTeamIdx: b });
  const data = raw.map((t) => ({
    id: t.idx,
    name: t.teamTitle || '',
    members: (t.members || [])
      .filter((m) => m.userId || m.userNick)
      .map((m) => ({ id: m.userId || '', nick: m.userNick || m.userId || '', role: m.role || '', leader: m.gradeType === 'TEAM_LEADER', sub: m.gradeType === 'TRAINEE' }))
      .sort((x, y) => (ROLE_ORDER.indexOf(x.role) + 1 || 9) - (ROLE_ORDER.indexOf(y.role) + 1 || 9)),
  }));
  versusCache.set(key, { at: Date.now(), data });
  if (versusCache.size > 200) versusCache.delete(versusCache.keys().next().value);
  return data;
}

function mount(app) {
  app.get('/api/gggl/versus', async (req, res) => {
    const a = parseInt(req.query.a, 10), b = parseInt(req.query.b, 10);
    if (!(a > 0) || !(b > 0)) return res.status(400).json({ error: '팀 번호가 필요해요' });
    try { res.json({ teams: await versus(a, b) }); }
    catch (e) { res.status(502).json({ error: '팀원 정보를 가져오지 못했어요: ' + e.message }); }
  });

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
