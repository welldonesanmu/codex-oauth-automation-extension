# 多页面自动化

一个基于 Chromium Manifest V3 的侧边栏扩展，用于自动执行 Codex / ChatGPT OAuth 注册与授权流程。

当前版本为 `v2.0.2`。扩展以侧边栏为主控，支持 10 步单步执行、整套自动运行、停止当前流程、按浏览器窗口隔离运行状态，并集成 Duck Mail / SimpleLogin / Addy.io 邮箱生成，以及 QQ / 163 邮箱验证码读取。

## 当前能力

- 支持 **10 步**主流程，既可单步执行，也可整套 `Auto` 运行
- 支持 **按浏览器 window 隔离**状态、标签页注册和自动运行上下文
- 支持 **Stop** 中断当前流程，支持 **Reset** 清空当前流程状态
- 支持 `继续当前` / `重新开始` 两种自动运行入口
- 支持 **跳过步骤**，便于手动接管异常流程
- Step 1 / Step 7 会从 CPA 面板获取或刷新最新 OAuth 链接
- Step 3 会把注册页切回前台填写密码并提交，降低超时概率
- Step 4 / Step 8 会分别轮询注册验证码与登录验证码
- Step 8 验证码填写与继续动作带有人类化停顿
- Step 8 遇到 `405 Method Not Allowed / Try again` 异常页时，会先点击“重试”恢复；如果恢复成功，则直接等待验证码，不再额外点击“重新发送电子邮件”
- Step 9 会自动处理 OAuth 同意页“继续”并监听本地回调
- Step 10 会校验并提交 Step 9 捕获到的回调地址，确认 CPA 面板返回 `认证成功！`

## 邮箱相关

当前版本把“注册邮箱生成”和“验证码邮箱读取”拆成两个独立配置：

- `Email Generation Service`：决定 **Step 2 注册邮箱来源**
- `Mail Provider`：决定 **Step 4 / Step 8 验证码邮箱来源**

### Step 2 注册邮箱来源

支持：

- `Duck Mail`
- `SimpleLogin`
- `Addy.io`

其中：

- `Duck Mail`：通过 DuckDuckGo Email Protection 页面自动生成 `@duck.com` 地址
- `SimpleLogin`：通过 SimpleLogin aliases 页面获取或创建邮箱
- `Addy.io`：通过 Addy aliases 页面获取或创建邮箱

### Addy.io 专用配置

仅当 `Email Generation Service = Addy.io` 时显示：

- `Recipients`
- `Alias Domain`

这两个值都会按你在侧边栏里的输入 **原样透传** 到 Addy 的 `Create Alias` 弹窗中：

- `Recipients`：用于 Addy 的收件人字段
- `Alias Domain`：用于 Addy 的域名字段

如果 `Alias Domain` 留空，则不会额外处理这个字段，直接按 Addy 默认行为创建 alias。

### 验证码邮箱来源

支持：

- `163 邮箱`
- `QQ 邮箱`

## 10 步流程

1. `打开 ChatGPT 官网`
2. `注册并输入邮箱`
3. `填写密码并继续`
4. `获取注册验证码`
5. `填写姓名和生日`
6. `清理登录 Cookies`
7. `刷新 OAuth 并登录`
8. `获取登录验证码`
9. `自动确认 OAuth`
10. `平台回调验证`

## 自动运行

点击侧边栏右上角 `自动` 后，扩展会按顺序执行整套 10 步流程。

支持：

- 多轮自动运行（`1 ~ 50` 轮）
- 中途停止
- 检测到已有进度时选择 `继续当前` 或 `重新开始`
- 当前轮失败后根据策略停止，或丢弃当前线程后新开一轮补足目标次数

### 自动获取邮箱

自动运行在进入 Step 2 前会优先自动获取当前生成服务的邮箱。

当前逻辑：

- 每轮最多自动获取 **5 次**
- 获取成功后直接继续后续步骤
- 获取连续失败时，这一轮会按当前自动运行策略处理：
  - 未勾选 `兜底`：停止本次自动运行
  - 已勾选 `兜底`：放弃当前线程并新开一轮，直到补足目标运行次数或达到安全重试上限

### 自动运行兜底

勾选侧边栏中的 `兜底` 后：

- 如果某一轮出现无法继续的错误，后台会直接放弃当前线程
- 然后新开一轮继续补足目标次数
- 不是在当前页面里硬继续，而是重置当前轮流程状态后重新开始

### 单轮超时

为避免某一步长期卡死，自动运行带有单轮总超时控制：

- 单轮上限：**3 分 30 秒**
- 仅在以下任一条件满足时启用：
  - 勾选了 `兜底`
  - 自动运行总轮次大于 `1`

