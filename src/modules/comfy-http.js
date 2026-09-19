'use strict';

const http = require('node:http');
const https = require('node:https');

// The connector needs buffered JSON, multipart uploads and image bytes, not a
// browser fetch. Keep this transport in Node even when called from preload.
async function nodeFetch(url, init = {}) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
  if (!transport) throw new Error('ComfyUI 地址必须使用 http 或 https');
  const signal = init.signal;
  if (signal?.aborted) throw signal.reason || new Error('请求已取消');
  const headers = new Headers(init.headers || {});
  let body = null;
  if (init.body != null) {
    if (typeof init.body === 'string' || Buffer.isBuffer(init.body) || init.body instanceof Uint8Array) body = Buffer.from(init.body);
    else {
      // Response only encodes the body here; it never sends a browser request.
      const encoded = new Response(init.body);
      body = Buffer.from(await encoded.arrayBuffer());
      if (!headers.has('content-type') && encoded.headers.has('content-type')) headers.set('content-type', encoded.headers.get('content-type'));
    }
    headers.set('content-length', String(body.length));
  }
  if (signal?.aborted) throw signal.reason || new Error('请求已取消');
  return new Promise((resolve, reject) => {
    let timer;
    const request = transport.request(target, { method: init.method || 'GET', headers: Object.fromEntries(headers) });
    const abort = () => request.destroy(signal.reason || new Error('请求已取消'));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const fail = error => { cleanup(); reject(error); };
    request.on('error', fail);
    request.on('response', response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', fail);
      response.on('end', () => {
        cleanup();
        const bytes = Buffer.concat(chunks);
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) if (value != null) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          headers: responseHeaders,
          text: async () => bytes.toString('utf8'),
          json: async () => JSON.parse(bytes.toString('utf8')),
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        });
      });
    });
    timer = setTimeout(() => request.destroy(Object.assign(new Error('ComfyUI 网络请求超时'), { code: 'ETIMEDOUT' })), Number(init.timeoutMs) || 60000);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else request.end(body);
  });
}

module.exports = { nodeFetch };
