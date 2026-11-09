/** 插件名（= package.json name）。 */
export const name = 'dsh-clean-chat';
/** 路由前缀。客户端用相对路径 fetch，同源。 */
export const API_PREFIX = '/clean-chat/api';
/** 需要的宿主服务。 */
export const inject = ['webServer', 'llm'];

// ── 各种上限：只在这里定义一次，routes.js 与 settings.js 都从这里取 ──
/** 单条消息内容上限（字符）。 */
export const MAX_MESSAGE_CHARS = 40_000;
/** 一次请求里全部历史的上限（字符）。 */
export const MAX_TOTAL_CHARS = 200_000;
/** 系统提示上限（字符）。 */
export const MAX_SYSTEM_CHARS = 8_000;
/** 一次请求里最多带多少条历史（防「几千条空转」把 prompt 堆爆）。 */
export const MAX_MESSAGES = 200;
/** 单次调用超时。 */
export const TIMEOUT_MS = 180_000;

// ── 限流：同一台机器上不该能无限刷模型 ──
/** 每分钟最多几次对话请求。 */
export const RATE_LIMIT_PER_MINUTE = 20;
/** 同时最多几个在途请求。 */
export const RATE_LIMIT_CONCURRENT = 2;
