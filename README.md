# NC-Baseball-alert

NC 다이노스 경기의 **시작 · 취소 · 득점 · 종료**를 그 시점에 푸시로 알려주고,
일자별 경기 기록을 앱에서 볼 수 있는 PWA입니다.

- 홈 화면에 추가하면 아이콘 · 전체화면 · 푸시까지 네이티브 앱처럼 동작합니다 (Android / iOS 16.4+)
- 알림 종류를 각각 켜고 끌 수 있습니다 (기기별로 저장)
- Cloudflare Workers 무료 티어에서 돌아갑니다. PC를 켜 둘 필요가 없습니다

---

## 구조

```
Cron (1분마다)
   └─ 네이버 스포츠 KBO 일정 API 조회
        └─ 직전 스냅샷(D1)과 비교 → 상태 전이 감지
             └─ 새 이벤트면 D1에 기록 + 구독자에게 Web Push
```

| 파일 | 역할 |
|---|---|
| `src/index.js` | Worker 진입점. 크론 핸들러 + `/api/*` |
| `src/kbo.js` | 네이버 KBO API 어댑터. 응답 스키마 변경 시 여기만 고치면 됨 |
| `src/detect.js` | 스냅샷 비교 → 알림 이벤트 생성 |
| `src/push.js` | Web Push 구현 (VAPID + aes128gcm, 외부 패키지 없음) |
| `src/db.js` | D1 쿼리 |
| `public/` | PWA (화면 · 서비스워커 · 매니페스트 · 아이콘) |

### 데이터 출처

네이버 스포츠의 비공식 엔드포인트 `api-gw.sports.naver.com/schedule/games` 를 씁니다.
공식 문서가 없으므로 스키마가 예고 없이 바뀔 수 있습니다. 문제가 생기면 `src/kbo.js`만 보면 됩니다.

한 번의 응답에서 필요한 값을 모두 얻습니다:

| 필드 | 쓰임 |
|---|---|
| `statusCode` | 경기 전(`BEFORE`) / 진행 중 / 종료(`RESULT`) |
| `cancel` | 경기 취소 여부 |
| `homeTeamScore`, `awayTeamScore` | 득점 감지 (직전 값과 비교) |
| `statusInfo` | "7회말" 같은 상황 표시 |

> **알려진 미검증 사항**: 개발 시점에 진행 중인 경기가 없어 *경기 중* 상태의 `statusCode`
> 실제 값을 확인하지 못했습니다. 코드는 `BEFORE`도 `RESULT`도 아니면 진행 중으로 간주하고,
> 원본 `statusCode`를 DB에 남깁니다. 첫 실경기 때 `wrangler tail` 로 확인해 두면 좋습니다.

### 중복 발송 방지

모든 이벤트에 `dedup_key`(UNIQUE)를 둡니다. 크론이 중복 실행되거나 재시도돼도
`INSERT OR IGNORE` 가 걸려 같은 알림이 두 번 가지 않습니다.
득점은 키에 점수 조합을 넣어(`G1:score:3-0`) 매 득점 상황이 각각 발송됩니다.

---

## 설치

### 0. 사전 준비

- Node 18 이상
- Cloudflare 계정 (무료)
- Python 3 (아이콘을 다시 생성할 때만. 이미 생성된 PNG가 저장소에 포함돼 있습니다)

```bash
npm install
npx wrangler login
```

### 1. D1 데이터베이스 생성

```bash
npx wrangler d1 create nc-alert
```

출력된 `database_id` 를 `wrangler.toml` 의 `REPLACE_WITH_YOUR_D1_DATABASE_ID` 자리에 넣습니다.

스키마를 적용합니다.

```bash
npm run db:init
```

### 2. VAPID 키 생성

```bash
npm run genkeys
```

- 출력된 **공개키** → `wrangler.toml` 의 `VAPID_PUBLIC_KEY`
- 출력된 **개인키** → 시크릿으로 등록 (파일에 넣지 마세요)

```bash
npx wrangler secret put VAPID_PRIVATE_KEY
```

`wrangler.toml` 의 `VAPID_SUBJECT` 도 본인 메일 주소로 바꿔 주세요.
푸시 서비스가 문제 발생 시 연락할 주소이며, 형식이 맞지 않으면 발송이 거부될 수 있습니다.

### 3. 배포

```bash
npm run deploy
```

`https://nc-baseball-alert.<계정>.workers.dev` 주소가 나옵니다.

### 4. 휴대폰에 설치

**Android (Chrome)** — 주소를 열고 메뉴 → *홈 화면에 추가*. 앱을 열어 **알림 켜기**.

**iPhone (Safari)** — 반드시 **Safari**로 열어야 합니다.
공유 버튼 → *홈 화면에 추가* → **홈 화면 아이콘으로 다시 열기** → **알림 켜기**.
iOS는 홈 화면에 추가한 PWA에서만 푸시를 허용하므로, 사파리 탭에서는 버튼이 비활성으로 보입니다.

설정 화면의 **테스트 알림 보내기** 로 동작을 확인하세요.

---

## 확인 · 운영

```bash
npm test              # 암호화 왕복 + 상태 전이 로직 검증 (네트워크 불필요)
npm run tail          # 실시간 로그
```

크론을 기다리지 않고 즉시 한 번 폴링:

```bash
curl -X POST https://<배포주소>/api/poll
```

> 배포 직후 첫 폴링은 스냅샷만 저장하고 알림을 보내지 않습니다.
> 과거 경기가 한꺼번에 알림으로 쏟아지는 것을 막기 위한 의도된 동작입니다.
> 두 번째 폴링부터 정상적으로 변화를 감지합니다.

### API

| 엔드포인트 | 메서드 | 설명 |
|---|---|---|
| `/api/config` | GET | VAPID 공개키, 대상 팀 코드 |
| `/api/history?days=30` | GET | 일자별 경기 기록 + 이벤트 로그 |
| `/api/subscribe` | POST | 푸시 구독 등록 |
| `/api/unsubscribe` | POST | 구독 해제 |
| `/api/settings` | GET/POST | 알림 종류별 on/off 조회 · 변경 |
| `/api/test` | POST | 본인에게 테스트 알림 발송 |
| `/api/poll` | POST | 즉시 1회 폴링 |

---

## 비용

Cloudflare 무료 티어 기준으로 충분합니다.

- Workers: 하루 10만 요청 / 크론은 하루 1,440회 실행
- D1: 5GB 저장, 하루 500만 행 읽기

크론 핸들러는 KST 12~23시가 아니면 즉시 반환하므로 실제 API 호출은 하루 700회 안팎입니다.

## 다른 팀으로 바꾸기

`wrangler.toml` 의 `TEAM_CODE` 를 바꾸고 재배포하면 됩니다.

`HT`(KIA) `SS`(삼성) `LG` `OB`(두산) `KT` `SK`(SSG) `LT`(롯데) `NC` `WO`(키움) `HH`(한화)

## 라이선스

MIT
