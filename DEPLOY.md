# 网页大富翁 - 纯前端 + 异地联机 部署指南

游戏本身完全在浏览器运行（WebRTC 联机，无游戏服务器）。
需要部署的只有两样：**静态游戏文件** + **信令服务器(Worker)**。
跨网络（朋友在外地）还需要一个 **TURN 服务器** 才能穿透 NAT。

---

## 第一步：部署游戏静态文件（HTTPS 必需）

选一个静态托管平台，把 `public/` 目录作为站点根目录部署：

### Cloudflare Pages（推荐，免费 HTTPS）
1. 把整个项目推到 GitHub
2. Cloudflare Pages → Create → 连 GitHub 仓库
3. Framework preset: **None**
4. **Build output directory: `public`**
5. 部署完成得到 `https://xxx.pages.dev`

### 或 Vercel / Netlify
- 拖拽 `public/` 目录，或连仓库设输出目录为 `public`

> ⚠️ 必须用 HTTPS 域名访问。手机用 `http://局域网IP` 会被浏览器拦截 WebRTC。

---

## 第二步：部署信令 Worker

```bash
npm install
npx wrangler login
npm run deploy:signal
```
得到地址如 `https://monopoly-signal.xxx.workers.dev`

---

## 第三步：配置 TURN（异地联机必需）

同 Wi-Fi 不用 TURN；**不同网络必须 TURN**，否则连不上。

### 免费 TURN 申请（二选一）
- **Metered.ca**：注册免费额度 1 GB/月 → 控制台创建 TURN credential → 得到 `host`、`username`、`credential`
- **OpenRelay**（免费公共）：`turn:openrelay.metered.ca:80` 等，详见其文档

### 填入方式（任选一种）
1. **URL 参数**（最方便，分享链接即用）：
   ```
   https://xxx.pages.dev/?signal=wss://monopoly-signal.xxx.workers.dev&turn=turn:your-host:3478&turnuser=xxx&turnpass=yyy
   ```
2. **localStorage**（每个玩家浏览器里 F12 控制台执行一次）：
   ```js
   localStorage.setItem('monopoly_turn', JSON.stringify({url:'turn:your-host:3478', username:'xxx', credential:'yyy'}))
   ```
3. **改代码**：编辑 `public/game-net.js` 顶部 `window.__TURN_CONFIG`

---

## 第四步：联机

1. 打开部署好的页面（带上面参数，或手动在"信号服务器地址"填 `wss://monopoly-signal.xxx.workers.dev`）
2. 玩家A 点"创建房间" → 显示房间码 `ABC12`
3. 玩家B 打开同一页面 → 房间列表出现 `ABC12` → 点击加入
4. 双方选角色 → A 点"开始游戏"

---

## 本地同 Wi-Fi 测试（不用部署）

```bash
npm run build      # 生成 public/server-browser.js
npm run signal     # 信令 ws://localhost:3001
npm run dev        # 静态 http://localhost:8080
```
- 电脑开 `http://localhost:8080`
- 手机同 Wi-Fi 开 `http://192.168.x.x:8080`（信号地址自动推断）
- 无需 TURN（同网络 STUN 即可）

---

## 你需要做的（清单）

- [ ] GitHub 上建仓库，推整个项目
- [ ] Cloudflare Pages 部署 `public/`（输出目录 `public`）
- [ ] `wrangler login` + `npm run deploy:signal` 部署信令
- [ ] 申请免费 TURN，拿到 host/user/pass
- [ ] 把页面链接拼上 `?signal=...&turn=...&turnuser=...&turnpass=...` 发给朋友
- [ ] 自己先开链接建房间，朋友开链接点房间加入

就这样，全程零服务器费用。
