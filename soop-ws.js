// 최소 WebSocket 클라이언트 (RFC 6455).
// Node 내장 WebSocket 이 SOOP 채팅 서버의 핸드셰이크 응답에서 멈추는 문제가 있어 직접 구현한다.
'use strict';

const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class MiniWebSocket extends EventEmitter {
  constructor(url, protocol, { timeoutMs = 10_000 } = {}) {
    super();
    this.readyState = 0; // 0 connecting, 1 open, 3 closed
    this._buf = Buffer.alloc(0);
    this._frag = [];
    const u = new URL(url);
    const req = https.request({
      host: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      timeout: timeoutMs,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        ...(protocol ? { 'Sec-WebSocket-Protocol': protocol } : {}),
      },
    });
    req.on('upgrade', (res, socket, head) => {
      this.socket = socket;
      socket.setTimeout(0);
      socket.setNoDelay(true);
      this.readyState = 1;
      socket.on('data', (d) => this._onData(d));
      socket.on('close', () => this._closed(1006));
      socket.on('error', (e) => this.emit('error', e));
      this.emit('open');
      if (head && head.length) this._onData(head);
    });
    req.on('response', (res) => {
      this.emit('error', new Error('WebSocket 업그레이드 실패: HTTP ' + res.statusCode));
      this._closed(1002);
    });
    req.on('timeout', () => req.destroy(new Error('WebSocket 연결 시간 초과')));
    req.on('error', (e) => {
      this.emit('error', e);
      this._closed(1006);
    });
    req.end();
    this._req = req;
  }

  send(text) {
    if (this.readyState !== 1) return;
    this._write(0x1, Buffer.from(text, 'utf8'));
  }

  close() {
    if (this.readyState === 1) {
      try {
        this._write(0x8, Buffer.from([0x03, 0xe8]));
      } catch {}
      this.socket.end();
    } else if (this._req) this._req.destroy();
    this._closed(1000);
  }

  _write(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      const b = this._buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      const maskKey = masked ? b.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (b.length < off + len) return;
      let payload = b.subarray(off, off + len);
      if (maskKey) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      }
      this._buf = b.subarray(off + len);
      this._frame(fin, opcode, payload);
    }
  }

  _frame(fin, opcode, payload) {
    if (opcode === 0x9) return this._write(0xa, payload); // ping → pong
    if (opcode === 0xa) return;
    if (opcode === 0x8) return this.close();
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      this._frag.push(Buffer.from(payload));
      if (!fin) return;
      const data = Buffer.concat(this._frag).toString('utf8');
      this._frag = [];
      this.emit('message', data);
    }
  }

  _closed(code) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.socket) this.socket.destroy();
    this.emit('close', code);
  }
}

module.exports = { MiniWebSocket };
