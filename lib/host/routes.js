/** 只做两件事：报告可用模型、把一次纯文本对话转成 SSE 流。 */
import {
  API_PREFIX,
  MAX_MESSAGE_CHARS,
  MAX_MESSAGES,
  MAX_SYSTEM_CHARS,
  MAX_TOTAL_CHARS,
  RATE_LIMIT_CONCURRENT,
  RATE_LIMIT_PER_MINUTE,
  TIMEOUT_MS,
} from './constants.js';
import { sendJson, readBody, openSse, sse } from './http.js';
import { createSettingsStore, normalizeSettings } from './settings.js';

/** 模型清单缓存（llm.listModels 是异步的，还可能触发端点探测）。 */
const MODEL_CACHE_MS = 60_000;
let modelCache = { at: 0, routes: [] };

// ── 限流：进程级滑动窗口 + 在途计数。单机单用户够用，不需要 Redis。──
let requestLog = [];
let inFlight = 0;

/** 记一次请求的许可；超限返回错误码。 */
function acquireSlot() {
  const now = Date.now();
  requestLog = requestLog.filter((at) => now - at < 60_000);
  if (requestLog.length >= RATE_LIMIT_PER_MINUTE) return 'RATE_LIMIT';
  if (inFlight >= RATE_LIMIT_CONCURRENT) return 'BUSY';
  requestLog.push(now);
  inFlight += 1;
  return null;
}

function releaseSlot() {
  inFlight = Math.max(0, inFlight - 1);
}

/** 测试用：把限流窗口清空。 */
export function resetRateLimiter() {
  requestLog = [];
  inFlight = 0;
}

/** 上游失败码 → 人话。原文只留在日志里也没有，干脆不回传。 */
const FAILURE_TEXT = {
  NO_ADAPTER: '这个提供方没有可用适配器，换一个模型试试',
  MISSING_CREDENTIAL: '这个模型还没配置凭据，去设置里补一下',
  INVALID_CREDENTIAL: '凭据无效，去设置里重新填',
  AUTH: '鉴权失败，检查一下 API Key',
  RATE_LIMIT: '上游限流了，等一会儿再发',
  QUOTA: '上游额度用完了',
  ACCOUNT_QUOTA: '账号额度用完了',
  CONTEXT_WINDOW_EXCEEDED: '这轮上下文超了模型窗口，清一下历史再来',
};

function friendlyFailure(code, fallback) {
  if (code && FAILURE_TEXT[code]) return FAILURE_TEXT[code];
  if (code) return `模型调用失败（${code}）`;
  return fallback;
}

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
  if (!isLocalBrowserRequest(req)) {
    sendJson(res, 403, { ok: false, error: rejectText() });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const force = url.searchParams.get('refresh') === '1';
  const routes = await listRoutes(ctx, force);
  const route = await resolveRoute(ctx, null);
  sendJson(res, 200, { ok: true, routes, current: route });
}

/** 拒绝记录：只留头部形状，方便下次定位「为什么面板被挡」；滚动覆盖，不涨盘。 */
let rejectLog = [];
/** 最近一次拒绝的原因：回给前端的 403 里带上，截图就能定位。 */
let lastWhy = '';

/** 测试用：读最近一次拒绝原因。 */
export function lastReject() {
  return rejectLog[rejectLog.length - 1] ?? null;
}

/** 拒绝文案：带上原因，用户截图就能说清是怎么被挡的。 */
function rejectText() {
  return `这个请求不是从 DSH 面板发出的，已拒绝（${lastWhy || '未知原因'}）`;
}

