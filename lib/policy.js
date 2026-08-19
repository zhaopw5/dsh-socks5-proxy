/**
 * URL 校验与内容类型分类——传输无关的纯函数层。
 *
 * 语义与 @deepseek-ai/dsh-web-fetch-http 的 policy.ts 保持一致
 * （该文件是其包内私有模块，未公开导出；此处按相同语义移植，
 *  并注明出处：deepseek-ai/deepseek-harness, MIT License）。
 */
import { WebError } from '@deepseek-ai/dsh-web';
/**
 * 校验请求 URL 的基本传输卫生：仅 http(s)、无内嵌凭据、长度有界。
 * （SSRF / 内网防护与官方 http provider 一致：暂不实现，见其 Agent Note。）
 */
export function validateFetchUrl(input, maxUrlLength) {
    if (input.length > maxUrlLength) {
        throw new WebError(`URL exceeds the maximum length of ${maxUrlLength}`, 'WEB_INVALID_URL');
    }
    let url;
    try {
        url = new URL(input);
    }
    catch (error) {
        throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL');
    }
    if (url.username.length > 0 || url.password.length > 0) {
        throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL');
    }
    return url;
}
/** scheme + hostname + port 全同才视为同源（跨源重定向一律拒绝，须重新发起工具调用）。 */
export function isSameOrigin(a, b) {
    return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
}
/** 把响应 Content-Type 归类为可解码的 html/text；不可解码（二进制等）返回 undefined。 */
export function classifyContentType(contentType) {
    const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase();
    if (mime === 'text/html' || mime === 'application/xhtml+xml')
        return 'html';
    if (mime.startsWith('text/'))
        return 'text';
    if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml'))
        return 'text';
    return undefined;
}
/** 提取 Content-Type 里的 charset 参数（小写），无则 undefined。 */
export function parseCharset(contentType) {
    const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '');
    return match?.[1]?.trim().toLowerCase();
}
/** 为声明（或默认 utf-8）的字符集构造 TextDecoder；未知字符集报错而不是乱码。 */
export function decoderForCharset(charset) {
    if (charset === undefined)
        return new TextDecoder('utf-8');
    try {
        return new TextDecoder(charset);
    }
    catch (error) {
        throw new WebError(`unsupported charset "${charset}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE', { cause: error });
    }
}
/** 解析 HTTP 状态行（HTTP/1.1 200 OK 等）。 */
export function parseStatusLine(line) {
    const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/.exec(line);
    if (!match)
        throw new WebError(`malformed HTTP status line: "${line}"`, 'WEB_PROVIDER_ERROR');
    return Number(match[1]);
}
