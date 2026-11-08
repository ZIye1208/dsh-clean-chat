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
// style 必须是对象：传字符串会炸成 Minified React error #62
check('没有字符串 style', /style\s*:\s*'/.test(source), false);
check('没有字符串 style（双引号）', /style\s*:\s*"/.test(source), false);

// ── 纯函数：数字格式 ────────────────────────────────────────────────
const { fmtTok, usageOf, usageLine, fmtPercent, fmtExact, TurnUsage, renderMarkdown } = mod.__internals;
check('fmtTok 999', fmtTok(999), '999');
check('fmtTok 1212', fmtTok(1212), '1.2K');
check('fmtTok 142000', fmtTok(142000), '142K');
check('fmtTok 1500000', fmtTok(1500000), '1.5M');
check('fmtTok 0', fmtTok(0), '0');

// ── 纯函数：usage 折算（口径 = 主界面 turn-usage）────────────────────
// 真实样本（dsh-opencode-go）：inputTokens 是未缓存输入，cacheReadTokens 是命中，
// totalTokens - outputTokens 才是提示词总量。命中率 = 640/886 ≈ 72.2%，不是 640/246。
const u = usageOf({ inputTokens: 246, outputTokens: 3860, cacheReadTokens: 640, totalTokens: 4746 });
check('usage 总量', u.total, 4746);
check('提示词总量', u.prompt, 886);
check('未缓存输入', u.uncached, 246);
check('命中率', Math.round(u.hitRate * 100), 72);
check('标了 hasCache', u.hasCache, true);
check('用法空值', usageOf(null), null);

// 没命中时适配器不写 cache 字段：不能显示成「命中 0%」，也不能说成「路由不返回」
const noCache = usageOf({ inputTokens: 43, outputTokens: 81, totalTokens: 124 });
check('无 cache 字段 → hasCache=false', noCache.hasCache, false);
check('无 cache 文案', usageLine(noCache), '43 输入 · 81 输出 · 本轮无缓存命中');
check('有 cache 文案', usageLine(u), '246 输入 · 3.9K 输出 · 缓存命中 72.2%（640 tok）');
check('cacheRead=0 文案', usageLine(usageOf({ inputTokens: 246, outputTokens: 30, cacheReadTokens: 0 })), '246 输入 · 30 输出 · 本轮无缓存命中');

// 命中率不许把 99.96% 抹成 100%
check('99.96% 不显示成 100', fmtPercent(9996, 10000), '99.9');
check('满命中显示 100', fmtPercent(1000, 1000), '100');
check('fmtExact 千分位', fmtExact(142000), '142,000');

// ── 用量胶囊（关闭态：只有胶囊，没有弹层）──────────────────────────
const turn = TurnUsage({ item: { usage: u, route: 'dsh-opencode-go / deepseek-v4.1-flash' } });
check('胶囊容器类名', turn.props.className, 'cc-usage-wrap');
const pill = turn.children[0];
check('胶囊类名', pill.props.className, 'cc-usage-pill');
check('胶囊文案', pill.children[1].children[0], '用量 4.7K');
check('胶囊有 title', typeof pill.props.title, 'string');
check('关闭时没有弹层', turn.children[1], null);
check('没有 usage 时不渲染', TurnUsage({ item: { usage: null } }), null);

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
