# 多页面自动化

一个基于 Chromium Manifest V3 的侧边栏扩展，用于自动执行 Codex / ChatGPT OAuth 注册与授权流程。

当前版本重点：

- 保持 **7 步**主流程
- 支持 **单步执行 / Auto 多轮运行 / Stop 中断**
- 支持 **按浏览器 window 隔离状态与任务空间**
- Step 1 / Step 2 尽量后台执行，减少抢焦点
- Step 3 会切回注册页前台填写邮箱和密码，以提升成功率
- Step 6 自动处理授权页“继续”与 localhost 回调捕获

## 当前能力

- 从 CPA 管理面板自动获取 Codex OAuth 链接
- 自动打开 OpenAI 注册页并进入注册流程
- 自动填写邮箱与密码
- 支持自定义密码；留空时自动生成强密码
- 自动轮询验证码并回填
- 自动填写姓名 / 生日信息
- 自动完成 OAuth 同意页确认
- 自动把 localhost 回调地址回填到 CPA 面板做最终校验

## 邮箱相关

当前版本把“生成注册邮箱”和“接收验证码邮箱”拆开：

- `emailGenerationService`：只决定 **Step 3 注册邮箱来源**
- `mailProvider`：只决定 **Step 4 / Step 6 验证码邮箱来源**

### Step 3 注册邮箱来源

支持：

- Duck Mail
- SimpleLogin
- Addy.io

### 验证码邮箱来源

支持：

- 163 Mail
- QQ Mail

## 7 步流程

1. `Get OAuth Link`：打开 CPA OAuth 面板并获取授权链接
2. `Open Signup`：打开 OpenAI 注册页并进入注册入口
3. `Fill Email / Password`：获取或填写邮箱，填写密码并提交
4. `Get Signup Code`：轮询验证码邮箱，读取并回填注册验证码
5. `Fill Name / Birthday`：填写资料页信息
6. `Auto OAuth Confirm`：处理剩余登录校验、点击“继续”、监听 localhost 回调
7. `CPA Verify`：回到 CPA 面板提交 localhost 回调地址并确认成功

## 自动运行

点击侧边栏右上角 `Auto` 后，扩展会按顺序执行整套 7 步流程。

支持：

- 多轮自动运行
- 中途停止
- 继续当前进度 / 重新开始
- 当前轮失败后按策略重试

## 侧边栏主要配置

### CPA

你的管理面板 OAuth 页面地址，例如：

```txt
http(s)://<your-host>/management.html#/oauth
```

Step 1 和 Step 7 都依赖这个地址。

### Mail Provider

验证码邮箱来源：

- `163`
- `QQ`

### Email Generation Service

Step 3 注册邮箱生成服务：

- `Duck Mail`
- `SimpleLogin`
- `Addy.io`

### Email

当前轮使用的注册邮箱。

来源可以是：

- 手动粘贴
- 由所选 `Email Generation Service` 自动获取

### Password

- 留空：自动生成强密码
- 手动输入：使用自定义密码

## 安装

1. 打开浏览器扩展页面
   - Edge：`edge://extensions/`
   - Chrome：`chrome://extensions/`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择本项目目录
5. 打开扩展侧边栏开始使用

## 关键行为说明

### Step 1

- CPA 面板会尽量后台打开
- 如果复用的是同一个 CPA URL，会在后台 reload 一次，确保 OAuth 链接能刷新

### Step 3

- 注册页会切到前台再填写邮箱/密码并提交
- 这样能明显降低 `operation timed out` 的概率

### Step 4 / Step 6

- 使用 `mailProvider` 对应邮箱页轮询验证码
- 读取到验证码后自动回填
- Step 6 如果还停留在登录校验阶段，会先补做登录验证码流程，再继续授权

### Window 隔离

- 一个浏览器 window = 一个独立任务空间
- 各 window 的运行状态、步骤进度、Auto 状态、当前邮箱/密码互不干扰

## 项目结构

```txt
background.js              后台主控：步骤编排、状态管理、tab 复用
manifest.json              扩展清单
content/signup-page.js     OpenAI 注册 / 认证页脚本
content/vps-panel.js       CPA 面板脚本
content/duck-mail.js       Duck Mail 获取脚本
content/simplelogin-mail.js SimpleLogin 获取脚本
content/addy-mail.js       Addy.io 获取脚本
content/qq-mail.js         QQ 邮箱验证码轮询
content/mail-163.js        163 邮箱验证码轮询
content/utils.js           通用工具
sidepanel/                 侧边栏 UI
data/names.js              随机资料数据
```

## 调试建议

- 先单步跑通，再开 Auto
- 重点关注侧边栏日志和 Service Worker 控制台
- 如果某一步频繁失败，优先检查目标页面 DOM / 按钮文案是否变化

## 已知限制

- Step 6 对 OAuth 同意页结构较敏感
- 邮箱页面 DOM 变化会影响验证码轮询
- CPA 管理面板 DOM 变化会影响 Step 1 / Step 7
