// presence.js — 지금 사이트에 접속해 있는 매니저 목록
//
// 페이지를 연 탭마다 20초에 한 번씩 "나 아직 보고 있어요" 신호(이름 + 보고 있는 페이지)를 보내고,
// 90초 동안 신호가 없으면 나간 것으로 본다. (백그라운드 탭은 브라우저가 타이머를 1분 간격으로
// 늦추기 때문에 넉넉하게 잡았다.) 탭을 닫을 때는 바로 나가기 신호를 보낸다.
// 잠깐 쓰는 정보라 저장소에 남기지 않고 메모리에만 둔다 (서버가 재시작되면 다음 신호 때 다시 채워짐).

const express = require('express');

const TTL_MS = 90 * 1000;
const PAGES = { main: '작업실', roulette: '룰렛', watch: '제재 이력' };
const clients = new Map(); // clientId → { name, page, lastSeen }

const ID_RE = /^[A-Za-z0-9-]{8,40}$/;

function cleanName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 12);
}

function list() {
  const now = Date.now();
  for (const [id, c] of clients) if (now - c.lastSeen > TTL_MS) clients.delete(id);
  // 같은 이름으로 여러 탭을 열어 둔 경우 한 명으로 묶는다.
  const byName = new Map();
  for (const c of clients.values()) {
    const name = c.name || '이름 없음';
    let p = byName.get(name);
    if (!p) byName.set(name, (p = { name, pages: [], since: c.since }));
    if (!p.pages.includes(PAGES[c.page])) p.pages.push(PAGES[c.page]);
    p.since = Math.min(p.since, c.since);
  }
  return [...byName.values()].sort((a, b) => a.since - b.since);
}

function mount(app) {
  app.post('/api/presence', (req, res) => {
    const { clientId, name, page } = req.body || {};
    if (!ID_RE.test(String(clientId || ''))) return res.status(400).json({ error: '잘못된 요청' });
    const prev = clients.get(clientId);
    clients.set(clientId, {
      name: cleanName(name),
      page: PAGES[page] ? page : 'main',
      lastSeen: Date.now(),
      since: prev ? prev.since : Date.now(),
    });
    res.json({ managers: list() });
  });

  // 탭을 닫을 때 navigator.sendBeacon 으로 보낸다 (본문은 text/plain 문자열).
  app.post('/api/presence/leave', express.text({ type: 'text/plain' }), (req, res) => {
    let id = '';
    try { id = JSON.parse(req.body || '{}').clientId; } catch { /* 무시 */ }
    if (ID_RE.test(String(id || ''))) clients.delete(id);
    res.json({ ok: true });
  });
}

module.exports = { mount };
