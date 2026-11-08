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

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
