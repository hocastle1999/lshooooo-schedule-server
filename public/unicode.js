// unicode.js — 🔤 유니코드 텍스트 변환기 (메모장 제목 옆 버튼)
//
// 글자를 Unicode에 원래 있는 꾸민 문자(굵은체·필기체·원 문자·전각 등)로 바꿔서 스타일별로 보여주고 복사한다.
// 전부 브라우저 안에서 처리하고, 서버나 다른 사이트로 아무것도 보내지 않는다.
// 영어 알파벳·숫자만 바뀌는 스타일이 대부분이고, 줄긋기·밑줄처럼 글자 위에 덧씌우는 스타일은 한글에도 된다.
(function(){
  var UP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', LO = 'abcdefghijklmnopqrstuvwxyz', DG = '0123456789';
  var cp = function(n){ return String.fromCodePoint(n); };

  // 수학용 영숫자 블록: 대문자 시작 코드(소문자는 +26), 숫자 시작 코드, 빈 자리를 채우는 예외 글자
  function mathMap(upStart, digitStart, except){
    var m = {};
    for(var i=0;i<26;i++){ m[UP[i]] = cp(upStart+i); m[LO[i]] = cp(upStart+26+i); }
    if(digitStart) for(var d=0;d<10;d++) m[DG[d]] = cp(digitStart+d);
    for(var k in (except||{})) m[k] = except[k];
    return m;
  }
  // 문자열 표 두 개로 만든 1:1 표 (Array.from 으로 서로게이트 쌍도 한 글자로)
  function tableMap(from, to){
    var a = Array.from(from), b = Array.from(to), m = {};
    a.forEach(function(ch, i){ if(b[i] && b[i] !== ' ') m[ch] = b[i]; });
    return m;
  }
  function rangeMap(chars, start){ var m = {}; Array.from(chars).forEach(function(ch, i){ m[ch] = cp(start+i); }); return m; }
  function merge(){ var m = {}; for(var i=0;i<arguments.length;i++) for(var k in arguments[i]) m[k] = arguments[i][k]; return m; }
  function upperToo(m){ var r = merge(m); for(var i=0;i<26;i++) if(!r[LO[i]] && r[UP[i]]) r[LO[i]] = r[UP[i]]; return r; }

  var mapText = function(m){ return function(s){ return Array.from(s).map(function(ch){ return m[ch] || ch; }).join(''); }; };
  // 글자마다 덧씌우는 결합 문자 (한글도 된다). 공백·줄바꿈에는 붙이지 않는다.
  var overlay = function(mark){ return function(s){ return Array.from(s).map(function(ch){ return /\s/.test(ch) ? ch : ch + mark; }).join(''); }; };

  var fullwidth = {}; for(var c=0x21;c<=0x7e;c++) fullwidth[String.fromCharCode(c)] = cp(0xff01 + c - 0x21); fullwidth[' '] = '　';

  var circled = merge(rangeMap(UP, 0x24b6), rangeMap(LO, 0x24d0), rangeMap('123456789', 0x2460), { '0': '⓪' });
  var negCircled = upperToo(merge(rangeMap(UP, 0x1f150), rangeMap('123456789', 0x2776), { '0': '⓿' }));
  var squared = upperToo(rangeMap(UP, 0x1f130));
  var negSquared = upperToo(rangeMap(UP, 0x1f170));
  var paren = merge(rangeMap(LO, 0x249c), rangeMap(UP, 0x1f110), rangeMap('123456789', 0x2474));
  var smallCaps = upperToo(tableMap(UP, 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ'));
  smallCaps = merge(smallCaps, tableMap(LO, 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ'));
  var superscript = merge(tableMap(LO, 'ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖqʳˢᵗᵘᵛʷˣʸᶻ'), tableMap(UP, 'ᴬᴮᶜᴰᴱᶠᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾQᴿˢᵀᵁⱽᵂˣʸᶻ'), tableMap(DG, '⁰¹²³⁴⁵⁶⁷⁸⁹'), tableMap('+-=()', '⁺⁻⁼⁽⁾'));
  var subscript = merge(tableMap('aehijklmnoprstuvx', 'ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ'), tableMap(DG, '₀₁₂₃₄₅₆₇₈₉'), tableMap('+-=()', '₊₋₌₍₎'));
  var flipped = merge(
    tableMap(LO, 'ɐqɔpǝɟƃɥᴉɾʞlɯuodbɹsʇnʌʍxʎz'),
    tableMap(UP, '∀ᗺƆᗡƎℲ⅁HIſʞ˥WNOԀΌᴚS⊥∩ΛMX⅄Z'),
    tableMap(DG, '0ƖᄅƐㄣϛ9ㄥ86'),
    tableMap('.,?!()[]{}<>_&\'"', '˙\'¿¡)(][}{><‾⅋,„'));
  var mirrorFlip = function(s){ return Array.from(mapText(flipped)(s)).reverse().join(''); };
  var spaced = function(s){ return Array.from(s).join(' '); };

  var STYLES = [
    ['굵게', mapText(mathMap(0x1d400, 0x1d7ce))],
    ['기울임', mapText(mathMap(0x1d434, 0, { h: 'ℎ' }))],
    ['굵은 기울임', mapText(mathMap(0x1d468))],
    ['필기체', mapText(mathMap(0x1d49c, 0, { B:'ℬ', E:'ℰ', F:'ℱ', H:'ℋ', I:'ℐ', L:'ℒ', M:'ℳ', R:'ℛ', e:'ℯ', g:'ℊ', o:'ℴ' }))],
    ['굵은 필기체', mapText(mathMap(0x1d4d0))],
    ['고딕(프락투어)', mapText(mathMap(0x1d504, 0, { C:'ℭ', H:'ℌ', I:'ℑ', R:'ℜ', Z:'ℨ' }))],
    ['굵은 고딕', mapText(mathMap(0x1d56c))],
    ['이중선', mapText(mathMap(0x1d538, 0x1d7d8, { C:'ℂ', H:'ℍ', N:'ℕ', P:'ℙ', Q:'ℚ', R:'ℝ', Z:'ℤ' }))],
    ['산세리프', mapText(mathMap(0x1d5a0, 0x1d7e2))],
    ['산세리프 굵게', mapText(mathMap(0x1d5d4, 0x1d7ec))],
    ['산세리프 기울임', mapText(mathMap(0x1d608))],
    ['산세리프 굵은 기울임', mapText(mathMap(0x1d63c))],
    ['고정폭', mapText(mathMap(0x1d670, 0x1d7f6))],
    ['전각', mapText(fullwidth)],
    ['원 문자', mapText(circled)],
    ['검은 원 문자', mapText(negCircled)],
    ['네모 문자', mapText(squared)],
    ['검은 네모 문자', mapText(negSquared)],
    ['괄호 문자', mapText(paren)],
    ['스몰 캡스', mapText(smallCaps)],
    ['위 첨자', mapText(superscript)],
    ['아래 첨자', mapText(subscript)],
    ['뒤집기', mirrorFlip],
    ['줄긋기 (한글 가능)', overlay('̶')],
    ['밑줄 (한글 가능)', overlay('̲')],
    ['이중 밑줄 (한글 가능)', overlay('̳')],
    ['윗줄 (한글 가능)', overlay('̅')],
    ['빗금 (한글 가능)', overlay('̸')],
    ['물결 (한글 가능)', overlay('̴')],
    ['띄어 쓰기 (한글 가능)', spaced],
  ];

  var lastText = '';
  window.openUnicodeModal = function(){
    var rows = STYLES.map(function(st, i){
      return '<div class="uc-row"><div class="uc-name">'+st[0]+'</div><div class="uc-out" id="uc-out-'+i+'"></div>'+
        '<button type="button" class="btn" data-uc-copy="'+i+'" style="padding:4px 10px;font-size:12px;">복사</button></div>';
    }).join('');
    document.getElementById('modal-slot').innerHTML =
      '<div class="overlay" data-action="overlay" data-key=""><div class="modal wide" data-stop="1">'+
        '<h3>🔤 유니코드 텍스트 변환기</h3>'+
        '<p style="margin:0;font-size:12px;color:var(--text-dim);line-height:1.5;">글을 입력하면 스타일별로 바뀐 글자가 나와요. 복사해서 채팅·닉네임·공지에 붙여 넣으면 돼요. 대부분은 영어·숫자만 바뀌고, \'한글 가능\' 스타일은 한글에도 돼요. 일부 기기나 채팅창에서는 빈 네모로 보일 수 있어요.</p>'+
        '<textarea id="uc-input" class="rules-edit" style="min-height:70px;" placeholder="예: Lee Sang Ho 2026"></textarea>'+
        '<div class="uc-list">'+rows+'</div>'+
        '<div class="modal-actions"><button type="button" class="btn" data-action="close-modal">닫기</button><span></span></div>'+
      '</div></div>';
    var ta = document.getElementById('uc-input');
    ta.value = lastText || 'Lee Sang Ho 2026';
    paint();
    ta.focus(); ta.select();
  };

  function paint(){
    var ta = document.getElementById('uc-input'); if(!ta) return;
    lastText = ta.value;
    STYLES.forEach(function(st, i){
      var el = document.getElementById('uc-out-'+i);
      if(el) el.textContent = ta.value ? st[1](ta.value) : '';
    });
  }

  // 클립보드 API가 막혀 있으면(권한·포커스 문제) 옛날 방식으로 한 번 더 시도한다
  function copyText(text){
    if(navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).catch(function(){ return legacyCopy(text); });
    return legacyCopy(text);
  }
  function legacyCopy(text){
    return new Promise(function(res, rej){
      var t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy') ? res() : rej(new Error('복사 실패')); } catch(e){ rej(e); }
      document.body.removeChild(t);
    });
  }

  document.addEventListener('input', function(ev){ if(ev.target && ev.target.id === 'uc-input') paint(); });
  document.addEventListener('click', function(ev){
    var b = ev.target.closest && ev.target.closest('[data-uc-copy]'); if(!b) return;
    var i = Number(b.getAttribute('data-uc-copy'));
    var out = document.getElementById('uc-out-'+i);
    if(!out || !out.textContent) return;
    copyText(out.textContent).then(function(){
      b.textContent = '복사됨'; setTimeout(function(){ b.textContent = '복사'; }, 1200);
    }).catch(function(){ b.textContent = '실패'; setTimeout(function(){ b.textContent = '복사'; }, 1200); });
  });

  // 화면 모양
  var css = document.createElement('style');
  css.textContent =
    '.uc-list{display:flex;flex-direction:column;gap:6px;max-height:52vh;overflow-y:auto;padding-right:2px;}'+
    '.uc-row{display:grid;grid-template-columns:118px 1fr auto;align-items:center;gap:8px;border:1px solid var(--border);border-radius:10px;padding:7px 9px;background:var(--surface-2);}'+
    '.uc-name{font-size:11.5px;color:var(--text-dim);}'+
    '.uc-out{font-size:15px;word-break:break-all;line-height:1.4;min-height:1.4em;}'+
    '@media (max-width:520px){.uc-row{grid-template-columns:1fr auto;}.uc-name{grid-column:1/-1;}}';
  document.head.appendChild(css);
})();
