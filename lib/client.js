window.__ModuleLoader__.load({
  id: 'dsh-clean-chat',
  factory: (require) => {
    var React = require('react');
    var h = React.createElement;

    // ── 常量 ────────────────────────────────────────────────────────
    var API = '/clean-chat/api';
    var DEFAULT_SYSTEM = 'You are a helpful assistant.';
    var LS_KEY = 'dsh-clean-chat:settings';
    var TAB_ID = 'clean-chat';

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

    /** 命中率：不允许把「还剩一个 token 没命中」显示成 100%（跟主界面同一条规矩）。 */
    function fmtPercent(part, whole) {
      if (!whole || whole <= 0) return '0';
      var pct = (part / whole) * 100;
      var rounded = Math.round(pct * 10) / 10;
      if (rounded >= 100 && part < whole) return '99.9';
      return String(rounded);
    }

    // ── 设置 ───────────────────────────────────────────────────────
    function loadSettings() {
      try {
        var raw = window.localStorage.getItem(LS_KEY);
        if (!raw) return { system: DEFAULT_SYSTEM, provider: '', model: '' };
        var parsed = JSON.parse(raw);
        return {
          system: typeof parsed.system === 'string' ? parsed.system : DEFAULT_SYSTEM,
          provider: typeof parsed.provider === 'string' ? parsed.provider : '',
          model: typeof parsed.model === 'string' ? parsed.model : '',
        };
      } catch (error) {
        return { system: DEFAULT_SYSTEM, provider: '', model: '' };
      }
    }
    function saveSettings(next) {
      try {
        window.localStorage.setItem(LS_KEY, JSON.stringify(next));
      } catch (error) {
        /* 隐私模式下写不进去，不影响使用 */
      }
    }

    // ── 模块级会话状态：切走 tab 再回来，对话还在 ──────────────────
    var store = {
      messages: [],
      settings: loadSettings(),
      streaming: false,
      error: '',
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
        store.settings = Object.assign({}, store.settings, patch);
        saveSettings(store.settings);
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
          headers: { 'content-type': 'application/json' },
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
      var reply = { role: 'assistant', content: '', thought: '', usage: null };
      store.messages.push(reply);
      store.streaming = true;
      store.error = '';
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
            if (event.type === 'delta') {
              reply.content += event.text;
              store.emit();
            } else if (event.type === 'thought') {
              reply.thought += event.text;
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
              { key: keyPrefix + '-a' + index, href: match[5], target: '_blank', rel: 'noreferrer' },
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
            h(
              'pre',
              { key: keyPrefix + '-p' + blockIndex, className: 'cc-pre' },
              h('code', null, code.join('\n')),
            ),
          );
          blockIndex += 1;
          continue;
        }

        // 空行
        if (!line.trim()) {
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

        // 标题
        var heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading) {
          var level = Math.min(heading[1].length + 2, 6);
          blocks.push(
            h(
              'h' + level,
              { key: keyPrefix + '-h' + blockIndex, className: 'cc-h' },
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
          !/^>\s?/.test(lines[lineIndex])
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
        '.cc-root{display:flex;flex-direction:column;height:100%;min-height:0;',
        'font-size:14px;line-height:1.7;color:var(--dsw-alias-label-primary,#e8e8e8)}',
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
        '.cc-turn{margin-bottom:18px;display:flex;flex-direction:column}',
        '.cc-user{align-items:flex-end}',
        '.cc-assistant{align-items:stretch}',
        '.cc-user .cc-body{max-width:86%;background:color-mix(in srgb, var(--dsw-alias-label-primary,#eee) 7%, transparent);',
        'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:14px;',
        'padding:9px 13px;white-space:pre-wrap;word-break:break-word;line-height:1.6}',
        '.cc-assistant .cc-body{word-break:break-word}',
        '.cc-p{margin:0 0 8px;white-space:pre-wrap}',
        '.cc-p:last-child{margin-bottom:0}',
        '.cc-h{margin:10px 0 6px;font-size:14px;font-weight:600;line-height:1.5}',
        '.cc-ul{margin:0 0 8px;padding-left:20px}',
        '.cc-ul li{margin:2px 0}',
        '.cc-pre{margin:8px 0;padding:10px 12px;border-radius:8px;overflow-x:auto;',
        'background:var(--dsw-alias-tooltip-bg,rgba(0,0,0,.28));',
        'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}',
        '.cc-pre code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;line-height:1.6}',
        '.cc-body code,.cc-body a code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;',
        'background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));border-radius:4px;padding:1px 4px}',
        '.cc-quote{margin:0 0 8px;padding:2px 0 2px 10px;white-space:pre-wrap;',
        'border-left:2px solid var(--dsw-alias-border-l3,rgba(255,255,255,.2));',
        'color:var(--dsw-alias-label-secondary,inherit)}',
        '.cc-body a{color:var(--dsw-alias-brand-primary,#6b8cff);text-decoration:none}',
        '.cc-body a:hover{text-decoration:underline}',
        '.cc-thought{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8b9096);',
        'margin-bottom:6px}',
        '.cc-thought-sum{cursor:pointer;list-style:none;user-select:none;padding:1px 0;opacity:.85}',
        '.cc-thought-sum::-webkit-details-marker{display:none}',
        '.cc-thought-sum::before{content:"▸ ";font-size:10px;opacity:.7}',
        '.cc-thought[open] .cc-thought-sum::before{content:"▾ "}',
        '.cc-thought-sum:hover{color:var(--dsw-alias-label-secondary,#c8ccd2)}',
        '.cc-thought-body{margin-top:4px;padding-left:10px;white-space:pre-wrap;max-height:260px;overflow-y:auto;',
        'border-left:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1))}',
        '.cc-usage{margin-top:7px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b9096)}',
        '.cc-empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;',
        'gap:6px;text-align:center;color:var(--dsw-alias-label-tertiary,#8b9096);font-size:13px;line-height:1.8}',
        '.cc-error{color:var(--dsw-alias-state-error-primary,#ff7a7a);font-size:12px;',
        'padding:0 14px 8px;white-space:pre-wrap}',
        '.cc-input{border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));padding:8px 10px 10px}',
        '.cc-box{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:10px;',
        'padding:6px 8px 6px 10px;display:flex;flex-direction:column;gap:4px}',
        '.cc-box:hover{border-color:var(--dsw-alias-border-l3,rgba(255,255,255,.2))}',
        '.cc-input textarea{resize:none;min-height:44px;max-height:180px;background:transparent;color:inherit;',
        'border:0;padding:2px 0;font:inherit;font-size:14px;line-height:1.6;outline:none}',
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

    // ── 面板 ───────────────────────────────────────────────────────
    function ChatTab() {
      var s = useStore();
      var [draft, setDraft] = React.useState('');
      var [models, setModels] = React.useState([]);
      var [showPrompt, setShowPrompt] = React.useState(false);
      var listRef = React.useRef(null);
      var inputRef = React.useRef(null);

      React.useEffect(function () {
        ensureStyle();
      }, []);

      React.useEffect(function () {
        var alive = true;
        fetch(API + '/models')
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            if (!alive || !data) return;
            setModels(Array.isArray(data.routes) ? data.routes : []);
          })
          .catch(function () {
            /* 拉不到就只显示「跟随默认模型」 */
          });
        return function () {
          alive = false;
        };
      }, []);

      React.useEffect(function () {
        var box = listRef.current;
        if (box) box.scrollTop = box.scrollHeight;
      }, [s.messages, s.messages.length, s.streaming]);

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
                  { style: 'font-size:12px;opacity:.75;max-width:260px' },
                  '前缀短，缓存命中通常为 0——主界面命中高，是因为它一上来就带几万 token 的系统提示和工具定义',
                ),
              )
            : s.messages.map(function (item, index) {
                var isUser = item.role === 'user';
                return h(
                  'div',
                  { key: index, className: isUser ? 'cc-turn cc-user' : 'cc-turn cc-assistant' },
                  !isUser && item.thought
                    ? h(
                        'details',
                        { className: 'cc-thought' },
                        h('summary', { className: 'cc-thought-sum' }, '思考过程'),
                        h('div', { className: 'cc-thought-body' }, item.thought.slice(-600)),
                      )
                    : null,
                  h(
                    'div',
                    { className: 'cc-body' },
                    isUser
                      ? item.content
                      : item.content
                        ? renderMarkdown(item.content, 'm' + index)
                        : s.streaming && index === s.messages.length - 1
                          ? '…'
                          : '',
                  ),
                  !isUser && item.usage
                    ? h('div', { className: 'cc-usage' }, usageLine(item.usage))
                    : null,
                );
              }),
        ),
        s.error ? h('div', { className: 'cc-error' }, s.error) : null,
        h(
          'div',
          { className: 'cc-input' },
          h(
            'div',
            { className: 'cc-box' },
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
    var inject = ['betterSidebar'];

    function apply(ctx) {
      if (!ctx.betterSidebar || typeof ctx.betterSidebar.registerTab !== 'function') {
        return;
      }
      ctx.effect(
        function () {
          return ctx.betterSidebar.registerTab({
            id: TAB_ID,
            title: function () {
              return '闲聊';
            },
            description: function () {
              return '干净对话：不给工具、不带会话上下文';
            },
            order: 40,
            single: true,
            component: ChatTab,
          });
        },
        'clean-chat: sidebar tab',
      );
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
        renderMarkdown: renderMarkdown,
      },
    };
  },
});
