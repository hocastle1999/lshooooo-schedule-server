// 롤 월즈 일정/결과 크롤러 (네이버 e스포츠 일정 페이지)
//
// 페이지가 자바스크립트로 그려지기 때문에 헤드리스 브라우저로 열고,
// 화면에 보이는 "글자 조각(텍스트 노드)"들을 순서대로 모은 뒤 날짜/경기 단위로 해석합니다.
// (CSS 때문에 글자가 붙어서 나오는 문제를 피하려고 innerText 대신 텍스트 노드를 씁니다.)
const { chromium } = require('playwright');
const { findChrome } = require('./crawler');

const WORLDS_URL = 'https://game.naver.com/esports/League_of_Legends/schedule/world_championship';

function pad(n) { return String(n).padStart(2, '0'); }

const DATE_RE = /^(\d{1,2})월\s*(\d{1,2})일\s*\(([일월화수목금토])\)/;
const TIME_RE = /^(\d{1,2}):(\d{2})\s*(.*)$/;
const STATUS_RE = /^(종료|예정|진행\s?중|LIVE|라이브|연기|취소)$/i;
const BUTTON_RE = /^(다시보기|알림\s?받기|승부예측|중계예정|중계\s?보기|하이라이트|티켓|VS|vs|:|：|-)$/;
const FOOTER_RE = /^네이버 이용약관/;

function statusKind(s) {
  if (/종료/.test(s)) return 'finished';
  if (/LIVE|라이브|진행/i.test(s)) return 'live';
  if (/연기|취소/.test(s)) return 'postponed';
  return 'scheduled';
}

// tokens: 화면 글자 조각 배열 (위에서 아래 순서). year: 이 페이지가 보여주는 연도.
// 한 경기는 "시간 → (상태) → 스테이지 → 팀1 → (점수) → (점수) → 팀2 → (버튼들) → 장소" 순서로 나옵니다.
function parseTokens(tokens, year) {
  const matches = [];
  let dateKey = null;
  let row = null; // { dateKey, time, tokens: [] }

  function finishRow() {
    if (!row) return;
    const r = row;
    row = null;
    let status = '';
    const rest = [];
    for (const t of r.tokens) {
      if (!status && STATUS_RE.test(t)) { status = t; continue; }
      if (BUTTON_RE.test(t)) continue;
      rest.push(t);
    }
    if (!rest.length) return;
    const stage = rest[0];
    const scores = [];
    const names = [];
    for (let i = 1; i < rest.length; i++) {
      const t = rest[i];
      const both = t.match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/);
      if (both) { scores.push(Number(both[1]), Number(both[2])); continue; }
      if (/^\d{1,2}$/.test(t)) { scores.push(Number(t)); continue; }
      names.push(t);
    }
    if (names.length < 2) return;
    matches.push({
      dateKey: r.dateKey,
      time: r.time,
      status: statusKind(status),
      stage,
      team1: names[0],
      team2: names[1],
      score1: scores.length >= 2 ? scores[0] : null,
      score2: scores.length >= 2 ? scores[1] : null,
      venue: names[2] || '',
    });
  }

  for (const raw of tokens) {
    const t = String(raw).replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (FOOTER_RE.test(t)) break;
    const d = t.match(DATE_RE);
    if (d) {
      finishRow();
      dateKey = `${year}-${pad(d[1])}-${pad(d[2])}`;
      continue;
    }
    if (!dateKey || t === '오늘') continue;
    const tm = t.match(TIME_RE);
    if (tm) {
      finishRow();
      row = { dateKey, time: `${pad(tm[1])}:${tm[2]}`, tokens: [] };
      // "03:00종료플레이인 1R" 처럼 한 조각에 붙어 나오는 경우도 처리
      const remain = (tm[3] || '').trim();
      if (remain) {
        const sm = remain.match(/^(종료|예정|진행\s?중|LIVE|라이브|연기|취소)\s*(.*)$/i);
        if (sm) { row.tokens.push(sm[1]); if (sm[2]) row.tokens.push(sm[2]); }
        else row.tokens.push(remain);
      }
      continue;
    }
    if (row) row.tokens.push(t);
  }
  finishRow();
  return matches;
}

async function fetchMonthTokens(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  try {
    await page.waitForFunction(() => /\d{1,2}월\s*\d{1,2}일\s*\([일월화수목금토]\)/.test(document.body.innerText), { timeout: 20000 });
  } catch (e) {
    console.log('[worlds] 일정 날짜 표시를 기다리다 시간 초과:', url);
  }
  await page.waitForTimeout(1500);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(400);
  }
  return page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const p = n.parentElement;
      if (!p) continue;
      const tag = p.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
      const v = n.nodeValue.replace(/\s+/g, ' ').trim();
      if (v) out.push(v);
    }
    return out;
  });
}

// baseUrl: 테스트용으로 바꿀 수 있음. 이번 달 + 다음 달을 가져옵니다.
async function runWorldsCrawl(baseUrl) {
  const base = baseUrl || WORLDS_URL;
  const executablePath = findChrome();
  const browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { headless: true });
  try {
    const page = await browser.newPage({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1000, height: 1400 },
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9' },
    });
    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    const y = kst.getUTCFullYear();
    const m = kst.getUTCMonth() + 1;
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    const months = [
      { year: y, key: `${y}-${pad(m)}` },
      { year: ny, key: `${ny}-${pad(nm)}` },
    ];
    const all = [];
    for (const mo of months) {
      const url = base + (base.includes('?') ? '&' : '?') + 'date=' + mo.key;
      const tokens = await fetchMonthTokens(page, url);
      const found = parseTokens(tokens, mo.year);
      console.log(`[worlds] ${mo.key}: 글자 조각 ${tokens.length}개, 경기 ${found.length}개`);
      if (!found.length) console.log('[worlds] 미리보기:', JSON.stringify(tokens.slice(0, 40)));
      all.push(...found);
    }
    // 같은 경기가 두 달 페이지에 겹쳐 나오면 한 번만
    const seen = new Set();
    const matches = all.filter((x) => {
      const k = [x.dateKey, x.time, x.stage, x.team1, x.team2].join('|');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    matches.sort((a, b) => (a.dateKey + a.time).localeCompare(b.dateKey + b.time));
    matches.forEach((mt, i) => { mt.id = 'w' + (i + 1); });
    const now = new Date(Date.now() + 9 * 3600 * 1000);
    const label = `${now.getUTCMonth() + 1}월 ${now.getUTCDate()}일 ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} 기준`;
    return { matches, updatedLabel: label, sourceUrl: WORLDS_URL };
  } finally {
    await browser.close();
  }
}

module.exports = { runWorldsCrawl, parseTokens, WORLDS_URL };
