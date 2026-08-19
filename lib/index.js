import z from '@deepseek-ai/schemastery';
import { HttpProxyFetchProvider, PROXY_FETCH_PROVIDER_ID } from "./provider.js";
export { PROXY_FETCH_PROVIDER_ID, HttpProxyFetchProvider, } from "./provider.js";
/** Cordis 插件名（loader 诊断用）。 */
export const name = 'socks5-proxy';
/** 依赖 web 能力 seam：provider 注册进 ctx.web 的 fetch 注册表。 */
export const inject = ['web'];
export const Config = z.object({
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
});
/** 配置值必须是正有限数，否则加载期响亮失败。 */
function assertPositiveFinite(name, value) {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`socks5-proxy: ${name} must be a positive finite number`);
    }
}
export function apply(ctx, config) {
    if (config.enabled === false) {
        console.log('[socks5-proxy] disabled by config; not registering provider');
        return;
    }
    const resolved = config;
    assertPositiveFinite('connectTimeoutMs', resolved.connectTimeoutMs);
    assertPositiveFinite('timeoutMs', resolved.timeoutMs);
    assertPositiveFinite('maxResponseBytes', resolved.maxResponseBytes);
    assertPositiveFinite('maxBodyChars', resolved.maxBodyChars);
    if (!Number.isInteger(resolved.maxRedirects) || resolved.maxRedirects < 0) {
        throw new Error('socks5-proxy: maxRedirects must be a non-negative integer');
    }
    const limits = {
        proxyHost: resolved.proxyHost,
        proxyPort: resolved.proxyPort,
        connectTimeoutMs: resolved.connectTimeoutMs,
        timeoutMs: resolved.timeoutMs,
        maxResponseBytes: resolved.maxResponseBytes,
        maxBodyChars: resolved.maxBodyChars,
        maxRedirects: resolved.maxRedirects,
        userAgent: resolved.userAgent,
        fallbackToDirect: resolved.fallbackToDirect,
    };
    ctx.web.registerFetchProvider(new HttpProxyFetchProvider(limits));
    console.log(`[socks5-proxy] registered fetch provider "${PROXY_FETCH_PROVIDER_ID}" → socks5://${resolved.proxyHost}:${resolved.proxyPort} (fallbackToDirect=${resolved.fallbackToDirect})`);
}
