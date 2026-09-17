// 이상호 방송국 게시판(soop) 공지 크롤러
// 게시판이 자바스크립트로 내용을 그리는 페이지라서, 헤더 fetch 대신
// 헤드리스 브라우저로 렌더링된 텍스트를 읽어옵니다.
//
// - 매니저 PC(Windows)에 이미 크롬이 설치되어 있으면 그 크롬을 그대로 사용합니다
//   (별도 다운로드 없이 바로 실행).
// - 크롬을 못 찾으면(예: 클라우드 서버) Playwright가 직접 관리하는 Chromium을
//   사용합니다. 이 경우 배포 전에 `npx playwright install --with-deps chromium`
//   으로 미리 설치해둬야 합니다 (render.yaml에 이미 반영되어 있음).
const fs = require('fs');
const { chromium } = require('playwright');

const BOARD_URL = 'https://www.sooplive.com/station/lshooooo/board';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function todayParts() {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

// 게시글 블록은 "이상호" -> "- 방 송 공 지-" -> "공지..." 로 시작합니다.
function splitBlocks(text) {
  const marker = /이상호\s*\n-\s*방\s*송\s*공\s*지\s*-\s*\n공지/g;
  const idxs = [];
  let m;
  while ((m = marker.exec(text))) idxs.push(m.index);
  const blocks = [];
  for (let i = 0; i < idxs.length; i++) {
    const start = idxs[i];
    const end = i + 1 < idxs.length ? idxs[i + 1] : text.length;
    blocks.push(text.slice(start, end));
  }
  return blocks;
}

function parseBlock(block) {
  const lines = block.split('\n').map((s) => s.trim()).filter(Boolean);
  let idx = 0;
  while (idx < lines.length && !lines[idx].startsWith('공지')) idx++;
  if (idx >= lines.length) return null;
  const title = lines[idx].replace(/^공지\s*/, '').trim();
  idx++;

  const isNum = (s) => /^[0-9][0-9,]*$/.test(s);
  const contentLines = [];
  while (idx < lines.length && !isNum(lines[idx])) {
    contentLines.push(lines[idx]);
    idx++;
  }
  const content = contentLines.join(' ').trim();

  let likes = 0, comments = 0, views = 0;
  if (idx < lines.length && isNum(lines[idx])) { likes = Number(lines[idx].replace(/,/g, '')); idx++; }
  if (idx < lines.length && isNum(lines[idx])) { comments = Number(lines[idx].replace(/,/g, '')); idx++; }
  if (idx < lines.length && isNum(lines[idx])) { views = Number(lines[idx].replace(/,/g, '')); idx++; }

  let dateInfo = null;
  if (idx < lines.length) {
    const l = lines[idx];
    if (/^\d{4}-\d{2}-\d{2}$/.test(l)) dateInfo = { kind: 'explicit', value: l };
    else if (/(전|오늘)$/.test(l) && l.length <= 12) dateInfo = { kind: 'relative', value: l };
  }

  if (!title) return null;
  return { title, content, likes, comments, views, dateInfo };
}

function toDateKey(dateInfo, fallbackKey) {
  const t = todayParts();
  const todayKey = `${t.y}-${pad(t.m)}-${pad(t.d)}`;
  if (!dateInfo) return { key: fallbackKey || todayKey, approx: !fallbackKey ? false : true };
  if (dateInfo.kind === 'relative') return { key: todayKey, approx: false };
  if (dateInfo.kind === 'explicit') return { key: dateInfo.value, approx: false };
  return { key: fallbackKey || todayKey, approx: true };
}

function fmtLabel(key, approx, isToday) {
  const [, m, d] = key.split('-').map(Number);
  if (isToday) return `${m}월 ${d}일 (오늘)`;
  return `${m}월 ${d}일${approx ? '경 (추정)' : ''}`;
}

async function runCrawl() {
  // 시스템에 설치된 크롬이 있으면 그걸 쓰고, 없으면 Playwright가 관리하는
  // Chromium을 사용합니다 (executablePath를 안 넘기면 Playwright 기본 브라우저 사용).
  const executablePath = findChrome();
  const launchOptions = executablePath ? { executablePath, headless: true } : { headless: true };
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await browser.newPage({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 800, height: 1200 },
    });
    const response = await page.goto(BOARD_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);
    // 가상 스크롤 목록이라 스크롤해야 더 많은 글이 렌더링됩니다.
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(500);
    }
    const text = await page.evaluate(() => document.body.innerText);
    const blocks = splitBlocks(text).slice(0, 15);
    // 진단용 로그 — 클라우드에서 크롤링이 이상할 때 원인을 로그로 확인하기 위함
    console.log('[crawler] http status:', response ? response.status() : '(no response)');
    console.log('[crawler] page title:', await page.title());
    console.log('[crawler] body text length:', text.length);
    console.log('[crawler] body text preview:', JSON.stringify(text.slice(0, 300)));
    console.log('[crawler] blocks found:', blocks.length);

    const t = todayParts();
    const todayKey = `${t.y}-${pad(t.m)}-${pad(t.d)}`;
    let fallbackKey = null;
    const notices = [];
    blocks.forEach((b, i) => {
      const parsed = parseBlock(b);
      if (!parsed) return;
      const { key, approx } = toDateKey(parsed.dateInfo, fallbackKey);
      fallbackKey = key;
      notices.push({
        id: 'n' + (i + 1),
        dateKey: key,
        dateLabel: fmtLabel(key, approx, key === todayKey && !approx),
        approx,
        title: parsed.title,
        preview: parsed.content.length > 160 ? parsed.content.slice(0, 160) + '…' : parsed.content,
        likes: parsed.likes,
        comments: parsed.comments,
        views: parsed.views,
        url: BOARD_URL,
      });
    });

    const now = new Date();
    const label = `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 ${pad(now.getHours())}:${pad(
      now.getMinutes()
    )} 기준`;

    return {
      notices,
      meta: {
        streamer: '이상호',
        boardUrl: BOARD_URL,
        crawledAtLabel: label,
      },
    };
  } finally {
    await browser.close();
  }
}

module.exports = { runCrawl };
