/**
 * HttpProxyFetchProvider — 通过本地 SOCKS5 代理抓取 HTTP(S) 的
 * `WebFetchProvider` 实现（注册 id: `http-proxy`）。
 *
 * 与官方 @deepseek-ai/dsh-web-fetch-http 的 HttpFetchProvider 对齐：
 *  - 同样做 URL 校验、同源重定向跟随、字节/字符上限、字符集解码
 *  - 不同点：传输层走 socks5 隧道（net + tls，零依赖），TLS 用 Node OpenSSL
 *  - 可配置 fallbackToDirect：代理不可达时回退到直连（Node 全局 fetch）
 */
import tls from 'node:tls'
import net from 'node:net'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchBody, WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { openSocks5Tunnel } from './socks5.ts'
import {
  classifyContentType,
  decoderForCharset,
  isSameOrigin,
  parseCharset,
  parseStatusLine,
  validateFetchUrl,
} from './policy.ts'

/** 本 provider 注册用的稳定 id。 */
export const PROXY_FETCH_PROVIDER_ID = 'http-proxy'

/** 解析后的 provider 限制（由插件入口的 schemastery Config 提供默认值）。 */
export interface ProxyFetchLimits {
  /** SOCKS5 代理地址。 */
  readonly proxyHost: string
  /** SOCKS5 代理端口。 */
  readonly proxyPort: number
  /** 代理连接 + 握手超时（毫秒）。 */
  readonly connectTimeoutMs: number
  /** 单次抓取总超时（毫秒）。 */
  readonly timeoutMs: number
  /** 最大响应体字节数（超限即截断并标记）。 */
  readonly maxResponseBytes: number
  /** 最大解码后字符数（超限即截断并标记）。 */
  readonly maxBodyChars: number
  /** 同源重定向最大跳数。 */
  readonly maxRedirects: number
  /** 请求 User-Agent。 */
  readonly userAgent: string
  /** 代理不可达时是否回退到直连（Node 全局 fetch）。 */
  readonly fallbackToDirect: boolean
}

/** 一次传输返回的原始响应（传输无关，供重定向循环与解码共用）。 */
interface RawResponse {
  readonly status: number
  readonly headers: Record<string, string>
  /** 已按 maxResponseBytes 截断的响应体（truncated 见 bodyTruncated）。 */
  readonly body: Buffer
  readonly bodyTruncated: boolean
}

