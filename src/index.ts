/**
 * socks5-proxy — 把 DSH 的 web_fetch 能力接到本地 SOCKS5 代理
 * （例如 `ssh -D 8081` 隧道），使被墙站点可抓。
 *
 * 角色：Web 能力 seam（ctx.web）的 Fetch Provider（与官方 web-fetch-http 同角色）。
 * 模型侧 `web_fetch` 工具零改动；只需在装配层把 fetchProvider 钉选为本插件：
 *
 *   - id: web
 *     config:
 *       searchProvider: deepseek-official
 *       fetchProvider: http-proxy
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { HttpProxyFetchProvider, PROXY_FETCH_PROVIDER_ID } from './provider.ts'
import type { ProxyFetchLimits } from './provider.ts'

export {
  PROXY_FETCH_PROVIDER_ID,
  HttpProxyFetchProvider,
} from './provider.ts'
export type { ProxyFetchLimits } from './provider.ts'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'socks5-proxy'

/** 依赖 web 能力 seam：provider 注册进 ctx.web 的 fetch 注册表。 */
export const inject = ['web']

/** 插件配置：代理地址、超时、大小上限、直连回退开关（全部有默认值）。 */
export interface Config {
  /** SOCKS5 代理地址。 */
  proxyHost?: string
  /** SOCKS5 代理端口。 */
  proxyPort?: number
  /** 代理连接 + 握手超时（毫秒）。 */
  connectTimeoutMs?: number
  /** 单次抓取总超时（毫秒）。 */
  timeoutMs?: number
  /** 最大响应体字节数。 */
  maxResponseBytes?: number
  /** 最大解码后字符数。 */
  maxBodyChars?: number
  /** 同源重定向最大跳数。 */
  maxRedirects?: number
  /** 请求 User-Agent。 */
  userAgent?: string
  /** 代理不可达时回退到直连。 */
  fallbackToDirect?: boolean
  /** 设为 false 时不注册 provider（回退到装配默认行为）。 */
  enabled?: boolean
}

export const Config: z<Config> = z.object({
  proxyHost: z.string().default('127.0.0.1'),
  proxyPort: z.number().default(8081),
  connectTimeoutMs: z.number().default(4000),
  timeoutMs: z.number().default(60_000),
  maxResponseBytes: z.number().default(5_000_000),
  maxBodyChars: z.number().default(100_000),
  maxRedirects: z.number().default(5),
  userAgent: z.string().default('deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)'),
  fallbackToDirect: z.boolean().default(false),
  enabled: z.boolean().default(true),
})

/** 配置值必须是正有限数，否则加载期响亮失败。 */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`socks5-proxy: ${name} must be a positive finite number`)
  }
}

export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) {
    console.log('[socks5-proxy] disabled by config; not registering provider')
    return
  }

  const resolved = config as Required<Config>
  assertPositiveFinite('connectTimeoutMs', resolved.connectTimeoutMs)
  assertPositiveFinite('timeoutMs', resolved.timeoutMs)
  assertPositiveFinite('maxResponseBytes', resolved.maxResponseBytes)
  assertPositiveFinite('maxBodyChars', resolved.maxBodyChars)
  if (!Number.isInteger(resolved.maxRedirects) || resolved.maxRedirects < 0) {
    throw new Error('socks5-proxy: maxRedirects must be a non-negative integer')
  }

  const limits: ProxyFetchLimits = {
    proxyHost: resolved.proxyHost,
    proxyPort: resolved.proxyPort,
    connectTimeoutMs: resolved.connectTimeoutMs,
    timeoutMs: resolved.timeoutMs,
    maxResponseBytes: resolved.maxResponseBytes,
    maxBodyChars: resolved.maxBodyChars,
    maxRedirects: resolved.maxRedirects,
    userAgent: resolved.userAgent,
    fallbackToDirect: resolved.fallbackToDirect,
  }

  ctx.web.registerFetchProvider(new HttpProxyFetchProvider(limits))
  console.log(`[socks5-proxy] registered fetch provider "${PROXY_FETCH_PROVIDER_ID}" → socks5://${resolved.proxyHost}:${resolved.proxyPort} (fallbackToDirect=${resolved.fallbackToDirect})`)
}
