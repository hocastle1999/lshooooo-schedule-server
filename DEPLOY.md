# 클라우드에 배포해서 PC 꺼도 계속 쓰기

지금까지는 호성님 PC에서 `start.bat`으로 서버를 켜고 ngrok으로 외부에 열어주는
방식이었습니다. PC를 끄면 서버도 같이 꺼져요. 이 문서대로 하면 Render라는
무료 클라우드에 올려서, PC를 꺼도 24시간 켜져 있는 서버로 바꿀 수 있습니다.

필요한 계정 3개 (전부 무료, 카드 등록 필요 없음):
1. GitHub — 이미 있음
2. Upstash — 일정/메모 데이터를 영구 저장할 곳
3. Render — 실제로 서버가 돌아가는 곳

---

## 1단계. Upstash에서 무료 Redis 만들기 (데이터 저장소)

1. https://upstash.com 에서 회원가입 (GitHub 계정으로 로그인해도 됩니다).
2. 로그인하면 "Create Database" 버튼 클릭.
3. 이름은 아무거나 (예: `lshooooo-schedule`), 타입은 **Redis**, 리전은 아무 곳이나
   (한국에서 가깝게 쓰려면 `ap-northeast` 계열 선택).
4. 만들어지면 데이터베이스 상세 페이지에 **REST API** 섹션이 있습니다. 거기서
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   두 값을 복사해서 메모장 같은 곳에 잠깐 저장해두세요. (3단계에서 씁니다)

## 2단계. 이 프로젝트를 GitHub에 올리기

이미 있는 GitHub 계정으로, 새 저장소(레포)를 하나 만들고 이 폴더
(`lshooooo-schedule-server`)를 그대로 올리면 됩니다.

**터미널(명령 프롬프트/PowerShell)을 쓸 수 있다면:**
```
cd lshooooo-schedule-server 폴더 경로로 이동
git init
git add .
git commit -m "이상호 방송 일정 서버"
git branch -M main
git remote add origin https://github.com/<본인아이디>/lshooooo-schedule-server.git
git push -u origin main
```
(GitHub에서 미리 빈 저장소를 하나 만들어두고, 그 주소를 `git remote add`에 넣으면 됩니다.
저장소는 Public이든 Private이든 상관없어요.)

**터미널이 어렵다면:** GitHub 웹사이트에서 새 저장소를 만든 뒤, "uploading an
existing file" 링크로 들어가서 이 폴더 안의 파일/폴더를 통째로 끌어다 놓아도
됩니다. (단, `node_modules` 폴더가 혹시 있다면 그건 올리지 마세요 — 필요 없고
용량만 큽니다. `data` 폴더의 `*.json` 파일들은 올려도 되고 안 올려도 됩니다,
Render에서는 Upstash를 쓰니까요.)

## 3단계. Render에 배포하기

1. https://render.com 에서 회원가입 (GitHub 계정으로 로그인하면 저장소 연결이 편합니다).
2. 대시보드에서 **New +** → **Blueprint** 클릭 → 방금 올린 GitHub 저장소 선택.
   (이 프로젝트에 있는 `render.yaml` 파일을 Render가 자동으로 읽어서 설정을 채워줍니다.)
   - Blueprint가 안 보이거나 복잡하면, 대신 **New +** → **Web Service**로 만들고
     아래 값을 직접 입력해도 됩니다:
     - Build Command: `npm install && npx playwright install --with-deps chromium`
     - Start Command: `node server.js`
     - Instance Type: Free
3. 환경변수(Environment) 설정 화면에서 1단계에서 복사해둔 값을 넣어주세요:
   - `UPSTASH_REDIS_REST_URL` = (복사해둔 값)
   - `UPSTASH_REDIS_REST_TOKEN` = (복사해둔 값)
4. **Deploy** 누르면 몇 분 정도 빌드가 진행됩니다 (Chromium 설치 때문에 첫 배포는
   조금 걸려요). 끝나면 `https://lshooooo-schedule-server-xxxx.onrender.com` 같은
   주소가 생깁니다. 이게 새로운 접속 주소예요.

## 참고할 점

- 무료 플랜은 15분 정도 아무도 안 들어오면 서버가 잠들고, 그 다음 첫 접속 때
  10~30초 정도 깨어나는 시간이 걸립니다. 그 뒤로는 정상 속도로 동작해요.
- 데이터(일정/메모/공지)는 이제 Upstash Redis에 저장되기 때문에 서버가
  잠들었다 깨어나거나 재배포돼도 사라지지 않습니다.
- 예전처럼 PC에서 `start.bat`으로 로컬 실행도 계속 됩니다 — 그때는 Upstash
  환경변수가 없으니 자동으로 `data/*.json` 파일 저장 방식으로 돌아갑니다
  (테스트용으로 쓰기 좋아요).
- 새 Render 주소가 정해지면 저번에 얘기했던 `ishscheduler.com` 같은 도메인을
  이 주소로 연결(리다이렉트/CNAME)하는 것도 그대로 가능합니다.
- 배포 후 안 되는 부분이 있으면 Render 대시보드의 **Logs** 탭에 에러가 그대로
  뜨니, 그 내용을 저한테 보여주시면 같이 고칠 수 있어요.
