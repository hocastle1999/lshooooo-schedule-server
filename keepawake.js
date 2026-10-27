// keepawake.js — Render 무료 플랜 잠들기 방지
//
// Render 무료 플랜은 15분간 접속이 없으면 서버가 잠들고, 그러면 채팅 연결도 끊긴다.
// 채팅을 받고 있는 기능(룰렛 수집, 제재 이력 참여자)이 하나라도 켜져 있는 동안은
// 10분마다 자기 자신에게 요청을 보내 깨어 있게 한다.

const INTERVAL_MS = 10 * 60 * 1000;
const holders = new Set();
let timer = null;

function update() {
  const selfUrl = process.env.RENDER_EXTERNAL_URL; // Render 가 자동으로 넣어주는 공개 주소
  if (holders.size && selfUrl && !timer) {
    timer = setInterval(() => {
      fetch(selfUrl + '/api/ping', { signal: AbortSignal.timeout(15000) }).catch(() => {});
    }, INTERVAL_MS);
  } else if (!holders.size && timer) {
    clearInterval(timer);
    timer = null;
  }
}

function acquire(name) { holders.add(name); update(); }
function release(name) { holders.delete(name); update(); }

function mount(app) {
  app.get('/api/ping', (req, res) => res.json({ ok: true }));
}

module.exports = { acquire, release, mount };
