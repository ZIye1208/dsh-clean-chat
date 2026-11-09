/** 只做两件事：报告可用模型、把一次纯文本对话转成 SSE 流。 */
import { API_PREFIX } from './constants.js';
import { sendJson, readBody, openSse, sse } from './http.js';
import { createSettingsStore, normalizeSettings } from './settings.js';

/** 单条消息内容上限（字符）。 */
const MAX_MESSAGE_CHARS = 40_000;
/** 一次请求里全部历史的上限（字符）。 */
const MAX_TOTAL_CHARS = 200_000;
/** 系统提示上限（字符）。 */
const MAX_SYSTEM_CHARS = 8_000;
/** 单次调用超时。 */
const TIMEOUT_MS = 180_000;

/** 模型清单缓存（llm.listModels 是异步的，还可能触发端点探测）。 */
const MODEL_CACHE_MS = 60_000;
let modelCache = { at: 0, routes: [] };

/**
 * 从 llm 服务列出可选路由。
 *
 * 注意：`listProviders()` 只给 provider 元数据，**模型要用 `await llm.listModels(id)` 拿**
 * （provider 上那个 `models` 字段在 0.2.2 是空的，照抄会得到一个空下拉框）。
 */
async function listRoutes(ctx, force = false) {
  if (!force && modelCache.routes.length > 0 && Date.now() - modelCache.at < MODEL_CACHE_MS) {
    return modelCache.routes;
  }
  const llm = ctx.llm ?? ctx.get?.('llm');
  const providers = llm?.listProviders?.() ?? [];
  const out = [];
  for (const provider of providers) {
    const id = provider?.id;
    if (!id) continue;
    let models = [];
    try {
      models = (await llm.listModels?.(id)) ?? [];
    } catch {
      models = [];
    }
    for (const model of models) {
      const modelId = model?.id;
      if (!modelId) continue;
      out.push({
        provider: id,
        model: modelId,
        label: model?.label ?? model?.name ?? modelId,
        providerLabel: provider?.label ?? provider?.name ?? id,
      });
    }
  }
  modelCache = { at: Date.now(), routes: out };
  return out;
}

/** 解析这一轮用哪个 provider/model：请求里显式指定 → 全局默认 → 第一个可用。 */
async function resolveRoute(ctx, want) {
  const routes = await listRoutes(ctx);
  const known = (provider, model) =>
    routes.some((item) => item.provider === provider && item.model === model);
  if (want?.provider && want?.model && (known(want.provider, want.model) || routes.length === 0)) {
    return { provider: want.provider, model: want.model };
  }
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
  if (selection?.provider && selection?.model) {
    return { provider: selection.provider, model: selection.model };
  }
  if (routes.length > 0) return { provider: routes[0].provider, model: routes[0].model };
  return null;
}

/** GET /models：给面板的模型下拉用。refresh=1 时绕过缓存。 */
async function handleModels(ctx, req, res) {
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const force = url.searchParams.get('refresh') === '1';
  const routes = await listRoutes(ctx, force);
  const route = await resolveRoute(ctx, null);
  sendJson(res, 200, { ok: true, routes, current: route });
}

/**
 * 只认同源请求。
 *
 * host 的 webServer 不做任何来源/鉴权策略，所以这一层是唯一的闸：
 * - 浏览器 fetch 会带 `sec-fetch-site: same-origin`，正常放行；
 * - 老浏览器没有这个头时，退一步拿 `Origin`/`Referer` 与 `Host` 比；
 * - 两者都没有 → 拒绝。**不能再放行 `none`**：curl、脚本、浏览器扩展发出的
 *   请求通常就是 `sec-fetch-site: none`，放行等于本机任意进程都能调模型。
 */
function isSameOrigin(req) {
  const headers = req.headers ?? {};
  const site = headers['sec-fetch-site'];
  if (typeof site === 'string' && site) return site === 'same-origin';
  const origin = headers.origin ?? headers.referer;
  if (!origin || !headers.host) return false;
  try {
    return new URL(origin).host === headers.host;
  } catch {
    return false;
  }
}

