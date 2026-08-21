# 🏇 RACING GOA

GAMBLE GOA에서 **경마 / 시장(인력사무소 + HARU'S SHOP 장미) / 쓰레기통**만 따로 떼어,
접속한 모든 사람이 **같은 경마를 실시간으로 함께 보고 베팅**할 수 있게 만든 웹 서버입니다.
암시장, 룰렛, 스크래치 등은 포함되어 있지 않습니다.

- 서버가 경마를 직접 진행(PREP 60초 → 경주 → RESULT 30초)하고, 접속자 전원에게 동일한 결과를 중계합니다.
- 닉네임으로 입장하고, 소지금/보유아이템은 계정별로 개별 관리됩니다.
- 채팅 기능 포함.
- 데스크탑 화면에 맞춘 넓은 레이아웃입니다.

## 1. 로컬에서 먼저 테스트해보기

```bash
npm install
npm start
```

브라우저에서 `http://localhost:3000` 접속. `MONGODB_URI`를 설정하지 않으면
`data/users.json` 파일에 자동 저장됩니다 (로컬 테스트용으로 충분).

## 2. Render 무료 배포

### 2-1. GitHub에 올리기
이 폴더를 그대로 새 GitHub 저장소에 push 하세요.

### 2-2. Render에서 Web Service 생성
1. https://render.com 가입/로그인
2. **New +** → **Web Service** → 방금 만든 GitHub 저장소 선택
3. 설정값
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
4. **Environment** 탭에서 아래 환경변수 추가 (3단계에서 만들 MongoDB 주소)
   - `MONGODB_URI` = (3단계에서 발급받은 연결 문자열)
5. **Create Web Service** 클릭 → 몇 분 뒤 `https://your-app.onrender.com` 주소로 접속 가능

> ⚠️ **중요**: Render 무료 플랜은 디스크가 영구적이지 않아서, `MONGODB_URI`를 설정하지 않으면
> 재배포하거나 서버가 오래 쉬었다 깨어날 때 유저 데이터(소지금 등)가 초기화될 수 있습니다.
> 아래 3단계로 무료 MongoDB Atlas를 꼭 연결하는 것을 추천합니다.

## 3. MongoDB Atlas 무료 DB 연결 (데이터 영구 저장)

1. https://www.mongodb.com/cloud/atlas/register 에서 무료 가입
2. **Create a deployment** → **M0 (Free)** 클러스터 생성 (리전은 아무거나, Seoul 있으면 Seoul 추천)
3. **Database Access**에서 유저 생성 (아이디/비밀번호 기억해두기)
4. **Network Access**에서 **Allow Access from Anywhere** (0.0.0.0/0) 추가 (Render가 매번 IP가 바뀌기 때문)
5. **Connect** → **Drivers** → 연결 문자열 복사
   `mongodb+srv://<username>:<password>@xxxx.mongodb.net/?retryWrites=true&w=majority`
6. `<username>`, `<password>` 부분을 실제 값으로 바꾼 뒤, Render의 `MONGODB_URI` 환경변수에 붙여넣기
7. Render에서 **Manual Deploy** 로 재배포하면 다음 로그가 뜨면 성공:
   `[store] MongoDB Atlas 연결 완료 — 데이터가 영구 저장됩니다.`

이후로는 Render를 재배포하거나 서버가 잠들었다 깨어나도 유저의 소지금/아이템은 그대로 유지됩니다.

## 4. 서버 업데이트/재배포 시 동작

- 화면 상단에 "서버가 업데이트되었습니다. 새로고침해주세요" 배너가 자동으로 뜹니다 (재배포로 서버가 재시작되면 감지됨).
- 경기 중(베팅 이후 ~ 정산 전)에 서버가 재시작되더라도, 베팅했던 돈은 서버가 다시 켜질 때 자동으로 전액 환불됩니다. (정상 종료 신호(SIGTERM) 기준이며, MongoDB Atlas를 연결해두면 더 안전합니다.)

## 5. 게임 규칙 요약

- **경마**: 60초 베팅 준비 → 경주 진행 → 30초 결과 발표, 무한 반복. 1위는 배당금 그대로, 2위는 ×0.3(장미 보유 시 ×1.0), 3위는 ×0.1 지급.
- **인력사무소**: $500에 알바생 고용(최대 5명), 8초마다 알바생 1명당 확률적으로 $0~$10 자동 수익. 접속을 끊어도 계속 일합니다.
- **HARU'S SHOP — 누군가의 장미**: $30,000. 경마 2위 배당 페널티(×0.3)를 없애고 전액 지급받게 해줍니다.
- **쓰레기통**: 클릭 시 88% 꽝, 10% $1, 2% $10.
- **로그인**: 닉네임+비밀번호로 회원가입 후 로그인합니다. 같은 브라우저에서는 자동으로 재접속되고, 다른 기기/브라우저에서는 로그인 탭에서 닉네임+비밀번호를 입력하면 같은 계정으로 접속됩니다. 비밀번호는 서버에 해시(bcrypt)로만 저장됩니다.

## 6. 관리자 시스템

- Render 환경변수에 `ADMIN_SECRET`을 원하는 비밀키로 설정하세요 (예: `myGoaSecret2026`). 설정 안 하면 서버가 켜질 때마다 무작위 키가 생성되어 **서버 로그(Render Logs 탭)** 에 한 번 출력되고, 서버 재시작하면 키가 바뀝니다 — 꾸준히 쓰려면 꼭 직접 설정하세요.
- 채팅창에 `/admin 비밀키` 를 입력하면 그 계정이 관리자가 됩니다.
- 관리자 명령어 (채팅창에 입력):
  - `/money 닉네임 금액` — 소지금 지급(양수)/회수(음수). 예: `/money 홍길동 10000`
  - `/op 닉네임` — 그 닉네임을 관리자로 지정
  - `/deop 닉네임` — 관리자 권한 해제
  - `/announce 메시지` — 전체 유저 채팅창에 공지 방송
  - `/help` — 명령어 목록 보기
- `/` 로 시작하는 채팅 메시지는 일반 채팅으로 전송되지 않고 명령어로만 처리됩니다.

## 7. 폴더 구조

```
racing-goa/
  server.js          # Express + Socket.IO 메인 서버
  lib/
    raceEngine.js     # 경마 시뮬레이션 순수 로직 (원본 GAMBLE_GOA에서 포팅)
    raceLoop.js        # PREP/RACING/RESULT 사이클을 도는 서버 루프, 베팅 처리
    store.js           # 유저 데이터 저장 (MongoDB Atlas 또는 JSON 파일)
  public/
    index.html         # 클라이언트 화면 (CSS/JS 전부 포함된 단일 HTML 파일, 원본 GAMBLE_GOA와 동일한 방식)
```
