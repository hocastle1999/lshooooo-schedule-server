# 이상호 매니저 작업실

SOOP 스트리머 **이상호(lshooooo)** 방송 매니저들이 같이 쓰는 웹사이트입니다.
방송 일정·공지·메모를 한곳에서 관리하고, 방송 채팅을 서버가 직접 받아서 후원 룰렛 명단, 참여자 검색, 주의 시청자 알림, 금지 단어 찾기, 방송 참여 중 매니저 표시 같은 방송 도구를 제공합니다.

> 매니저 로그인(이름 + 공용 비밀번호)이 있어야 들어올 수 있습니다. 비밀번호는 Render 환경변수 `MANAGER_PASSWORD`로 정합니다.

---

## 기능

### 매니저 작업실 (메인 화면, `/`)

| 기능 | 설명 |
|---|---|
| 방송 일정 달력 | 날짜를 눌러 일정 추가·수정·삭제. 일정 메모는 제목 아래에 표시. 일요일은 빨강, 토요일은 파랑 |
| 날짜 미정 일정 | 날짜가 안 정해진 일정을 적어 두고 📅 버튼으로 달력에 배정 |
| 메모장 | 일정·CK·매크로 등 페이지(탭)별 메모, 자동 저장. 탭은 끌어서(휴대폰은 ◀ ▶) 순서 변경 |
| 🔤 글자 변환 | 메모장 제목 옆. 𝗚𝗘𝗡 같은 꾸민 글자 30가지로 바꿔 복사, ☆ 즐겨찾기한 스타일은 맨 위 고정 |
| 첨부 파일 | 파일 1개당 5MB까지 올려 두고 같이 내려받기 |
| 최근 방송 공지 | 방송국 게시판 공지를 2시간마다 자동 크롤링, `⟳ 공지 새로고침`으로 즉시 갱신. 제목을 눌러 접기/펼치기 (브라우저에 기억) |
| 📋 제재 기준 | 제목 옆 버튼. 누르면 제재 기준을 보고 같은 창에서 수정 |
| 📰 패치 노트 | 제재 기준 옆 버튼. 사이트 업데이트 내용을 보고 수정 |
| 방송 참여 중 매니저 | 지금 방송 채팅방에 들어와 있는 매니저를 제목 아래에 모두 표시 (5초마다 갱신) |
| 변경 기록 · 백업 | 작업실 아래 카드(눌러서 펼치기). 누가 언제 무엇을 바꿨는지, 매일 자동 백업과 골라서 되돌리기 |
| 바로가기 링크 | 딥롤, 숲롤, 숲로그, 배그·공경내기 시트지, FC온라인 스트리머 랭크, 유니코드 변환, 👮제재내역(트래키파이 페이지로 이동만) |

각 카드의 설명은 제목 옆 **?** 버튼을 누르면 보입니다.

### 🎰 후원 룰렛 명단 (`/roulette.html`)

`soopchat-roulette.exe`를 사이트로 옮긴 기능입니다. PC를 켜 둘 필요 없이 서버가 채팅을 받아서 모읍니다.

