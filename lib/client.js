window.__ModuleLoader__.load({
  id: 'dsh-clean-chat',
  factory: (require) => {
    var React = require('react');
    var h = React.createElement;

    // ── 常量 ────────────────────────────────────────────────────────
    var API = '/clean-chat/api';
    /** 自证标记：桌面端的请求经过一层转发，没有 sec-fetch-site/Origin，
     *  唯一能带上的身份信息就是我们自己加的这个头。 */
    var CLIENT_HEADER = { 'x-clean-chat': '1' };
    var DEFAULT_SYSTEM = 'You are a helpful assistant.';
    var LS_KEY = 'dsh-clean-chat:settings';
    var TAB_ID = 'clean-chat';
    var KIND = 'clean-chat';
    /** 距底多少像素算「还在看最新」；比这更远、又不是用户主动上翻的，仍然继续跟随。 */
    var STICKY_THRESHOLD = 40;

    // ── 数字格式：对齐主界面 formatTokens（517 / 12.2K / 517K / 1.2M）──
    function fmtTok(value) {
      var n = Number(value);
      if (!isFinite(n) || n <= 0) return '0';
      if (n < 1000) return String(Math.round(n));
      var scaled = function (candidate) {
        return candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
      };
      if (n < 1000000) return scaled(n / 1000) + 'K';
      return scaled(n / 1000000) + 'M';
    }

    /**
     * 一次 usage 折算成人看的三段。
     * 口径照抄主界面 turn-usage：分母用「提示词总量」= totalTokens - outputTokens，
     * 因为适配器给的 inputTokens 是**未缓存**输入，命中数另算在 cacheReadTokens 里。
     */
    function usageOf(usage) {
      if (!usage) return null;
      var input = Number(usage.inputTokens) || 0;
      var output = Number(usage.outputTokens) || 0;
      var cacheRead = Number(usage.cacheReadTokens) || 0;
      var cacheWrite = Number(usage.cacheWriteTokens) || 0;
      var total = Number(usage.totalTokens) || input + output + cacheRead + cacheWrite;
      if (total <= 0) return null;
      var prompt = Math.max(input + cacheRead + cacheWrite, total - output);
      // pi-ai 适配器只在 cacheRead > 0 时才写 cacheReadTokens 字段，所以「没有字段」= 这一轮真没命中。
      var hasCache = typeof usage.cacheReadTokens === 'number' || typeof usage.cacheWriteTokens === 'number';
      return {
        total: total,
        input: input,
        output: output,
        prompt: prompt,
        hasCache: hasCache,
        uncached: input,
        cacheRead: cacheRead,
        cacheWrite: cacheWrite,
        hitRate: prompt > 0 ? cacheRead / prompt : 0,
      };
    }

    /** 一行用量文案：命中率永远相对「提示词总量」，不是相对未缓存输入。 */
    function usageLine(u) {
      if (!u) return '';
      var parts = [fmtTok(u.uncached) + ' 输入', fmtTok(u.output) + ' 输出'];
      if (u.cacheRead > 0) {
        var pct = fmtPercent(u.cacheRead, u.prompt);
        parts.push('缓存命中 ' + pct + '%（' + fmtTok(u.cacheRead) + ' tok）');
      } else {
        parts.push('本轮无缓存命中');
      }
      return parts.join(' · ');
    }

    /** 整数千分位：142000 → "142,000"（主界面 formatExactTokens 同款）。 */
    function fmtExact(value) {
      var n = Math.round(Number(value) || 0);
      return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /** 命中率：不允许把「还剩一个 token 没命中」显示成 100%（跟主界面同一条规矩）。 */
    function fmtPercent(part, whole) {
      if (!whole || whole <= 0) return '0';
      var pct = (part / whole) * 100;
      var rounded = Math.round(pct * 10) / 10;
      if (rounded >= 100 && part < whole) return '99.9';
      return String(rounded);
    }

    /**
     * 本轮用量胶囊 + 点击弹层（照主界面 TurnUsagePanel 的字段与口径）。
     * 主界面用 dsh-client-ui-primitives 的图标，官方 practices 不建议插件 require 它，所以用文字符号代替。
     */
    /**
     * 弹层定位：贴着锚点下方、与锚点左边缘对齐，越界就挪 / 翻面。
     * 纯函数，方便单测（真实 DOM 的 rect 在测试里造不出来）。
     */
    function computePopoverPlacement(anchor, pop, viewport) {
      var GAP = 6;
      var EDGE = 8;
      var width = Math.min(pop.width, viewport.width - EDGE * 2);
      var left = Math.max(EDGE, Math.min(anchor.left, viewport.width - width - EDGE));
      var below = anchor.bottom + GAP;
      var above = anchor.top - GAP - pop.height;
      var top;
      var placement;
      if (below + pop.height <= viewport.height - EDGE) {
        top = below;
        placement = 'down';
      } else if (above >= EDGE) {
        top = above;
        placement = 'up';
      } else {
        // 上下都放不下（弹层比可用高度还高）：贴边显示，交给 max-height 滚动。
        top = EDGE;
        placement = 'down';
      }
      return { top: top, left: left, width: width, placement: placement };
    }

    function TurnUsage(props) {
      var item = props.item;
      var u = item.usage;
      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var rootRef = React.useRef(null);
      var pillRef = React.useRef(null);
      var popRef = React.useRef(null);
      var posState = React.useState(null);
      var pos = posState[0];
      var setPos = posState[1];

      // 弹层改成 position:fixed，坐标必须自己算：贴着胶囊下方居中，
      // 右边放不下就整体左移，下边放不下就翻到上方 —— 上面那些注释里
      // 说「会被 .cc-list 裁掉」的问题，fixed 之后就只剩视口边界这一件事。
      React.useLayoutEffect(function () {
        if (!open) {
          setPos(null);
          return undefined;
        }
        function place() {
          var pill = pillRef.current;
          var pop = popRef.current;
          if (!pill || !pop) return;
          setPos(
            computePopoverPlacement(
              pill.getBoundingClientRect(),
              { width: pop.offsetWidth, height: pop.offsetHeight },
              { width: window.innerWidth, height: window.innerHeight },
            ),
          );
        }
        place();
        window.addEventListener('resize', place);
        // capture：面板内部滚动的 target 是 .cc-list，不捕获就收不到。
        document.addEventListener('scroll', place, true);
        return function () {
          window.removeEventListener('resize', place);
          document.removeEventListener('scroll', place, true);
        };
      }, [open]);

      React.useEffect(function () {
        if (!open) return undefined;
        function onPointerDown(event) {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        }
        function onKeyDown(event) {
          if (event.key === 'Escape') setOpen(false);
        }
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return function () {
          document.removeEventListener('mousedown', onPointerDown);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      if (!u) return null;

      var rows = [];
      if (item.route) rows.push(['提供方 / 模型', item.route]);
      if (u.cacheRead > 0) rows.push(['缓存命中', fmtPercent(u.cacheRead, u.prompt) + '%']);
      rows.push(['未缓存输入', fmtExact(u.uncached)]);
      if (u.cacheRead > 0) rows.push(['缓存读取', fmtExact(u.cacheRead)]);
      if (u.cacheWrite > 0) rows.push(['缓存写入', fmtExact(u.cacheWrite)]);
      rows.push(['输出', fmtExact(u.output)]);

      return h(
        'div',
        { className: 'cc-usage-wrap', ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            ref: pillRef,
            className: 'cc-usage-pill',
            title: usageLine(u),
            'aria-haspopup': 'dialog',
            'aria-expanded': open ? 'true' : 'false',
            onClick: function () {
              setOpen(!open);
            },
          },
          h('span', { className: 'cc-usage-icon' }, '\u25a4'),
          h('span', null, '用量 ' + fmtTok(u.total)),
        ),
        open
          ? h(
              'div',
              {
                className: 'cc-usage-pop',
                ref: popRef,
                role: 'dialog',
                'aria-label': '本轮用量',
                'data-placement': pos ? pos.placement : undefined,
                style: pos
                  ? {
                      top: pos.top + 'px',
                      left: pos.left + 'px',
                      width: pos.width + 'px',
                      maxHeight: 'calc(100vh - 16px)',
                      overflowY: 'auto',
                    }
                  : { top: '-9999px', left: '-9999px' },
              },
              h(
                'div',
                { className: 'cc-usage-title' },
                h('span', { className: 'cc-usage-title-label' }, '\u25a4 本轮用量'),
                h('span', { className: 'cc-usage-total' }, fmtExact(u.total)),
              ),
              h('div', { className: 'cc-usage-rule' }),
              h(
                'div',
                { className: 'cc-usage-dl' },
                rows.map(function (row, index) {
                  return h(
                    'div',
                    { className: 'cc-usage-row', key: 'u' + index },
                    h('span', null, row[0]),
                    h('b', null, row[1]),
                  );
                }),
              ),
            )
          : null,
      );
    }

    // ── 设置：以宿主磁盘为准（~/.dsh/storages/clean-chat/settings.json）──
    // DSH 的 GUI 端口每次启动都变，localStorage 又按 origin 隔离，所以只靠它
    // 等于「重启就恢复默认」。这里改成宿主说了算，localStorage 只当兜底缓存。
    function sanitizeSettings(parsed) {
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        system: typeof parsed.system === 'string' ? parsed.system : DEFAULT_SYSTEM,
        provider: typeof parsed.provider === 'string' ? parsed.provider : '',
        model: typeof parsed.model === 'string' ? parsed.model : '',
      };
    }
    function loadCachedSettings() {
      try {
        var raw = window.localStorage.getItem(LS_KEY);
        return raw ? sanitizeSettings(JSON.parse(raw)) : null;
      } catch (error) {
        return null;
      }
    }
    function cacheSettings(next) {
      try {
        window.localStorage.setItem(LS_KEY, JSON.stringify(next));
      } catch (error) {
        /* 隐私模式下写不进去，不影响使用 */
      }
    }
    function loadSettings() {
      return loadCachedSettings() || { system: DEFAULT_SYSTEM, provider: '', model: '' };
    }

    var settingsDirty = false;
    var saveTimer = null;
    var lastSaved = '';
    function postSettings(next) {
      try {
        var payload = JSON.stringify(next);
        // 内容没变就不写盘：每次按键都 mkdir+write+rename 是纯浪费，SSD 也受不了。
        if (payload === lastSaved) return Promise.resolve();
        lastSaved = payload;
        return fetch(API + '/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-clean-chat': '1' },
          body: payload,
        }).catch(function () {
          lastSaved = ''; // 没写成功就别记账，下次改动还能重试
        });
      } catch (error) {
        return Promise.resolve();
      }
    }
    function persistSettings(next) {
      cacheSettings(next);
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        saveTimer = null;
        postSettings(next);
      }, 800);
    }
    /** 启动时把宿主的设置拉回来；宿主还没有记录就把本地缓存迁过去。 */
    function hydrateSettings() {
      try {
        fetch(API + '/settings', { headers: CLIENT_HEADER })
          .then(function (response) {
            return response && response.ok ? response.json() : null;
          })
          .then(function (data) {
            if (settingsDirty) return;
            var remote = data && data.ok && data.settings ? data.settings : null;
            if (!remote) return;
            var hasAny = ['system', 'provider', 'model'].some(function (key) {
              return typeof remote[key] === 'string';
            });
            if (!hasAny) {
              postSettings(store.settings); // 迁移旧版本的 localStorage 设置
              return;
            }
            var merged = Object.assign({}, store.settings, sanitizeSettings(remote));
            store.settings = merged;
            cacheSettings(merged);
            store.emit();
          })
          .catch(function () {
            /* 拿不到就用本地缓存，不影响对话 */
          });
      } catch (error) {
        /* 没有 fetch（测试环境）就跳过 */
      }
    }

    /** 测试用：把「用户已改过设置」的标记清掉，让下一次 hydrate 能生效。 */
    function resetSettingsState() {
      settingsDirty = false;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
    }

    // ── 模块级会话状态：切走 tab 再回来，对话还在 ──────────────────
    var store = {
      messages: [],
      settings: loadSettings(),
      streaming: false,
      error: '',
      notice: '',
      controller: null,
      listeners: new Set(),
      emit: function () {
        store.listeners.forEach(function (fn) {
          try {
            fn();
          } catch (error) {
            /* 订阅方自己炸了不关我事 */
          }
        });
      },
      subscribe: function (fn) {
        store.listeners.add(fn);
        return function () {
          store.listeners.delete(fn);
        };
      },
      reset: function () {
        if (store.controller) store.controller.abort();
        store.messages = [];
        store.error = '';
        store.streaming = false;
        store.emit();
      },
      setSettings: function (patch) {
        settingsDirty = true;
        store.settings = Object.assign({}, store.settings, patch);
        persistSettings(store.settings);
        store.emit();
      },
      totals: function () {
        var input = 0;
        var output = 0;
        var cacheRead = 0;
        var prompt = 0;
        var hasCache = false;
        store.messages.forEach(function (item) {
          if (item.usage) {
            input += item.usage.input;
            output += item.usage.output;
            cacheRead += item.usage.cacheRead;
            prompt += item.usage.prompt;
            if (item.usage.hasCache) hasCache = true;
          }
        });
        return {
          input: input,
          output: output,
          total: input + output + cacheRead,
          hasCache: hasCache,
          prompt: prompt,
          cacheRead: cacheRead,
          hitRate: prompt > 0 ? cacheRead / prompt : 0,
        };
      },
    };

    function useStore() {
      var force = React.useReducer(function (x) {
        return x + 1;
      }, 0)[1];
      React.useEffect(function () {
        return store.subscribe(force);
      }, []);
      return store;
    }

    // ── SSE 读取 ───────────────────────────────────────────────────
    async function streamChat(body, onEvent, signal) {
      var response;
      try {
        response = await fetch(API + '/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-clean-chat': '1' },
          body: JSON.stringify(body),
          signal: signal,
        });
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        onEvent({ type: 'error', message: '连不上宿主：' + String((error && error.message) || error) });
        return;
      }
      if (!response.ok) {
        var detail = '';
        try {
          var parsed = await response.json();
          detail = parsed && parsed.error ? String(parsed.error) : '';
        } catch (error) {
          detail = '';
        }
        onEvent({ type: 'error', message: detail || '请求失败（HTTP ' + response.status + '）' });
        return;
      }
      if (!response.body) {
        onEvent({ type: 'error', message: '当前环境不支持流式响应' });
        return;
      }
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      for (;;) {
        var chunk;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (error && error.name === 'AbortError') return;
          onEvent({ type: 'error', message: '读取中断：' + String((error && error.message) || error) });
          return;
        }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var split;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          var frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          var payload = frame.replace(/^data: /, '');
          if (!payload) continue;
          try {
            onEvent(JSON.parse(payload));
          } catch (error) {
            /* 半个 JSON，丢掉 */
          }
        }
      }
    }

    // ── 发送 ───────────────────────────────────────────────────────
    async function send(text) {
      if (store.streaming) return;
      var content = String(text || '').trim();
      if (!content) return;
      store.messages.push({ role: 'user', content: content });
      var reply = {
        role: 'assistant',
        content: '',
        thought: '',
        usage: null,
        route: '',
        // 思考用时：第一次收到 thought 打点，收到正文或结束时收尾。
        thoughtStart: 0,
        thoughtEnd: 0,
      };
      store.messages.push(reply);
      store.streaming = true;
      store.error = '';
      store.notice = '';
      store.emit();

      var controller = new AbortController();
      store.controller = controller;
      var payload = {
        system: store.settings.system,
        provider: store.settings.provider || undefined,
        model: store.settings.model || undefined,
        messages: store.messages
          .filter(function (item) {
            return item.role === 'user' || (item.role === 'assistant' && item.content);
          })
          .map(function (item) {
            return { role: item.role, content: item.content };
          }),
      };

      try {
        await streamChat(
          payload,
          function (event) {
            if (event.type === 'start') {
              reply.route = (event.provider || '') + (event.model ? ' / ' + event.model : '');
              store.emit();
            } else if (event.type === 'delta') {
              if (typeof event.text === 'string') reply.content += event.text;
              // 正文来了就说明思考阶段结束，先把时长定格。
              if (reply.thoughtStart && !reply.thoughtEnd) reply.thoughtEnd = Date.now();
              store.emit();
            } else if (event.type === 'thought') {
              if (typeof event.text === 'string') {
                if (!reply.thoughtStart) reply.thoughtStart = Date.now();
                reply.thought += event.text;
              }
              store.emit();
            } else if (event.type === 'usage') {
              reply.usage = usageOf(event.usage);
              store.emit();
            } else if (event.type === 'error') {
              store.error = (event.code ? '[' + event.code + '] ' : '') + (event.message || '调用失败');
              if (!reply.content) store.messages.pop();
              store.emit();
            }
          },
          controller.signal,
        );
      } finally {
        if (reply.thoughtStart && !reply.thoughtEnd) reply.thoughtEnd = Date.now();
        if (store.controller === controller) store.controller = null;
        store.streaming = false;
        store.emit();
      }
    }

    // ── 轻量 Markdown：代码块 / 列表 / 粗体 / 行内码 ───────────────
    function renderInline(text, keyPrefix) {
      var nodes = [];
      var pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\))/g;
      var last = 0;
      var match;
      var index = 0;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index));
        if (match[1]) {
          nodes.push(h('code', { key: keyPrefix + '-c' + index }, match[1].slice(1, -1)));
        } else if (match[2]) {
          nodes.push(h('strong', { key: keyPrefix + '-b' + index }, match[2].slice(2, -2)));
        } else {
          nodes.push(
            h(
              'a',
              { key: keyPrefix + '-a' + index, href: match[5], target: '_blank', rel: 'noreferrer noopener' },
              match[4],
            ),
          );
        }
        last = match.index + match[0].length;
        index += 1;
      }
      if (last < text.length) nodes.push(text.slice(last));
      return nodes;
    }

    /**
     * 代码块：banner（语言名 + 复制按钮）+ 正文。
     * 结构照主界面的 data-code-block-banner，但我们不需要粘性定位，就一个普通行。
     */
    function CodeBlock(props) {
      var state = React.useState(false);
      var copied = state[0];
      var setCopied = state[1];
      var timerRef = React.useRef(null);

      React.useEffect(function () {
        return function () {
          if (timerRef.current) clearTimeout(timerRef.current);
        };
      }, []);

      function flash() {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(function () {
          setCopied(false);
        }, 1500);
      }

      function onCopy() {
        var text = props.code || '';
        var fail = function () {
          store.notice = '复制失败：浏览器没给剪贴板权限，可以手动选中这段代码';
          store.emit();
        };
        // 面板挂在 127.0.0.1 上，属于安全上下文，clipboard API 可用；
        // 但桌面端若把页面放进受限容器，也可能拿不到，所以两条路都留着。
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(flash, fail);
          return;
        }
        fail();
      }

      return h(
        'div',
        { className: 'cc-code' },
        h(
          'div',
          { className: 'cc-code-head' },
          h('span', { className: 'cc-code-lang' }, props.lang || 'text'),
          h(
            'button',
            { type: 'button', className: 'cc-code-copy', onClick: onCopy },
            copied ? '已复制' : '复制',
          ),
        ),
        h('pre', { className: 'cc-code-body' }, h('code', null, props.code || '')),
      );
    }

    /** 把一段正文拆成块级元素（够用就停，不做完整 Markdown）。 */
    function renderMarkdown(text, keyPrefix) {
      var lines = String(text || '').split(/\r?\n/);
      var blocks = [];
      var lineIndex = 0;
      var blockIndex = 0;

      while (lineIndex < lines.length) {
        var line = lines[lineIndex];

        // 围栏代码块
        var fence = /^```([\w+#.-]*)\s*$/.exec(line);
        if (fence) {
          var code = [];
          lineIndex += 1;
          while (lineIndex < lines.length && !/^```\s*$/.test(lines[lineIndex])) {
            code.push(lines[lineIndex]);
            lineIndex += 1;
          }
          lineIndex += 1;
          blocks.push(
            h(CodeBlock, {
              key: keyPrefix + '-c' + blockIndex,
              code: code.join('\n'),
              lang: fence[1] || '',
            }),
          );
          blockIndex += 1;
          continue;
        }

        // 空行
        if (!line.trim()) {
          lineIndex += 1;
          continue;
        }

        // 分隔线（必须排在列表之前：`- - -` 同时符合列表正则）
        if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          blocks.push(h('hr', { key: keyPrefix + '-r' + blockIndex, className: 'cc-hr' }));
          blockIndex += 1;
          lineIndex += 1;
          continue;
        }

        // 列表（连续的 - / * / 数字. 视为一个块）
        if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
          var items = [];
          while (lineIndex < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[lineIndex])) {
            var itemText = lines[lineIndex].replace(/^\s*([-*]|\d+\.)\s+/, '');
            items.push(h('li', { key: keyPrefix + '-l' + blockIndex + '-' + items.length }, renderInline(itemText, keyPrefix + '-li' + blockIndex + items.length)));
            lineIndex += 1;
          }
          blocks.push(h('ul', { key: keyPrefix + '-u' + blockIndex, className: 'cc-ul' }, items));
          blockIndex += 1;
          continue;
        }

        // 标题：`#` 就是 h1（以前写成 +2，`#` 会变 h3，四级标题全撞在 14px 上）
        var heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading) {
          var level = heading[1].length;
          blocks.push(
            h(
              'h' + level,
              { key: keyPrefix + '-h' + blockIndex, className: 'cc-h' + level },
              renderInline(heading[2], keyPrefix + '-hi' + blockIndex),
            ),
          );
          blockIndex += 1;
          lineIndex += 1;
          continue;
        }

        // 引用
        if (/^>\s?/.test(line)) {
          var quoted = [];
          while (lineIndex < lines.length && /^>\s?/.test(lines[lineIndex])) {
            quoted.push(lines[lineIndex].replace(/^>\s?/, ''));
            lineIndex += 1;
          }
          blocks.push(
            h(
              'blockquote',
              { key: keyPrefix + '-q' + blockIndex, className: 'cc-quote' },
              renderInline(quoted.join('\n'), keyPrefix + '-qi' + blockIndex),
            ),
          );
          blockIndex += 1;
          continue;
        }

        // 普通段落：连续非空行合并
        var paragraph = [];
        while (
          lineIndex < lines.length &&
          lines[lineIndex].trim() &&
          !/^```/.test(lines[lineIndex]) &&
          !/^\s*([-*]|\d+\.)\s+/.test(lines[lineIndex]) &&
          !/^(#{1,4})\s+/.test(lines[lineIndex]) &&
          !/^>\s?/.test(lines[lineIndex]) &&
          !/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[lineIndex])
        ) {
          paragraph.push(lines[lineIndex]);
          lineIndex += 1;
        }
        blocks.push(
          h(
            'p',
            { key: keyPrefix + '-t' + blockIndex, className: 'cc-p' },
            renderInline(paragraph.join('\n'), keyPrefix + '-ti' + blockIndex),
          ),
        );
        blockIndex += 1;
      }
      return blocks;
    }

    // ── 样式（全部走 DSH 主题变量，跟主界面同色） ──────────────────
    var styleInjected = false;
    function ensureStyle() {
      if (styleInjected) return;
      styleInjected = true;
      var css = [
        // 字号跟宿主「内容字号」设置走：主界面正文是 var(--dsh-content-font-size,14px) / calc(24px + delta)，
        // 写死 14px 的后果是用户调大字号后，主界面变大、只有这个面板不动。
        '.cc-root{display:flex;flex-direction:column;height:100%;min-height:0;',
        'font-size:var(--dsh-content-font-size,14px);',
        'line-height:calc(24px + var(--dsh-content-font-delta,0px));',
        'color:var(--dsw-alias-label-primary,#e8e8e8)}',
        '.cc-bar{display:flex;align-items:center;gap:4px;padding:6px 8px;',
        'border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}',
        '.cc-select{appearance:none;background:transparent;color:var(--dsw-alias-label-secondary,inherit);',
        'border:0;border-radius:6px;padding:4px 8px;font-size:12px;max-width:190px;cursor:pointer;outline:none}',
        '.cc-select:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}',
        '.cc-select option{background:var(--dsw-alias-bg-base,#1b1b1e);color:var(--dsw-alias-label-primary,#eee)}',
        '.cc-btn{background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a6);border:0;border-radius:6px;',
        'padding:4px 8px;font-size:12px;cursor:pointer;line-height:1.4}',
        '.cc-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));',
        'color:var(--dsw-alias-label-primary,#eee)}',
        '.cc-btn.is-on{color:var(--dsw-alias-brand-primary,#4d6bfe)}',
        '.cc-spacer{flex:1}',
        '.cc-sys{margin:8px 10px 0;min-height:58px;max-height:140px;background:transparent;',
        'color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));',
        'border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;line-height:1.6;outline:none;resize:vertical}',
        '.cc-sys:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
        '.cc-list{flex:1;min-height:0;overflow-y:auto;padding:14px 16px 6px}',
        // 滚动容器里再包一层，专门给 ResizeObserver 观察「内容变高了」这件事。
        // 直接观察 .cc-list 只能看到它自己的尺寸，内容长高它是不变的。
        '.cc-column{display:flex;flex-direction:column}',
        '.cc-turn{margin-bottom:18px;display:flex;flex-direction:column}',
        '.cc-user{align-items:flex-end}',
        '.cc-assistant{align-items:stretch}',
        '.cc-user .cc-body{max-width:86%;background:color-mix(in srgb, var(--dsw-alias-label-primary,#eee) 7%, transparent);',
        'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:14px;',
        'padding:9px 13px;white-space:pre-wrap;word-break:break-word;line-height:1.6}',
        '.cc-assistant .cc-body{word-break:break-word}',
        // ── Markdown 排版：数值全部对齐主界面（--dsw-font-markdown-*）──────
        // 主界面 h1~h4 是 21/19/18/14px 三档递减 + h4 与正文同号，此前我们一律 14px，
        // 于是「# 标题」和正文长得一模一样，长回答完全没有骨架。
        '.cc-p{margin:16px 0;white-space:pre-wrap}',
        '.cc-p:first-child{margin-top:0}',
        '.cc-p:last-child{margin-bottom:0}',
        '.cc-h1{font-size:calc(21px + var(--dsh-content-font-delta,0px));',
        'line-height:calc(30px + var(--dsh-content-font-delta,0px));font-weight:700;margin:32px 0 16px}',
        '.cc-h2{font-size:calc(19px + var(--dsh-content-font-delta,0px));',
        'line-height:calc(28px + var(--dsh-content-font-delta,0px));font-weight:700;margin:32px 0 16px}',
        '.cc-h3{font-size:calc(18px + var(--dsh-content-font-delta,0px));',
        'line-height:calc(26px + var(--dsh-content-font-delta,0px));font-weight:700;margin:32px 0 16px}',
        '.cc-h4{font-size:var(--dsh-content-font-size,14px);',
        'line-height:calc(24px + var(--dsh-content-font-delta,0px));font-weight:600;margin:16px 0}',
        '.cc-h1:first-child,.cc-h2:first-child,.cc-h3:first-child,.cc-h4:first-child{margin-top:0}',
        '.cc-ul{margin:16px 0;padding-left:18px}',
        '.cc-ul li:not(:first-child){margin-top:6px}',
        '.cc-ul li::marker{color:var(--dsw-alias-label-secondary,#c8ccd2)}',
        '.cc-hr{border:0;height:.5px;margin:32px 0;background:var(--dsw-alias-border-l2,rgba(255,255,255,.1))}',
        // 代码块：banner（语言名 + 复制）+ 正文分开，跟着主界面的 data-code-block-banner 形态走。
        '.cc-code{margin:16px 0;border-radius:8px;overflow:hidden;',
        'background:var(--dsw-alias-tooltip-bg,rgba(0,0,0,.28));',
        'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}',
        '.cc-code-head{display:flex;align-items:center;justify-content:space-between;gap:8px;',
        'padding:4px 6px 4px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}',
        '.cc-code-lang{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8b9096);',
        'font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace)}',
        '.cc-code-copy{background:transparent;border:0;border-radius:5px;padding:1px 8px;font-size:11px;',
        'line-height:1.6;color:var(--dsw-alias-label-tertiary,#8b9096);cursor:pointer;font-family:inherit}',
        '.cc-code-copy:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));',
        'color:var(--dsw-alias-label-primary,#eee)}',
        '.cc-code-body{margin:0;padding:10px 12px;overflow-x:auto;background:transparent;border:0}',
        // 这条特意写成两级类名：.cc-body code（行内码）在后、特异性同为 (0,1,1)，
        // 一层类名压不住它，代码块里的字会凭空长出行内码的内边距和底色。
        '.cc-code .cc-code-body code{display:block;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);',
        'font-size:var(--dsh-code-font-size,11px);line-height:calc(19px + var(--dsh-code-font-delta,0px));',
        'background:transparent;padding:0;border-radius:0;white-space:pre}',
        '.cc-body code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);',
        'font-size:calc(12px + var(--dsh-code-font-delta,0px));',
        'background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));border-radius:4px;padding:1px 4px}',
        '.cc-quote{margin:16px 0 0;padding:0 0 0 14px;white-space:pre-wrap;',
        'border-left:2px solid var(--dsw-alias-label-caption,rgba(255,255,255,.28));',
        'color:var(--dsw-alias-label-secondary,inherit)}',
        // 主界面的链接是品牌蓝 + 500 字重 + 悬停点线下划线；用 brand-primary 会和主界面差一个色。
        '.cc-body a{color:var(--dsw-alias-link,var(--dsw-alias-brand-primary,#6b8cff));',
        'font-weight:500;text-decoration:none}',
        '.cc-body a:hover{text-decoration:underline dotted;text-underline-offset:3px}',
        '.cc-thought{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8b9096);',
        'margin-bottom:6px}',
        '.cc-thought-sum{cursor:pointer;list-style:none;user-select:none;padding:1px 0;opacity:.85}',
        '.cc-thought-sum::-webkit-details-marker{display:none}',
        '.cc-thought-sum::before{content:"▸ ";font-size:10px;opacity:.7}',
        '.cc-thought[open] .cc-thought-sum::before{content:"▾ "}',
        '.cc-thought-sum:hover{color:var(--dsw-alias-label-secondary,#c8ccd2)}',
        // 思考中的扫光：颜色继承 label-tertiary，只让跨度内的文字流动，不额外加 DOM。
        '.cc-shimmer{background:linear-gradient(90deg,var(--dsw-alias-label-tertiary,#8b9096) 0%,',
        'var(--dsw-alias-label-secondary,#c8ccd2) 45%,var(--dsw-alias-label-tertiary,#8b9096) 90%);',
        'background-size:300% 100%;-webkit-background-clip:text;background-clip:text;',
        '-webkit-text-fill-color:transparent;animation:cc-shimmer 1.8s linear infinite}',
        '@keyframes cc-shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}',
        '@media (prefers-reduced-motion:reduce){.cc-shimmer{animation:none;background:none;',
        '-webkit-text-fill-color:currentColor}}',
        '.cc-thought-body{margin-top:4px;padding-left:10px;white-space:pre-wrap;max-height:260px;overflow-y:auto;',
        'border-left:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1))}',
        '.cc-usage-wrap{position:relative;display:inline-flex;margin-top:8px;align-self:flex-start}',
        '.cc-usage-pill{display:inline-flex;align-items:center;gap:5px;background:transparent;cursor:pointer;',
        'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:999px;padding:1px 9px;',
        'color:var(--dsw-alias-label-tertiary,#8b9096);font-size:11px;line-height:1.7;font-family:inherit}',
        '.cc-usage-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));',
        'color:var(--dsw-alias-label-secondary,#c8ccd2)}',
        '.cc-usage-icon{font-size:10px;opacity:.8}',
        // 弹层：改成 fixed + JS 算坐标。原来是 absolute left:0 bottom:100%，
        // 胶囊靠右时横向溢出、第一轮靠顶时纵向顶穿——而且 .cc-list 的 overflow-y:auto 会把它裁掉。
        '.cc-usage-pop{position:fixed;z-index:60;min-width:210px;max-width:320px;',
        'background:var(--dsw-alias-bg-base,#1b1b1e);border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.18));',
        'border-radius:10px;padding:9px 11px;box-shadow:0 10px 28px rgba(0,0,0,.38)}',
        '.cc-usage-title{display:flex;align-items:center;justify-content:space-between;gap:16px;',
        'font-size:12px;color:var(--dsw-alias-label-secondary,#c8ccd2)}',
        '.cc-usage-title-label{opacity:.9}',
        '.cc-usage-total{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#eee)}',
        '.cc-usage-rule{height:1px;margin:7px 0;background:var(--dsw-alias-border-l2,rgba(255,255,255,.1))}',
        '.cc-usage-row{display:flex;justify-content:space-between;gap:16px;font-size:12px;line-height:1.95;',
        'color:var(--dsw-alias-label-tertiary,#8b9096)}',
        '.cc-usage-row b{font-weight:500;color:var(--dsw-alias-label-secondary,#c8ccd2);',
        'font-variant-numeric:tabular-nums}',
        '.cc-empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;',
        'gap:6px;text-align:center;color:var(--dsw-alias-label-tertiary,#8b9096);font-size:13px;line-height:1.8}',
        '.cc-empty-hint{font-size:12px;opacity:.75;max-width:260px}',
        '.cc-error{color:var(--dsw-alias-state-error-primary,#ff7a7a);font-size:12px;',
        'padding:0 14px 8px;white-space:pre-wrap}',
        '.cc-notice{color:var(--dsw-alias-label-tertiary,#8b9096);font-size:12px;',
        'padding:0 14px 8px;white-space:pre-wrap}',
        '.cc-input{border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));padding:8px 10px 10px}',
        '.cc-box{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:10px;',
        'padding:6px 8px 6px 10px;display:flex;flex-direction:column;gap:4px}',
        '.cc-box:hover{border-color:var(--dsw-alias-border-l3,rgba(255,255,255,.2))}',
        // 输入框自增高：用一个隐藏镜像撑高度，textarea 绝对定位铺满。
        // 纯 CSS，不用测 scrollHeight，也就没有"边打边抖"。
        '.cc-ta-wrap{position:relative;min-height:44px;max-height:180px}',
        '.cc-ta-mirror{visibility:hidden;pointer-events:none;box-sizing:border-box;',
        'min-height:44px;max-height:180px;overflow:hidden;',
        'padding:2px 0;border:0;margin:0;font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:1.6;',
        'white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}',
        '.cc-input textarea{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;',
        'resize:none;background:transparent;color:inherit;',
        'border:0;margin:0;padding:2px 0;font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:1.6;',
        'outline:none;overflow-y:auto}',
        '.cc-foot{display:flex;align-items:center;gap:8px}',
        '.cc-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b9096)}',
        '.cc-send{background:var(--dsw-alias-button-primary-fill,#4d6bfe);',
        'color:var(--dsw-alias-label-primary-foreground,#fff);border:0;border-radius:7px;',
        'padding:4px 13px;font-size:12px;line-height:1.6;cursor:pointer}',
        '.cc-send:hover{background:var(--dsw-alias-button-primary-hover,#3f5ae0)}',
        '.cc-send:disabled{opacity:.45;cursor:default}',
        '.cc-stop{background:transparent;color:var(--dsw-alias-label-secondary,inherit);',
        'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));border-radius:7px;',
        'padding:3px 11px;font-size:12px;cursor:pointer}',
      ].join('\n');
      var el = document.createElement('style');
      el.textContent = css;
      document.head.appendChild(el);
    }

    /** 思考区标题：进行中走扫光文案，结束后带上用时（至少 1 秒，跟主界面一致）。 */
    function thoughtLabel(item, thinking) {
      if (thinking) return '正在思考…';
      var ms = Number(item.thoughtEnd || 0) - Number(item.thoughtStart || 0);
      if (!item.thoughtStart || !(ms > 0)) return '思考过程';
      return '思考过程 · ' + Math.max(1, Math.round(ms / 1000)) + 's';
    }

    // ── 面板 ───────────────────────────────────────────────────────
    function ChatTab() {
      var s = useStore();
      var [draft, setDraft] = React.useState('');
      var [models, setModels] = React.useState([]);
      var [showPrompt, setShowPrompt] = React.useState(false);
      var listRef = React.useRef(null);
      var contentRef = React.useRef(null);
      var stickyRef = React.useRef(true);
      var scrollTopRef = React.useRef(0);
      var inputRef = React.useRef(null);

      React.useEffect(function () {
        ensureStyle();
      }, []);

      React.useEffect(function () {
        var alive = true;
        fetch(API + '/models', { headers: CLIENT_HEADER })
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            if (!alive || !data) return;
            var routes = Array.isArray(data.routes) ? data.routes : [];
            setModels(routes);
            // 存盘的模型可能已经被删掉了（换机器、换提供方都很常见）。
            // 以前是静默失败：面板一直发请求、一直报错，用户不知道为什么。
            var saved = store.settings;
            if (routes.length === 0 || (!saved.provider && !saved.model)) return;
            var alive0 = routes.some(function (item) {
              return item.provider === saved.provider && item.model === saved.model;
            });
            if (alive0) return;
            store.settings = Object.assign({}, saved, { provider: '', model: '' });
            persistSettings(store.settings);
            store.notice = '原来选的模型（' + (saved.model || saved.provider) + '）已经不可用，已切回默认模型';
            store.emit();
          })
          .catch(function () {
            /* 拉不到就只显示「跟随默认模型」 */
          });
        return function () {
          alive = false;
        };
      }, []);

      // 粘底跟随。原来是一条「依赖 messages / length / streaming」的 effect，
      // 而流式时 delta 只改 reply.content，三个依赖都不变 —— effect 根本不跑，
      // 于是回答越长视口越不动。改成 ResizeObserver 驱动 + 用户上翻才解除跟随。
      React.useLayoutEffect(function () {
        var stick = stickyRef.current;
        var box = listRef.current;
        var content = contentRef.current;
        if (!box || !content) return undefined;
        // 观察内容层：观察滚动容器本身只能感知它自己的尺寸，感知不到内容变高。
        var observer = new ResizeObserver(function () {
          if (!stickyRef.current) return;
          var el = listRef.current;
          if (!el) return;
          el.scrollTop = el.scrollHeight;
          scrollTopRef.current = el.scrollTop;
        });
        observer.observe(content);
        observer.observe(box);
        if (stick) {
          box.scrollTop = box.scrollHeight;
          scrollTopRef.current = box.scrollTop;
        }
        return function () {
          observer.disconnect();
        };
      }, [s.messages.length]);

      React.useEffect(function () {
        var box = listRef.current;
        if (!box) return undefined;
        function onScroll() {
          // 只有「用户把 scrollTop 往回拉」才解除跟随；内容自己长高不算。
          var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < STICKY_THRESHOLD;
          if (nearBottom) {
            stickyRef.current = true;
          } else if (box.scrollTop < scrollTopRef.current) {
            stickyRef.current = false;
          }
          scrollTopRef.current = box.scrollTop;
        }
        box.addEventListener('scroll', onScroll, { passive: true });
        return function () {
          box.removeEventListener('scroll', onScroll);
        };
      }, []);

      // 新消息进来时强制回到跟随状态（自己发的、或对面开始回）。
      React.useEffect(function () {
        stickyRef.current = true;
      }, [s.messages.length]);

      function submit() {
        var text = draft;
        setDraft('');
        send(text);
        if (inputRef.current) inputRef.current.focus();
      }

      function onKeyDown(event) {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          submit();
        }
      }

      var optionValue = s.settings.provider && s.settings.model ? s.settings.provider + '\u0000' + s.settings.model : '';

      // 按 provider 分组，provider 名字只出现在 optgroup 上
      var groups = [];
      var seen = {};
      models.forEach(function (item) {
        if (!seen[item.provider]) {
          seen[item.provider] = { provider: item.provider, label: item.providerLabel || item.provider, items: [] };
          groups.push(seen[item.provider]);
        }
        seen[item.provider].items.push(item);
      });

      var totals = s.totals();

      return h(
        'div',
        { className: 'cc-root' },
        h(
          'div',
          { className: 'cc-bar' },
          h(
            'select',
            {
              className: 'cc-select',
              value: optionValue,
              title: '这段对话用哪个模型',
              onChange: function (event) {
                var value = event.target.value;
                if (!value) store.setSettings({ provider: '', model: '' });
                else {
                  var parts = value.split('\u0000');
                  store.setSettings({ provider: parts[0], model: parts[1] });
                }
              },
            },
            h('option', { value: '' }, '默认模型'),
            groups.map(function (group) {
              return h(
                'optgroup',
                { key: group.provider, label: group.label },
                group.items.map(function (item) {
                  var key = item.provider + '\u0000' + item.model;
                  return h('option', { key: key, value: key }, item.label || item.model);
                }),
              );
            }),
          ),
          h('span', { className: 'cc-spacer' }),
          totals.total > 0
            ? h(
                'span',
                { className: 'cc-hint', title: '这一格对话的累计用量（来源：每轮 usage 分片）' },
                fmtTok(totals.total) + ' tok' + (totals.cacheRead > 0 ? ' · 命中 ' + fmtPercent(totals.cacheRead, totals.prompt) + '%' : ''),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: showPrompt ? 'cc-btn is-on' : 'cc-btn',
              onClick: function () {
                setShowPrompt(!showPrompt);
              },
              title: '改系统提示（立刻生效）',
            },
            '提示',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'cc-btn',
              onClick: function () {
                store.reset();
              },
              title: '清空这段对话（历史只在内存里）',
            },
            '清空',
          ),
        ),
        showPrompt
          ? h('textarea', {
              className: 'cc-sys',
              value: s.settings.system,
              placeholder: '留空 = 不带系统提示',
              onChange: function (event) {
                store.setSettings({ system: event.target.value });
              },
            })
          : null,
        h(
          'div',
          { className: 'cc-list', ref: listRef },
          s.messages.length === 0
            ? h(
                'div',
                { className: 'cc-empty' },
                h('div', null, '干净的一格对话'),
                h('div', null, '不带工具、不带你的会话上下文，只带一句系统提示'),
                h(
                  'div',
                  { className: 'cc-empty-hint' },
                  '前缀短，缓存命中通常为 0——主界面命中高，是因为它一上来就带几万 token 的系统提示和工具定义',
                ),
              )
            : h(
                'div',
                { className: 'cc-column', ref: contentRef },
                s.messages.map(function (item, index) {
                  var isUser = item.role === 'user';
                  var isLast = index === s.messages.length - 1;
                  var thinking = !isUser && s.streaming && isLast && !item.content;
                  return h(
                    'div',
                    { key: index, className: isUser ? 'cc-turn cc-user' : 'cc-turn cc-assistant' },
                    !isUser && item.thought
                      ? h(
                          'details',
                          { className: 'cc-thought' },
                          h(
                            'summary',
                            { className: 'cc-thought-sum' },
                            h(
                              'span',
                              { className: thinking ? 'cc-shimmer' : null },
                              thoughtLabel(item, thinking),
                            ),
                          ),
                          // 以前这里按末尾 600 字截断，长思考的开头被静默吃掉。
                          // 改成全文 + CSS 限高滚动，想看多久的思考都在。
                          h('div', { className: 'cc-thought-body' }, item.thought),
                        )
                      : null,
                    h(
                      'div',
                      { className: 'cc-body' },
                      isUser
                        ? item.content
                        : item.content
                          ? renderMarkdown(item.content, 'm' + index)
                          : s.streaming && isLast
                            ? '…'
                            : '',
                    ),
                    !isUser && item.usage ? h(TurnUsage, { key: 'usage' + index, item: item }) : null,
                  );
                }),
              ),
        ),
        s.error ? h('div', { className: 'cc-error' }, s.error) : null,
        s.notice ? h('div', { className: 'cc-notice' }, s.notice) : null,
        h(
          'div',
          { className: 'cc-input' },
          h(
            'div',
            { className: 'cc-box' },
            h(
              'div',
              { className: 'cc-ta-wrap' },
              // 隐藏镜像撑高度：末尾那个 \n 不能省，否则最后一行是空行时高度少一行。
              h('div', { className: 'cc-ta-mirror', 'aria-hidden': 'true' }, draft + '\n'),
              h('textarea', {
                ref: inputRef,
                value: draft,
                placeholder: '说点什么…',
                rows: 2,
                onChange: function (event) {
                  setDraft(event.target.value);
                },
                onKeyDown: onKeyDown,
              }),
            ),
            h(
              'div',
              { className: 'cc-foot' },
              h('span', { className: 'cc-hint' }, s.streaming ? '生成中…' : 'Enter 发送 · Shift+Enter 换行'),
              h('span', { className: 'cc-spacer' }),
              s.streaming
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'cc-stop',
                      onClick: function () {
                        if (store.controller) store.controller.abort();
                      },
                    },
                    '停止',
                  )
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'cc-send',
                      disabled: !draft.trim(),
                      onClick: submit,
                    },
                    '发送',
                  ),
            ),
          ),
        ),
      );
    }

    // ── 插件入口 ───────────────────────────────────────────────────
    // 正式形态：走宿主原生的右侧栏（@deepseek-ai/dsh-client-ui-sidebar-right）。
    // 两条铁律（0.8.0 踩过，代价是 DSH 起不来）：
    //   ① inject 必须声明所有用到的服务：cordis 的代理会抛 "cannot get property ... without inject"；
    //   ② 按 key 的席位必须等 `slots.inject(seat, ...)` 就绪再注册，不能直接 register。
    // 而且 apply 抛异常 = 整个客户端 boot 失败，所以运行期异常要自己兜住。
    var inject = ['slots'];

    function apply(ctx) {
      hydrateSettings(); // 先把存盘的设置拉回来，别等面板挂载才补

      // sidebarRightTabs 不是 apply 时一定就绪的服务：用 ctx.inject 等它。
      ctx.inject(['sidebarRightTabs'], function (host) {
        var tabs = readService(host, 'sidebarRightTabs');
        if (!tabs || typeof tabs.register !== 'function') {
          warnOnce('[clean-chat] 宿主没有 sidebarRightTabs（右侧栏服务），面板不会出现。');
          return;
        }
        try {
          mountNative(ctx, tabs);
        } catch (error) {
          // 宁可没有面板，也不能把宿主 boot 拖崩。
          try {
            console.error('[clean-chat] 挂载原生右侧栏席位失败，面板不会出现：', error);
          } catch (ignored) {
            /* 控制台不可用就算了 */
          }
        }
      });
    }

    /** 读服务：ctx.get 是标准姿势，也兼容直接挂载的老形态。 */
    function readService(from, name) {
      try {
        return typeof from.get === 'function' ? from.get(name) : from[name];
      } catch (error) {
        return undefined;
      }
    }

    function warnOnce(text) {
      try {
        console.warn(text);
      } catch (ignored) {
        /* 控制台不可用就算了 */
      }
    }

    function mountNative(ctx, tabs) {
      // ① 声明页类型；② 等席位就绪再把正文注册到该 key 下。
      ctx.effect(function () {
        return tabs.register({
          id: TAB_ID,
          kind: KIND,
          keepMounted: true,
          priority: 'extension',
          title: function () {
            return '闲聊';
          },
          guide: [
            {
              id: KIND,
              order: 40,
              title: function () {
                return '闲聊';
              },
              description: function () {
                return '干净对话：不给工具、不带会话上下文';
              },
            },
          ],
        });
      }, 'clean-chat: sidebar tab type');

      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.pane.tab', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: TAB_ID,
            },
            ChatTab,
          );
        });
      }, 'clean-chat: sidebar tab body');
    }

    return {
      apply: apply,
      inject: inject,
      // 给测试用的纯函数出口（没有副作用）
      __internals: {
        fmtTok: fmtTok,
        usageOf: usageOf,
        usageLine: usageLine,
        fmtPercent: fmtPercent,
        fmtExact: fmtExact,
        TurnUsage: TurnUsage,
        renderMarkdown: renderMarkdown,
        CodeBlock: CodeBlock,
        thoughtLabel: thoughtLabel,
        computePopoverPlacement: computePopoverPlacement,
        ChatTab: ChatTab,
        store: store,
        loadSettings: loadSettings,
        hydrateSettings: hydrateSettings,
        persistSettings: persistSettings,
        resetSettingsState: resetSettingsState,
      },
    };
  },
});
