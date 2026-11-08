/** 插件名（= package.json name）。 */
export const name = 'dsh-clean-chat';
/** 路由前缀。客户端用相对路径 fetch，同源。 */
export const API_PREFIX = '/clean-chat/api';
/** 需要的宿主服务。 */
export const inject = ['webServer', 'llm'];
