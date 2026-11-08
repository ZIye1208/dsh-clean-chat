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

    // ── 设置（只存系统提示与模型选择，历史不落盘） ──────────────────
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

    // ── SSE 读取：把一次 POST 的响应流拆成事件 ─────────────────────
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

    // ── 发送一条消息 ───────────────────────────────────────────────
    async function send(text) {
      if (store.streaming) return;
      var content = String(text || '').trim();
      if (!content) return;
      store.messages.push({ role: 'user', content: content });
      var reply = { role: 'assistant', content: '', thought: '' };
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

    // ── 样式：一次性注入 ──────────────────────────────────────────
    var styleInjected = false;
    function ensureStyle() {
      if (styleInjected) return;
      styleInjected = true;
      var css = [
        '.cc-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsh-text-primary,#e6e6e6)}',
        '.cc-bar{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsh-border,rgba(255,255,255,.08))}',
        '.cc-bar select{background:transparent;color:inherit;border:1px solid var(--dsh-border,rgba(255,255,255,.14));border-radius:6px;padding:3px 6px;font-size:12px;max-width:170px}',
        '.cc-bar button{margin-left:auto;background:transparent;color:inherit;border:1px solid var(--dsh-border,rgba(255,255,255,.14));border-radius:6px;padding:3px 9px;font-size:12px;cursor:pointer}',
        '.cc-bar button:hover{border-color:var(--dsh-accent,#4d6bfe)}',
        '.cc-sys{margin:0 10px 8px;min-height:60px;max-height:140px;background:transparent;color:inherit;border:1px solid var(--dsh-border,rgba(255,255,255,.14));border-radius:8px;padding:7px 9px;font:inherit;line-height:1.5;outline:none;resize:vertical}',
        '.cc-list{flex:1;min-height:0;overflow-y:auto;padding:10px}',
        '.cc-msg{margin:0 0 12px;white-space:pre-wrap;word-break:break-word;line-height:1.6}',
        '.cc-role{font-size:11px;opacity:.5;margin-bottom:3px}',
        '.cc-user .cc-body{background:rgba(77,107,254,.10);border-radius:8px;padding:7px 9px}',
        '.cc-thought{font-size:11px;opacity:.45;white-space:pre-wrap;margin-bottom:4px;max-height:120px;overflow:auto}',
        '.cc-empty{opacity:.45;text-align:center;padding:32px 12px;line-height:1.7}',
        '.cc-error{color:#ff7a7a;font-size:12px;padding:0 10px 8px;white-space:pre-wrap}',
        '.cc-input{border-top:1px solid var(--dsh-border,rgba(255,255,255,.08));padding:8px 10px;display:flex;flex-direction:column;gap:6px}',
        '.cc-input textarea{resize:none;min-height:56px;max-height:200px;background:transparent;color:inherit;border:1px solid var(--dsh-border,rgba(255,255,255,.14));border-radius:8px;padding:7px 9px;font:inherit;line-height:1.5;outline:none}',
        '.cc-input textarea:focus{border-color:var(--dsh-accent,#4d6bfe)}',
        '.cc-actions{display:flex;gap:8px;align-items:center}',
        '.cc-hint{font-size:11px;opacity:.4;margin-left:auto}',
        '.cc-send{background:var(--dsh-accent,#4d6bfe);color:#fff;border:0;border-radius:8px;padding:5px 14px;font-size:12px;cursor:pointer}',
        '.cc-send:disabled{opacity:.45;cursor:default}',
        '.cc-stop{background:transparent;color:inherit;border:1px solid var(--dsh-border,rgba(255,255,255,.14));border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer}',
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

      return h(
        'div',
        { className: 'cc-root' },
        h(
          'div',
          { className: 'cc-bar' },
          h(
            'select',
            {
              value: optionValue,
              title: '这一格对话用哪个模型',
              onChange: function (event) {
                var value = event.target.value;
                if (!value) store.setSettings({ provider: '', model: '' });
                else {
                  var parts = value.split('\u0000');
                  store.setSettings({ provider: parts[0], model: parts[1] });
                }
              },
            },
            h('option', { value: '' }, '跟随默认模型'),
            models.map(function (item) {
              var key = item.provider + '\u0000' + item.model;
              return h('option', { key: key, value: key }, item.label || item.model);
            }),
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: function () {
                setShowPrompt(!showPrompt);
              },
              title: '改系统提示（改完立刻生效，只影响这一格对话）',
            },
            '提示',
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: function () {
                store.reset();
              },
              title: '清空这段对话（历史只在内存里，清掉就没了）',
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
                '干净的一格对话。',
                h('br'),
                '没有工具、没有你的会话上下文，只带一句系统提示。',
              )
            : s.messages.map(function (item, index) {
                var isUser = item.role === 'user';
                return h(
                  'div',
                  { key: index, className: isUser ? 'cc-msg cc-user' : 'cc-msg cc-assistant' },
                  h('div', { className: 'cc-role' }, isUser ? '我' : '助手'),
                  item.thought
                    ? h('div', { className: 'cc-thought' }, item.thought.slice(-400))
                    : null,
                  h('div', { className: 'cc-body' }, item.content || (s.streaming ? '…' : '')),
                );
              }),
        ),
        s.error ? h('div', { className: 'cc-error' }, s.error) : null,
        h(
          'div',
          { className: 'cc-input' },
          h('textarea', {
            ref: inputRef,
            value: draft,
            placeholder: '说点什么…（Enter 发送，Shift+Enter 换行）',
            onChange: function (event) {
              setDraft(event.target.value);
            },
            onKeyDown: onKeyDown,
          }),
          h(
            'div',
            { className: 'cc-actions' },
            h(
              'span',
              { className: 'cc-hint' },
              s.streaming ? '生成中…' : '不占会话 · 不计上下文',
            ),
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

    return { apply: apply, inject: inject };
  },
});
