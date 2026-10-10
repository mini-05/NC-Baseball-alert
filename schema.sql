-- 경기 스냅샷. 폴링마다 덮어쓰고, 직전 값과 비교해서 이벤트를 찾는다.
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

-- 알림 이벤트 이력. 기록 탭 데이터이자 중복 발송 방지(dedup_key).
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id    TEXT NOT NULL,
  game_date  TEXT NOT NULL,
  -- start | cancel | score | concede | end
  -- concede(실점)는 기록용 값. 알림은 score 로 나가고(on_score) 기록 탭에서만 실점으로 보인다.
  kind       TEXT NOT NULL,
  series     TEXT NOT NULL DEFAULT 'regular',
  dedup_key  TEXT NOT NULL UNIQUE,      -- 같은 전이를 두 번 알리지 않기 위한 키
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  home_score INTEGER NOT NULL DEFAULT 0,
  away_score INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  -- 기기가 알림을 띄우고 /api/delivered 로 알려온 시각. created_at 과의 차이가
  -- 배달 지연이고, 끝까지 NULL 이면 미배달.
  -- 구독이 여러 개여도 첫 응답만 남긴다. 구독별로 보려면 테이블이 따로 필요한데
  -- 구독이 몇 개 안 돼서 아직은 필요 없다.
  delivered_at TEXT,
  -- 재발송한 시각. 재발송은 한 번만. 이게 없으면 확인이 끝까지 안 오는 기기(꺼진
  -- 기기 등) 때문에 매 틱 다시 보내게 된다.
  resent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_date ON events(game_date DESC, id DESC);

-- allSettledBefore 가 경기별 종료·취소 이벤트를 찾을 때 쓴다(매 틱).
-- idx_events_date 는 game_date 로 시작해서 이 조회에는 안 맞는다.
CREATE INDEX IF NOT EXISTS idx_events_game ON events(game_id, kind);

-- 재발송 대상(확인도 재발송도 없는 이벤트) 조회용 부분 인덱스. 확인이 오면
-- 빠지니까 평소에는 거의 비어 있다.
CREATE INDEX IF NOT EXISTS idx_events_undelivered ON events(created_at)
  WHERE delivered_at IS NULL AND resent_at IS NULL;

-- 푸시 구독과 구독별 알림 설정.
CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint      TEXT PRIMARY KEY,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  on_start      INTEGER NOT NULL DEFAULT 1,
  on_cancel     INTEGER NOT NULL DEFAULT 1,
  on_score      INTEGER NOT NULL DEFAULT 1,
  on_end        INTEGER NOT NULL DEFAULT 1,
  -- 정규시즌 / 포스트시즌 따로 끌 수 있다.
  on_regular    INTEGER NOT NULL DEFAULT 1,
  on_postseason INTEGER NOT NULL DEFAULT 1,
  -- 1 이면 홈경기만. 기본 0(전부).
  home_only     INTEGER NOT NULL DEFAULT 0,
  -- 마지막 테스트 알림 시각(연타 방지)
  last_test_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 폴링마다 받은 원본 상태(디버깅용). 네이버가 상태를 언제 바꿨는지 볼 때 쓴다.
-- 6개월 지나면 지운다(season.js POLL_LOG_KEEP_DAYS).
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

-- 캐시. key 예: 'plan:2026-08-23'(오늘 경기 계획), 'schedule:2026', 'standings:2026'.
-- 만료돼도 행은 남겨 두고 조회 실패 때 폴백으로 쓴다(db.js getCacheStale).
CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,             -- JSON
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ─────────── 데이터 이관 ───────────
-- concede 를 도입하기 전 기록 정리. 그때는 실점도 score 로 저장됐고 제목으로만
-- 구분됐다. 한 번 돌면 대상이 없어서 다시 실행해도 아무 일도 안 한다.
UPDATE events SET kind = 'concede'
 WHERE kind = 'score' AND title LIKE '%실점%';

-- 예전 DB 에는 아래 컬럼이 없다. D1 콘솔에서 한 번 직접 실행할 것.
-- (SQLite ALTER TABLE 에 IF NOT EXISTS 가 없어서 db:init 에 넣으면 두 번째부터 실패)
--   ALTER TABLE events ADD COLUMN delivered_at TEXT;
--   ALTER TABLE events ADD COLUMN resent_at TEXT;