- 별풍선 · 애드벌룬 · 도전미션 · 대결미션 후원자를 자동으로 모아 `닉네임(아이디)*배수,...` 룰렛 명단을 만듦
- 기준 별풍선 개수, 보너스 계산식(기본 배수 10마다 +1), 집계할 항목은 수집 중에도 바꿀 수 있음
- 실시간 후원 현황: 최신순 / 개수순 정렬, 닉네임·아이디 눌러서 복사
- **룰렛 돌리기**: 사이트에서 바로 돌림판을 돌림 (배수만큼 칸이 넓어짐, 당첨자 빼기 옵션, 당첨 기록)
- 명단 복사, [lazygyu 룰렛](https://lazygyu.github.io/roulette) 열기, 후원 기록 CSV 받기, 초기화
- 수집 중에 서버가 재시작돼도 명단이 남아 있고 자동으로 다시 접속함

### 🔎 참여자 검색 · 주의 시청자 (`/watch.html`)

방송 채팅방을 서버가 직접 보고 있다가 알려주는 도구입니다.

| 탭 | 내용 |
|---|---|
| **1 참여자 검색** (`#search`, `#q=검색어`) | 지금 방송에 들어와 있는 시청자를 아이디·닉네임으로 찾기. 매니저·열혈팬·구독·팬클럽·입장 시각 표시 |
| **2 주의 시청자** (`#watch`) | 등록해 둔 시청자가 채팅하면 알림 (이 페이지를 열어 두면 어느 탭이든, 브라우저 알림·소리 선택). 목록·메모는 매니저 모두가 같이 씀 |
| **3 금지 단어** (`#banned`) | 금지 단어를 등록하면 그 단어가 들어간 채팅과 친 사람을 최신순으로 보여줌. 띄어쓰기·대소문자 무시. 단어를 눌러 그 단어만 보기 |

공통:

- 닉네임은 **아이디 기준 최신 닉네임**을 보여주고, 바뀐 경우 바로 직전 닉네임 하나를 `이전 닉`으로 표시
- `참여 중` = 지금 방송에 들어와 있는 사람, ⭐ = 주의 시청자
- 닉네임·아이디를 누르면 복사
- 금지 단어는 서버가 모아 둔 **최근 7일 · 최대 2만 줄** 채팅에서 찾습니다 (서버가 채팅방에 들어가 있던 동안 받은 채팅만)

### 로그인 (`/login.html`)

- 이름과 공용 비밀번호로 로그인하면 30일 동안 유지됩니다. 비밀번호를 바꾸면 모두 다시 로그인해야 합니다.
- 여러 번 틀려도 잠그지 않습니다. 로그인 기록은 변경 기록에 남습니다.
- `MANAGER_PASSWORD`가 비어 있으면 로그인 없이 열립니다 (PC 테스트용).

---

## 동작 방식

### 데이터 출처

| 데이터 | 출처 | 갱신 |
|---|---|---|
| 채팅(후원, 참여자 목록, 매니저 표시, 주의 시청자·금지 단어) | SOOP 채팅 서버에 직접 접속 (`soop-chat.js`) | 실시간 |
| 공지 | SOOP 방송국 게시판 크롤링 (Playwright) | 2시간마다 |
| 일정·메모·제재 기준·패치 노트 등 | 매니저가 직접 입력 | — |

**트래키파이**: 약관(무단 수집·복제, 과도한 자동 요청 금지)에 맞춰 트래키파이에서 데이터를 가져오는 기능은 모두 껐습니다 (`watch.js`의 `TRACKIFY_OFF`). 예전에 저장해 둔 트래키파이 데이터(`sanctions`, `channelCounts`, `userSummaries`, `broadcasts`)는 서버가 켜질 때 지웁니다. 작업실의 👮제재내역은 트래키파이 페이지로 가는 링크일 뿐입니다.

### 채팅 연결

- 서버가 켜져 있는 동안 항상 이상호 방송 채팅방에 붙어 있습니다. 방송이 꺼져 있으면 1분마다 확인하다가 켜지면 자동으로 들어갑니다.
- 방송이 끝나도 SOOP 채팅방이 한동안 열려 있어서, 1분마다 방송 상태를 직접 확인해 끝났으면 나옵니다. 방송 제목이 바뀌면 따라 바꿉니다.
- **매니저 표시**: 참여자 목록의 flag 256 비트가 매니저입니다. 방송 도중 들어온 사람은 입장 알림에 매니저 표시가 빠져 오는 경우가 있어서, 매니저를 아이디로 따로 기억하고 3분마다 새 전체 목록으로 다시 맞춥니다.
- **채팅 기록**: 금지 단어 찾기용으로 최근 7일 · 최대 2만 줄을 메모리에 모으고 2분마다(그리고 서버가 꺼질 때) 저장합니다.
- Render 무료 플랜은 15분간 접속이 없으면 잠들기 때문에, 채팅을 받는 동안은 10분마다 자기 자신을 불러 깨어 있게 합니다 (`keepawake.js`).

### 변경 기록 · 백업

- 데이터를 바꾸는 요청이 성공하면 누가(로그인 이름) 무엇을 바꿨는지 남깁니다. 최근 500줄, 메모 자동 저장처럼 자주 오는 것은 같은 사람이 30분 안에 또 바꾸면 한 줄로 합칩니다.
- 하루에 한 번(한국 시간 날짜가 바뀌면) 일정·날짜 미정 일정·메모장·제재 기준·주의 시청자·금지 단어를 자동 백업합니다. 자동 7개, 직접 백업 5개, 되돌리기 전 백업 3개까지 남깁니다.
- 되돌릴 때 항목을 골라서 되돌릴 수 있고, 되돌리기 직전 상태도 백업으로 남습니다.

---

## 파일 구조

```
server.js        Express 서버, 일정·메모·첨부·공지·제재 기준·패치 노트 API, 모듈 연결
auth.js          매니저 로그인 (서명한 쿠키, 30일)
audit.js         변경 기록
backup.js        매일 자동 백업 · 되돌리기
store.js         저장소 (Upstash Redis, 없으면 data/*.json)
crawler.js       방송국 게시판 공지 크롤링
roulette.js      후원 룰렛 명단 (채팅 후원 수집·배수 계산)
watch.js         참여자 목록·매니저 표시·참여자 검색·주의 시청자·채팅 기록·금지 단어
soop-chat.js     SOOP 채팅 클라이언트 (getCurrentThread/soopapi 프로토콜을 Node.js로)
soop-ws.js       최소 WebSocket 클라이언트
keepawake.js     Render 잠들기 방지
public/
  index.html       매니저 작업실
  login.html       로그인
  auth.js          로그인이 풀리면 로그인 화면으로 보내기
  unicode.js       🔤 글자 변환
  roulette.html    후원 룰렛 명단
  watch.html       참여자 검색 · 주의 시청자 · 금지 단어
  viewers.html     예전 주소 → watch.html 로 이동
  icons/           탭 아이콘
```

### 주요 API

| 경로 | 설명 |
|---|---|
| `GET /api/state` | 일정·공지·메모·첨부·제재 기준·패치 노트·매니저 (작업실이 20초마다 호출) |
| `GET /api/managers` | 방송 참여 중 매니저 (5초마다 호출) |
| `GET /api/version` | 지금 돌고 있는 커밋 (배포 확인용, 로그인 없이 열림) |
| `POST /api/login` · `POST /api/logout` · `GET /api/me` | 로그인 |
| `GET·DELETE /api/audit` | 변경 기록 보기·지우기 |
| `GET·POST /api/backups` · `POST /api/backups/:id/restore` | 백업 목록·직접 백업·되돌리기 |
| `POST /api/sanction-rules` · `POST /api/patch-notes` | 제재 기준 · 패치 노트 저장 |
| `GET /api/roulette` · `POST /api/roulette/start·stop·filter·reset` · `GET /api/roulette/log.csv` | 후원 룰렛 |
| `GET /api/viewers/search?q` | 참여자 검색 |
| `GET·POST·DELETE /api/watchlist` · `GET /api/watchlist/alerts?since` | 주의 시청자 · 채팅 알림 |
| `GET /api/banned-words?word` · `POST /api/banned-words` · `DELETE /api/banned-words/:word` | 금지 단어 · 그 단어가 들어간 채팅 |

### 저장소 키 (Upstash)

`events`, `unscheduled`, `memos`, `files`·`file_<id>`, `notices`, `meta`, `sanctionRules`, `patchNotes`·`patchNotesAdded`, `roulette`, `roulette_log`, `watchlist`, `watchAlerts`, `bannedWords`, `chatLog`, `auditLog`, `backups`(백업 목록)·`backup:<id>`

---

## 배포

GitHub `main` 브랜치에 push하면 Render가 자동으로 다시 배포합니다 (`render.yaml`). 처음 설정 방법은 [DEPLOY.md](DEPLOY.md)를 참고하세요.

필요한 환경변수:

- `MANAGER_PASSWORD` — 매니저 공용 비밀번호 (비우면 로그인 없이 열림)
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — 데이터 저장 (없으면 `data/*.json` 파일에 저장)
- `PLAYWRIGHT_BROWSERS_PATH=0` — 크롤러용 Chromium을 node_modules 안에 받기
- `RENDER_EXTERNAL_URL`, `RENDER_GIT_COMMIT` — Render가 자동으로 넣어줌 (잠들기 방지, 배포 확인용)

## PC에서 실행하기 (테스트용)

```bash
npm install
node server.js
```

또는 `start.bat`을 더블클릭한 뒤 브라우저에서 http://localhost:3000 으로 접속합니다. Upstash 환경변수가 없으면 `data/*.json` 파일에 저장해서 실제 사이트 데이터와 섞이지 않습니다. Node.js 18 이상이 필요합니다.

## 참고

- 채팅 프로토콜: [getCurrentThread/soopapi](https://github.com/getCurrentThread/soopapi), [halfdogs/soopchat](https://github.com/halfdogs/soopchat)
- 룰렛 배수 계산(보너스 코인): [Gyeon-ai/ManPinball](https://github.com/Gyeon-ai/ManPinball)
