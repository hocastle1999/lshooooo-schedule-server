// auth.js — 매니저 로그인 (비밀번호 하나 + 이름)
//
// Render 환경변수 MANAGER_PASSWORD 에 매니저끼리 정한 비밀번호를 넣으면 로그인이 켜진다.
// 비어 있으면 로그인 없이 예전처럼 누구나 들어온다 (PC 테스트, 비밀번호 정하기 전).
//
// 로그인하면 이름과 만료 시각을 서명한 쿠키를 30일 동안 준다. 서명 열쇠는 비밀번호에서 만들어서,
// 비밀번호를 바꾸면 모두 다시 로그인해야 한다. 여러 번 틀려도 잠그지는 않는다.

const crypto = require('crypto');
const express = require('express');

const COOKIE = 'mgr';
const TTL_MS = 30 * 24 * 3600 * 1000;

// 로그인 없이 열려야 하는 것: 로그인 화면, 잠들기 방지 신호, 배포 확인, 아이콘
const OPEN_PATHS = ['/login.html', '/api/login', '/api/ping', '/api/version', '/auth.js'];
const OPEN_PREFIXES = ['/icons/'];

const password = () => process.env.MANAGER_PASSWORD || '';
const enabled = () => Boolean(password());
const key = () => crypto.createHash('sha256').update('lshooooo-manager:' + password()).digest();
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');
const sign = (data) => crypto.createHmac('sha256', key()).update(data).digest('base64url');

function makeToken(name) {
  const data = b64(name) + '.' + (Date.now() + TTL_MS);
  return data + '.' + sign(data);
}

// 쿠키 → 이름 (잘못됐거나 만료면 '')
function readToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return '';
  const data = parts[0] + '.' + parts[1];
  const sig = Buffer.from(sign(data));
  const got = Buffer.from(parts[2]);
  if (sig.length !== got.length || !crypto.timingSafeEqual(sig, got)) return '';
  if (Number(parts[1]) < Date.now()) return '';
  try { return unb64(parts[0]); } catch { return ''; }
}

function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function setCookie(req, res, value, maxAgeMs) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; SameSite=Lax` + (secure ? '; Secure' : ''));
}

// 요청한 매니저 이름 (로그인이 꺼져 있으면 '')
function who(req) {
  return req.manager || '';
}

function mount(app) {
  app.set('trust proxy', 1); // Render 앞단 프록시 뒤의 실제 IP·https 를 믿는다

  // 모든 요청 앞에서 확인
  app.use((req, res, next) => {
    if (!enabled()) return next();
    const name = readToken(cookieOf(req, COOKIE));
    if (name) { req.manager = name; return next(); }
    if (OPEN_PATHS.includes(req.path) || OPEN_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '로그인이 필요해요', login: true });
    const nextUrl = req.originalUrl && req.originalUrl !== '/' ? '?next=' + encodeURIComponent(req.originalUrl) : '';
    res.redirect('/login.html' + nextUrl);
  });

  app.post('/api/login', express.json(), (req, res) => {
    if (!enabled()) return res.json({ ok: true, name: '', disabled: true });
    const ip = req.ip || 'unknown';
    const name = String((req.body || {}).name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    const pw = String((req.body || {}).password || '');
    if (!name) return res.status(400).json({ error: '이름(매니저 닉네임)을 입력해주세요' });
    const a = Buffer.from(crypto.createHash('sha256').update(pw).digest('hex'));
    const b = Buffer.from(crypto.createHash('sha256').update(password()).digest('hex'));
    if (!crypto.timingSafeEqual(a, b)) {
      console.log(`[auth] 로그인 실패 ${name} (${ip})`);
      return res.status(401).json({ error: '비밀번호가 틀렸어요' });
    }
    setCookie(req, res, makeToken(name), TTL_MS);
    console.log(`[auth] 로그인 ${name} (${ip})`);
    require('./audit').record(name, '로그인', '').catch(() => {});
    res.json({ ok: true, name });
  });

  app.post('/api/logout', (req, res) => {
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  // 지금 로그인한 사람 (작업실 위쪽 "하늘하늘_ · 로그아웃" 표시용)
  app.get('/api/me', (req, res) => res.json({ name: who(req), loginEnabled: enabled() }));
}

module.exports = { mount, who, enabled };
