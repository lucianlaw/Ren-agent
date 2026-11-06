-- 001_init：状态库的起点
--
-- 这四张表原来是以一大段字符串常量写在 lib/state.js 的 openDb() 里的。
-- 那样的问题不是难看，是「改不了」——想在线上加一列，只能往 init 里塞
-- 一句 try { ALTER TABLE ... }，谁也不知道哪次发布跑过哪一句。
-- 现在把它们落成第一份迁移文件：新库照这份建，老库标记为「已应用」。

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

-- 谁在跑什么。这一张是「任务不能因为重启变成幽灵」的全部依据。
CREATE TABLE IF NOT EXISTS runs (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  uid        TEXT,
  title      TEXT,
  device     TEXT,
  model      TEXT,
  status     TEXT NOT NULL,
  reason     TEXT,
  boot       TEXT NOT NULL,
  pid        INTEGER,
  host       TEXT,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  hb_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_scope ON runs(scope, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_hb ON runs(status, hb_at);

-- 锁：同一个东西同一时刻只能有一个任务在动它
CREATE TABLE IF NOT EXISTS locks (
  key        TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  boot       TEXT NOT NULL,
  pid        INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 路径租约：同一份文件不能被两个任务同时写
CREATE TABLE IF NOT EXISTS leases (
  path       TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 限流计数：读-改-写，两个进程同时改 JSON 就是丢失更新
CREATE TABLE IF NOT EXISTS rate (
  key        TEXT PRIMARY KEY,
  n          INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
