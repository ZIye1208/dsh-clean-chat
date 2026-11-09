/** 纯逻辑单测：拿假的 ctx/req/res 跑一遍路由，不碰真模型。 */
import { Readable } from 'node:stream';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerRoutes, resetModelCache, resetRateLimiter } from '../lib/host/routes.js';
import { RATE_LIMIT_PER_MINUTE } from '../lib/host/constants.js';

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

/** 假 req：POST + JSON body。默认带同源头（真浏览器 fetch 就是这么发的）。 */
function fakeReq(
  body,
  method = 'POST',
  headers = { 'x-clean-chat': '1', host: '127.0.0.1:9999', 'content-type': 'application/json' },
  remoteAddress = '127.0.0.1',
) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = headers;
  req.socket = { remoteAddress };
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
  check('注册了 4 条路由', [...routes.keys()].sort(), [
    '/clean-chat/api/chat',
    '/clean-chat/api/models',
    '/clean-chat/api/ping',
    '/clean-chat/api/settings',
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
  crossSite.headers = { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example.com' };
  const crossOut = await hit(routes.get('/clean-chat/api/chat'), crossSite);
  check('跨站请求 → 403', crossOut.status, 403);

  const blank = await hit(routes.get('/clean-chat/api/chat'), fakeReq({ messages: [{ role: 'user', content: '   ' }] }));
  check('全空白消息 → 400（不去换一次模型调用）', blank.status, 400);

  const plain = fakeReq(
    { messages: [{ role: 'user', content: 'hi' }] },
    'POST',
    { 'x-clean-chat': '1', host: '127.0.0.1:9999', 'content-type': 'text/plain' },
  );
  const plainOut = await hit(routes.get('/clean-chat/api/chat'), plain);
  check('Content-Type 不是 JSON → 415', plainOut.status, 415);
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

// ── 8. settings：存盘 / 读回 / 校验 ────────────────────────────────
{
  const dir = join(tmpdir(), `clean-chat-test-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  const { ctx, routes } = fakeCtx();
  resetModelCache();
  registerRoutes(ctx, { settingsDir: dir });
  const route = routes.get('/clean-chat/api/settings');

  const emptyGet = await hit(route, fakeReq({}, 'GET'));
  check('没文件时 GET → 200', emptyGet.status, 200);
  check('没文件时给空对象', JSON.parse(emptyGet.body).settings, {});

  const save = await hit(
    route,
    fakeReq({ system: '你是猫', provider: 'p1', model: 'm1', junk: 'drop me' }),
  );
  check('POST → 200', save.status, 200);
  check('只存认识的三字段', JSON.parse(save.body).settings, {
    system: '你是猫',
    provider: 'p1',
    model: 'm1',
  });

  const file = join(dir, 'settings.json');
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  check('文件里确实写进去了', onDisk.system, '你是猫');
  check('未知字段没落盘', onDisk.junk, undefined);

  const back = await hit(route, fakeReq({}, 'GET'));
  check('再 GET 读得回来', JSON.parse(back.body).settings.model, 'm1');

  const patch = await hit(route, fakeReq({ model: 'm2' }));
  check('部分更新保留其它字段', JSON.parse(patch.body).settings, {
    system: '你是猫',
    provider: 'p1',
    model: 'm2',
  });

  const bad = await hit(route, fakeReq({ nothing: 1 }));
  check('没有可存字段 → 400', bad.status, 400);

  const notObject = await hit(route, fakeReq(['a']));
  check('数组不是合法设置 → 400', notObject.status, 400);

  const crossSite = fakeReq({ model: 'm9' });
  crossSite.headers = { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example.com' };
  check('跨站 POST → 403', (await hit(route, crossSite)).status, 403);

  const getMethod = await hit(route, fakeReq({}, 'PUT'));
  check('PUT → 405', getMethod.status, 405);

  // 半截损坏的文件不能让面板白屏
  writeFileSync(file, '{ 这不是 json', 'utf8');
  const broken = await hit(route, fakeReq({}, 'GET'));
  check('坏文件当空设置', JSON.parse(broken.body).settings, {});

  rmSync(dir, { recursive: true, force: true });
}

// ── 9. 来源闸：回环 socket + x-clean-chat 标记 ─────────────────────
{
  const { ctx, routes } = fakeCtx();
  resetModelCache();
  registerRoutes(ctx);
  const chat = routes.get('/clean-chat/api/chat');
  const payload = { messages: [{ role: 'user', content: 'hi' }] };
  const mark = { 'x-clean-chat': '1', host: '127.0.0.1:9999' };

  // 桌面端实测形状：经过一层转发，没有 sec-fetch-site、没有 Origin，只有我们的标记
  const desktopShaped = fakeReq(payload, 'POST', mark);
  check('桌面端形状（无 site/Origin，只有标记）→ 放行', (await hit(chat, desktopShaped)).status, 200);

  const noMark = fakeReq(payload, 'POST', { host: '127.0.0.1:9999' });
  check('本机脚本（无任何头）也放行——它是面板还是脚本区分不了', (await hit(chat, noMark)).status, 200);

  const noHeaders = fakeReq(payload);
  noHeaders.headers = undefined;
  check('完全没有头 → 放行（同上，回环即可）', (await hit(chat, noHeaders)).status, 200);

  const remote = fakeReq(payload, 'POST', mark, '192.168.1.9');
  check('socket 不是回环 → 403', (await hit(chat, remote)).status, 403);

  const evilOrigin = fakeReq(payload, 'POST', { ...mark, origin: 'https://evil.example.com' });
  check('标记 + https 外站 Origin → 403', (await hit(chat, evilOrigin)).status, 403);

  const localOrigin = fakeReq(payload, 'POST', { ...mark, origin: 'http://127.0.0.1:9999' });
  check('标记 + 回环 Origin → 放行', (await hit(chat, localOrigin)).status, 200);

  const settingsRoute = routes.get('/clean-chat/api/settings');
  const settingsNoMark = fakeReq({}, 'GET');
  settingsNoMark.headers = { host: '127.0.0.1:9999' };
  check('读设置：回环即放行', (await hit(settingsRoute, settingsNoMark)).status, 200);

  const modelsNoMark = fakeReq({}, 'GET');
  modelsNoMark.headers = { host: '127.0.0.1:9999' };
  check('列模型：回环即放行', (await hit(routes.get('/clean-chat/api/models'), modelsNoMark)).status, 200);
}

// ── 10. 长度超限：说清楚，不再静默截断 ──────────────────────────────
{
  const { ctx, routes } = fakeCtx();
  resetModelCache();
  registerRoutes(ctx);
  const chat = routes.get('/clean-chat/api/chat');

  const longOne = await hit(
    chat,
    fakeReq({ messages: [{ role: 'user', content: 'a'.repeat(40_001) }] }),
  );
  check('单条超 4 万 → 413', longOne.status, 413);
  check('413 里说明了长度', /40,001|超过/.test(JSON.parse(longOne.body).error), true);

  const longSystem = await hit(
    chat,
    fakeReq({ system: 'x'.repeat(8_001), messages: [{ role: 'user', content: 'hi' }] }),
  );
  check('系统提示超 8000 → 413', longSystem.status, 413);

  const longTotal = await hit(
    chat,
    fakeReq({
      messages: [
        { role: 'user', content: 'a'.repeat(39_000) },
        { role: 'assistant', content: 'b'.repeat(39_000) },
        { role: 'user', content: 'c'.repeat(39_000) },
        { role: 'assistant', content: 'd'.repeat(39_000) },
        { role: 'user', content: 'e'.repeat(39_000) },
        { role: 'assistant', content: 'f'.repeat(6_000) },
        { role: 'user', content: 'tail' },
      ],
    }),
  );
  check('总量超 20 万 → 413', longTotal.status, 413);
}

// ── 11. 请求体过大：给 413，不是连接重置 ────────────────────────────
{
  const { ctx, routes } = fakeCtx();
  resetModelCache();
  registerRoutes(ctx);
  const huge = fakeReq({ messages: [{ role: 'user', content: 'a'.repeat(1_100_000) }] });
  const out = await hit(routes.get('/clean-chat/api/chat'), huge);
  check('请求体超 1 MiB → 413', out.status, 413);
  check('413 里不出现 ECONNRESET 之类黑话', /1 MiB|太大/.test(JSON.parse(out.body).error), true);
}

// ── 12. 模型白名单：不许点名不存在的模型 ────────────────────────────
{
  const { ctx, routes } = fakeCtx({
    providers: [{ id: 'p1', models: [{ id: 'cheap' }] }],
    selection: { provider: 'p1', model: 'cheap' },
  });
  resetModelCache();
  registerRoutes(ctx);
  const chat = routes.get('/clean-chat/api/chat');

  const bad = await hit(
    chat,
    fakeReq({ provider: 'p1', model: 'expensive', messages: [{ role: 'user', content: 'hi' }] }),
  );
  check('点了不存在的模型 → 400', bad.status, 400);
  check('400 里说模型不可用', /模型不可用/.test(JSON.parse(bad.body).error), true);

  const good = await hit(
    chat,
    fakeReq({ provider: 'p1', model: 'cheap', messages: [{ role: 'user', content: 'hi' }] }),
  );
  check('点存在的模型 → 200', good.status, 200);
}

// ── 0.6.0：来源校验加强 / 条数上限 / 限流 / 错误脱敏 ─────────────────
{
  const { ctx, routes } = fakeCtx({ chunks: [{ type: 'text-delta', text: 'ok' }] });
  resetModelCache();
  resetRateLimiter();
  registerRoutes(ctx);
  const chat = routes.get('/clean-chat/api/chat');
  // 真机结论：桌面端的请求经过一层转发，浏览器头部一个都没有，只有我们自己加的
  // x-clean-chat 标记。这里把所有「长得像面板」和「不像面板」的形状都咬一遍。
  const noMark = await hit(
    chat,
    fakeReq({ messages: [{ role: 'user', content: 'hi' }] }, 'POST', { host: '127.0.0.1:9999' }),
  );
  check('没有标记（本机脚本）→ 放行（与面板不可区分）', noMark.status, 200);


  const electronUA = fakeReq({ messages: [{ role: 'user', content: 'hi' }] }, 'POST', {
    host: '127.0.0.1:9999',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130 Safari/537.36 Electron/32.2.0',
  });
  check('标记丢失但 UA 是 Electron → 放行', (await hit(chat, electronUA)).status, 200);
  const evilOrigin = await hit(
    chat,
    fakeReq({ messages: [{ role: 'user', content: 'hi' }] }, 'POST', {
      'x-clean-chat': '1',
      host: '127.0.0.1:9999',
      origin: 'https://evil.example.com',
    }),
  );
  check('标记 + 外站 Origin → 403', evilOrigin.status, 403);

  const remote = await hit(
    chat,
    fakeReq({ messages: [{ role: 'user', content: 'hi' }] }, 'POST', undefined, '192.168.1.9'),
  );
  check('socket 不是回环 → 403', remote.status, 403);

  const localOrigin = await hit(
    chat,
    fakeReq({ messages: [{ role: 'user', content: 'hi' }] }, 'POST', {
      'x-clean-chat': '1',
      host: 'localhost:9999',
      origin: 'http://localhost:9999',
    }),
  );
  check('标记 + 回环 Origin → 放行', localOrigin.status, 200);

  // 消息条数超过 200
  const many = Array.from({ length: 201 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x',
  }));
  many[many.length - 1] = { role: 'user', content: 'x' };
  const tooMany = await hit(chat, fakeReq({ messages: many }));
  check('消息条数超 200 → 413', tooMany.status, 413);
  check('413 说清条数', /条消息/.test(JSON.parse(tooMany.body).error), true);

  // 第 21 次命中限流
  const body = { messages: [{ role: 'user', content: 'hi' }] };
  let last = null;
  for (let i = 0; i < RATE_LIMIT_PER_MINUTE + 1; i += 1) {
    last = await hit(chat, fakeReq(body));
  }
  check(`第 ${RATE_LIMIT_PER_MINUTE + 1} 次 → 429`, last.status, 429);
  check('429 提示发得太快', /太快/.test(JSON.parse(last.body).error), true);

  // 并发：在途上限 RATE_LIMIT_CONCURRENT=2，第 3 个立刻被挡（别让上游堆请求）
  resetRateLimiter();
  let unblock;
  const gate = new Promise((resolve) => {
    unblock = resolve;
  });
  const slow = fakeCtx({ chunks: [] });
  let streamCount = 0;
  slow.ctx.llm.stream = () => {
    streamCount += 1;
    return (async function* () {
      await gate;
      yield { type: 'text-delta', text: 'late' };
    })();
  };
  resetModelCache();
  registerRoutes(slow.ctx);
  const slowChat = slow.routes.get('/clean-chat/api/chat');
  const running = [
    slowChat(fakeReq(body), fakeRes().res),
    slowChat(fakeReq(body), fakeRes().res),
  ];
  await new Promise((resolve) => setTimeout(resolve, 20));
  const third = await hit(slowChat, fakeReq(body));
  check('两个在途时第 3 个 → 429', third.status, 429);
  check('提示上一个还没结束', /还没结束/.test(JSON.parse(third.body).error), true);
  check('只真的开了两次上游调用', streamCount, 2);
  unblock();
  await Promise.all(running);
}

// 上游报错只回人话，不回原文（原文可能带 URL / trace）
{
  resetRateLimiter();
  const { ctx, routes } = fakeCtx({
    chunks: [
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { code: 'MISSING_CREDENTIAL', message: 'post https://api.secret.internal/v1 boom key=sk-xxx' },
        },
      },
    ],
  });
  resetModelCache();
  registerRoutes(ctx);
  const chat = routes.get('/clean-chat/api/chat');
  const res = await hit(chat, fakeReq({ messages: [{ role: 'user', content: 'hi' }] }));
  check('错误事件仍是 200（SSE 流）', res.status, 200);
  check('失败码回人话', /凭据/.test(res.body), true);
  check('不回传上游原文', /api\.secret\.internal/.test(res.body), false);
  check('不回传 key', /sk-xxx/.test(res.body), false);
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
