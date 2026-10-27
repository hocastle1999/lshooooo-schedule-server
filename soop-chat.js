// SOOP(구 아프리카TV) 채팅 수신 클라이언트.
// getCurrentThread/soopapi (Java) 의 프로토콜 구현을 Node.js 로 옮긴 것이다.
//   패킷: ESC(0x1b) TAB  cmd(4) len(6) "00"  payload   (payload 필드 구분자 = \f)
'use strict';

const { EventEmitter } = require('events');
const { MiniWebSocket } = require('./soop-ws');

const F = '\u000c';
const ESC = '\u001b\t';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const CMD = { PING: '0000', CONNECT: '0001', JOIN: '0002' };
const CODE = {
  JOIN_CHANNEL: 2,
  CHAT_USER: 4, // 입장/퇴장 (강퇴도 여기로 온다)
  CHAT_MESSAGE: 5,
  SET_DUMB: 8, // 채팅 금지(채금)
  KICK: 11, // 강퇴
  BLIND_KICK: 25, // 블라인드
  KICK_AND_CANCEL: 76, // 강퇴/강퇴취소
};

function buildPacket(cmd, data) {
  const len = String(Buffer.byteLength(data, 'utf8')).padStart(6, '0');
  return ESC + cmd + len + '00' + data;
}
const connectPacket = () => buildPacket(CMD.CONNECT, F.repeat(3) + '16' + F);
const joinPacket = (chatNo) => buildPacket(CMD.JOIN, F + chatNo + F.repeat(5));
const pingPacket = () => buildPacket(CMD.PING, F);

/** "abc(2)" 처럼 다중 접속 표시가 붙은 아이디를 정규화한다. */
const normId = (id) => String(id || '').replace(/\(\d+\)$/, '');

function parsePacket(msg) {
  const sep = msg.indexOf(F);
  if (sep < 0) return null;
  const tab = msg.lastIndexOf('\t', sep - 1);
  if (tab < 0) return null;
  const code = Number(msg.slice(tab + 1, tab + 5));
  if (!Number.isInteger(code)) return null;
  return { code, parts: msg.slice(sep + 1).split(F) };
}

