/**
 * 最小 SOCKS5 客户端（RFC 1928），零依赖。
 *
 * 只实现两种报文：
 *  1. 协商（greeting）：客户端提议方法列表 → 服务端选定（无认证 = 0x00）
 *  2. CONNECT 请求：以「域名」方式请求连接目标（远程 DNS，等同 socks5h 语义，
 *     由代理端解析域名，规避本地 DNS 污染）
 *
 * 返回已连通的裸 TCP socket；调用方（provider）负责在其上做 TLS/HTTP。
 */
import net from 'node:net';
/** SOCKS5 服务端拒绝 CONNECT 时返回的状态码含义（RFC 1928 §6）。 */
const REPLY_CODES = {
    0x01: 'general SOCKS server failure',
    0x02: 'connection not allowed by ruleset',
    0x03: 'network unreachable',
    0x04: 'host unreachable',
    0x05: 'connection refused',
    0x06: 'TTL expired',
    0x07: 'command not supported',
    0x08: 'address type not supported',
};
/** 将 SOCKS5 状态码转成人类可读错误文本。 */
function replyText(code) {
    return REPLY_CODES[code] ?? `unknown reply code 0x${code.toString(16)}`;
}
/**
 * 通过 SOCKS5 代理建立到目标的隧道。
 *
 * @param targetHost - 目标主机名（由代理端解析）。
 * @param targetPort - 目标端口。
 * @param opts - 代理地址与超时。
 * @returns 已通过代理连通目标的裸 socket（未做 TLS）。
 * @throws Error 握手失败、被拒绝或超时（消息含代理信息，便于排查）。
 */
export function openSocks5Tunnel(targetHost, targetPort, opts) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let buffer = Buffer.alloc(0);
        let stage = 'greeting';
        const socket = net.connect({ host: opts.host, port: opts.port });
        const timer = setTimeout(() => {
            socket.destroy();
            fail(new Error(`SOCKS5 proxy ${opts.host}:${opts.port} connect timed out after ${opts.connectTimeoutMs}ms`));
        }, opts.connectTimeoutMs);
        function fail(error) {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            socket.off('data', onData);
            socket.off('error', onError);
            socket.off('close', onClose);
            reject(error);
        }
        function succeed() {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            socket.off('data', onData);
            socket.off('error', onError);
            socket.off('close', onClose);
            resolve(socket);
        }
        function onData(chunk) {
            buffer = Buffer.concat([buffer, chunk]);
            try {
                if (stage === 'greeting') {
                    // 期待 [VER=5, METHOD]
                    if (buffer.length < 2)
                        return;
                    const ver = buffer[0];
                    const method = buffer[1];
                    if (ver !== 0x05)
                        throw new Error(`SOCKS5 proxy ${opts.host}:${opts.port} replied with unsupported version ${ver}`);
                    if (method === 0xff)
                        throw new Error(`SOCKS5 proxy ${opts.host}:${opts.port} requires authentication, which this plugin does not support`);
                    if (method !== 0x00)
                        throw new Error(`SOCKS5 proxy ${opts.host}:${opts.port} selected unsupported auth method 0x${method.toString(16)}`);
                    buffer = buffer.subarray(2);
                    stage = 'connect';
                    // CONNECT 请求：CMD=1, RSV=0, ATYP=3(域名)
                    const hostBuf = Buffer.from(targetHost, 'utf8');
                    if (hostBuf.length > 255)
                        throw new Error(`target hostname too long: ${targetHost}`);
                    socket.write(Buffer.concat([
                        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
                        hostBuf,
                        Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
                    ]));
                    return;
                }
                // CONNECT 响应：固定头 4 字节 + 可变地址
                if (buffer.length < 4)
                    return;
                const ver = buffer[0];
                const rep = buffer[1];
                if (ver !== 0x05)
                    throw new Error(`SOCKS5 proxy ${opts.host}:${opts.port} replied with unsupported version ${ver}`);
                if (rep !== 0x00)
                    throw new Error(`SOCKS5 proxy ${opts.host}:${opts.port} refused connection to ${targetHost}:${targetPort}: ${replyText(rep)}`);
                // 跳过 BND.ADDR（按 ATYP 变长）与 BND.PORT(2)
                const atyp = buffer[3];
                let addrLen;
                if (atyp === 0x01)
                    addrLen = 4;
                else if (atyp === 0x03)
                    addrLen = buffer[4];
                else if (atyp === 0x04)
                    addrLen = 16;
                else
                    throw new Error(`SOCKS5 proxy ${opts.host}:${opts.port} returned unknown address type 0x${atyp.toString(16)}`);
                const headerLen = 4 + (atyp === 0x03 ? 1 : 0) + addrLen + 2;
                if (buffer.length < headerLen)
                    return;
                succeed();
            }
            catch (error) {
                socket.destroy();
                fail(error instanceof Error ? error : new Error(String(error)));
            }
        }
        function onError(error) {
            fail(new Error(`SOCKS5 proxy ${opts.host}:${opts.port} connection failed: ${error.message}`));
        }
        function onClose() {
            fail(new Error(`SOCKS5 proxy ${opts.host}:${opts.port} closed before handshake completed`));
        }
        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('close', onClose);
        // 1) 协商：版本5，提供 1 种认证方法（0x00 无认证）
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
}