function noteReject(req, why) {
  lastWhy = why;
  const headers = req.headers ?? {};
  rejectLog.push({
    at: new Date().toISOString(),
    why,
    method: req.method,
    host: headers.host,
    origin: headers.origin,
    site: headers['sec-fetch-site'],
    addr: req.socket?.remoteAddress,
  });
  if (rejectLog.length > 20) rejectLog.shift();
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/**
 * 只接受「本机浏览器页面发来的」请求。
 *
 * host 的 webServer 不做任何来源/鉴权策略，所以这一层是唯一的闸。但**不能**要求
 * `sec-fetch-site: same-origin`——桌面端面板一类的宿主页面可能是 `same-site`、
 * `none`（file:// 或被包了一层），0.6.0 就是这么把正常请求挡掉的。
 *
 * 现在的规则：
 * 1. socket 必须来自回环地址（挡掉局域网/远程访问）；
 * 2. 必须带 `sec-fetch-site`（curl、脚本、Node 客户端没有这个头）；
 * 3. 带了 `Origin` 的：http(s) 站点必须是回环名（挡掉 DNS rebinding 与真跨站）；
 *    自定义 scheme（`app://`、`file://`、`null`）当自家外壳放行；
 * 4. `cross-site` 只在 Origin 确实是 http(s) 外站时才拒——Electron 自定义 scheme
 *    的页面会被 Chromium 标成 cross-site，那不是攻击，是我们自己的壳。
 */
function isLocalBrowserRequest(req) {
  const headers = req.headers ?? {};
  const addr = req.socket?.remoteAddress;
  if (!LOOPBACK.has(String(addr ?? ''))) {
    noteReject(req, 'socket 不是回环地址');
    return false;
  }
  const site = headers['sec-fetch-site'];
  if (typeof site !== 'string' || !site) {
    noteReject(req, '没有 sec-fetch-site（不是浏览器发的）');
    return false;
  }
  const origin = headers.origin;
  const hasOrigin = typeof origin === 'string' && origin && origin !== 'null';
  if (site === 'cross-site' && !hasOrigin) {
    noteReject(req, 'sec-fetch-site: cross-site 且无 Origin');
    return false;
  }
  if (hasOrigin) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      noteReject(req, 'Origin 解析失败');
      return false;
    }
    const httpLike = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    if (httpLike && !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(parsed.hostname)) {
      noteReject(req, `Origin 主机不是回环：${parsed.hostname}`);
      return false;
    }
  }
  return true;
}

/** POST /chat：body = { messages, system?, provider?, model? }。 */
async function handleChat(ctx, req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '只支持 POST' });
    return;
  }
  if (!isLocalBrowserRequest(req)) {
    sendJson(res, 403, { ok: false, error: rejectText() });
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
  if (messages.length > MAX_MESSAGES) {
    sendJson(res, 413, {
      ok: false,
      error: `这段对话有 ${messages.length} 条消息，超过上限 ${MAX_MESSAGES} 条，清一下再来`,
    });
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

  const blocked = acquireSlot();
  if (blocked) {
    sendJson(res, 429, {
      ok: false,
      error: blocked === 'BUSY'
        ? '上一个回复还没结束，等它跑完'
        : `发得太快了（每分钟最多 ${RATE_LIMIT_PER_MINUTE} 次），歇一下`,
    });
    return;
  }

  const route = await resolveRoute(ctx, wanted);
  if (!route) {
    releaseSlot();
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
          // 上游报错原文可能带上 URL、trace 之类内部细节，这里只回人话 + 错误码。
          const code = failure.code ?? (kind === 'aborted' ? 'ABORTED' : 'FAILED');
          sse(res, {
            type: 'error',
            code,
            message: kind === 'aborted' ? '已中止' : friendlyFailure(failure.code, '模型调用失败'),
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
      message: aborted ? `调用超时或已取消（${TIMEOUT_MS}ms）` : friendlyFailure(error?.code, '调用失败，请稍后再试'),
    });
  } finally {
    finished = true;
    clearTimeout(timer);
    releaseSlot();
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
  if (!isLocalBrowserRequest(req)) {
    sendJson(res, 403, { ok: false, error: rejectText() });
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
  if (!isLocalBrowserRequest(req)) {
    sendJson(res, 403, { ok: false, error: rejectText() });
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
