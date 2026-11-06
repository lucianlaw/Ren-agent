/* 部署包体检：哪些文件不该跟着上传。
 *
 * 存在的理由很具体：`data/` 在 .gitignore 里，所以 `git status` 永远看不见它，
 * 「工作区干净」这道门对它完全放行。但发布工具传的是**目录**，不是 commit。
 * 于是本地跑过的痕迹——工单状态、修复快照、分诊决策、审计日志——会被一起打包，
 * 在线上装成生产数据。
 *
 * 它坏起来的样子是「正常的」：
 *   - 线上 health 里出现「修复过 2 轮，当前接着 6927c3… 在修」，而那个工单号
 *     在线上不存在；
 *   - 工单列表里多出一张从没发生过的 E_UI_RENDER；
 *   - 更糟的是同名的 `data/incidents/<日期>.jsonl` 覆盖掉线上那一天的真实报错。
 *
 * 没有一个地方会报错，能发现的唯一办法是「记得自己没造过这些数据」。
 * 所以把它变成发布闸门的一道门，而不是一条注意事项。
 */

import fs from 'node:fs';
import path from 'node:path';

/* 会落运行时数据的目录（相对部署根）。
   名单来自各库的默认路径：state 库、工作区、审计、报错、工单、修复、证据、用量。
   新开一个落盘目录就要回来加一行——不然这道门会「合格」而实际早漏了。 */
export const RUNTIME_DIRS = [
  'data',
  'workspace',
  '.ren-state',
  '.ren-dev'
];

/* 允许存在的占位文件（说明性文件，不含数据） */
const KEEP = new Set(['README.md', '.gitkeep']);

export function runtimeDataFiles(root) {
  const out = [];
  for (const rel of RUNTIME_DIRS) {
    const dir = path.join(root, rel);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    const walk = (d, base) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const r = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else if (!KEEP.has(e.name)) out.push(r);
      }
    };
    walk(dir, rel);
  }
  return out.sort();
}

/* 一句话说清「为什么这事严重、以及别直接删」 */
export function explain(files, total) {
  const head = files.slice(0, 5).join(', ') + (total > 5 ? ` …（共 ${total} 个）` : '');
  return {
    label: `部署目录里有运行时数据（${total} 个文件）`,
    note: head,
    hint: '上传传的是整个目录，这些文件会一起上线上、并且混进生产数据——\n'
      + '线上会开始显示从没发生过的工单，而它是「正常」的样子，不会报错。\n'
      + '\n'
      + '别直接删：先挪到部署目录外面留一份，确认无用再清。\n'
      + '  mkdir -p ../.ren-local-data && mv data ../.ren-local-data/data-$(date +%Y%m%d-%H%M%S)\n'
      + '\n'
      + '根因那一条要一起修：dev 实例的数据目录必须落在 .ren-dev 下\n'
      + '（npm run dev 现在会设 TICKET_DIR / REPAIR_DIR / PROOF_DIR），\n'
      + '否则下次在 dev 上跑一轮自愈又会写回这里。'
  };
}