如果超时，会放弃当前线程并按自动运行策略处理。

## 侧边栏配置

### CPA

你的 CPA 管理面板 OAuth 页面地址，例如：

```txt
http(s)://<your-host>/management.html#/oauth
```

Step 1 / Step 7 / Step 10 都依赖这个地址。

### 管理密钥

CPA 面板登录所需的管理密钥。

扩展会在打开 CPA 管理页后自动填写该值，并进入 OAuth 管理页面。

### 收码邮箱

验证码邮箱来源：

- `163`
- `QQ`

### 生成服务

Step 2 使用的注册邮箱生成服务：

- `Duck Mail`
- `SimpleLogin`
- `Addy.io`

### Recipients / Alias Domain

仅当 `生成服务 = Addy.io` 时显示。

- `Recipients`：原样透传到 Addy.io `Create Alias` 弹窗中的 `Recipients`
- `Alias Domain`：原样透传到 Addy.io `Create Alias` 弹窗中的 `Alias Domain`

### 邮箱

当前轮使用的注册邮箱。

来源有两种：

- 手动粘贴
- 点击 `获取`，由当前 `生成服务` 自动获取

### 密码

- 留空：自动生成强密码
- 手动输入：使用自定义密码

### 兜底

当自动运行某一轮出现错误且无法继续时：

- 不勾选：直接停止自动运行
- 勾选：放弃当前线程并新开一轮，继续补足目标次数

## 安装

1. 打开浏览器扩展页面
   - Edge：`edge://extensions/`
   - Chrome：`chrome://extensions/`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择本项目目录
5. 打开扩展侧边栏开始使用

## 关键行为说明

### Step 1：打开 ChatGPT 官网 / 获取 OAuth 链路

- 会先打开或复用 CPA 面板页
- 如需要，会自动填写 `管理密钥` 并进入 OAuth 管理页
- 会读取当前显示的授权链接，作为后续 OAuth 登录链路的来源

### Step 2：注册并输入邮箱

- 在 ChatGPT 页面查找 `Sign up / Register / 创建账户` 按钮
- 使用当前侧边栏邮箱，或先从当前 `生成服务` 自动获取邮箱
- 自动填写注册邮箱并继续

### Step 3：填写密码并继续

- 使用自定义密码或自动生成强密码
- 注册页会切到前台后再填写密码并提交
- 如果认证页直接进入验证码阶段，后续交给 Step 4 处理

### Step 4：获取注册验证码

- 根据 `收码邮箱` 配置轮询验证码邮件
- 当前支持：
  - `content/mail-163.js`
  - `content/qq-mail.js`
- 如果密码页出现 `Operation timed out` / `重试` 之类异常，会优先尝试恢复后再继续等验证码

### Step 5：填写姓名和生日

- 自动生成姓名与生日资料
- 同时兼容两类页面：
  - `birthday`
  - `age`
- 某些情况下如果资料页被跳过、页面直接进入真实本地回调地址，也会按已完成处理

### Step 6：清理登录 Cookies

- 在重新进入 OAuth 登录链路前，会清理 ChatGPT / OpenAI 相关登录 cookies
- 用于减少上一轮账号状态污染下一轮授权流程

### Step 7：刷新 OAuth 并登录

- 会重新回到 CPA 面板刷新最新 OAuth 链接
- 使用当前轮注册好的账号重新进入 OAuth 登录链路
- 如果页面已经直接到本地回调地址，会按本步骤已完成处理

### Step 8：获取登录验证码

- 与 Step 4 类似，但针对登录验证码场景
- 如果页面已经直接进入本地回调地址，会跳过当前步骤
- 验证码填写与继续动作之间加入了 1~2 秒的人类化延迟

### Step 9：自动确认 OAuth

- 会在 OAuth 同意页定位“继续”按钮
- 必要时通过 Chrome debugger 输入事件点击
- 同时监听当前认证标签页的主 frame 跳转
- 捕获成功后把回调地址写入 `回调`

严格回调规则：

- 只接受 `http(s)://localhost:<port>/auth/callback?code=...&state=...`
- 也接受：
  - `127.0.0.1`
  - `192.168.2.1`
- 必须是 `/auth/callback`
- query 中必须同时包含 `code` 和 `state`

### Step 10：平台回调验证

- 会回到 CPA 面板
- 自动填写 Step 9 捕获到的本地回调地址
- 自动点击“提交回调 URL”
- 只有当 CPA 面板出现精确的 `认证成功！` 状态时，才判定这一轮成功

如果 Step 10 遇到 OAuth callback 超时，后台会最多回到最终 OAuth 链路起点重新跑若干次，再决定本轮是否失败。

