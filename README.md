# 听译 · Cloudflare Token 公开申请页

独立的 Cloudflare Worker 项目，同时托管网页和申请接口。访客无需注册账号：填写设备 ID（默认 `test`），完成 Turnstile 验证，申请并复制访问 Token。

**源码包不包含真实密钥。签名密钥只配置在 Worker 的 Secret 中，不发送到浏览器、不放入安装包。** 本项目没有修改现有听译客户端或 Windows 安装包。

## 1. 先看本地演示

安装 Node.js 22 或更高版本，在本目录打开终端：

```powershell
node scripts/preview.mjs
```

打开 <http://localhost:18809/>。点击「完成模拟验证」→「申请 Token」，可以检查填写、申请、复制、隐藏和清除功能。

这一步不需要安装依赖、不读取真实密钥、不连接真实 API。页面顶部明确标注演示模式；生成的 Token 不能用于翻译。关闭终端或按 `Ctrl+C` 停止演示。

## 2. 在 Cloudflare 创建 Worker 和 Turnstile

这一步需要你自己的 Cloudflare 账号。本项目交付时尚未发布到你的账号。

先在本目录执行：

```powershell
npm install
npx wrangler login
npm run check:deploy
npm run deploy
```

第一次发布时，密钥和 Turnstile 尚未配置，申请接口会保持关闭。终端会给出 `https://tingyi-token-portal.<你的子域>.workers.dev` 这样的地址。

进入 Cloudflare 控制台的 **Turnstile → Add widget**：

1. 填写名称，例如「听译 Token 申请」。
2. 添加刚发布的 Worker 域名，只填主机名，不带 `https://`、路径；例如 `tingyi-token-portal.example.workers.dev`。
3. 选择 Managed 模式，创建组件，得到 Site key 和 Secret key。
4. 如果改用自定义域名，也需要把该域名加入 Turnstile 的允许列表。

Site key 可以公开，Secret key 必须保密。生产代码会拒绝 Turnstile 官方的测试密钥。

> 你也可以把本项目作为一个独立的 Git 仓库，通过 Workers & Pages 的 Git 集成导入。保留 `wrangler.jsonc`，构建无需前端编译，部署命令使用 `npx wrangler deploy`。不要把父目录整个上传到 Git，那里有其他项目和真实密钥文件。

## 3. 配置设备和两个 Secret

编辑 `wrangler.jsonc` 的 `vars`，其中真实签名密钥不能写在这里：

| 变量 | 配置方法 |
| --- | --- |
| `API_BASE_URL` | 默认 `https://tm.goldoak.cn`。仅接受 HTTPS 根地址，无账号密码和查询参数。 |
| `PUBLIC_DEVICE_ID` | 表单默认设备，已按要求设置为 `test`。 |
| `PUBLIC_DEVICE_IDS` | 允许公开申请的设备名单，默认字符串 `"[\"test\"]"`。用户修改输入框后，仍需命中这个服务端名单。 |
| `APP_VERSION` / `DEVICE_VERSION` | 与现有 API 调用示例一致：`V0.2.8` / `1.3`。 |
| `TURNSTILE_SITE_KEY` | 上一步的公开 Site key。 |
| `PUBLIC_ORIGIN` | 建议填写最终完整 HTTPS 网址，例如 `https://token.example.com`，不要有末尾 `/`。为空时按当前访问网址做同源校验。 |

如需开放第二个设备，把 `PUBLIC_DEVICE_IDS` 改为 `"[\"test\",\"another-public-device\"]"`。每个设备都必须已在翻译后端绑定账号，并适合公开试用。不要把内部设备加入名单。

然后执行两次 Secret 配置命令，在终端提示下粘贴值，不要把密钥直接放入命令行参数：

```powershell
npx wrangler secret put DEVICE_SIGNING_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npm run deploy
```

- `DEVICE_SIGNING_KEY`：将你已有 `device_request_signing_key` 文件中的内容粘贴到提示中，不是文件路径。
- `TURNSTILE_SECRET_KEY`：填写 Turnstile 组件的 Secret key，不是 Site key。

也可以在 **Workers & Pages → 你的 Worker → Settings → Variables and Secrets → Add** 中添加。类型选 **Secret**，使用上述名称，保存并部署。不要选普通文本变量。

Wrangler 的 `secret put` 会发布一个版本；配置完成后再次执行 `npm run deploy`，以确保代码、普通变量和 Secret 一致。未满足配置、没有限流绑定或缺少安全验证时，接口不会签发 Token。

网站只会给访客返回所申请设备的 ID、`access_token` 和后端明确提供的有效时长。不会返回签名密钥、签名请求、API 内部错误或后端地址。

