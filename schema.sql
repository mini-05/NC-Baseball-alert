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
  kind       TEXT NOT NULL,             -- start | cancel | score | end
  series     TEXT NOT NULL DEFAULT 'regular',
  dedup_key  TEXT NOT NULL UNIQUE,      -- 같은 전이를 두 번 알리지 않기 위한 키
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  home_score INTEGER NOT NULL DEFAULT 0,
  away_score INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_date ON events(game_date DESC, id DESC);

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

-- 하루 단위 캐시. 오늘 경기가 없으면 크론이 외부 API를 아예 호출하지 않게 한다.
-- key 예: 'plan:2026-08-23' (오늘의 경기 계획), 'standings:2026' (순위)
CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,             -- JSON
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