### OAuth 全局锁

如果你会在多个浏览器实例 / 多个指纹浏览器 profile 中并发跑 Step 7 ~ Step 10，建议先启动本地 OAuth 锁服务，避免多个实例同时进入最终 OAuth 链路：

```bash
node tools/oauth-lock-server.js
```

默认监听：

```txt
http://127.0.0.1:17666
```

当前版本中：

- Auto 进入 Step 7 ~ Step 10 前会申请这把锁
- 手动执行 Step 7 ~ Step 10 也会申请这把锁
- 如果当前锁被其他实例占用，侧边栏会显示等待状态，当前窗口会排队等待
- Step 10 完成、Stop、Reset 或窗口关闭后会释放锁

## 状态与数据

### `chrome.storage.session`

运行时状态按 **浏览器窗口** 隔离保存在 `chrome.storage.session` 中，主要包括：

- 当前步骤
- 每一步状态
- OAuth 链接
- 当前邮箱
- 当前密码
- 本地回调地址
- 当前窗口的 tab 注册信息
- 自动运行阶段、目标轮次、尝试次数

### `chrome.storage.local`

持久化配置保存在 `chrome.storage.local` 中，主要包括：

- CPA 地址
- CPA 管理密钥
- 自定义密码
- 收码邮箱
- 邮箱生成服务
- Addy `Recipients`
- Addy `Alias Domain`
- 兜底开关

特点：

- 运行时流程状态是当前浏览器会话级，并且按 window 隔离
- 配置项会持久化保存，关闭浏览器后重新打开仍可恢复
- 同一窗口内的自动运行与步骤状态彼此共享

## 项目结构

```txt
background.js              后台主控，编排 10 步流程、状态管理、自动运行与标签页复用
manifest.json              扩展清单
content/utils.js           通用工具：等待元素、点击、日志、停止控制
content/signup-page.js     ChatGPT / OpenAI 注册与授权页步骤
content/vps-panel.js       CPA 面板步骤：获取 OAuth / 提交回调验证
content/duck-mail.js       Duck Mail 自动获取
content/simplelogin-mail.js SimpleLogin 自动获取
content/addy-mail.js       Addy.io 自动获取
content/qq-mail.js         QQ 邮箱验证码轮询
content/mail-163.js        163 邮箱验证码轮询
sidepanel/                 侧边栏 UI
data/step-definitions.js   当前 10 步流程定义
data/names.js              随机资料数据
```

## 常见使用建议

### 1. 先单步验证，再开 Auto

推荐先手动跑通至少前几步：

1. 打开 ChatGPT 官网
2. 注册并输入邮箱
3. 填写密码并继续
4. 获取注册验证码

确认邮箱生成链路、验证码链路都稳定后，再使用 `自动`。

### 2. Addy.io 建议先单独验证弹窗字段

如果你使用 `Addy.io` 生成邮箱，建议先手动点一次 `获取`，确认：

- `Recipients` 能被正确应用
- `Alias Domain` 能被正确应用
- Addy 当前页面结构没有变化

### 3. 自动获取失败时可手动粘贴邮箱

如果当前生成服务页面打不开、未登录、DOM 变化，或者自动获取失败：

- 直接在侧边栏 `邮箱` 输入框里手动粘贴邮箱
- 再手动执行 Step 2 / Step 3，或重新开始自动运行

### 4. 跳过步骤

- 每个步骤右侧都有跳过按钮
- 只会把当前步骤状态标记为“已跳过”，不会真正执行脚本
- 适合在页面已手动处理完成时放行后续步骤
- 如果自动运行处于暂停态，接管后也可以切回手动控制

### 5. Step 9 / Step 10 失败时重点检查

- OAuth 同意页 DOM 是否变化
- “继续”按钮文案是否变化
- 浏览器是否允许 debugger 附加
- 回调路径是否仍然是 `/auth/callback`
- query 中是否仍然同时包含 `code` 和 `state`
- CPA 面板是否仍然返回精确的 `认证成功！`

## 已知限制

- Step 9 对 OAuth 同意页 DOM 仍然比较敏感
- Addy / Duck / SimpleLogin 依赖目标页面真实 DOM，页面改版会直接影响自动获取
- QQ / 163 邮箱页面 DOM 变化会影响验证码轮询
- CPA 管理面板 DOM 变化会影响 Step 1 / Step 7 / Step 10

## 调试建议

- 先单步跑通，再开 Auto
- 重点关注侧边栏日志和 Service Worker 控制台
- 如果某一步频繁失败，优先检查目标页面 DOM、按钮文案、登录态和网络状态是否变化