## 4. 上线前做一次真实验收

本地已执行模拟自动检查和 Worker 本地构建检查。真实 Cloudflare 验证、真实签发和客户端连接，需要在你配置账号及 Secret 后执行：

1. 访问 HTTPS 页面，确认设备 ID 默认是 `test`，且可以修改。
2. 完成真实 Turnstile 验证并申请。真实验证码需要你自己操作。
3. 将返回的设备 ID 和 Token 填入听译客户端设置，保存后开始翻译。
4. 填入一个未开放的设备 ID，应提示「此设备未开放公开申请」，不能领取 Token。
5. 连续快速申请应触发限流；刷新后 Token 不应保留，页面和网络响应中不应出现签名密钥。
6. 用两台设备各申请一次，确认后端允许同一设备 ID 的多份 Token 同时使用。如果后端签发新 Token 会撤销旧 Token，共享设备的访客会互相掉线；这种情况需先修改后端的 Token 会话策略或改成独立设备。

如果出现「申请设备暂不可用」，请先确认 `test` 在后端已绑定账号、可用且具备额度。网页不负责注册或绑定设备，因为目前已有 API 示例只提供鉴权接口。

## 公共试用的边界

用户选择了共享公开试用设备方案。领取者会获得这些公开设备的 API 权限并共享额度；隐藏签名密钥不会阻止合法领到 Token 的人调用 API。

- 真实 Token 的有效期、翻译权限、并发数、费用、额度和撤销由翻译后端控制，网页不会伪造或承诺有效期。建议为公开试用设备设置独立额度和权限。
- 当前使用 Cloudflare Turnstile + 两个限流绑定：每 IP 10 次/60 秒，站点 60 次/60 秒。规则在 `wrangler.jsonc` 中修改。公司/校园共享公网 IP 的人会共用 IP 限额。
- Cloudflare 的限流计数按其位置执行、采用近似计数，不是全球严格额度。后端仍需限制设备总额度。`namespace_id` 是你账号内自行分配的限流命名空间，若已有其他 Worker 使用 `173001` / `173002`，请改成两个未用的正整数，避免共享计数。
- 同源校验减少其他网站借浏览器调用接口，但不能代替身份认证或阻止直接脚本请求。这里的发放策略本来就是公开申请。
- Token 仅保留在页面内存，不使用 localStorage、Cookie 或下载文件。清除按钮不会撤销已签发 Token，也不会清除系统剪贴板或客户端已保存的凭证。
- 页面会加载 Cloudflare Turnstile。申请时 Cloudflare 会收到验证码和请求 IP；翻译后端会收到设备鉴权请求。没有额外统计或广告脚本。
- 不记录 Token 或签名，Worker 请求观测默认关闭。不要自行添加输出 Token/请求体的日志。

## 调用链与文件

```text
浏览器：设备 ID + 一次性验证码
  → 同源 Worker /api/token
  → 校验公开设备名单、限流、Turnstile hostname 和 action
  → Worker 使用 Secret 计算 HMAC-SHA256
  → POST API_BASE_URL/api/v1/auth
  → 仅将 device_id 和 access_token 返回浏览器
```

签名与现有客户端一致：UTF-8 编码 `device_id|app_version|device_version|timestamp|nonce`，用 `DEVICE_SIGNING_KEY` 计算 HMAC-SHA256，输出小写十六进制。nonce 使用 5 字节随机数，timestamp 为 Unix 秒。仅 Worker 与翻译后端持有签名密钥。

| 路径 | 用途 |
| --- | --- |
| `src/worker.mjs` | 生产接口、签名、验证码校验、限流及安全响应头。 |
| `public/` | 公共 HTML/CSS/JS/图标，共 4 个静态资源。 |
| `wrangler.jsonc` | Worker、静态资源和限流部署配置；不含 Secret。 |
| `scripts/preview.mjs` | 仅本地模拟预览，不部署到 Worker。 |
| `tests/worker.test.mjs` | 协议、安全和异常分支的离线测试。 |
| `.dev.vars.example` | 本地 Wrangler 调试的占位示例，禁止填写后提交仓库。 |

离线测试：`node --test`。部署构建检查：`npm run check:deploy`，不发布网站。

## 官方资料

- [Workers 入门](https://developers.cloudflare.com/workers/get-started/dashboard/)
- [静态页面与 Worker 同时部署](https://developers.cloudflare.com/workers/static-assets/)
- [Secret 配置与部署行为](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Turnstile 服务端校验](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [限流绑定及其计数范围](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
