// 模型网关：只认 OpenAI Chat Completions 协议，业务代码不碰任何厂商 SDK
// 另带一个离线 mock 基座，没有 API Key 时也能把整条链路跑通

const sleep = ms => new Promise(r => setTimeout(r, ms));

export const PRESETS = [
  { id: 'mock',      label: '离线 Mock（无需 Key，用于验证链路）', baseURL: '', model: 'mock-1' },
  { id: 'deepseek',  label: 'DeepSeek（性价比基线）',              baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'bailian',   label: '阿里百炼 Qwen',                       baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'bigmodel',  label: '智谱 GLM（有免费档）',                baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'silicon',   label: '硅基流动 SiliconFlow',                baseURL: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { id: 'openrouter',label: 'OpenRouter（一个 Key 打多家）',       baseURL: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' },
  { id: 'custom',    label: '自定义（自填 baseURL / model）',      baseURL: '', model: '' }
];

/* ── 离线 mock：按目标关键词造一条真实的执行轨迹 ── */
function mockTurn(messages, tools) {
  const goal = (messages.find(m => m.role === 'user') || {}).content || '';
  const hasTool = messages.some(m => m.role === 'tool');
  const names = (tools || []).map(t => t.function.name);
  const pick = n => names.includes(n);

  if (!hasTool) {
    const calls = [];
    if (/目录|文件|看看|有哪些|list/i.test(goal) && pick('list_dir')) {
      calls.push({ id: 'c1', name: 'list_dir', args: { path: '.' } });
    }
    if (/写|创建|生成|保存/.test(goal) && pick('write_file')) {
      calls.push({
        id: 'c2', name: 'write_file',
        args: { path: 'hello.md', content: `# 你好\n\n这是 Boss Agent 的第一次写入。\n\n目标：${goal.slice(0, 120)}\n` }
      });
    }
    if (/搜索|查找|包含|grep/i.test(goal) && pick('search_text')) {
      calls.push({ id: 'c3', name: 'search_text', args: { pattern: 'agent' } });
    }
    if (/运行|执行|命令|shell|统计/i.test(goal) && pick('run_shell')) {
      calls.push({ id: 'c4', name: 'run_shell', args: { command: 'ls -la && echo "---" && wc -l *.md 2>/dev/null || true' } });
    }
    if (!calls.length && pick('todo_write')) {
      calls.push({
        id: 'c5', name: 'todo_write',
        args: { items: [{ text: '理解目标', status: 'done' }, { text: '执行第一步', status: 'doing' }] }
      });
    }
    return { content: '', toolCalls: calls, usage: { in: 320, out: 48 } };
  }

  const lastTools = messages.filter(m => m.role === 'tool').slice(-3);
  const digest = lastTools.map(t => `· ${String(t.content || '').split('\n')[0].slice(0, 80)}`).join('\n');
  return {
    content: `做完了。这是离线 Mock 基座的返回，用于验证「员工 → 模型 → 工具 → 轨迹」这条链路是通的。\n\n工具返回摘要：\n${digest}\n\n接上真实基座后，这里会是模型自己的结论。`,
    toolCalls: [],
    usage: { in: 680, out: 130 }
  };
}

/* ── 真实调用 ── */
export async function callModel({ provider, messages, tools, signal }) {
  if (!provider || provider.preset === 'mock' || !provider.baseURL) {
    await sleep(260);
    return mockTurn(messages, tools);
  }
  const url = provider.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: provider.model,
    messages,
    temperature: typeof provider.temperature === 'number' ? provider.temperature : 0.2,
    tools,
    tool_choice: 'auto'
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 90000);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey || ''}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(t);
    throw new Error(`连不上模型基座：${e.message}。检查 baseURL 与网络（境外模型可能需要代理）。`);
  }
  clearTimeout(t);

  const text = await res.text();
  if (!res.ok) {
    let hint = '';
    if (res.status === 401 || res.status === 403) hint = ' 多半是 API Key 不对。';
    if (res.status === 404) hint = ' 检查 baseURL 是否需要带 /v1。';
    if (res.status === 429) hint = ' 触发限流或余额不足。';
    throw new Error(`模型返回 ${res.status}：${text.slice(0, 300)}${hint}`);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('模型返回的不是 JSON：' + text.slice(0, 200)); }

  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  const toolCalls = (msg.tool_calls || []).map(tc => {
    let args = {};
    try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = { __raw: tc.function.arguments }; }
    return { id: tc.id, name: tc.function.name, args };
  });
  const u = data.usage || {};
  return {
    content: msg.content || '',
    toolCalls,
    usage: { in: u.prompt_tokens || 0, out: u.completion_tokens || 0 }
  };
}
