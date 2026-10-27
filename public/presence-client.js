// 지금 접속 중인 매니저 표시.
// 모든 페이지에서 20초마다 접속 신호를 보내고, id="presence" 칸이 있는 페이지(작업실)에만 목록을 그린다.
// 이름은 이 브라우저에 저장해 두고(localStorage), 처음 들어온 사람에게 작업실에서 한 번 물어본다.
(function(){
  "use strict";
  var script = document.currentScript;
  var PAGE = (script && script.getAttribute('data-page')) || 'main';
  var BEAT_MS = 20000;
  var clientId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  var managers = [];
  var myName = '';
  try { myName = localStorage.getItem('managerName') || ''; } catch(e) {}

  var css =
    '.pz{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;padding:7px 10px 7px 12px;border-radius:999px;background:var(--surface);border:1px solid var(--border);box-shadow:var(--shadow);font-size:12.5px;color:var(--text-dim);max-width:100%;}' +
    '.pz-dot{width:8px;height:8px;border-radius:50%;background:#1F9D55;box-shadow:0 0 0 3px rgba(31,157,85,.18);flex:none;}' +
    '.pz-count b{color:var(--text);}' +
    '.pz-chips{display:inline-flex;gap:5px;flex-wrap:wrap;}' +
    '.pz-chip{font:inherit;font-size:12px;font-weight:600;color:var(--text);background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:3px 9px;white-space:nowrap;}' +
    '.pz-chip.me{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-ink);cursor:pointer;}' +
    '.pz-chip.me:hover{filter:brightness(1.05);}' +
    '.pz-chip.more{color:var(--text-dim);}' +
    '.pz-overlay{position:fixed;inset:0;background:rgba(10,12,14,.5);display:flex;align-items:center;justify-content:center;padding:16px;z-index:50;}' +
    '.pz-modal{background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);width:100%;max-width:340px;padding:18px;display:flex;flex-direction:column;gap:12px;}' +
    '.pz-modal h3{margin:0;font-size:16px;}' +
    '.pz-modal p{margin:0;font-size:12.5px;color:var(--text-dim);line-height:1.5;}' +
    '.pz-modal input{font:inherit;font-size:14px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:9px 11px;color:var(--text);}' +
    '.pz-modal input:focus{outline:2px solid var(--accent);outline-offset:1px;}' +
    '.pz-actions{display:flex;justify-content:flex-end;gap:8px;}' +
    '.pz-btn{font:inherit;font-size:13px;border-radius:9px;padding:8px 14px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);cursor:pointer;}' +
    '.pz-btn.primary{background:var(--accent);border-color:var(--accent);color:#06231F;font-weight:700;}';
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}

  function paint(){
    var el = document.getElementById('presence');
    if (!el) return;
    if (!managers.length) { el.innerHTML = ''; return; }
    var me = myName || '이름 없음';
    var sorted = managers.slice().sort(function(a, b){ return (b.name === me) - (a.name === me); });
    var MAX = 6;
    var chips = sorted.slice(0, MAX).map(function(m){
      var where = m.pages.join(', ') + ' 보는 중';
      if (m.name === me) {
        var label = myName ? esc(myName) + ' (나)' : '내 이름 정하기';
        return '<button type="button" class="pz-chip me" data-presence-rename title="눌러서 이름 바꾸기 · ' + esc(where) + '">' + label + '</button>';
      }
      return '<span class="pz-chip" title="' + esc(where) + '">' + esc(m.name) + '</span>';
    }).join('');
    var rest = sorted.slice(MAX);
    if (rest.length) {
      chips += '<span class="pz-chip more" title="' + esc(rest.map(function(m){ return m.name; }).join(', ')) + '">+' + rest.length + '</span>';
    }
    el.innerHTML = '<div class="pz"><span class="pz-dot"></span><span class="pz-count">접속 중 <b>' + managers.length + '</b>명</span><span class="pz-chips">' + chips + '</span></div>';
  }

  async function beat(){
    try {
      var res = await fetch('/api/presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: clientId, name: myName, page: PAGE })
      });
      if (!res.ok) return;
      managers = (await res.json()).managers || [];
      paint();
    } catch(e) { /* 다음 신호 때 다시 시도 */ }
  }

  function askName(){
    if (document.querySelector('.pz-overlay')) return;
    var wrap = document.createElement('div');
    wrap.className = 'pz-overlay';
    wrap.innerHTML =
      '<form class="pz-modal">' +
        '<h3>' + (myName ? '이름 바꾸기' : '매니저 이름을 알려주세요') + '</h3>' +
        '<p>오른쪽 위 "접속 중" 목록에 이 이름으로 보여요. 이 브라우저에 저장돼서 다음부터는 묻지 않아요.</p>' +
        '<input type="text" name="name" maxlength="12" placeholder="예: 호성" value="' + esc(myName) + '" required>' +
        '<div class="pz-actions">' +
          '<button type="button" class="pz-btn" data-pz-close>' + (myName ? '닫기' : '나중에') + '</button>' +
          '<button type="submit" class="pz-btn primary">저장</button>' +
        '</div>' +
      '</form>';
    document.body.appendChild(wrap);
    var input = wrap.querySelector('input');
    input.focus();
    input.select();
    wrap.addEventListener('click', function(ev){
      if (ev.target === wrap || ev.target.hasAttribute('data-pz-close')) {
        try { sessionStorage.setItem('managerNameSkipped', '1'); } catch(e) {}
        wrap.remove();
      }
    });
    wrap.querySelector('form').addEventListener('submit', function(ev){
      ev.preventDefault();
      var v = input.value.replace(/\s+/g, ' ').trim().slice(0, 12);
      if (!v) return;
      myName = v;
      try { localStorage.setItem('managerName', v); } catch(e) {}
      wrap.remove();
      beat();
    });
  }

  document.addEventListener('click', function(ev){
    if (ev.target.closest && ev.target.closest('[data-presence-rename]')) askName();
  });
  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'visible') beat();
  });
  window.addEventListener('pagehide', function(){
    try { navigator.sendBeacon('/api/presence/leave', JSON.stringify({ clientId: clientId })); } catch(e) {}
  });
  window.addEventListener('pageshow', function(ev){ if (ev.persisted) beat(); });

  beat();
  setInterval(beat, BEAT_MS);
  var skipped = false;
  try { skipped = sessionStorage.getItem('managerNameSkipped') === '1'; } catch(e) {}
  if (PAGE === 'main' && !myName && !skipped) setTimeout(askName, 600);

  // 작업실은 20초마다 화면 전체를 다시 그리므로, 그때마다 이 목록도 다시 그려 달라고 부른다.
  window.Presence = { paint: paint };
})();
