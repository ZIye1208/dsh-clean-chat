/** HTTP 小工具：SSE 写事件、JSON 响应、带上限的请求体读取。 */

/** 单次请求体上限（字节）。20 万字中文按 UTF-8 约 600 KB，留足余量。 */
export const BODY_LIMIT = 1024 * 1024;

/** 写一条 SSE 事件。 */
export function sse(res, payload) {
  if (res.writableEnded) return;
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    /* 客户端已断开 */
  }
}

/** 开一条 SSE 响应头。 */
export function openSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

export function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/**
 * 读取请求体（带长度上限）。
 *
 * 超限时**不 destroy**：直接断连会让前端只看到 `fetch failed`／连接重置，
 * 用户根本不知道是「内容太长」。这里把剩下的字节读完丢掉，交给上层回一个
 * 413 + 人话；错误码 `BODY_TOO_LARGE` 就是给上层识别用的。
 */
export function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return; // 已经拒绝了，继续把流水掉就行
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        const error = new Error(`请求体超过 ${limit} 字节`);
        error.code = 'BODY_TOO_LARGE';
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (!tooLarge) reject(error);
    });
  });
}
