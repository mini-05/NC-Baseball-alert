-- 경기 스냅샷: 폴링할 때마다 최신 상태를 덮어쓰고, 직전 값과 비교해 전이를 감지한다.
CREATE TABLE IF NOT EXISTS game_state (
  game_id       TEXT PRIMARY KEY,
  game_date     TEXT NOT NULL,          -- YYYY-MM-DD (KST)
  start_at      TEXT NOT NULL,          -- ISO8601 (KST, 오프셋 없음)
  stadium       TEXT,
  home_code     TEXT NOT NULL,
  home_name     TEXT NOT NULL,
  away_code     TEXT NOT NULL,
  away_name     TEXT NOT NULL,
  home_score    INTEGER NOT NULL DEFAULT 0,
  away_score    INTEGER NOT NULL DEFAULT 0,
  phase         TEXT NOT NULL,          -- before | live | result
  series        TEXT NOT NULL DEFAULT 'regular',  -- regular | wildcard | semi_playoff | playoff | korean_series | tiebreaker
  status_code   TEXT,                   -- 네이버 원본 statusCode (미지의 값 추적용)
  status_info   TEXT,                   -- "3회말", "경기취소" 등
  cancelled     INTEGER NOT NULL DEFAULT 0,
  suspended     INTEGER NOT NULL DEFAULT 0,
  scoreboard    TEXT,                    -- 이닝별 점수(전광판). JSON. 경기 전이면 NULL
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_game_state_date ON game_state(game_date DESC);

-- 발생한 알림 이벤트 이력. 일자별 기록 화면의 원천이자 중복 발송 방지 키.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id    TEXT NOT NULL,
  game_date  TEXT NOT NULL,
  -- start | cancel | score | concede | end
  -- concede(실점)는 발송 종류가 아니라 기록 전용 값이다. 알림은 score 로 나가고
  -- (구독 on/off 는 on_score 하나로 묶인다) 기록 탭 라벨만 실점으로 갈린다.
  kind       TEXT NOT NULL,
  series     TEXT NOT NULL DEFAULT 'regular',
  dedup_key  TEXT NOT NULL UNIQUE,      -- 같은 전이를 두 번 알리지 않기 위한 키
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  home_score INTEGER NOT NULL DEFAULT 0,
  away_score INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  -- 단말이 실제로 알림을 띄우고 /api/delivered 로 알려온 시각. NULL 이면 아직
  -- 어느 단말도 띄웠다고 알려오지 않은 것이다. 서버가 FCM 에 넘긴 뒤 단말에
  -- 안 뜨는 유실(2026-08-30, 09-01 각 1건)을 재기 위해 둔다 — created_at 과의
  -- 차이가 곧 배달 지연이고, 끝내 NULL 이면 유실이다.
  -- 여러 구독 중 첫 응답만 남긴다(이벤트 단위). 구독별로 따로 재려면 별도
  -- 테이블이 필요한데, 지금 구독은 몇 건뿐이라 그 비용을 들일 단계가 아니다.
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_date ON events(game_date DESC, id DESC);

-- 감시를 접어도 되는지 판단할 때(allSettledBefore) 경기별 종료·취소 이벤트를
-- 찾는다. 위 idx_events_date 는 game_date 로 시작해 이 조회에 쓰이지 못해,
-- 인덱스가 없으면 매 크론 틱마다 events 전체를 스캔하게 된다.
CREATE INDEX IF NOT EXISTS idx_events_game ON events(game_id, kind);

-- 푸시 구독. 알림 종류별 on/off 와 시리즈 범위 설정을 구독 단위로 보관한다.
CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint      TEXT PRIMARY KEY,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  on_start      INTEGER NOT NULL DEFAULT 1,
  on_cancel     INTEGER NOT NULL DEFAULT 1,
  on_score      INTEGER NOT NULL DEFAULT 1,
  on_end        INTEGER NOT NULL DEFAULT 1,
  -- 시리즈 범위: 정규시즌 / 포스트시즌을 따로 끌 수 있다.
  on_regular    INTEGER NOT NULL DEFAULT 1,
  on_postseason INTEGER NOT NULL DEFAULT 1,
  -- 켜면 홈경기 알림만 받는다. 기본값은 꺼짐(전 경기 수신).
  home_only     INTEGER NOT NULL DEFAULT 0,
  -- 테스트 알림 남용을 막기 위한 최근 발송 시각
  last_test_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 폴링마다 네이버가 준 원본 상태를 그대로 남긴다. 디버깅 전용 — 화면에 안 쓰고
-- 알림도 안 보낸다. "언제 상태가 바뀌었는지"를 사후에 되짚을 자료가 없어서 만든
-- 것으로, prunePollLog() 로 6개월 지나면 지운다(db.js 참고).
CREATE TABLE IF NOT EXISTS poll_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id     TEXT NOT NULL,
  status_code TEXT,
  status_info TEXT,
  home_score  INTEGER,
  away_score  INTEGER,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_poll_log_game ON poll_log(game_id, id DESC);

-- 하루 단위 캐시. 오늘 경기가 없으면 크론이 외부 API를 아예 호출하지 않게 한다.
-- key 예: 'plan:2026-08-23' (오늘의 경기 계획), 'standings:2026' (순위)
CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,             -- JSON
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ─────────── 데이터 이관 ───────────
-- 실점을 events.kind 로 구분하기 전에 쌓인 기록을 옮긴다. 그때는 종류가 전부
-- score 였고 실점 여부가 제목 문구에만 남아 있었다(app.js 가 그 문자열을 뒤져
-- 라벨을 골랐다). 그대로 두면 지난 실점이 기록 탭에서 득점으로 보인다.
--
-- 제목 문구에 기대는 마지막 코드다. 한 번 돌고 나면 대상이 없어 다시 실행돼도
-- 아무 일도 하지 않는다 — 새 이벤트는 애초에 concede 로 저장된다.
UPDATE events SET kind = 'concede'
 WHERE kind = 'score' AND title LIKE '%실점%';

-- events.delivered_at 은 위 CREATE TABLE 에 들어 있어 새 DB 에는 저절로 생기지만,
-- 이미 있는 DB 에는 아래를 D1 콘솔에서 한 번 직접 실행해야 한다. SQLite 의
-- ALTER TABLE 에는 IF NOT EXISTS 가 없어 여기 그대로 두면 두 번째 db:init 이
-- "duplicate column" 으로 실패하므로 주석으로만 남긴다.
--   ALTER TABLE events ADD COLUMN delivered_at TEXT;
