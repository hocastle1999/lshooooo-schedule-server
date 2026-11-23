// app-refresh.js — 모든 페이지 공통
//  1) 새 버전 안내: 사이트가 다시 배포되면(서버 /api/version 의 커밋이 바뀌면) 아래쪽에
//     "새 버전이 있어요 · 눌러서 새로고침" 띠를 띄운다. 1분마다, 그리고 화면으로 돌아올 때마다 확인한다.
//  2) 앱 모드(홈 화면 아이콘으로 연 경우)에는 주소창·새로고침 버튼이 없어서
//     오른쪽 아래에 ⟳ 새로고침 버튼을, 작업실이 아닌 페이지에는 🏠 작업실 버튼을 띄운다.
//     앱 모드에서는 사이트 안 링크(룰렛·참여자 검색)를 새 창 대신 같은 창에서 연다 (새 창은 Safari로 빠져나가서 다시 로그인해야 함).
// 작업실 메모는 새로고침 직전에 저장된다 (index.html 의 beforeunload).
(function(){
  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  var css = document.createElement('style');
  css.textContent =
    '.ar-bar{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:60;display:flex;align-items:center;gap:8px;max-width:calc(100vw - 32px);' +
      'font:inherit;font-size:13.5px;font-weight:700;color:#fff;background:#2563eb;border:none;border-radius:999px;padding:10px 16px;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer;}' +
    '.ar-bar:hover{filter:brightness(1.08);}' +
    '.ar-fab{position:fixed;right:14px;z-index:55;width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
      'font-size:19px;line-height:1;text-decoration:none;color:var(--text,#222);background:var(--surface,#fff);border:1px solid var(--border,#ddd);box-shadow:0 4px 14px rgba(0,0,0,.18);cursor:pointer;}' +
    '.ar-fab.reload{bottom:calc(16px + env(safe-area-inset-bottom));}' +
    '.ar-fab.home{bottom:calc(66px + env(safe-area-inset-bottom));}' +
    'body.ar-has-bar .ar-fab.reload{bottom:calc(66px + env(safe-area-inset-bottom));} body.ar-has-bar .ar-fab.home{bottom:calc(116px + env(safe-area-inset-bottom));}';
  document.head.appendChild(css);

  function reload(){ location.reload(); }

  // ---- 1) 새 버전 안내 ----
  var first = null, shown = false;
  function sig(v){ return v.commit || String(v.startedAt || ''); } // PC 테스트(커밋 없음)는 서버 시작 시각으로
  async function check(){
    if (shown) return;
    try {
      var v = await (await fetch('/api/version', { cache: 'no-store' })).json();
      var s = sig(v);
      if (!s) return;
      if (first === null) { first = s; return; }
      if (s !== first) showBar();
    } catch(e) {}
  }
  function showBar(){
    shown = true;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ar-bar';
    b.textContent = '🔄 새 버전이 있어요 · 눌러서 새로고침';
    b.addEventListener('click', reload);
    document.body.appendChild(b);
    document.body.classList.add('ar-has-bar');
  }
  window.__appRefreshCheck = check; // 테스트용
  check();
  setInterval(check, 60 * 1000);
  document.addEventListener('visibilitychange', function(){ if (document.visibilityState === 'visible') check(); });

  // ---- 2) 앱 모드 버튼 ----
  if (!standalone) return;
  function fab(cls, text, title, onClick, href){
    var el = document.createElement(href ? 'a' : 'button');
    if (href) el.href = href; else el.type = 'button';
    el.className = 'ar-fab ' + cls;
    el.textContent = text;
    el.title = title; el.setAttribute('aria-label', title);
    if (onClick) el.addEventListener('click', onClick);
    document.body.appendChild(el);
  }
  fab('reload', '⟳', '새로고침', reload);
  if (location.pathname !== '/' && location.pathname !== '/index.html') fab('home', '🏠', '작업실로', null, '/');
  // 사이트 안 링크는 같은 창에서 (외부 링크는 그대로 새 창)
  document.addEventListener('click', function(e){
    var a = e.target.closest && e.target.closest('a[target="_blank"]');
    if (!a) return;
    try { if (new URL(a.href, location.href).origin !== location.origin) return; } catch(err) { return; }
    e.preventDefault();
    location.href = a.href;
  }, true);
})();
