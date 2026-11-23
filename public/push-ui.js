// push-ui.js — 작업실의 '🔔 방송 알림' 창 (웹 푸시 켜기·끄기·알림 종류·테스트)
// 서버 쪽은 push.js. 알림은 sw.js(서비스 워커)가 띄운다. 이 기기(브라우저)마다 따로 켠다.
(function(){
  var KIND_LABEL = { start: '🔴 방송 시작', end: '⚫ 방송 종료', title: '✏️ 방송 제목 변경' };
  var reg = null;

  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function supported(){ return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function isIOS(){ return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  function standalone(){ return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; }
  function keyBytes(b64){
    var pad = '='.repeat((4 - b64.length % 4) % 4);
    var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  async function post(url, body){
    var res = await fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body || {}) });
    var d = await res.json().catch(function(){ return {}; });
    if (!res.ok) throw new Error(d.error || ('HTTP ' + res.status));
    return d;
  }
  async function getReg(){
    if (!reg) reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    return reg;
  }
  function toast(msg){ if (window.__toast) window.__toast(msg); }

  function show(inner){
    document.getElementById('modal-slot').innerHTML =
      '<div class="overlay" data-action="overlay" data-key=""><div class="modal" data-stop="1">' +
        '<h3>🔔 방송 알림</h3>' + inner +
      '</div></div>';
  }
  var HELP = '<p style="margin:0;font-size:12px;color:var(--text-dim);line-height:1.6;">이 기기로 방송 알림을 보내요. 사이트를 닫아 둬도 와요. 기기(폰·PC 브라우저)마다 따로 켜야 해요. 방송 시작 알림을 누르면 방송 화면이 열려요.</p>';

  async function open(){
    show('<p style="margin:0;color:var(--text-dim)">불러오는 중…</p>');
    if (!supported()) {
      var why = isIOS() && !standalone()
        ? '아이폰·아이패드는 <b>Safari에서 공유 버튼 → "홈 화면에 추가"</b>를 한 뒤, 홈 화면에 생긴 <b>매니저 작업실</b> 아이콘으로 열어서 여기서 켜야 해요. (iOS 16.4 이상, 처음 열면 한 번 더 로그인해야 해요)'
        : '이 브라우저는 알림을 받을 수 없어요. 크롬·엣지·삼성 인터넷·사파리(맥) 최신 버전에서 열어 주세요.';
      show(HELP + '<p style="margin:0;font-size:13.5px;line-height:1.6;">' + why + '</p>' +
        '<div class="modal-actions"><button type="button" class="btn" data-action="close-modal">닫기</button><span></span></div>');
      return;
    }
    try {
      var r = await getReg();
      var sub = await r.pushManager.getSubscription();
      var me = sub ? await post('/api/push/me', { endpoint: sub.endpoint }) : { subscribed: false, prefs: { start: true, end: false, title: false } };
      var on = Boolean(sub && me.subscribed);
      var blocked = Notification.permission === 'denied';
      var prefs = me.prefs || {};
      show(HELP +
        '<div style="font-size:14px;font-weight:700;">이 기기: ' + (on ? '<span style="color:var(--ok,#1F9D55)">알림 켜짐</span>' : '<span style="color:var(--text-dim)">알림 꺼짐</span>') + '</div>' +
        (blocked ? '<p style="margin:0;font-size:12.5px;color:var(--danger,#e5484d);line-height:1.5;">이 브라우저에서 이 사이트 알림이 <b>차단</b>되어 있어요. 주소창 왼쪽 자물쇠(사이트 설정) → 알림 → 허용으로 바꾼 뒤 다시 열어 주세요.</p>' : '') +
        '<div class="field" style="gap:8px;">' + ['start','end','title'].map(function(k){
          return '<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;"><input type="checkbox" data-push-pref="' + k + '"' + (prefs[k] ? ' checked' : '') + '> ' + KIND_LABEL[k] + '</label>';
        }).join('') + '</div>' +
        '<div class="error" id="push-err" style="display:none;font-size:12.5px;color:var(--danger,#e5484d);"></div>' +
        '<div class="modal-actions" style="flex-wrap:wrap;">' +
          '<button type="button" class="btn" data-action="close-modal">닫기</button>' +
          '<span style="display:flex;gap:6px;flex-wrap:wrap;">' +
            (on ? '<button type="button" class="btn" id="push-off">알림 끄기</button><button type="button" class="btn" id="push-test">테스트 알림</button>' : '') +
            '<button type="button" class="btn primary" id="push-save"' + (blocked ? ' disabled' : '') + '>' + (on ? '설정 저장' : '이 기기에서 알림 켜기') + '</button>' +
          '</span>' +
        '</div>');
      bind(on);
    } catch (e) {
      show(HELP + '<p style="margin:0;color:var(--danger,#e5484d)">알림 설정을 불러오지 못했어요: ' + esc(e.message) + '</p>' +
        '<div class="modal-actions"><button type="button" class="btn" data-action="close-modal">닫기</button><span></span></div>');
    }
  }

  function err(msg){ var el = document.getElementById('push-err'); if (el) { el.textContent = msg; el.style.display = msg ? '' : 'none'; } }
  function readPrefs(){
    var p = {};
    document.querySelectorAll('[data-push-pref]').forEach(function(c){ p[c.getAttribute('data-push-pref')] = c.checked; });
    return p;
  }

  function bind(on){
    var save = document.getElementById('push-save');
    if (save) save.addEventListener('click', async function(){
      save.disabled = true; err('');
      try {
        var perm = await Notification.requestPermission();
        if (perm !== 'granted') throw new Error('알림 권한을 허용해야 받을 수 있어요.');
        var r = await getReg();
        var sub = await r.pushManager.getSubscription();
        if (!sub) {
          var k = await (await fetch('/api/push/key')).json();
          sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(k.publicKey) });
        }
        await post('/api/push/subscribe', { subscription: sub.toJSON(), prefs: readPrefs() });
        toast(on ? '알림 설정을 저장했어요' : '🔔 이 기기에서 방송 알림을 켰어요');
        open();
      } catch (e) { err(e.message); save.disabled = false; }
    });
    var off = document.getElementById('push-off');
    if (off) off.addEventListener('click', async function(){
      off.disabled = true; err('');
      try {
        var r = await getReg();
        var sub = await r.pushManager.getSubscription();
        if (sub) { await post('/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
        toast('이 기기의 방송 알림을 껐어요');
        open();
      } catch (e) { err(e.message); off.disabled = false; }
    });
    var test = document.getElementById('push-test');
    if (test) test.addEventListener('click', async function(){
      test.disabled = true; err('');
      try {
        var r = await getReg();
        var sub = await r.pushManager.getSubscription();
        if (!sub) throw new Error('이 기기는 알림이 꺼져 있어요');
        await post('/api/push/test', { endpoint: sub.endpoint });
        toast('테스트 알림을 보냈어요. 몇 초 안에 와요');
      } catch (e) { err(e.message); }
      test.disabled = false;
    });
  }

  window.openPushModal = open;
  // 알림을 켜 둔 기기는 들어올 때마다 서비스 워커를 확인해 둔다 (업데이트 반영)
  if (supported() && Notification.permission === 'granted') { getReg().catch(function(){}); }
})();
