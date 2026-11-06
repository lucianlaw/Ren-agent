-- 002_runs_host：runs 表补 host 列
--
-- 线上第一版没有这一列（那时状态还只在内存里，也没想过「同一个任务可能被另一台
-- 机器接管」）。老库升级上来会缺这一列，而 SQLite 没有 ADD COLUMN IF NOT EXISTS。
-- 所以这里用一条跳过指令：001 建出来的新库已经有 host，这条会被跳过；
-- 只有真正缺列的老库才会执行 ALTER。
-- @skip-if-column runs.host
ALTER TABLE runs ADD COLUMN host TEXT;
