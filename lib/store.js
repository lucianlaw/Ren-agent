// 数据层：JSON 文件存储，原子写，零依赖
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const DEFAULT_WORKSPACE = path.join(ROOT, 'workspace');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(DEFAULT_WORKSPACE, { recursive: true });

function file(name) { return path.join(DATA_DIR, name); }

export function readJSON(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch (e) {
    return fallback;
  }
}

export function writeJSON(name, obj) {
  const tmp = file(name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file(name));
}

/* ── 访问口令：首次启动生成，写进 data/token.txt ── */
export function ensureToken() {
  const p = file('token.txt');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  const t = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(p, t + '\n', { mode: 0o600 });
  return t;
}

/* ── 会话：内存 + 落盘，重启后仍可用 ── */
const sessions = readJSON('sessions.json', {});
export function createSession() {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions[sid] = { at: Date.now() };
  writeJSON('sessions.json', sessions);
  return sid;
}
export function validSession(sid) {
  return !!(sid && sessions[sid]);
}

/* ── 配置 ── */
const DEFAULT_CONFIG = {
  provider: { preset: 'mock', baseURL: '', apiKey: '', model: 'mock-1', temperature: 0.2 },
  permissions: { read: true, write: false, exec: false },
  workspace: DEFAULT_WORKSPACE,
  maxSteps: 12
};
export function getConfig() {
  const c = readJSON('config.json', null);
  if (!c) { writeJSON('config.json', DEFAULT_CONFIG); return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
  return {
    ...DEFAULT_CONFIG, ...c,
    provider: { ...DEFAULT_CONFIG.provider, ...(c.provider || {}) },
    permissions: { ...DEFAULT_CONFIG.permissions, ...(c.permissions || {}) }
  };
}
export function saveConfig(patch) {
  const cur = getConfig();
  const next = {
    ...cur, ...patch,
    provider: { ...cur.provider, ...(patch.provider || {}) },
    permissions: { ...cur.permissions, ...(patch.permissions || {}) }
  };
  writeJSON('config.json', next);
  return next;
}

/* ── 员工 ── */
export const PERSONAS = {
  rigor:  { n: '严谨', d: '先给结论与依据，再谈建议，不用形容词', ex: '该条款违约金按日 3% 计算，折年化超 1000%，超出司法实践可支持范围。建议改为总额 20% 封顶。' },
  calm:   { n: '沉稳', d: '克制、给依据、留余地',             ex: '这一项我建议再核一遍。按现行准则，违约金上限通常按实际损失 130% 认定，3% 日息明显偏高。' },
  sharp:  { n: '锋利', d: '直指要害，敢否定方案',             ex: '这个签不了。日 3% 违约金，等于给对方一个随时引爆的雷。换成 20% 封顶，今天就能定。' },
  youth:  { n: '青春', d: '口语化，敢用语气词',               ex: '老板这条有点猛啊，一天赔 3% 顶不住 😅 建议砍到 20% 封顶，我去改？' },
  warm:   { n: '温和', d: '先照顾情绪再讲问题',               ex: '理解对方希望有强约束。不过按日 3% 这个量级，真出问题时我们压力会很大，要不要换个更稳的写法？' },
  mature: { n: '成熟', d: '稳重、有分寸、先讲影响面',         ex: '这条的影响面比看上去大：一旦触发，金额会随时间线性放大。建议先封顶，再谈触发条件。' }
};

export function listEmployees() { return readJSON('employees.json', []); }
export function saveEmployees(list) { writeJSON('employees.json', list); }

/* ── 任务 ── */
export function listTasks() { return readJSON('tasks.json', []); }
export function saveTasks(list) { writeJSON('tasks.json', list.slice(0, 200)); }
