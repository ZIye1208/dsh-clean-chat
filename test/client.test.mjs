/** 客户端入口的结构测试：不渲染、只验「能不能加载 + 注册出正确的 tab」。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

/** 最小 React 桩：只够 apply() 用（不渲染组件）。 */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useReducer: (reducer, initial) => [initial, () => {}],
};

let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load(options) {
      loaded = options;
    },
  },
  localStorage: { getItem: () => null, setItem: () => {} },
};

// 执行模块（它注册进 window.__ModuleLoader__）
new Function('window', source)(globalThis.window);

check('调用了 ModuleLoader.load', loaded !== null, true);
check('模块 id', loaded?.id, 'dsh-clean-chat');
check('factory 是函数', typeof loaded?.factory, 'function');

const requireStub = (id) => {
  if (id === 'react') return fakeReact;
  throw new Error(`不允许的模块依赖：${id}`);
};
const mod = loaded.factory(requireStub);

check('导出 apply', typeof mod.apply, 'function');
check('声明 inject', mod.inject, ['betterSidebar']);

// 注册出 tab
const tabs = [];
const effects = [];
const ctx = {
  effect(fn, label) {
    effects.push(label);
    const dispose = fn();
    if (typeof dispose === 'function') dispose();
    return () => {};
  },
  betterSidebar: {
    registerTab(descriptor) {
      tabs.push(descriptor);
      return () => {};
    },
  },
};
mod.apply(ctx);
check('注册了 1 个 tab', tabs.length, 1);
check('tab id', tabs[0]?.id, 'clean-chat');
check('tab 单例', tabs[0]?.single, true);
check('tab 有 component', typeof tabs[0]?.component, 'function');
check('effect 有标签', effects.length, 1);

// 没有 betterSidebar 时静默跳过，不抛
const bare = { effect: () => {}, betterSidebar: undefined };
let threw = '';
try {
  mod.apply(bare);
} catch (error) {
  threw = String(error?.message ?? error);
}
check('缺 betterSidebar 不抛错', threw, '');

// 客户端只允许依赖 react
check('只 require react', /require\((?!'react'\))/.test(source.replace(/require\('react'\)/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'[^']*'/g, "''")), false);

// ── 纯函数：数字格式 ────────────────────────────────────────────────
const { fmtTok, usageOf, renderMarkdown } = mod.__internals;
check('fmtTok 999', fmtTok(999), '999');
check('fmtTok 1212', fmtTok(1212), '1.2K');
check('fmtTok 142000', fmtTok(142000), '142K');
check('fmtTok 1500000', fmtTok(1500000), '1.5M');
check('fmtTok 0', fmtTok(0), '0');

// ── 纯函数：usage 折算 ─────────────────────────────────────────────
const u = usageOf({ inputTokens: 1212, outputTokens: 828, cacheReadTokens: 1200 });
check('usage 总量', u.total, 2040);
check('usage 未缓存输入', u.uncached, 12);
check('usage 命中率', Math.round(u.hitRate * 100), 99);
check('usage 空值', usageOf(null), null);

// ── 纯函数：Markdown 块级结构 ──────────────────────────────────────
const tree = renderMarkdown('# 标题\n\n第一段**粗**和`码`。\n\n- a\n- b\n\n```js\nconst x = 1;\n```\n', 'k');
const kinds = tree.map((node) => node.type);
/** 把「一个数组子节点」摊平（假 React 不展开数组，真 React 会）。 */
const flat = (node) => ([]).concat(...node.children.map((child) => (Array.isArray(child) ? child : [child])));
check('markdown 块序列', kinds, ['h3', 'p', 'ul', 'pre']);
check('列表两项', flat(tree[2]).length, 2);
check('代码块内容', tree[3].children[0].children[0], 'const x = 1;');
check('粗体节点', flat(tree[1]).some((child) => child && child.type === 'strong'), true);
check('行内码节点', flat(tree[1]).some((child) => child && child.type === 'code'), true);
check('空文本不炸', renderMarkdown('', 'z').length, 0);

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
