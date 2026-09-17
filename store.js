// store.js — 상태 저장소
//
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 환경변수가 설정되어 있으면
// Upstash Redis(무료, 영구 저장)를 사용합니다. Render 같은 클라우드에 배포할 때는
// 로컬 디스크가 재시작할 때마다 초기화되기 때문에 이 방식을 써야 데이터가 안전합니다.
//
// 두 환경변수가 없으면(예: 매니저 PC에서 그냥 로컬로 실행할 때) data/*.json 파일에
// 저장하는 예전 방식으로 자동 전환됩니다. 즉, 로컬 실행과 클라우드 배포 둘 다
// server.js 코드는 그대로 두고 이 파일 하나로 저장 방식만 갈아끼울 수 있습니다.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useRedis = Boolean(REDIS_URL && REDIS_TOKEN);

let redis = null;
if (useRedis) {
  // @upstash/redis 는 필요할 때만 로드합니다 (로컬 모드에서는 설치 안 돼 있어도 됨).
  const { Redis } = require('@upstash/redis');
  redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  console.log('[store] Upstash Redis 저장소를 사용합니다 (영구 저장 O)');
} else {
  console.log('[store] 로컬 data/*.json 파일 저장소를 사용합니다.');
  console.log('[store] 클라우드에 배포할 때는 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 환경변수를 꼭 설정하세요. (안 하면 재시작할 때 데이터가 사라질 수 있습니다)');
}

function localFile(key) {
  return path.join(DATA_DIR, key + '.json');
}
function localRead(key, fallback) {
  try {
    return JSON.parse(fs.readFileSync(localFile(key), 'utf8'));
  } catch (e) {
    return fallback;
  }
}
function localWrite(key, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(localFile(key), JSON.stringify(value, null, 2), 'utf8');
}

async function getState(key, fallback) {
  if (useRedis) {
    try {
      const value = await redis.get(key);
      return value === null || value === undefined ? fallback : value;
    } catch (e) {
      console.error('[store] Redis 읽기 실패, 기본값 사용:', e.message);
      return fallback;
    }
  }
  return localRead(key, fallback);
}

async function setState(key, value) {
  if (useRedis) {
    await redis.set(key, value);
    return;
  }
  localWrite(key, value);
}

module.exports = { getState, setState, useRedis };
