/** 插件主体：只注册路由，不碰会话、不注册工具。 */
import { registerRoutes } from './routes.js';

export const name = 'dsh-clean-chat';
export const inject = ['webServer', 'llm'];

export function apply(ctx) {
  registerRoutes(ctx);
}
