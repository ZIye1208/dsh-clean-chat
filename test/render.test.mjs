/**
 * 真实渲染测试：用真正的 react + react-dom/server 把面板渲染一遍。
 * 结构测试（client.test.mjs）用的是假 React，像「style 传字符串」这类属性校验错误只有真 React 才会抛，
 * 所以这里必须用 devDependency 里的 react 真渲染。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

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

// 浏览器环境最小桩（渲染期只会碰到 localStorage）
let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load(options) {
      loaded = options;
    },
  },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
  },
};

new Function('window', source)(globalThis.window);
const mod = loaded.factory((id) => {
  if (id === 'react') return React;
  throw new Error(`不允许的模块依赖：${id}`);
});

// 抓出 tab 组件（走宿主原生右侧栏那条路）
const tabs = [];
const types = [];
const service = { register: (definition) => (types.push(definition), () => {}) };
mod.apply({
  effect(fn) {
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  inject: (list, callback) => callback({ get: (name) => (name === 'sidebarRightTabs' ? service : undefined) }),
  get: () => undefined,
  slots: {
    inject: (seat, register) => register(),
    register: (seat, component) => {
      tabs.push({ seat, component });
      return () => {};
    },
  },
});
const ChatTab = tabs[0]?.component;

// ── 1. 空状态整屏渲染（这里就是上次 style 字符串炸掉的地方）──────────
let html = '';
try {
  html = renderToStaticMarkup(React.createElement(ChatTab));
  check('面板能渲染', html.length > 0, true);
} catch (error) {
  failed += 1;
  console.log(`FAIL 面板渲染抛错\n  ${error.message}`);
}
check('渲染出空状态', html.includes('cc-empty'), true);
check('空状态带提示', html.includes('cc-empty-hint'), true);
check('有输入框占位符', html.includes('说点什么'), true);
check('有发送按钮', html.includes('发送'), true);
check('没有残留的字符串 style', html.includes('style="font-size:12px'), false);

// ── 2. 用量胶囊渲染（关闭态）────────────────────────────────────────
const usage = mod.__internals.usageOf({
  inputTokens: 246,
  outputTokens: 3860,
  cacheReadTokens: 640,
  totalTokens: 4746,
});
const pill = renderToStaticMarkup(
  React.createElement(mod.__internals.TurnUsage, {
    item: { usage, route: 'dsh-opencode-go / deepseek-v4.1-flash' },
  }),
);
check('胶囊渲染出 aria', pill.includes('aria-haspopup="dialog"'), true);
check('胶囊渲染出用量', pill.includes('用量 4.7K'), true);
check('关闭态没有弹层', pill.includes('cc-usage-pop'), false);

// ── 3. 助手消息 + Markdown 渲染路径 ────────────────────────────────
const markdown = mod.__internals.renderMarkdown('**粗** 和 `码`\n\n```js\nx\n```', 'k');
const mdHtml = renderToStaticMarkup(React.createElement('div', null, markdown));
check('Markdown 渲染出 strong', mdHtml.includes('<strong>粗</strong>'), true);
check('Markdown 渲染出 code', mdHtml.includes('<code>x</code>'), true);

// ── 4. 排版：标题分级 / 分隔线 ─────────────────────────────────────
const typo = renderToStaticMarkup(
  React.createElement(
    'div',
    null,
    mod.__internals.renderMarkdown('# 一\n\n## 二\n\n### 三\n\n#### 四\n\n---\n\n段落\n', 't'),
  ),
);
check('h1 渲染', typo.includes('<h1 class="cc-h1">'), true);
check('h2 渲染', typo.includes('<h2 class="cc-h2">'), true);
check('h4 渲染', typo.includes('<h4 class="cc-h4">'), true);
check('分隔线渲染', typo.includes('class="cc-hr"'), true);

// ── 5. 代码块 banner：语言名 + 复制按钮 ────────────────────────────
const codeHtml = renderToStaticMarkup(
  React.createElement(
    'div',
    null,
    mod.__internals.renderMarkdown('```python\nprint(1)\n```\n', 'c'),
  ),
);
check('代码块外框', codeHtml.includes('class="cc-code"'), true);
check('语言名显示', codeHtml.includes('>python<'), true);
check('复制按钮存在', codeHtml.includes('cc-code-copy'), true);
check('代码正文', codeHtml.includes('print(1)'), true);
// 没写语言的围栏退回中性标签，不能是空白
const noLang = renderToStaticMarkup(
  React.createElement('div', null, mod.__internals.renderMarkdown('```\nx\n```\n', 'n')),
);
check('无语言退回 text 标签', noLang.includes('>text<'), true);

// ── 6. 思考区：全文展示 + 用时 ──────────────────────────────────────
const longThought = 'A'.repeat(1200) + 'TAIL-MARKER';
const thinkHtml = renderToStaticMarkup(
  React.createElement(
    'div',
    null,
    mod.__internals.renderMarkdown('正文', 'x'),
  ),
);
check('普通正文能渲染', thinkHtml.includes('正文'), true);
// 直接验 thoughtLabel + 组件里没有截断：拿真实组件渲染一条带长思考的助手消息
{
  const internals = mod.__internals;
  const store = internals.store;
  const saved = store.messages.slice();
  store.messages.length = 0;
  store.messages.push(
    { role: 'user', content: '问', usage: null, route: null, thought: '' },
    {
      role: 'assistant',
      content: '答',
      usage: null,
      route: null,
      thought: longThought,
      thoughtStart: 1000,
      thoughtEnd: 3400,
    },
  );
  store.streaming = false;
  const withThought = renderToStaticMarkup(React.createElement(ChatTab));
  check('思考区显示全文（不再截断）', withThought.includes('TAIL-MARKER'), true);
  check('思考区显示用时', withThought.includes('思考过程 · 2s'), true);
  check('思考区没有 600 字截断痕迹', withThought.length > longThought.length, true);
  store.messages.length = 0;
  saved.forEach((message) => store.messages.push(message));
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