/** HTTP 重定向状态码。 */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** 解析（可能相对的）Location。 */
function resolveRedirect(location: string, base: URL): URL {
  try {
    return new URL(location, base)
  } catch (error: unknown) {
    throw new WebError(`invalid redirect Location "${location}"`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

/** 从原始响应里取单个响应头（键不区分大小写）。 */
function headerOf(headers: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value
  }
  return null
}

export class HttpProxyFetchProvider implements WebFetchProvider {
  readonly id = PROXY_FETCH_PROVIDER_ID

  readonly limits: ProxyFetchLimits

  constructor(limits: ProxyFetchLimits) {
    this.limits = limits
  }

  /** 无凭据的公开抓取器，恒可用（代理是否活着由 fetch 阶段失败快速暴露）。 */
  available(): boolean {
    return true
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')

    const url = validateFetchUrl(request.url, 2048)

    // 单一 deadline 同时约束连接、TLS、重定向与读体；外部 signal 同样中止一切。
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.limits.timeoutMs)
    const onExternalAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onExternalAbort, { once: true })

    try {
      return await this.followAndRead(url, controller.signal)
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        if (timedOut) throw new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: error })
        throw new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
      }
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  /** 同源重定向循环：追到非重定向响应为止，然后解码为 WebFetchResult。 */
  private async followAndRead(url: URL, signal: AbortSignal): Promise<WebFetchResult> {
    let current = url
    let redirects = 0
    for (;;) {
      const raw = await this.requestOnce(current, signal)
      if (isRedirectStatus(raw.status)) {
        if (redirects >= this.limits.maxRedirects) {
          throw new WebError(`exceeded the maximum of ${this.limits.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
        }
        const location = headerOf(raw.headers, 'location')
        if (location === null) {
          throw new WebError(`redirect response (HTTP ${raw.status}) without a Location header`, 'WEB_PROVIDER_ERROR')
        }
        const target = resolveRedirect(location, current)
        if (!isSameOrigin(target, current)) {
          throw new WebError(
            `cross-origin redirect to ${target.origin} is not followed automatically; retry against that URL directly`,
            'WEB_REDIRECT_BLOCKED',
          )
        }
        current = target
        redirects++
        continue
      }
      return this.decodeBody(raw, current)
    }
  }

  /** 传输层：优先走 SOCKS5 隧道；代理失败且允许直连时回退全局 fetch。 */
  private async requestOnce(url: URL, signal: AbortSignal): Promise<RawResponse> {
    if (signal.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    try {
      return await this.requestViaProxy(url, signal)
    } catch (error: unknown) {
      if (error instanceof WebError && error.code === 'WEB_PROXY_ERROR' && this.limits.fallbackToDirect) {
        return await this.requestDirect(url, signal)
      }
      throw error
    }
  }

  /** 通过 SOCKS5 隧道 + (可选) TLS 发送 GET，读回原始响应。 */
  private async requestViaProxy(url: URL, signal: AbortSignal): Promise<RawResponse> {
    const isHttps = url.protocol === 'https:'
    const port = Number(url.port) || (isHttps ? 443 : 80)

    let socket: net.Socket
    try {
      socket = await openSocks5Tunnel(url.hostname, port, {
        host: this.limits.proxyHost,
        port: this.limits.proxyPort,
        connectTimeoutMs: this.limits.connectTimeoutMs,
      })
    } catch (error: unknown) {
      throw new WebError(`web fetch failed: ${String(error)}`, 'WEB_PROXY_ERROR', { cause: error })
    }

    const abortSocket = (): void => { socket.destroy() }
    signal.addEventListener('abort', abortSocket, { once: true })
    try {
      // HTTPS：在 SOCKS 隧道之上做 TLS（Node 用 OpenSSL，沙箱/平台 schannel 问题不存在）
      const wire = isHttps
        ? tls.connect({ socket, servername: url.hostname })
        : socket
      if (isHttps) {
        try {
          await new Promise<void>((resolve, reject) => {
            wire.once('secureConnect', resolve)
            wire.once('error', reject)
            if (signal.aborted) { wire.destroy(); reject(new WebError('web fetch aborted', 'WEB_ABORTED')) }
          })
        } catch (error: unknown) {
          throw new WebError(`web fetch failed: TLS handshake to ${url.hostname} failed`, 'WEB_PROVIDER_ERROR', { cause: error })
        }
      }

      const path = url.pathname + url.search
      const requestHead = [
        `GET ${path} HTTP/1.1`,
        `Host: ${url.hostname}${url.port ? `:${url.port}` : ''}`,
        `User-Agent: ${this.limits.userAgent}`,
        'Accept: text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
        'Connection: close',
        '',
        '',
      ].join('\r\n')
      wire.write(requestHead)

      return await this.readRaw(wire, signal)
    } finally {
      signal.removeEventListener('abort', abortSocket)
      socket.destroy()
    }
  }

  /** 直连回退：Node 全局 fetch（redirect: manual，语义与官方 http provider 一致）。 */
  private async requestDirect(url: URL, signal: AbortSignal): Promise<RawResponse> {
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': this.limits.userAgent,
          'accept': 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
        },
        signal,
      })
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => { headers[key] = value })
      const declared = response.headers.get('content-length')
      let body: Buffer
      let bodyTruncated = false
      if (declared !== null && Number(declared) > this.limits.maxResponseBytes) {
        await response.body?.cancel()
        throw new WebError(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
      }
      if (response.body === null) {
        body = Buffer.alloc(0)
      } else {
        const chunks: Buffer[] = []
        let total = 0
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const remaining = this.limits.maxResponseBytes - total
          if (value.byteLength > remaining) {
            chunks.push(Buffer.from(value.subarray(0, remaining)))
            total += remaining
            bodyTruncated = true
            break
          }
          chunks.push(Buffer.from(value))
          total += value.byteLength
        }
        body = Buffer.concat(chunks)
      }
      return { status: response.status, headers, body, bodyTruncated }
    } catch (error: unknown) {
      if (signal.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`web fetch failed (direct fallback): ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /** 从隧道/TLS 流里读 HTTP 原始响应：头 + 体（字节上限截断）。 */
  private async readRaw(wire: import('node:stream').Duplex, signal: AbortSignal): Promise<RawResponse> {
    const chunks: Buffer[] = []
    let head: string | null = null
    let status = 0
    let headers: Record<string, string> = {}
    let body: Buffer = Buffer.alloc(0)
    let bodyTruncated = false
    let bodyStarted = false
    let declaredLength: number | null = null
    let sawError: unknown = null

    try {
      for await (const chunk of wire as AsyncIterable<Buffer>) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (head === null) {
          // 找 \r\n\r\n 切分响应头
          const acc = Buffer.concat([...chunks, buf])
          const idx = acc.indexOf('\r\n\r\n')
          if (idx === -1) {
            chunks.push(buf)
            continue
          }
          head = acc.subarray(0, idx).toString('latin1')
          const [statusLine, ...headerLines] = head.split('\r\n')
          status = parseStatusLine(statusLine)
          headers = {}
          for (const line of headerLines) {
            const colon = line.indexOf(':')
            if (colon > 0) {
              const key = line.slice(0, colon).trim()
              const value = line.slice(colon + 1).trim()
              headers[key.toLowerCase()] = value
            }
          }
          const cl = headers['content-length']
          if (cl !== undefined && Number.isFinite(Number(cl))) declaredLength = Number(cl)
          if (declaredLength !== null && declaredLength > this.limits.maxResponseBytes) {
            wire.destroy()
            throw new WebError(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
          }
          bodyStarted = true
          const bodyPart = acc.subarray(idx + 4)
          if (bodyPart.length > 0) {
            const remaining = this.limits.maxResponseBytes
            if (bodyPart.length > remaining) {
              body = Buffer.concat([body, bodyPart.subarray(0, remaining)])
              bodyTruncated = true
            } else {
              body = Buffer.concat([body, bodyPart])
            }
          }
        } else {
          const remaining = this.limits.maxResponseBytes - body.length
          if (buf.length > remaining) {
            body = Buffer.concat([body, buf.subarray(0, remaining)])
            bodyTruncated = true
          } else {
            body = Buffer.concat([body, buf])
          }
        }
      }
    } catch (error: unknown) {
      sawError = error
    }

    if (sawError !== null) {
      if (signal.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED', { cause: sawError })
      throw new WebError(`web fetch failed: ${String(sawError)}`, 'WEB_PROVIDER_ERROR', { cause: sawError })
    }
    if (head === null) {
      throw new WebError('web fetch failed: connection closed before any HTTP response', 'WEB_PROVIDER_ERROR')
    }
    return { status, headers, body, bodyTruncated }
  }

  /** 分类、解码、截断为 seam 的 WebFetchResult；非 2xx 也是结果而非错误。 */
  private decodeBody(raw: RawResponse, finalUrl: URL): WebFetchResult {
    const contentType = headerOf(raw.headers, 'content-type')
    const kind = classifyContentType(contentType)
    if (kind === undefined) {
      throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }
    const decoder = decoderForCharset(parseCharset(contentType))
    const decoded = decoder.decode(raw.body)
    const truncatedByChars = decoded.length > this.limits.maxBodyChars
    const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded
    const body: WebFetchBody = kind === 'html' ? { kind: 'html', content } : { kind: 'text', content }
    return {
      url: finalUrl.toString(),
      statusCode: raw.status,
      body,
      truncated: raw.bodyTruncated || truncatedByChars,
    }
  }
}
