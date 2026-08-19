/**
 * HttpProxyFetchProvider — 通过本地 SOCKS5 代理抓取 HTTP(S) 的
 * `WebFetchProvider` 实现（注册 id: `http-proxy`）。
 *
 * 与官方 @deepseek-ai/dsh-web-fetch-http 的 HttpFetchProvider 对齐：
 *  - 同样做 URL 校验、同源重定向跟随、字节/字符上限、字符集解码
 *  - 不同点：传输层走 socks5 隧道（net + tls，零依赖），TLS 用 Node OpenSSL
 *  - 可配置 fallbackToDirect：代理不可达时回退到直连（Node 全局 fetch）
 */
import tls from 'node:tls';
import { WebError } from '@deepseek-ai/dsh-web';
import { openSocks5Tunnel } from "./socks5.js";
import { classifyContentType, decoderForCharset, isSameOrigin, parseCharset, parseStatusLine, validateFetchUrl, } from "./policy.js";
/** 本 provider 注册用的稳定 id。 */
export const PROXY_FETCH_PROVIDER_ID = 'http-proxy';
/** HTTP 重定向状态码。 */
function isRedirectStatus(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
/** 解析（可能相对的）Location。 */
function resolveRedirect(location, base) {
    try {
        return new URL(location, base);
    }
    catch (error) {
        throw new WebError(`invalid redirect Location "${location}"`, 'WEB_PROVIDER_ERROR', { cause: error });
    }
}
/** 从原始响应里取单个响应头（键不区分大小写）。 */
function headerOf(headers, name) {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === lower)
            return value;
    }
    return null;
}
export class HttpProxyFetchProvider {
    id = PROXY_FETCH_PROVIDER_ID;
    limits;
    constructor(limits) {
        this.limits = limits;
    }
    /** 无凭据的公开抓取器，恒可用（代理是否活着由 fetch 阶段失败快速暴露）。 */
    available() {
        return true;
    }
    async fetch(request, signal) {
        if (signal?.aborted)
            throw new WebError('web fetch aborted', 'WEB_ABORTED');
        const url = validateFetchUrl(request.url, 2048);
        // 单一 deadline 同时约束连接、TLS、重定向与读体；外部 signal 同样中止一切。
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, this.limits.timeoutMs);
        const onExternalAbort = () => controller.abort();
        signal?.addEventListener('abort', onExternalAbort, { once: true });
        try {
            return await this.followAndRead(url, controller.signal);
        }
        catch (error) {
            if (controller.signal.aborted) {
                if (timedOut)
                    throw new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: error });
                throw new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error });
            }
            throw error;
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onExternalAbort);
        }
    }
    /** 同源重定向循环：追到非重定向响应为止，然后解码为 WebFetchResult。 */
    async followAndRead(url, signal) {
        let current = url;
        let redirects = 0;
        for (;;) {
            const raw = await this.requestOnce(current, signal);
            if (isRedirectStatus(raw.status)) {
                if (redirects >= this.limits.maxRedirects) {
                    throw new WebError(`exceeded the maximum of ${this.limits.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED');
                }
                const location = headerOf(raw.headers, 'location');
                if (location === null) {
                    throw new WebError(`redirect response (HTTP ${raw.status}) without a Location header`, 'WEB_PROVIDER_ERROR');
                }
                const target = resolveRedirect(location, current);
                if (!isSameOrigin(target, current)) {
                    throw new WebError(`cross-origin redirect to ${target.origin} is not followed automatically; retry against that URL directly`, 'WEB_REDIRECT_BLOCKED');
                }
                current = target;
                redirects++;
                continue;
            }
            return this.decodeBody(raw, current);
        }
    }
    /** 传输层：优先走 SOCKS5 隧道；代理失败且允许直连时回退全局 fetch。 */
    async requestOnce(url, signal) {
        if (signal.aborted)
            throw new WebError('web fetch aborted', 'WEB_ABORTED');
        try {
            return await this.requestViaProxy(url, signal);
        }
        catch (error) {
            if (error instanceof WebError && error.code === 'WEB_PROXY_ERROR' && this.limits.fallbackToDirect) {
                return await this.requestDirect(url, signal);
            }
            throw error;
        }
    }
    /** 通过 SOCKS5 隧道 + (可选) TLS 发送 GET，读回原始响应。 */
    async requestViaProxy(url, signal) {
        const isHttps = url.protocol === 'https:';
        const port = Number(url.port) || (isHttps ? 443 : 80);
        let socket;
        try {
            socket = await openSocks5Tunnel(url.hostname, port, {
                host: this.limits.proxyHost,
                port: this.limits.proxyPort,
                connectTimeoutMs: this.limits.connectTimeoutMs,
            });
        }
        catch (error) {
            throw new WebError(`web fetch failed: ${String(error)}`, 'WEB_PROXY_ERROR', { cause: error });
        }
        const abortSocket = () => { socket.destroy(); };
        signal.addEventListener('abort', abortSocket, { once: true });
        try {
            // HTTPS：在 SOCKS 隧道之上做 TLS（Node 用 OpenSSL，沙箱/平台 schannel 问题不存在）
            const wire = isHttps
                ? tls.connect({ socket, servername: url.hostname })
                : socket;
            if (isHttps) {
                try {
                    await new Promise((resolve, reject) => {
                        wire.once('secureConnect', resolve);
                        wire.once('error', reject);
                        if (signal.aborted) {
                            wire.destroy();
                            reject(new WebError('web fetch aborted', 'WEB_ABORTED'));
                        }
                    });
                }
                catch (error) {
                    throw new WebError(`web fetch failed: TLS handshake to ${url.hostname} failed`, 'WEB_PROVIDER_ERROR', { cause: error });
                }
            }
            const path = url.pathname + url.search;
            const requestHead = [
                `GET ${path} HTTP/1.1`,
                `Host: ${url.hostname}${url.port ? `:${url.port}` : ''}`,
                `User-Agent: ${this.limits.userAgent}`,
                'Accept: text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
                'Connection: close',
                '',
                '',
            ].join('\r\n');
            wire.write(requestHead);
            return await this.readRaw(wire, signal);
        }
        finally {
            signal.removeEventListener('abort', abortSocket);
            socket.destroy();
        }
    }
    /** 直连回退：Node 全局 fetch（redirect: manual，语义与官方 http provider 一致）。 */
    async requestDirect(url, signal) {
        try {
            const response = await fetch(url, {
                method: 'GET',
                redirect: 'manual',
                headers: {
                    'user-agent': this.limits.userAgent,
                    'accept': 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
                },
                signal,
            });
            const headers = {};
            response.headers.forEach((value, key) => { headers[key] = value; });
            const declared = response.headers.get('content-length');
            let body;
            let bodyTruncated = false;
            if (declared !== null && Number(declared) > this.limits.maxResponseBytes) {
                await response.body?.cancel();
                throw new WebError(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE');
            }
            if (response.body === null) {
                body = Buffer.alloc(0);
            }
            else {
                const chunks = [];
                let total = 0;
                const reader = response.body.getReader();
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    const remaining = this.limits.maxResponseBytes - total;
                    if (value.byteLength > remaining) {
                        chunks.push(Buffer.from(value.subarray(0, remaining)));
                        total += remaining;
                        bodyTruncated = true;
                        break;
                    }
                    chunks.push(Buffer.from(value));
                    total += value.byteLength;
                }
                body = Buffer.concat(chunks);
            }
            return { status: response.status, headers, body, bodyTruncated };
        }
        catch (error) {
            if (signal.aborted)
                throw new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error });
            throw new WebError(`web fetch failed (direct fallback): ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
        }
    }
    /** 从隧道/TLS 流里读 HTTP 原始响应：头 + 体（字节上限截断）。 */
    async readRaw(wire, signal) {
        const chunks = [];
        let head = null;
        let status = 0;
        let headers = {};
        let body = Buffer.alloc(0);
        let bodyTruncated = false;
        let bodyStarted = false;
        let declaredLength = null;
        let sawError = null;
        try {
            for await (const chunk of wire) {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                if (head === null) {
                    // 找 \r\n\r\n 切分响应头
                    const acc = Buffer.concat([...chunks, buf]);
                    const idx = acc.indexOf('\r\n\r\n');
                    if (idx === -1) {
                        chunks.push(buf);
                        continue;
                    }
                    head = acc.subarray(0, idx).toString('latin1');
                    const [statusLine, ...headerLines] = head.split('\r\n');
                    status = parseStatusLine(statusLine);
                    headers = {};
                    for (const line of headerLines) {
                        const colon = line.indexOf(':');
                        if (colon > 0) {
                            const key = line.slice(0, colon).trim();
                            const value = line.slice(colon + 1).trim();
                            headers[key.toLowerCase()] = value;
                        }
                    }
                    const cl = headers['content-length'];
                    if (cl !== undefined && Number.isFinite(Number(cl)))
                        declaredLength = Number(cl);
                    if (declaredLength !== null && declaredLength > this.limits.maxResponseBytes) {
                        wire.destroy();
                        throw new WebError(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE');
                    }
                    bodyStarted = true;
                    const bodyPart = acc.subarray(idx + 4);
                    if (bodyPart.length > 0) {
                        const remaining = this.limits.maxResponseBytes;
                        if (bodyPart.length > remaining) {
                            body = Buffer.concat([body, bodyPart.subarray(0, remaining)]);
                            bodyTruncated = true;
                        }
                        else {
                            body = Buffer.concat([body, bodyPart]);
                        }
                    }
                }
                else {
                    const remaining = this.limits.maxResponseBytes - body.length;
                    if (buf.length > remaining) {
                        body = Buffer.concat([body, buf.subarray(0, remaining)]);
                        bodyTruncated = true;
                    }
                    else {
                        body = Buffer.concat([body, buf]);
                    }
                }
            }
        }
        catch (error) {
            sawError = error;
        }
        if (sawError !== null) {
            if (signal.aborted)
                throw new WebError('web fetch aborted', 'WEB_ABORTED', { cause: sawError });
            throw new WebError(`web fetch failed: ${String(sawError)}`, 'WEB_PROVIDER_ERROR', { cause: sawError });
        }
        if (head === null) {
            throw new WebError('web fetch failed: connection closed before any HTTP response', 'WEB_PROVIDER_ERROR');
        }
        return { status, headers, body, bodyTruncated };
    }
    /** 分类、解码、截断为 seam 的 WebFetchResult；非 2xx 也是结果而非错误。 */
    decodeBody(raw, finalUrl) {
        const contentType = headerOf(raw.headers, 'content-type');
        const kind = classifyContentType(contentType);
        if (kind === undefined) {
            throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE');
        }
        const decoder = decoderForCharset(parseCharset(contentType));
        const decoded = decoder.decode(raw.body);
        const truncatedByChars = decoded.length > this.limits.maxBodyChars;
        const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded;
        const body = kind === 'html' ? { kind: 'html', content } : { kind: 'text', content };
        return {
            url: finalUrl.toString(),
            statusCode: raw.status,
            body,
            truncated: raw.bodyTruncated || truncatedByChars,
        };
    }
}
