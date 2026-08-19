# dsh-socks5-proxy

让 DSH 的 `web_fetch` 工具通过**本地 SOCKS5 代理**抓取网页——解决"外网学习资源访问不了"的问题。零运行时依赖（只用 Node 内置 `net`/`tls` 和宿主提供的 `@deepseek-ai/*`）。

## 原理

```
模型 ── web_fetch 工具（DSH 自带，需在预设里开启）
        └─▶ ctx.web 服务（DSH 的 web 能力接缝）
              └─▶ http-proxy provider（← 本插件注册）
                    └─▶ SOCKS5 隧道（如 ssh -D 8081 → 瑞士服务器）
                          └─▶ 目标网站
```

- 本插件 = 一台"发动机"；`web_fetch` 是 DSH 造好的"车"，我们没造车，只是装了发动机并告诉系统用它。
- HTTPS 走隧道时在 SOCKS 之上做 TLS（Node 的 OpenSSL 实现，与平台 schannel 无关）。

## 前置条件

- DeepSeek Harness（含 `dsh` CLI）
- 一个本地 SOCKS5 代理，例如 SSH 动态隧道：
  ```sh
  ssh -D 8081 用户名@你的服务器
  ```
  或任何 SOCKS5 代理（Clash/v2rayN 等，改 `proxyPort` 即可）。

## 安装（GitHub）

```sh
dsh plugin --profile web add github:zhaopw5/dsh-socks5-proxy#<commit号>
```

仓库地址：https://github.com/zhaopw5/dsh-socks5-proxy

> 本仓库的 `lib/`（构建产物）已提交，**无需构建脚本**，因此不会触发 pnpm 的
> `allowBuilds` 批准——安装即用。

## 使用（两步）

### 1. 开启 `web_fetch` 工具

默认部署里 `web_fetch` 是关闭的（工具由 agent 预设提供）。两种做法任选：

- **推荐**：在设置页把会话预设复制一份（或直接编辑你的预设 `agent.cordis.yml`），
  把 `tool-web` 行的 `fetch` 改为 `true`：

  ```yaml
  - id: tool-web
    name: '@deepseek-ai/dsh-tool-web'
    config:
      fetch: true
      searchTimeoutMs: 60000
  ```

- 改完**重启 dsh web**，并**新建会话**（已产生内容的会话锁定在旧预设）。

### 2.（可选）钉选 provider

如果本插件是部署里**唯一**的 fetch provider，`ctx.web` 会自动选中它，无需配置。
若部署里还有其他 fetch provider，请在**你的** profile patch（`$DSH_HOME/profiles/web/cordis.patch.yml`）
里显式钉选（注意：覆盖行要**重写整行 config**）：

```yaml
- id: web
  config:
    searchProvider: <你原有的搜索 provider，如 deepseek-official>
    fetchProvider: http-proxy
```

### 验证

新建会话，让模型执行：

> 用 web_fetch 工具抓取 https://en.wikipedia.org/wiki/OpenAI ，并总结第一段要点。

成功返回正文即 OK。也可不经过 harness 直接验证（需代理在跑）：

```sh
node test/headless-test.ts
```

## 配置项（在 cordis.yml 插件行里覆盖）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `proxyHost` | `127.0.0.1` | SOCKS5 代理地址 |
| `proxyPort` | `8081` | SOCKS5 代理端口 |
| `connectTimeoutMs` | `4000` | 代理连接+握手超时 |
| `timeoutMs` | `60000` | 单次抓取总超时 |
| `maxResponseBytes` | `5000000` | 响应体字节上限（超限截断） |
| `maxBodyChars` | `100000` | 解码后字符上限（超限截断） |
| `maxRedirects` | `5` | 同源重定向最大跳数 |
| `userAgent` | deepseek-harness UA | 请求 UA |
| `fallbackToDirect` | `false` | 代理不可达时回退直连（被墙站点直连仍会失败，但报错更明确） |
| `enabled` | `true` | `false` 时不注册 provider |

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 模型说没有 `web_fetch` 工具 | 预设里 `fetch` 未开，或会话不是新建的（旧会话锁定旧预设） |
| `WEB_PROXY_ERROR` / 抓取失败 | 代理没开。检查：`Test-NetConnection 127.0.0.1 -Port 8081`；重开 `ssh -D 8081` |
| 插件行加载报 `ERR_UNSUPPORTED_ESM_URL_SCHEME` | 本地路径必须写成 `file:///C:/...`，不要写裸 `C:/...`（详见下方"历史教训"） |
| 响应被截断 | 调大 `maxResponseBytes` / `maxBodyChars` |

## 卸载

```sh
dsh plugin --profile web remove dsh-socks5-proxy
```
或（本机手动装配时）删掉 profile patch 里的 `socks5-proxy` 行，重启。

## 开发与构建

```sh
npm run build        # tsc → lib/（产物随仓库提交，安装免构建）
npm test             # 无头测试（需代理在跑）
```

## 历史教训

- Windows 本地插件路径必须转成标准 file URL（`pathToFileURL(...).href`），
  不能只把 `\` 换成 `/`——否则 Node ESM loader 会把盘符当协议（`c:`）。
- 预设默认值改动要**重启**才进运行中进程（`--dump-config` 读的是文件不是进程）。

## 许可

MIT。`src/policy.ts` 的 URL 校验/内容分类语义移植自
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
的 `@deepseek-ai/dsh-web-fetch-http`（MIT）。
