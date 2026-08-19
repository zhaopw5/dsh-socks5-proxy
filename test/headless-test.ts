/**
 * 无头测试：不启动 dsh，直接实例化 HttpProxyFetchProvider 验证抓取逻辑。
 *
 * 运行（在 plugins/socks5-proxy 目录下）：
 *   node --import tsx test/headless-test.mjs
 *
 * 依赖：本目录下 node_modules 联接指向仓库 node_modules（供 @deepseek-ai/* 解析）。
 */
import { HttpProxyFetchProvider } from '../src/provider.ts'

const limits = {
  proxyHost: process.env.PROXY_HOST || '127.0.0.1',
  proxyPort: Number(process.env.PROXY_PORT || 8081),
  connectTimeoutMs: 4000,
  timeoutMs: 60000,
  maxResponseBytes: 2_000_000,
  maxBodyChars: 200_000,
  maxRedirects: 5,
  userAgent: 'socks5-proxy-headless-test/0.1',
  fallbackToDirect: false,
}

const provider = new HttpProxyFetchProvider(limits)

const targets = [
  'https://en.wikipedia.org/wiki/OpenAI', // 被墙站点（必须走代理）
  'https://arxiv.org/list/cs.CL/recent',  // 被墙站点（走代理 + 可能重定向）
  'http://example.com/',                  // 明文 HTTP（走隧道但无 TLS）
]

for (const url of targets) {
  try {
    const r = await provider.fetch({ url })
    console.log(`OK   ${url}\n     → HTTP ${r.statusCode} | ${r.body.kind} | ${r.body.content.length} chars | truncated=${r.truncated}`)
  } catch (e) {
    console.log(`FAIL ${url}\n     → ${e.constructor.name}: ${e.message}${e.code ? ` (code=${e.code})` : ''}`)
  }
}
