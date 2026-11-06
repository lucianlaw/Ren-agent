/* 注销：把这个账号在这台机器上的东西真的删掉
 *
 * 为什么单独一层
 *   「清空工作区」和「注销」差一个字，差的是可恢复性：
 *   前者进回收站（还能捞回来），后者是真删。两件事混在一个按钮里，
 *   迟早有人在想清缓存的时候把自己的合同删了。
 *
 * 具体删什么（按「用户能不能感知到」排）：
 *   1. 工作区目录（含 .trash）——所有文件，真删
 *   2. 记忆目录（memory/<scope>）——公司口径、员工画像、项目记忆
 *   3. 状态库里的痕迹（runs / locks / leases / rate）——「谁在跑什么」的历史
 *   4. 用量记录（data/usage/<scope>.json）——每天用了多少 token
 *
 * 刻意**不删**的：
 *   · 审计日志（data/audit/<scope>/）。它记的是「某个动作在什么时候发生」，
 *     属于运维/合规凭证，用户自己不该有删除入口——否则出事之后第一件事
 *     就是把记录删掉。它有自己的保留期（默认 30 天，见 lib/audit.js）。
 *     这一点在接口返回里明说（auditKept），不假装删干净了。
 *   · 备份包。那是整机的定期归档，不是某个账号的私有文件；
 *     要连备份一起清，得走运维流程。
 *
 * 正在跑的任务：不允许注销。删到一半的文件会让正在写的那一步崩溃，
 * 而且「任务还在跑却提示已注销」比拒绝更糟。调用方负责传 running。
 */
import fs from 'node:fs';
import path from 'node:path';

import { scopeRoot, WORKSPACE_BASE } from './workspace.js';
import * as STATE from './state.js';
import { purgeUsage } from './quota.js';
import { writeAudit } from './audit.js';

function sizeOf(abs) {
  let bytes = 0, files = 0;
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.isDirectory()) {
      let ents = [];
      try { ents = fs.readdirSync(p); } catch { return; }
      for (const e of ents) walk(path.join(p, e));
      return;
    }
    bytes += st.size;
    files += 1;
  };
  walk(abs);
  return { bytes, files };
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch { return false; }
}

/**
 * 注销一个工作区。
 * @param {string} scope 32 位十六进制
 * @param {{running?:number, now?:number}} opts running = 当前活着在跑的任务数
 */
export function purgeAccount(scope, { running = 0, now = Date.now() } = {}) {
  const root = scopeRoot(scope);
  if (!root) return { ok: false, error: '工作区标识不合法' };
  if (Number(running) > 0) {
    return { ok: false, error: `还有 ${running} 个任务在跑，等它停下来再注销` };
  }

  const memDir = path.join(WORKSPACE_BASE, 'memory', String(scope));
  const ws = fs.existsSync(root) ? sizeOf(root) : { bytes: 0, files: 0 };
  const mm = fs.existsSync(memDir) ? sizeOf(memDir) : { bytes: 0, files: 0 };

  /* 顺序：先删「能被工具读到的东西」（文件、记忆），再删「记账」。
     反过来先清状态库的话，中途失败会留下「有文件但系统认为这个账号不存在」的状态。 */
  const wsOk = !fs.existsSync(root) || rmrf(root);
  if (!wsOk) {
    return { ok: false, error: '工作区删不掉（可能被别的进程占着），这次没有继续往下删' };
  }
  const memOk = !fs.existsSync(memDir) || rmrf(memDir);

  const st = STATE.purgeScope(scope);
  const q = purgeUsage(scope);

  writeAudit({
    kind: 'account', scope, action: '注销账号', target: '',
    ok: true, blocked: false, ms: 0, category: 'system',
    output: `删 ${ws.files + mm.files} 个文件 ${ws.bytes + mm.bytes}B；`
      + `状态 runs=${st.runs || 0} locks=${st.locks || 0}；用量 ${q.ok ? '已删' : '跳过'}`
  });

  return {
    ok: true,
    at: new Date(now).toISOString(),
    files: ws.files + mm.files,
    bytes: ws.bytes + mm.bytes,
    workspace: { bytes: ws.bytes, files: ws.files, removed: wsOk },
    memory: { bytes: mm.bytes, files: mm.files, removed: memOk },
    state: st,
    usage: q,
    /* 明说哪些没删：注销最忌讳的是「看起来删干净了，其实还在」 */
    auditKept: true,
    note: '审计日志（只有时间/动作/文件名，30 天后自动清）和整机备份没有一起删——'
      + '这两样不是这个账号的私有文件，要清得走运维流程。'
  };
}
