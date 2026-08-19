/**
 * SOCKS5 + Node TLS 原型验证（插件一 socks5-proxy 的核心难点）
 *
 * 目标：用 Node 内置 net + tls（OpenSSL，不受沙箱 schannel 问题影响）
 * 通过本地 SOCKS5 代理（ssh -D 8081 → 瑞士服务器）抓取被墙站点。
 *
 * 运行：node socks5-fetch.mjs <url>
 * 示例：node socks5-fetch.mjs https://en.wikipedia.org/wiki/OpenAI
 *
 * 说明：本文件是纯 JS 原型，验证通过后再移植为插件里的 TypeScript 模块。
 */
import net from 'node:net'
import tls from 'node:tls'

const PROXY_HOST = process.env.PROXY_HOST || '127.0.0.1'
const PROXY_PORT = Number(process.env.PROXY_PORT || 8081)

/** RFC 1928 SOCKS5 CONNECT（远程 DNS，等同 socks5h 语义） */
function socks5Connect(socket, host, port) {
  return new Promise((resolve, reject) => {
    let stage = 0
    let buffer = Buffer.alloc(0)

    // 1) 协商：版本5，提供1种认证方法（0x00 无认证）
    socket.write(Buffer.from([0x05, 0x01, 0x00]))

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (stage === 0) {
        if (buffer.length < 2) return
        const [ver, method] = buffer
        if (ver !== 5 || method !== 0) return reject(new Error(`SOCKS5 协商失败: ver=${ver} method=${method}`))
        stage = 1
        buffer = buffer.subarray(2)
        // 发送 CONNECT 请求：域名方式
        const hostBuf = Buffer.from(host, 'utf8')
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
          hostBuf,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ])
        socket.write(req)
      } else if (stage === 1) {
        if (buffer.length < 10) return
        const ver = buffer[0]
        const rep = buffer[1]
        if (ver !== 5) return reject(new Error(`SOCKS5 响应版本错误: ${ver}`))
        if (rep !== 0) return reject(new Error(`SOCKS5 CONNECT 被拒绝: 状态码 ${rep}`))
        // 跳过 BND.ADDR/BND.PORT
        let addrLen
        switch (buffer[3]) {
          case 0x01: addrLen = 4; break
          case 0x03: addrLen = buffer[4]; break
          case 0x04: addrLen = 16; break
          default: return reject(new Error(`SOCKS5 地址类型错误: ${buffer[3]}`))
        }
        const total = 4 + (buffer[3] === 0x03 ? 1 : 0) + addrLen + 2
        if (buffer.length < total) return
        socket.off('data', onData)
        resolve()
      }
    }
    socket.on('data', onData)
  })
}

async function fetchViaProxy(url) {
  const u = new URL(url)
  const isHttps = u.protocol === 'https:'
  const port = Number(u.port) || (isHttps ? 443 : 80)

  const socket = net.connect({ host: PROXY_HOST, port: PROXY_PORT })
  await new Promise((res, rej) => { socket.once('connect', res); socket.once('error', rej) })

  // 通过 SOCKS5 隧道连到目标
  await socks5Connect(socket, u.hostname, port)
  console.error(`# SOCKS5 隧道已建立: ${u.hostname}:${port} via ${PROXY_HOST}:${PROXY_PORT}`)

  // HTTPS 在隧道之上做 TLS（Node 用 OpenSSL，schannel 问题不存在）
  const tlsSocket = isHttps
    ? tls.connect({ socket, servername: u.hostname })
    : socket
  if (isHttps) {
    await new Promise((res, rej) => { tlsSocket.once('secureConnect', res); tlsSocket.once('error', rej) })
    console.error('# TLS 握手完成')
  }

  // 发送 HTTP/1.1 GET
  const path = u.pathname + u.search
  const req = [
    `GET ${path} HTTP/1.1`,
    `Host: ${u.hostname}`,
    'User-Agent: socks5-proto-test/0.1 (node)',
    'Accept: text/html,text/plain,*/*',
    'Connection: close',
    '',
    '',
  ].join('\r\n')
  tlsSocket.write(req)

  // 收响应（上限 2MB）
  const chunks = []
  let total = 0
  for await (const chunk of tlsSocket) {
    chunks.push(chunk)
    total += chunk.length
    if (total > 2_000_000) { tlsSocket.destroy(); break }
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  const [head, ...bodyParts] = raw.split('\r\n\r\n')
  const statusLine = head.split('\r\n')[0]
  console.error(`# ${statusLine}`)
  console.log(bodyParts.join('\r\n\r\n'))
}

const url = process.argv[2]
if (!url) { console.error('用法: node socks5-fetch.mjs <url>'); process.exit(1) }
fetchViaProxy(url).catch((e) => { console.error('失败:', e.message); process.exit(1) })
