# Speedy

面向 Chromebook 的 3D 网页多人小游戏:跑步、挑战、宠物孵化、偷别人宠物、收集宝石。

前端 Three.js，后端 Node.js + 原生 `ws`，数据库 PostgreSQL。**服务器权威模拟**，客户端只上报输入。

---

## 目录

- [架构总览](#架构总览)
- [本地跑通（3 分钟）](#本地跑通3-分钟)
- [生产部署（Oracle Cloud / Ubuntu 22.04）](#生产部署)
- [Cloudflare Worker 网关](#cloudflare-worker-网关)
- [配置项](#配置项)
- [测试流程](#测试流程)
- [作弊测试用例](#作弊测试用例)
- [常见问题](#常见问题)

---

## 架构总览

```
浏览器（Chromebook Chrome）
  │  20Hz 只发输入      ▲ 10Hz 世界快照 + 权威自身状态
  ▼                     │
Cloudflare Worker "speedy"        ← 静态资源 CDN + /ws 与 /api 透传
  │                     ▲
  ▼                     │
cloudflared tunnel（speedy-game） ← 独立于 1Panel 的 tunnel
  │                     ▲
  ▼                     │
Node.js 权威服务器（127.0.0.1:8080）
  ├── 20 tick/s 物理模拟 + 校验
  ├── 10Hz 广播
  └── PostgreSQL（只在登录/下线/宝石/宠物变更时写）
```

**硬性约束（不可更改）**

| 约束 | 实现 |
| --- | --- |
| 通信 | 原生 `ws`，不用 Socket.IO |
| 客户端上报 | 固定 20Hz，切后台降到 5Hz |
| 服务器模拟 | 20 tick/s |
| 下行广播 | 10Hz（每个客户端额外 10Hz 自身状态） |
| 数据库写入 | 绝不每 tick 写 |
| 依赖许可 | MIT / ISC / Apache-2.0（无 GPL） |
| 传输 | 仅 WebSocket over TCP，不做 UDP |

**目录结构**

```
speedy/
├── server/                 后端
│   ├── index.js            HTTP + WebSocket 入口
│   ├── gameRoom.js         房间:主循环、输入、操作、广播、心跳
│   ├── world.js            世界状态 + 权威物理积分
│   ├── antiCheat.js        限流、位移校验、资源操作校验、作弊日志
│   ├── protocol.js         上行包解析与严格字段校验
│   ├── auth.js             scrypt 密码哈希 + HMAC session token
│   ├── store.js            PostgreSQL 存档层（批量落库）
│   ├── http.js             静态资源 + JSON 响应工具
│   ├── config.js           所有常量与可调参数
│   └── logger.js           日志 + 作弊日志文件
├── public/                 前端（无构建步骤）
│   ├── index.html
│   ├── css/style.css
│   ├── js/
│   │   ├── main.js         登录 → 连接 → 主循环
│   │   ├── net.js          WebSocket、20Hz 上报、心跳、重连
│   │   ├── render.js       Three.js 场景、插值、本地预测
│   │   ├── input.js        WASD + 空格
│   │   ├── hud.js          HUD 与提示
│   │   ├── interpolation.js 快照缓冲与插值
│   │   ├── targeting.js    最近目标筛选（仅视觉）
│   │   └── assets.js       ★ 皮肤 / 地图 / 配色（换美术改这里）
│   └── vendor/three/       本地 three.js（MIT，无 CDN 依赖）
├── db/init.sql             建表脚本（幂等）
├── deploy/                 systemd / cloudflared / nginx / 备份脚本
├── worker/                 Cloudflare Worker（静态 + WS 网关）
├── scripts/init-db.js      本地建表 CLI
└── test/                   端到端与多人测试
```

---

## 本地跑通（3 分钟）

### 1. 准备 Node 与数据库

```bash
node -v     # 需要 >= 20.12
npm install
```

数据库两种选择：

**A. 用已有 PostgreSQL**（推荐）

```bash
export DATABASE_URL="postgres://user:pass@127.0.0.1:5432/speedy"
```

**B. 用 Docker 起一个**

```bash
docker run -d --name speedy-pg \
  -e POSTGRES_USER=speedy -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=speedy \
  -p 5432:5432 postgres:16-alpine

export DATABASE_URL="postgres://speedy:devpass@127.0.0.1:5432/speedy"
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 生成一个随机 session 密钥
node -e "console.log('SESSION_SECRET=' + require('node:crypto').randomBytes(48).toString('base64url'))"
```

把这一行填进 `.env`，并把 `DATABASE_URL` 改成你的连接串。
`DB_AUTO_MIGRATE=true` 时启动会自动建表。

### 3. 启动

```bash
npm start
# 或者开发模式（改文件自动重启）
npm run dev
```

打开 <http://127.0.0.1:8080>，注册一个账号即可进入。

### 4. 一键自测

```bash
# 需要服务器已在运行
node test/e2e.mjs                       # 26 项:协议、鉴权、物理、防作弊
DATABASE_URL=... node test/multiplayer.mjs   # 14 项:偷宠物、冷却、权限
```

### 操作

| 键 | 作用 |
| --- | --- |
| `W` `A` `S` `D` | 移动 |
| `Space` | 跳跃 |
| `E` | 拾取宝石 / 偷别人的宠物 |
| `F` | 孵化自己的宠物 |

---

## 生产部署

目标：Oracle Cloud Always Free VM，Ubuntu 22.04，独立公网 IPv4。

### 1. 服务器基础

```bash
ssh ubuntu@<公网IP>

# 安装 Node.js 22（脚本自动处理，也可手动）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

sudo useradd --system --create-home --shell /usr/sbin/nologin speedy
sudo mkdir -p /opt/speedy /opt/speedy/logs
```

### 2. 上传代码

```bash
# 在本地
scp -i <私钥> -r server public db deploy scripts test worker \
    package.json package-lock.json .env.example ubuntu@<IP>:/tmp/speedy/
# 在服务器
sudo cp -r /tmp/speedy/* /opt/speedy/
cd /opt/speedy && sudo -u speedy npm install --omit=dev
```

或者直接用安装脚本（会自动装 Node、建用户、装 systemd）：

```bash
sudo bash deploy/install.sh
```

### 3. 数据库

如果 PG 跑在 Docker 里（1Panel 默认就是这样）：

```bash
sudo bash deploy/init-db.sh
```

如果是宿主机原生 PostgreSQL：

```bash
sudo -u postgres psql -c "CREATE USER speedy WITH PASSWORD '<强密码>';"
sudo -u postgres psql -c 'CREATE DATABASE speedy OWNER speedy;'
sudo -u postgres psql -d speedy -f /opt/speedy/db/init.sql
```

### 4. 环境变量

```bash
sudo nano /opt/speedy/.env
```

```ini
HOST=127.0.0.1
PORT=8080
DATABASE_URL=postgres://speedy:<强密码>@127.0.0.1:5432/speedy
PG_POOL_MAX=8
DB_AUTO_MIGRATE=true
SESSION_SECRET=<随机 48 字节 base64url>
SESSION_TTL_HOURS=12
LOG_LEVEL=info
CHEAT_LOG_FILE=logs/cheat.log
NODE_ENV=production
```

```bash
sudo chown speedy:speedy /opt/speedy/.env
sudo chmod 600 /opt/speedy/.env
```

> **注意**：数据库端口不要暴露到公网。若 PG 在 Docker 里且映射了 `5432:5432`，
> 请改成 `127.0.0.1:5432:5432`，否则等于把数据库直接开到公网。

### 5. systemd 常驻

```bash
sudo install -m 644 /opt/speedy/deploy/speedy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now speedy
sudo systemctl status speedy
sudo journalctl -u speedy -f
```

为什么不用 PM2：PM2 是 **AGPL-3.0**，与本项目"不得引入 GPL 强传染依赖"的约束冲突。
systemd 提供同等的开机自启与崩溃重启能力。

### 6. 公网入口（Cloudflare Tunnel）

不需要开放 80/443，也不需要 certbot。

**创建独立 tunnel**（不要复用 1Panel 的 tunnel）：

```bash
cloudflared tunnel login                       # 一次性,生成 cert.pem
cloudflared tunnel create speedy-game          # 记下输出的 TunnelID
```

把凭证放到服务器：

```bash
sudo install -m 600 ~/.cloudflared/<TunnelID>.json /etc/cloudflared/speedy-game.json
```

配置 ingress（在 Cloudflare Dashboard → Zero Trust → Networks → Tunnels →
`speedy-game` → Public Hostname 添加）：

| 子域 | 域名 | 服务 |
| --- | --- | --- |
| `speedy-origin` | `potatoedu.cc` | `http://127.0.0.1:8080` |

DNS 记录由 Dashboard 自动创建（CNAME → `<TunnelID>.cfargotunnel.com`，Proxied）。

**如果要用命令行创建 DNS 记录**（需要带 `Zone.DNS:Edit` 的 API Token，
`cloudflared tunnel login` 签发的 cert.pem 也可以）：

```bash
sudo cloudflared tunnel --config /etc/cloudflared/speedy-game.yml \
  route dns speedy-game speedy-origin.potatoedu.cc
```

**安装为系统服务**（开机自启）：

```bash
sudo install -m 644 /opt/speedy/deploy/cloudflared-speedy.yml /etc/cloudflared/speedy-game.yml
sudo install -m 644 /opt/speedy/deploy/cloudflared-speedy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-speedy
sudo systemctl status cloudflared-speedy
```

验证：

```bash
curl -s http://127.0.0.1:8080/api/health
sudo journalctl -u cloudflared-speedy -n 30 --no-pager
```

### 7. 防火墙

Tunnel 只需要出站连接，**不需要**开放 80/443：

```bash
sudo ufw allow 22/tcp
sudo ufw enable
```

OCI 控制台的安全列表（Security List / NSG）同理，只放行 22 即可。

### 8. 可选：不经过 Cloudflare，直接对外

如果确实想直连 VPS，用 `deploy/nginx-speedy.conf`：

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx-speedy.conf /etc/nginx/sites-available/speedy
sudo ln -s /etc/nginx/sites-available/speedy /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d speedy.example.com
```

注意 `location /ws` 里的 `proxy_read_timeout 3600s` 与 `Upgrade` 头必须保留，
否则长连接会被 nginx 掐断。

---

## Cloudflare Worker 网关

Worker 只做两件事：托管前端静态资源、把 `/ws` 与 `/api/*` 透传到源站。
**不含任何游戏逻辑。**

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

`worker/wrangler.jsonc` 关键字段：

| 字段 | 说明 |
| --- | --- |
| `name: "speedy"` | Worker 名（Cloudflare 要求全小写） |
| `assets.directory: "../public"` | 直接把 `public/` 作为静态资源上传 |
| `routes[0].pattern: "speedy.potatoedu.cc"` | 自定义域，部署时自动创建 DNS |
| `vars.ORIGIN_URL` | 源站地址，即 tunnel 的公开主机名 |

本地联调源站可以改成本机：

```bash
# 临时把 ORIGIN_URL 指向本机（需要先用 cloudflared 暴露本机）
cd worker && npx wrangler dev --var ORIGIN_URL:http://127.0.0.1:8080
```

### 为什么 Worker 需要转发 `/api`

登录、会话校验、WS 票据都走 `/api/*`，这些在 Node 上。
Worker 必须同时代理 `/api/*`，否则页面上能加载但无法登录。

### WebSocket 代理原理

Worker 侧用 `fetch(url, { headers: { Upgrade: 'websocket' } })` 拿到源站的
`response.webSocket`，再与浏览器侧用 `WebSocketPair` 配对，双向转发帧。
Worker 不解析任何业务消息，只搬运字节并协调关闭码。

---

## 配置项

所有可调参数集中在 [`server/config.js`](server/config.js)，并支持环境变量覆盖：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TICK_RATE` | 20 | 服务器模拟频率 |
| `BROADCAST_RATE` | 10 | 下行快照频率 |
| `MAX_ONLINE` | 30 | 同时在线上限 |
| `PLAYER_MAX_SPEED` | 6 | 最大速度 units/s |
| `PLAYER_ACCELERATION` | 12 | 加速度 units/s² |
| `PLAYER_FRICTION` | 0.9 | 每 tick 阻尼系数 |
| `PLAYER_JUMP_IMPULSE` | 7.5 | 跳跃初速度 |
| `PLAYER_GRAVITY` | 22 | 重力 |
| `INPUT_STALE_MS` | 450 | 输入过期时间（防"幽灵前进"） |
| `CHEAT_DISPLACEMENT_TOLERANCE` | 1.45 | 位移容差倍数 |
| `CHEAT_MAX_DRIFT` | 3.5 | 允许的最大坐标漂移 |
| `CHEAT_STRIKES_BEFORE_KICK` | 8 | 累计多少次异常后断开 |
| `MAX_INPUT_PACKETS_PER_SEC` | 22 | 输入包限流 |
| `MAX_ACTION_PACKETS_PER_SEC` | 10 | 操作包限流 |

玩法规格：拾取半径 2.2、偷宠物半径 2.5、偷宠物冷却 12s/pet、孵化冷却 20s/pet。

地图刷新点、皮肤白名单也在 `config.js` 里，改完重启即可生效。

换美术资源只改 [`public/js/assets.js`](public/js/assets.js)：
配色、模型尺寸、相机、皮肤颜色/贴图都在那里。

### Cloudflare Turnstile(注册与登录人机认证)

注册和登录都必须先通过 Turnstile。token 由浏览器产出,服务端再带 secret
去 Cloudflare 校验一次,伪造的 token 无效。

| 变量 | 说明 |
| --- | --- |
| `CF_TURNSTILE_SITE_KEY` | 公开值,下发给浏览器渲染 widget |
| `CF_TURNSTILE_SECRECT_KEY` | 私密值,只用于服务端 siteverify |

注意 **SECRECT 的拼写**:Cloudflare Dashboard 上这个 key 就是这么拼的。
代码按原样读取,同时接受正确的 `CF_TURNSTILE_SECRET_KEY`,改对了也不会失效。

生产环境这两个 key 存在 **Worker 的环境变量**里,由 Worker 随请求头转到源站
(`X-Turnstile-Site-Key` / `X-Turnstile-Secret-Key`),服务器 `.env` 里不需要写。

**未配置时注册和登录一律拒绝**(返回 `503 captcha_failed / not_configured`),
不会静默放行。

本地开发想跑通,用 Cloudflare 官方测试 key:

```ini
CF_TURNSTILE_SITE_KEY=1x00000000000000000000AA
CF_TURNSTILE_SECRECT_KEY=1x0000000000000000000000000000000AA   # 始终通过
```

换成 `2x0000000000000000000000000000000AA` 则始终失败,用来验证拒绝路径。

### 源站保护(ORIGIN_SHARED_SECRET)

`speedy-origin.<域名>` 是公网可直连的。如果只在前端放 Turnstile,攻击者直接
POST 源站就能完全跳过。

所以 Worker 转发时会带一个共享密钥 `X-Origin-Secret`,源站只接受带了正确头的
请求,其余 `/api/*` 与 WebSocket 握手一律 `403 direct_origin_forbidden`。

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

两边都要配,值必须相同:

```bash
# Worker(Cloudflare 侧)
cd worker && npx wrangler secret put ORIGIN_SHARED_SECRET --name speedy

# 源站
echo 'ORIGIN_SHARED_SECRET=<同一个值>' | sudo tee -a /opt/speedy/.env
sudo systemctl restart speedy
```

不配这个变量时源站不做来源检查(方便本地开发),生产环境启动日志会给出警告。

---

## 测试流程

### 1. 自动化测试

```bash
npm start &                                   # 先起服务

node test/e2e.mjs                              # 26 项
DATABASE_URL=... node test/multiplayer.mjs     # 14 项（需要直连数据库发宠物）
```

`e2e.mjs` 覆盖：注册/登录/会话/票据、伪造 token 被拒、welcome 结构、
输入驱动的权威位移与限速、快照排除自身、远距离拾取被拒、非法字段被拒、
瞬移被忽略、超频被断开、健康检查。

`multiplayer.mjs` 覆盖：野生宠物不可偷、不能偷自己的、不存在的宠物、
远距离被拒、合法抢夺成功、原主人收到通知、库存同步、冷却保护。

### 2. 手动冒烟

1. 开两个浏览器窗口，分别注册 `alice` / `bob`
2. alice 按 `E` 捡几颗宝石，HUD 数字增加
3. alice 走到 bob 的宠物旁按 `E`，bob 收到"你的宠物被偷走了"
4. alice 按 `F` 孵化自己的宠物，进度条 +25%
5. 切到别的标签页 10 秒再切回，连接不断，位置连续

### 3. 观察日志

```bash
sudo journalctl -u speedy -f                       # 运行日志
sudo tail -f /opt/speedy/logs/cheat.log            # 作弊日志
curl -s http://127.0.0.1:8080/api/health           # tick / 在线数
```

---

## 作弊测试用例

以下用例用于验证防作弊是否生效。**只在自己的服务器上测试。**

### 0. 绕过人机认证 / 直连源站 → 拒绝

```bash
# 不带 Turnstile token 直接注册
curl -X POST -H 'Content-Type: application/json' \
  -d '{"username":"hacker","password":"TestPass123"}' \
  https://speedy.potatoedu.cc/api/register
# 期望:403 {"error":"captcha_failed","reason":"missing_token"}

# 伪造一个 token
curl -X POST -H 'Content-Type: application/json' \
  -d '{"username":"hacker","password":"TestPass123","turnstileToken":"forged"}' \
  https://speedy.potatoedu.cc/api/register
# 期望:403 {"error":"captcha_failed","reason":"rejected"}

# 绕开 Worker,直接打源站(源站域名公网可达)
curl -X POST -H 'Content-Type: application/json' \
  -d '{"username":"hacker","password":"TestPass123"}' \
  https://speedy-origin.potatoedu.cc/api/register
# 期望:403 {"error":"direct_origin_forbidden"}

# 同样绕开 Worker 直接连 WebSocket
wscat -c "wss://speedy-origin.potatoedu.cc/ws?token=<任意>"
# 期望:立即关闭,code 4003
```

注意第 3、4 条只有在配置了 `ORIGIN_SHARED_SECRET` 之后才会生效。
这是 Turnstile 真正有意义的前提——否则攻击者根本不需要过 Turnstile。

### 1. 超频发包 → 断开

```js
// 在浏览器控制台执行
setInterval(() => {
  for (let i = 0; i < 5; i++) {
    window.__speedy_ws?.send(JSON.stringify({
      type: 'player_input', seq: Date.now() + i,
      input: { moveX: 0, moveZ: 0, jump: false },
      clientPreviewPos: { x: 0, y: 0, z: 0 },
    }));
  }
}, 50);
```

**预期**：超过 22 包/秒后被拒绝，累计计次达到阈值后连接以 `4002` 断开，
`cheat.log` 出现 `"reason":"input_rate"`。

### 2. 瞬移 → 坐标被忽略

```js
// 连续两次上报间隔 100 米
send({ type: 'player_input', seq: Date.now(), input: { moveX: 1, moveZ: 1, jump: false },
       clientPreviewPos: { x: 500, y: 0, z: 500 } });
```

**预期**：服务器坐标完全不变(角色仍在原处),`cheat.log` 出现
`"reason":"displacement"`,带 `travelled` 与 `maxTravel` 对比。

### 3. 伪造资源数量 → 无效

```js
send({ type: 'try_pick_gem', gemId: '00000000-0000-0000-0000-000000000000' });
```

**预期**：返回 `{"ok":false,"reason":"gem_unavailable"}`。
客户端在任何包里附带 `gems` / `petId` / `speedBonus` 都会被协议层直接忽略。

### 4. 远距离操作 → 拒绝

```js
// 站在原点,去偷地图另一端的宠物
send({ type: 'try_steal_pet', petId: '<远端宠物 id>' });
```

**预期**：`{"ok":false,"reason":"too_far","details":{"dist":...,"limit":2.5}}`。

### 5. 伪造 / 过期 token → 断开

```bash
# 用一个乱写的 token 连 WS
wscat -c "wss://speedy.potatoedu.cc/ws?token=forged.token"
```

**预期**：立即以 `4001 unauthorized` 关闭。

### 6. 高频操作请求 → 限流

```js
for (let i = 0; i < 30; i++) send({ type: 'try_pick_gem', gemId: '<任意>' });
```

**预期**：超过 10 次/秒的部分被丢弃，持续超限则断开(`4004`)。

---

## 常见问题

**Q: 页面能打开但一直显示"正在连接服务器"?**

检查 Worker 的 `ORIGIN_URL` 是否指向正确的 tunnel 主机名，并且该主机名的 DNS
已经存在（`dig +short speedy-origin.potatoedu.cc` 应有结果）。
再确认源站 `/api/health` 正常。

**Q: 登录返回 500?**

`.env` 里的 `SESSION_SECRET` 为空，或 `DATABASE_URL` 连不上。
`journalctl -u speedy -n 50` 会给出具体原因。

**Q: 角色一直往前走,松手不停?**

`INPUT_STALE_MS` 太大或客户端发包停了。默认 450ms 会把过期输入视为无输入。

**Q: 切标签页回来位置跳了一下?**

后台是 5Hz 上报，切回来瞬间有一帧间隔较大。这是设计行为，位置会在一两个
快照内收敛。

**Q: 想改地图 / 速度 / 宠物规则?**

只改 `server/config.js`（服务器权威参数）与 `public/js/assets.js`（视觉参数）。

---

## 许可

本项目代码 MIT。依赖：`ws`(MIT)、`pg`(MIT)、`three`(MIT)。

不使用 GPL/AGPL 依赖，因此**不使用 PM2**（AGPL-3.0），改用 systemd。