async function getBno(bid) {
  const res = await fetch('https://play.sooplive.com/' + encodeURIComponent(bid), {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error('방송 페이지 요청 실패: HTTP ' + res.status);
  const body = await res.text();
  const m =
    body.match(/<meta property="og:image" content="https:\/\/liveimg\.sooplive\.com\/m\/(\d+)/) ||
    body.match(/"bno"\s*:\s*"?(\d+)"?/);
  if (!m) throw new OfflineError('방송 번호(BNO)를 찾지 못했습니다. 방송 중이 아닐 수 있습니다.');
  return m[1];
}

async function getDetail(bid, bno) {
  const body =
    `bid=${encodeURIComponent(bid)}&bno=${bno}&type=live&confirm_adult=false&player_type=html5` +
    '&mode=landing&from_api=0&pwd=&stream_type=common&quality=HD';
  const res = await fetch(
    'https://live.sooplive.com/afreeca/player_live_api.php?bjid=' + encodeURIComponent(bid),
    {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) throw new Error('방송 정보 요청 실패: HTTP ' + res.status);
  const json = await res.json();
  const ch = json.CHANNEL;
  if (!ch) throw new OfflineError('방송 정보가 없습니다 (RESULT=' + json.RESULT + ')');
  const result = Number(ch.RESULT);
  if (result === -6) throw new Error('19세 방송은 익명으로 채팅을 받을 수 없습니다.');
  if (result !== 1) throw new OfflineError('방송 중이 아닙니다 (RESULT=' + result + ')');
  return {
    bjId: ch.BJID,
    bno,
    title: ch.TITLE,
    domain: String(ch.CHDOMAIN).toLowerCase(),
    chatNo: ch.CHATNO,
    port: Number(ch.CHPT) + 1,
  };
}

class OfflineError extends Error {}

/**
 * events: status({state, message, title}), chat({...}), sanction({...})
 */
class SoopChat extends EventEmitter {
  constructor(bid, { offlineRetryMs = 60_000 } = {}) {
    super();
    this.bid = bid;
    this.offlineRetryMs = offlineRetryMs;
    this.closed = false;
    this.retry = 0;
  }

  start() {
    this._connect();
    return this;
  }

  stop() {
    this.closed = true;
    clearTimeout(this._timer);
    this._cleanup();
  }

  _status(state, message, extra = {}) {
    this.emit('status', { state, message, ...extra });
  }

  async _connect() {
    if (this.closed) return;
    this._status('connecting', `${this.bid} 방송 정보 조회 중`);
    let info;
    try {
      const bno = await getBno(this.bid);
      info = await getDetail(this.bid, bno);
    } catch (e) {
      const offline = e instanceof OfflineError;
      this._status(offline ? 'offline' : 'error', e.message);
      return this._schedule(offline ? this.offlineRetryMs : this._backoff());
    }
    this.info = info;
    const url = `wss://${info.domain}:${info.port}/Websocket/${this.bid}`;
    const ws = new MiniWebSocket(url, 'chat');
    this.ws = ws;
    let joined = false;

    ws.on('open', () => {
      ws.send(connectPacket());
      ws.send(joinPacket(info.chatNo));
      let waited = 0;
      this._joinTimer = setInterval(() => {
        if (joined) return clearInterval(this._joinTimer);
        waited += 1000;
        if (waited >= 10_000) {
          this._status('error', '채팅 서버가 JOIN 에 응답하지 않습니다');
          ws.close();
        } else ws.send(joinPacket(info.chatNo));
      }, 1000);
    });

    ws.on('message', (text) => {
      const pkt = parsePacket(text);
      if (!pkt) return;
      this.emit('packet', pkt);
      if (pkt.code === CODE.JOIN_CHANNEL && !joined) {
        joined = true;
        this.retry = 0;
        clearInterval(this._joinTimer);
        this._ping = setInterval(() => ws.readyState === 1 && ws.send(pingPacket()), 60_000);
        // 방송이 끝나도 채팅방은 한동안 열려 있어서 연결이 안 끊긴다.
        // 그래서 1분마다 방송이 아직 켜져 있는지 직접 확인하고, 꺼졌으면 나온다.
        this._liveCheck = setInterval(async () => {
          try {
            await getDetail(this.bid, info.bno);
          } catch (e) {
            if (!(e instanceof OfflineError) || ws.readyState !== 1) return; // 일시적인 조회 실패는 무시
            this._ended = true;
            ws.close();
          }
        }, 60_000);
        this._status('live', '채팅 연결됨', { title: info.title, bno: info.bno });
        return;
      }
      this._dispatch(pkt);
    });

    ws.on('close', () => {
      this._cleanup();
      if (this.closed) return;
      if (this._ended) {
        this._ended = false;
        this._status('offline', '방송이 끝났습니다. 다시 켜지면 자동으로 연결합니다');
        return this._schedule(this.offlineRetryMs);
      }
      this._status('reconnecting', '연결 끊김, 재연결 대기');
      this._schedule(this._backoff());
    });
    ws.on('error', () => {}); // close 에서 처리
  }

  _dispatch({ code, parts }) {
    const ts = Date.now();
    switch (code) {
      case CODE.CHAT_MESSAGE:
        if (parts.length < 8) return;
        // message | senderId | - | type | lang | nickname | flag | subMonth
        return this.emit('chat', {
          ts,
          message: parts[0],
          userId: normId(parts[1]),
          rawId: parts[1],
          nickname: parts[5],
          flag: parts[6],
          subMonth: parts[7],
        });
      case CODE.CHAT_USER:
        // 퇴장: -1 | userId | nickname | 퇴장사유 | - | flag
        // 퇴장사유 1=일반 퇴장, 2=강제퇴장(KCIK), 6=운영자 강제퇴장(ADMKICK)
        if (parts[0] === '-1' && (parts[3] === '2' || parts[3] === '6')) {
          return this.emit('sanction', {
            ts,
            type: 'kick',
            label: parts[3] === '6' ? '강제퇴장 (운영자)' : '강제퇴장',
            userId: normId(parts[1]),
            nickname: parts[2] || '',
          });
        }
        return;
      case CODE.SET_DUMB:
        if (!parts[0]) return;
        // userId | userInfo | dumbTime | dumbCount | adminId | adminType | extra | nickname
        // 필드가 덜 오는 경우도 있어 아이디만 있으면 처리한다
        return this.emit('sanction', {
          ts,
          type: 'mute',
          label: '채팅금지' + (parts[2] ? ` ${parts[2]}초` : '') + (parts[3] ? ` (${parts[3]}회차)` : ''),
          userId: normId(parts[0]),
          nickname: parts[7] || '',
          by: parts[4] || '',
          duration: Number(parts[2]) || 0,
          count: Number(parts[3]) || 0,
        });
      case CODE.KICK:
        if (parts.length < 5) return;
        return this.emit('sanction', {
          ts,
          type: 'kick',
          label: '강제퇴장' + (parts[3] ? ` (${parts[3]})` : ''),
          userId: normId(parts[0]),
          nickname: parts[1],
          by: parts[4],
        });
      case CODE.BLIND_KICK:
        if (parts.length < 3) return;
        return this.emit('sanction', {
          ts,
          type: 'blind',
          label: '블라인드 강퇴',
          userId: normId(parts[0]),
          nickname: parts[1],
          duration: Number(parts[2]) || 0,
        });
      case CODE.KICK_AND_CANCEL:
        if (parts.length < 3) return;
        return this.emit('sanction', {
          ts,
          type: 'kick',
          label: `강퇴/강퇴취소 (status=${parts[0]})`,
          userId: normId(parts[1]),
          nickname: parts[2],
          status: Number(parts[0]),
        });
    }
  }

  _backoff() {
    this.retry++;
    return Math.min(30_000, 2000 * 2 ** Math.min(this.retry - 1, 4));
  }

  _schedule(ms) {
    if (this.closed) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._connect(), ms);
  }

  _cleanup() {
    clearInterval(this._joinTimer);
    clearInterval(this._ping);
    clearInterval(this._liveCheck);
    if (this.ws && this.ws.readyState <= 1) {
      try {
        this.ws.close();
      } catch {}
    }
  }
}

module.exports = { SoopChat, parsePacket, buildPacket, normId, CODE, F };
