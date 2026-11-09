/**
 * 设置持久化：只有 system / provider / model 三个字段，写到
 * `~/.dsh/storages/clean-chat/settings.json`。
 *
 * 对话历史**不落盘**——这个面板的价值就是聊完拉倒；需要留下的设置
 * 才存盘，好让「重启后系统提示还在、模型还是刚才选的那个」。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { MAX_SYSTEM_CHARS } from './constants.js';

/** provider / model 标识上限（字符）。 */
export const MAX_ID_CHARS = 200;

/** 默认存储目录：跟 DSH 自己的 storages 放一起。 */
export function defaultSettingsDir() {
  return join(homedir(), '.dsh', 'storages', 'clean-chat');
}

/** 只保留认识的字段，并把类型/长度收拾干净。 */
export function normalizeSettings(raw) {
  const out = {};
  if (typeof raw?.system === 'string') out.system = raw.system.slice(0, MAX_SYSTEM_CHARS);
  if (typeof raw?.provider === 'string') out.provider = raw.provider.slice(0, MAX_ID_CHARS);
  if (typeof raw?.model === 'string') out.model = raw.model.slice(0, MAX_ID_CHARS);
  return out;
}

/**
 * 建一个文件型设置仓库。
 * @param {string} [dir] 存储目录，测试里指到临时目录。
 */
export function createSettingsStore(dir = defaultSettingsDir()) {
  const file = join(dir, 'settings.json');

  async function read() {
    try {
      const text = await readFile(file, 'utf8');
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? normalizeSettings(parsed) : {};
    } catch {
      // 文件不存在 / 半截损坏 / 没权限：一律当空设置，面板回落到默认值。
      return {};
    }
  }

  async function write(patch) {
    const next = normalizeSettings({ ...(await read()), ...normalizeSettings(patch) });
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmp, file); // 原子替换，避免写一半留下坏文件
    return next;
  }

  return { file, read, write };
}
