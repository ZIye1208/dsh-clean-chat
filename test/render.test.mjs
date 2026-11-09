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

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
