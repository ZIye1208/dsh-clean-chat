/** 只做两件事：报告可用模型、把一次纯文本对话转成 SSE 流。 */
import { API_PREFIX } from './constants.js';
import { sendJson, readBody, openSse, sse } from './http.js';

/** 单条消息内容上限（字符）。 */
const MAX_MESSAGE_CHARS = 40_000;
/** 一次请求里全部历史的上限（字符）。 */
const MAX_TOTAL_CHARS = 200_000;
/** 系统提示上限（字符）。 */
const MAX_SYSTEM_CHARS = 8_000;
/** 单次调用超时。 */
const TIMEOUT_MS = 180_000;

function trimText(raw, max) {
  const text = typeof raw === 'string' ? raw : '';
  return text.length > max ? text.slice(0, max) : text;
}

/** 从 llm 服务列出可选路由。 */
function listRoutes(ctx) {
  const llm = ctx.llm ?? ctx.get?.('llm');
  const providers = llm?.listProviders?.() ?? [];
  const out = [];
  for (const provider of providers) {
    const id = provider?.id ?? provider?.name;
    if (!id) continue;
    for (const model of provider?.models ?? []) {
      const modelId = model?.id ?? model?.name;
      if (!modelId) continue;
      out.push({ provider: id, model: modelId, label: `${id} / ${modelId}` });
    }
  }
  return out;
}

/** 解析这一轮用哪个 provider/model：请求里显式指定 → 全局默认 → 第一个可用。 */
function resolveRoute(ctx, want) {
  const routes = listRoutes(ctx);
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

/** GET /models：给面板的模型下拉用。 */
async function handleModels(ctx, req, res) {
  const route = resolveRoute(ctx, null);
  sendJson(res, 200, { ok: true, routes: listRoutes(ctx), current: route });
}

/** POST /chat：body = { messages, system?, provider?, model? }。 */
async function handleChat(ctx, req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '只支持 POST' });
    return;
  }
  // host 的 webServer 不做来源策略：自己挡掉跨站请求，别让本地任意页面白嫖模型额度。
  const site = req.headers?.['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' });
    return;
  }
  let body;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (error) {
    sendJson(res, 400, { ok: false, error: `请求体不可用：${String(error?.message ?? error)}` });
    return;
  }

  const system = trimText(body.system, MAX_SYSTEM_CHARS);
  const incoming = Array.isArray(body.messages) ? body.messages : [];
  /** @type {{ role: 'user' | 'assistant', content: { type: 'text', text: string }[] }[]} */
  const messages = [];
  let total = 0;
  for (const item of incoming) {
    if (!item || (item.role !== 'user' && item.role !== 'assistant')) continue;
    const text = trimText(item.content, MAX_MESSAGE_CHARS);
    if (!text) continue;
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

  const route = resolveRoute(ctx, { provider: body.provider, model: body.model });
  if (!route) {
    sendJson(res, 503, { ok: false, error: '没有可用的模型路由' });
    return;
  }

  const payload = system ? [{ role: 'system', content: [{ type: 'text', text: system }] }, ...messages] : messages;

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

/** 注册全部路由。 */
export function registerRoutes(ctx) {
  const exact = (path, handler, label) =>
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}${path}`, handler }),
      `${'dsh-clean-chat'}: ${label}`,
    );

  exact('/ping', (_req, res) => sendJson(res, 200, { ok: true }), 'ping route');
  exact('/models', (req, res) => handleModels(ctx, req, res), 'models route');
  exact('/chat', (req, res) => handleChat(ctx, req, res), 'chat route');
}
