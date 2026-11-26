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
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// ---- 공지 전체 내용 (방송국 게시판 API) ----
// 게시판 페이지가 쓰는 공개 API. 첫 페이지(고정 공지 + 최근 글)에서 이상호님이 쓴 글의 제목 → 전체 본문.
const BOARD_API = 'https://api-channel.sooplive.com/v1.3/channel/lshooooo/board?perPage=20&startDate=&endDate=&field=title,contents,user_nick,user_id,hashtags&keyword=&type=all&orderBy=reg_date&page=1&bbsNo=';
function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
async function fetchFullContents() {
  const res = await fetch(BOARD_API, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const items = [...(Array.isArray(j.noticeData) ? j.noticeData : [j.noticeData]), ...(j.contents || [])].filter(Boolean);
  const map = new Map();
  for (const it of items) {
    if (it.userId !== 'lshooooo' || !it.titleName || !it.content) continue;
    const text = htmlToText(it.content.content) || it.content.textContent || '';
    // 제목 → { 전체 본문, 게시물 주소 } (원문 보기를 게시판 목록이 아니라 그 게시물로)
    if (!map.has(it.titleName.trim())) {
      map.set(it.titleName.trim(), {
        text,
        url: it.titleNo ? `https://www.sooplive.com/station/lshooooo/post/${it.titleNo}` : '',
        regDate: typeof it.regDate === 'string' ? it.regDate : '', // 올린 시각 (한국 시간, "2026-11-24 15:42:23")
      });
    }
  }
  return map;
}

function todayParts() {
  // 서버(Render)는 UTC 라서 한국 날짜로 맞춘다 (새벽 0~9시에 '오늘'이 어제로 잡히지 않게)
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

// 게시글 블록은 "이상호" -> "- 방 송 공 지-" -> "공지..." 로 시작합니다.
// (사이트가 접속 지역에 따라 영어 UI로 뜨면 "공지" 대신 "Notice"로 나올 수 있어서 둘 다 허용합니다.)
function splitBlocks(text) {
  const marker = /이상호\s*\n-\s*방\s*송\s*공\s*지\s*-\s*\n(?:공지|Notice)/gi;
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
  while (idx < lines.length && !lines[idx].startsWith('공지') && !/^notice/i.test(lines[idx])) idx++;
  if (idx >= lines.length) return null;
  const title = lines[idx].replace(/^(?:공지|notice)\s*/i, '').trim();
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
    else if ((/(전|오늘)$/.test(l) || /ago$/i.test(l) || /^today$/i.test(l)) && l.length <= 20) dateInfo = { kind: 'relative', value: l };
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
      // 클라우드 서버는 해외 IP라 사이트가 영어 UI로 뜨는 경우가 있어서,
      // 한국어로 렌더링되도록 유도합니다 (그래도 영어로 뜰 경우를 대비해
      // 파싱 로직도 "공지"/"Notice" 둘 다 인식하도록 해뒀습니다).
      locale: 'ko-KR',
      extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9' },
    });
    const response = await page.goto(BOARD_URL, { waitUntil: 'networkidle', timeout: 30000 });
    // 글 목록이 늦게 그려질 때가 있어서, 본문 글자가 충분히 생길 때까지 최대 20초 기다린다
    try {
      await page.waitForFunction(() => document.body.innerText.length > 400, { timeout: 20000 });
    } catch (e) {
      console.log('[crawler] 글 목록을 기다리다 시간 초과');
    }
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
        content: parsed.content.slice(0, 3000), // 전체 내용 (작업실에서 '더 보기'로 펼친다)
        likes: parsed.likes,
        comments: parsed.comments,
        views: parsed.views,
        url: BOARD_URL,
      });
    });

    // 게시판 목록 글은 187자에서 잘려 있어서, 방송국 게시판 API 의 본문(HTML)으로 전체 내용을 채운다.
    // 실패해도 목록에서 읽은 앞부분은 그대로 둔다.
    try {
      const full = await fetchFullContents();
      for (const n of notices) {
        const f = full.get(n.title.trim());
        if (!f) continue;
        if (f.text && f.text.length > n.content.length) n.content = f.text.slice(0, 5000);
        if (f.url) n.url = f.url;
        // 날짜는 추정하지 않고 실제로 올린 시각으로 ("11월 24일 15:42", 오늘이면 "(오늘)")
        const rd = f.regDate.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
        if (rd) {
          n.dateKey = `${rd[1]}-${rd[2]}-${rd[3]}`;
          n.approx = false;
          n.postedAt = f.regDate;
          n.dateLabel = `${Number(rd[2])}월 ${Number(rd[3])}일 ${rd[4]}:${rd[5]}` + (n.dateKey === todayKey ? ' (오늘)' : '');
        }
      }
    } catch (e) {
      console.error('[crawler] 공지 전체 내용 가져오기 실패:', e.message);
    }

    // Render 서버 시간대는 UTC 라서 한국 시간으로 맞춘다
    const now = new Date(Date.now() + 9 * 3600 * 1000);
    const label = `${now.getUTCFullYear()}년 ${now.getUTCMonth() + 1}월 ${now.getUTCDate()}일 ${pad(now.getUTCHours())}:${pad(
      now.getUTCMinutes()
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

module.exports = { runCrawl, findChrome };