/** POST /chat：body = { messages, system?, provider?, model? }。 */
async function handleChat(ctx, req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '只支持 POST' });
    return;
  }
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' });
    return;
  }
  let body;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (error) {
    if (error?.code === 'BODY_TOO_LARGE') {
      sendJson(res, 413, { ok: false, error: '发送的内容太大了（上限 1 MiB），请删掉一些历史再试' });
      return;
    }
    sendJson(res, 400, { ok: false, error: `请求体不可用：${String(error?.message ?? error)}` });
    return;
  }

  const system = typeof body.system === 'string' ? body.system : '';
  if (system.length > MAX_SYSTEM_CHARS) {
    sendJson(res, 413, {
      ok: false,
      error: `系统提示太长了（${system.length} 字，上限 ${MAX_SYSTEM_CHARS} 字）`,
    });
    return;
  }
  const incoming = Array.isArray(body.messages) ? body.messages : [];
  /** @type {{ role: 'user' | 'assistant', content: { type: 'text', text: string }[] }[]} */
  const messages = [];
  let total = 0;
  for (const item of incoming) {
    if (!item || (item.role !== 'user' && item.role !== 'assistant')) continue;
    const text = typeof item.content === 'string' ? item.content : '';
    if (!text) continue;
    // 超长不再静默截断：说清楚哪条、超了多少，别让用户以为发全了。
    if (text.length > MAX_MESSAGE_CHARS) {
      sendJson(res, 413, {
        ok: false,
        error: `有一条消息 ${text.length} 字，超过了单条上限 ${MAX_MESSAGE_CHARS} 字，请拆开发送`,
      });
      return;
    }
    total += text.length;
    if (total > MAX_TOTAL_CHARS) {
      sendJson(res, 413, { ok: false, error: `这段对话太长了（上限 ${MAX_TOTAL_CHARS} 字），清一下再来` });
      return;
    }
    messages.push({ role: item.role, content: [{ type: 'text', text }] });
  }
  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    sendJson(res, 400, { ok: false, error: '没有可发送的用户消息' });
    return;
  }

  // 只允许选「真的存在」的模型：否则本机任意进程都能点名最贵的那个来刷账单。
  const wanted = { provider: body.provider, model: body.model };
  if (wanted.provider || wanted.model) {
    const known = await listRoutes(ctx);
    if (known.length > 0 && !known.some((item) => item.provider === wanted.provider && item.model === wanted.model)) {
      sendJson(res, 400, {
        ok: false,
        error: `模型不可用：${wanted.provider ?? '?'} / ${wanted.model ?? '?'}，请重新选择`,
      });
      return;
    }
  }

  const route = await resolveRoute(ctx, wanted);
  if (!route) {
    sendJson(res, 503, { ok: false, error: '没有可用的模型路由' });
    return;
  }

  // assistant 历史必须带 source：llm 服务按 source.replayState 决定能不能复用上游回放状态，
  // 裸 {role:'assistant',content} 会在 forAdapter 里读 undefined.replayState 直接炸。
  const history = messages.map((message) => message.role === 'assistant'
    ? { ...message, source: { kind: 'model', provider: route.provider, model: route.model } }
    : message);
  const payload = system
    ? [{ role: 'system', content: [{ type: 'text', text: system }] }, ...history]
    : history;

  openSse(res);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let finished = false;
  res.on('close', () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    controller.abort();
  });

  sse(res, { type: 'start', provider: route.provider, model: route.model });
  let answer = '';
  try {
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      messages: payload,
      signal: controller.signal,
    });
    for await (const chunk of stream) {
      if (chunk?.type === 'reasoning-delta') {
        sse(res, { type: 'thought', text: chunk.text ?? '' });
      } else if (chunk?.type === 'text-delta') {
        const text = chunk.text ?? '';
        if (text) {
          answer += text;
          sse(res, { type: 'delta', text });
        }
      } else if (chunk?.type === 'usage') {
        sse(res, { type: 'usage', usage: chunk.usage ?? null });
      } else if (chunk?.type === 'finish') {
        // finish 是终止态：失败信息在 reason 里（kind: 'error' | 'aborted'）
        const reason = chunk.reason ?? chunk;
        const kind = reason?.kind;
        if (kind === 'error' || kind === 'aborted') {
          const failure = reason?.failure ?? {};
          sse(res, {
            type: 'error',
            code: failure.code ?? (kind === 'aborted' ? 'ABORTED' : 'FAILED'),
            message: String(failure.message ?? (kind === 'aborted' ? '上游中止' : '模型调用失败')),
          });
        }
      }
    }
    sse(res, { type: 'done', chars: answer.length });
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    sse(res, {
      type: 'error',
      code: aborted ? 'ABORTED' : (error?.code ?? 'FAILED'),
      message: aborted ? `调用超时或已取消（${TIMEOUT_MS}ms）` : String(error?.message ?? error),
    });
  } finally {
    finished = true;
    clearTimeout(timer);
    if (!res.writableEnded) res.end();
  }
}

/** GET /settings：把存盘的设置读给面板。 */
async function handleGetSettings(ctx, req, res, store) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: '只支持 GET' });
    return;
  }
  // 系统提示可能含私人内容，读也要求同源，别让本机任意进程顺手抄走。
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' });
    return;
  }
  const settings = await store.read();
  sendJson(res, 200, { ok: true, settings });
}

/** POST /settings：面板改了系统提示/模型就写盘（只认三个字段）。 */
async function handlePostSettings(ctx, req, res, store) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '只支持 POST' });
    return;
  }
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' });
    return;
  }
  let body;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (error) {
    if (error?.code === 'BODY_TOO_LARGE') {
      sendJson(res, 413, { ok: false, error: '设置太大了' });
      return;
    }
    sendJson(res, 400, { ok: false, error: `请求体不可用：${String(error?.message ?? error)}` });
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { ok: false, error: '设置必须是对象' });
    return;
  }
  const patch = normalizeSettings(body);
  if (Object.keys(patch).length === 0) {
    sendJson(res, 400, { ok: false, error: '没有可保存的字段' });
    return;
  }
  try {
    const settings = await store.write(patch);
    sendJson(res, 200, { ok: true, settings });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: `写盘失败：${String(error?.message ?? error)}` });
  }
}

/** 清掉模型清单缓存（测试用；生产只在进程重启时自然过期）。 */
export function resetModelCache() {
  modelCache = { at: 0, routes: [] };
}

/** 注册全部路由。options.settingsDir 只给测试用（指到临时目录）。 */
export function registerRoutes(ctx, options = {}) {
  const settings = options.settingsStore ?? createSettingsStore(options.settingsDir);
  const exact = (path, handler, label) =>
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}${path}`, handler }),
      `${'dsh-clean-chat'}: ${label}`,
    );

  exact('/ping', (_req, res) => sendJson(res, 200, { ok: true }), 'ping route');
  exact('/models', (req, res) => handleModels(ctx, req, res), 'models route');
  exact('/settings', (req, res) => (req.method === 'POST'
    ? handlePostSettings(ctx, req, res, settings)
    : handleGetSettings(ctx, req, res, settings)), 'settings route');
  exact('/chat', (req, res) => handleChat(ctx, req, res), 'chat route');
}
