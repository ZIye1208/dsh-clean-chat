/** 纯逻辑单测：拿假的 ctx/req/res 跑一遍路由，不碰真模型。 */
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerRoutes, resetModelCache } from '../lib/host/routes.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed += 1;
    console.log(`FAIL ${label}\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

/** 假 res：记录写出的 SSE / JSON。 */
function fakeRes() {
  const out = { status: 0, headers: null, body: '', events: [], ended: false };
  const res = {
    writableEnded: false,
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers;
    },
    write(chunk) {
      out.body += chunk;
      const line = String(chunk);
      const m = /^data: (.*)\n\n$/s.exec(line);
      if (m) out.events.push(JSON.parse(m[1]));
      return true;
    },
    end(text) {
      if (typeof text === 'string') out.body += text;
      res.writableEnded = true;
      out.ended = true;
    },
    on() {},
  };
  return { res, out };
}

/** 假 req：POST + JSON body。 */
function fakeReq(body, method = 'POST') {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method;
  return req;
}

/** 假 ctx：记录注册的路由，llm.stream 吐固定分片。 */
function fakeCtx({ chunks = [], providers, selection } = {}) {
  const routes = new Map();
  const ctx = {
    llm: {
      listProviders: () => providers ?? [{ id: 'fake-provider', models: [{ id: 'fake-model' }] }],
      listModels: async (providerId) => {
        const found = (providers ?? [{ id: 'fake-provider', models: [{ id: 'fake-model' }] }]).find(
          (item) => item.id === providerId,
        );
        return (found?.models ?? []).map((model) => ({ id: model.id, label: model.id }));
      },
      stream: (options) => {
        ctx.lastStreamOptions = options;
        return (async function* () {
          for (const chunk of chunks) yield chunk;
        })();
      },
    },
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => selection ?? null };
      }
      return undefined;
    },
    effect(fn) {
      fn();
    },
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler);
        return () => {};
      },
    },
  };
  return { ctx, routes };
}

async function hit(handler, req) {
  const { res, out } = fakeRes();
  await handler(req, res);
  return out;
}

// ── 1. 包清单基本一致 ───────────────────────────────────────────────
check('package name', pkg.name, 'dsh-clean-chat');
check('main 指到 lib/index.js', pkg.main, './lib/index.js');
check('exports ./client 存在', typeof pkg.exports['./client']?.default, 'string');
check('dsh.client.platform', pkg.dsh.client.platform, 'web');
check('bundle patch 存在', pkg.dsh.bundle.patch, './cordis.patch.yml');

// ── 2. ping ────────────────────────────────────────────────────────
{
  const { ctx, routes } = fakeCtx();
  resetModelCache();
  registerRoutes(ctx);
  check('注册了 3 条路由', [...routes.keys()].sort(), [
    '/clean-chat/api/chat',
    '/clean-chat/api/models',
    '/clean-chat/api/ping',
  ]);
  const out = await hit(routes.get('/clean-chat/api/ping'), fakeReq({}, 'GET'));
  check('ping 返回 200', out.status, 200);
}

// ── 3. models：默认选择优先 ─────────────────────────────────────────
{
  const { ctx, routes } = fakeCtx({
    providers: [{ id: 'p1', models: [{ id: 'm1' }, { id: 'm2' }] }],
    selection: { provider: 'p1', model: 'm2' },
  });
  resetModelCache();
  registerRoutes(ctx);
  const out = await hit(routes.get('/clean-chat/api/models'), fakeReq({}, 'GET'));
  const payload = JSON.parse(out.body);
  check('models 列出两条', payload.routes.length, 2);
  check('current 跟随默认模型', payload.current, { provider: 'p1', model: 'm2' });
}

// ── 4. chat：正常流 ────────────────────────────────────────────────
{
  const { ctx, routes } = fakeCtx({
    chunks: [
      { type: 'reasoning-delta', text: '想' },
      { type: 'text-delta', text: '你' },
      { type: 'text-delta', text: '好' },
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'done' } },
    ],
  });
  resetModelCache();
  registerRoutes(ctx);
  const out = await hit(
    routes.get('/clean-chat/api/chat'),
    fakeReq({ system: '你是助手。', messages: [{ role: 'user', content: '你好' }] }),
  );
  check('chat 200', out.status, 200);
  check('content-type 是 SSE', String(out.headers['content-type']).startsWith('text/event-stream'), true);
  check('事件序列', out.events.map((e) => e.type), ['start', 'thought', 'delta', 'delta', 'usage', 'done']);
  check('拼出的回答', out.events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), '你好');
  check('有 system 时放在最前', ctx.lastStreamOptions.messages[0].role, 'system');
  check('没有 tools 字段', 'tools' in ctx.lastStreamOptions, false);
  check('消息内容用 text 块', ctx.lastStreamOptions.messages[1], {
    role: 'user',
    content: [{ type: 'text', text: '你好' }],
  });
}

// ── 5. chat：assistant 历史必须带 source（否则 llm 服务读 undefined.replayState 崩）──
{
  const { ctx, routes } = fakeCtx({ chunks: [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }] });
  resetModelCache();
  registerRoutes(ctx);
  const out = await hit(
    routes.get('/clean-chat/api/chat'),
    fakeReq({
      messages: [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一答' },
        { role: 'user', content: '第二问' },
      ],
    }),
  );
  check('两轮对话 200', out.status, 200);
  const assistant = ctx.lastStreamOptions.messages.find((m) => m.role === 'assistant');
  check('assistant 有 source', assistant?.source?.kind, 'model');
  check('assistant source 带 provider', assistant?.source?.provider, 'fake-provider');
  check('assistant source 带 model', assistant?.source?.model, 'fake-model');
  check('assistant 没有 replayState', 'replayState' in (assistant?.source ?? {}), false);
  check('user 消息不带 source', 'source' in ctx.lastStreamOptions.messages[0], false);
}

// ── 6. chat：上游报错 ──────────────────────────────────────────────
{
  const { ctx, routes } = fakeCtx({
    chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: '密钥无效' } } }],
  });
  resetModelCache();
  registerRoutes(ctx);
  const out = await hit(
    routes.get('/clean-chat/api/chat'),
    fakeReq({ messages: [{ role: 'user', content: 'hi' }] }),
  );
  const error = out.events.find((e) => e.type === 'error');
  check('error 事件透出上游 code', error?.code, 'AUTH');
}

// ── 6. chat：参数校验 ──────────────────────────────────────────────
{
  const { ctx, routes } = fakeCtx();
  resetModelCache();
  registerRoutes(ctx);
  const empty = await hit(routes.get('/clean-chat/api/chat'), fakeReq({ messages: [] }));
  check('空消息 → 400', empty.status, 400);

  const lastAssistant = await hit(
    routes.get('/clean-chat/api/chat'),
    fakeReq({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }),
  );
  check('最后一条不是 user → 400', lastAssistant.status, 400);

  const getMethod = await hit(routes.get('/clean-chat/api/chat'), fakeReq({}, 'GET'));
  check('GET → 405', getMethod.status, 405);

  const crossSite = fakeReq({ messages: [{ role: 'user', content: 'hi' }] });
  crossSite.headers = { 'sec-fetch-site': 'cross-site' };
  const crossOut = await hit(routes.get('/clean-chat/api/chat'), crossSite);
  check('跨站请求 → 403', crossOut.status, 403);
}

// ── 7. 没有可用模型 ────────────────────────────────────────────────
{
  const { ctx, routes } = fakeCtx({ providers: [] });
  resetModelCache();
  registerRoutes(ctx);
  const out = await hit(
    routes.get('/clean-chat/api/chat'),
    fakeReq({ messages: [{ role: 'user', content: 'hi' }] }),
  );
  check('无路由 → 503', out.status, 503);
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
