# 运维坑清单（Oracle Cloud Always Free + Speedy）

实战踩坑记录与应对办法。按"会不会让线上挂掉"排序。

---

## 一、Oracle Free Tier 硬限制

### 1.1 实例规格

Always Free 的 ARM（Ampere A1）是 4 OCPU / 24 GB，但**总量**受限：

- 每个 tenancy 最多 **4 OCPU + 24 GB 内存** 的 A1 实例，所有实例加总
- 若开了多个 A1 实例，超出部分会被 OCI 直接回收（不是降级，是关机删除）

AMD 版本是 `VM.Standard.E2.1.Micro`：**1/8 OCPU、1 GB 内存**，每月 2 个。
本项目实测环境就是 2 核 956 MB，**够跑 30 人在线，但不要再装别的服务**。

**建议**：游戏服单独一台小机器，别和面板/数据库抢内存。

### 1.2 带宽

```bash
# 查看当月出站流量（OCI 控制台 → Billing → Cost Analysis）
```

- **出站流量每月 10 TB 免费**，超出按 $0.0085/GB 计费
- 入站流量不计费

本项目的带宽估算（30 人同时在线）：

| 项目 | 单包大小 | 频率 | 每人每秒 | 30 人合计 |
| --- | --- | --- | --- | --- |
| 上行（输入） | ~150 B | 20 Hz | 3 KB/s | 90 KB/s |
| 下行（快照） | ~2—4 KB | 10 Hz | 25 KB/s | 750 KB/s |
| 下行（自身状态） | ~200 B | 10 Hz | 2 KB/s | 60 KB/s |

峰值约 **6.5 Mbps**、约 **2.9 GB/小时**。按每天开 8 小时算，一月约 700 GB，
远低于 10 TB。但如果有人在浏览器里挂着不动一整天，会持续消耗——考虑空闲踢人。

### 1.3 计算资源

- Free Tier 实例**没有 CPU 信用（burstable）保障**，长期跑满会被限速
- 20 tick/s 的模拟在 1 GB 内存机器上 CPU 占用约 5—15%
- **不要在游戏机上跑编译、Docker 多容器、数据库 + 游戏 + 面板**

### 1.4 公网 IP

- 实例销毁重建后 **公网 IPv4 会变**
- 但走 Cloudflare Tunnel 时**源站 IP 变化不影响服务**（Tunnel 是出站连接），
  这是选择 Tunnel 而非直接暴露端口的一大好处
- 如果直连（Nginx + Let's Encrypt），IP 变化后 DNS 要更新，证书续期也会短暂失败

---

## 二、OCI 网络与断流

### 2.1 空闲长连接被掐

OCI 的 NAT/安全组对"看起来空闲"的 TCP 连接有超时行为（常见 5—30 分钟不等）。

**本项目已处理**：双向心跳，每 3 秒一次；服务器 10 秒收不到任何上行包即断连，
客户端自动重连（最多 5 次，间隔 1 秒）。

**如果你自己改代码**：千万不要去掉心跳，或把 `heartbeatIntervalMs` 调大到
30 秒以上。

### 2.2 Tunnel 偶发重连

```bash
sudo journalctl -u cloudflared-speedy -n 100 --no-pager | grep -i -E "error|retry|reconnect"
```

正常现象：`Retrying connection in up to 1m4s` 这种日志偶尔出现，几秒内自愈。
持续出现则检查：

```bash
# 出站 7844/UDP 是否被拦（QUIC 模式）
sudo ufw status
# 改用 http2 传输试试
sudo sed -i 's/^# *protocol.*//' /etc/cloudflared/speedy-game.yml
echo 'protocol: http2' | sudo tee -a /etc/cloudflared/speedy-game.yml
sudo systemctl restart cloudflared-speedy
```

### 2.3 Dashboard 里改了 ingress 但没生效

Remote-managed tunnel（`config_src: cloudflare`）的 ingress 只能通过 Dashboard
或 API 改。**本地 `speedy-game.yml` 里写 ingress 不生效**，两者会各说各话。

排查：

```bash
sudo cloudflared tunnel --config /etc/cloudflared/speedy-game.yml tunnel info speedy-game
```

### 2.4 健康检查 falsely failed

`cloudflared` 的 precheck 偶尔报 `UDP Connectivity FAIL`，但 HTTP/2 通，
服务也正常。看最终汇总行：

```
SUMMARY: Environment is healthy. cloudflared will use 'quic' as primary protocol.
```

这一行是 healthy 就没问题。

---

## 三、PostgreSQL 相关

### 3.1 Docker 里的 PG 端口暴露

**高危**。默认 `-p 5432:5432` 会监听 `0.0.0.0`，等于把数据库开到公网。

检查：

```bash
sudo ss -tlnp | grep 5432
# 期望看到 127.0.0.1:5432,而不是 0.0.0.0:5432
```

修复（1Panel 创建的容器）：

```bash
# 1Panel → 容器 → 编辑 → 端口改为 127.0.0.1:5432:5432
# 或者用 iptables 兜底
sudo ufw deny 5432
```

本项目 `.env` 里的 `DATABASE_URL` 用 `127.0.0.1:5432`，走本机回环即可。

### 3.2 容器重启后连接失败

`pool.on('error')` 已处理，但如果 PG 容器重启，Node 侧的连接池需要重建。

```bash
sudo systemctl restart speedy
```

如果想自动化，加一个 systemd 依赖：

```ini
# /etc/systemd/system/speedy.service 的 [Unit] 段
After=docker.service
Wants=docker.service
```

（已在 `deploy/speedy.service` 里配好）

### 3.3 磁盘被日志/数据撑满

```bash
df -h /
sudo docker system df
sudo journalctl --disk-usage
```

清理：

```bash
# 限制 systemd 日志到 200 MB
sudo journalctl --vacuum-size=200M

# 清理不用的镜像
sudo docker image prune -a

# 清理作弊日志（保留最近 7 天）
sudo find /opt/speedy/logs -name 'cheat.log' -size +50M -exec truncate -s 0 {} \;
```

建议给 `journald` 设上限：

```bash
sudo sed -i 's/^#SystemMaxUse=.*/SystemMaxUse=200M/' /etc/systemd/journald.conf
sudo systemctl restart systemd-journald
```

### 3.4 备份

```bash
sudo bash /opt/speedy/deploy/backup-db.sh
```

脚本会：`docker exec pg_dump | gzip` → `/var/backups/speedy/` → 校验 gzip 完整性
与关键表存在 → 删除 14 天前的旧备份。

加定时任务：

```bash
sudo crontab -e
# 每天 03:10
10 3 * * * /usr/bin/bash /opt/speedy/deploy/backup-db.sh >> /var/log/speedy-backup.log 2>&1
```

**恢复演练一定要做一次**（不然备份等于没有）：

```bash
# 在测试库上验证
gunzip -c /var/backups/speedy/speedy-20261122-031000.sql.gz | \
  sudo docker exec -i 1Panel-postgresql-tGSS psql -U speedy -d speedy_test
```

### 3.5 宝石数据丢失

宝石走"批量落库"（5 秒一批）。如果进程被 `kill -9`，最多丢 5 秒的宝石。

`SIGTERM`（`systemctl stop`/`restart` 用的就是它）会触发优雅关闭，
`flushInventory()` 会把脏数据写完再退出。**不要用 `kill -9` 停服务。**

---

## 四、Node / 进程管理

### 4.1 内存泄漏 / OOM

```bash
sudo systemctl status speedy     # 看 Memory 字段
sudo journalctl -u speedy -n 100 | grep -i -E "heap|oom"
```

`deploy/speedy.service` 里设了 `MemoryMax=512M`。超过会被 systemd 杀掉并重启
（`Restart=always`）。如果频繁触发，检查：

- 在线人数是否远超 30（`/api/health` 的 `online`）
- `logs/cheat.log` 是否异常巨大（有人攻击）

### 4.2 重启风暴

systemd 会在 60 秒内最多重启 10 次，超过就停下来等人工介入：

```
StartLimitIntervalSec=60
StartLimitBurst=10
```

看到 `start-limit-hit` 就用：

```bash
sudo systemctl reset-failed speedy
sudo systemctl start speedy
```

### 4.3 时区

服务器默认 UTC。日志时间戳也是 UTC。如果想让日志显示本地时间：

```bash
sudo timedatectl set-timezone Asia/Shanghai
sudo systemctl restart speedy
```

（本项目日志用 ISO 8601 带 Z 后缀，明确是 UTC，不会混淆。）

---

## 五、Cloudflare 相关

### 5.1 Worker 的 Origin 报 1016

`Origin DNS error 1016` = Worker 连不上 `ORIGIN_URL` 的主机名。

排查顺序：

1. `dig +short speedy-origin.potatoedu.cc` 有没有结果
2. 该记录是不是 CNAME 到 `<TunnelID>.cfargotunnel.com`
3. `sudo systemctl status cloudflared-speedy` 是否 active
4. 源站 `curl http://127.0.0.1:8080/api/health` 是否 200

### 5.2 部署 Worker 时 name 报错

```
Expected "name" to be of type string, alphanumeric and lowercase with dashes only
```

Cloudflare 要求 Worker 名**全小写**。`wrangler.jsonc` 里写 `"name": "speedy"`，
不要写 `"Speedy"`。

### 5.3 自定义域和 Tunnel 的 DNS 冲突

同一个子域名不要既指向 Worker 又指向 Tunnel。分工建议：

| 子域 | 指向 | 用途 |
| --- | --- | --- |
| `speedy.potatoedu.cc` | Worker | 玩家访问入口（静态 + WS 代理） |
| `speedy-origin.potatoedu.cc` | Tunnel | 只有 Worker 用，不对玩家暴露 |

### 5.4 WebSocket 被 Worker 断开

Workers 运行时升级时会重连 WebSocket（不是 bug）。客户端已实现自动重连，
所以玩家只会看到短暂"正在重连"。

如果频繁发生，检查 Worker 是否在转发时漏了 `Upgrade` 头。

---

## 六、安全

### 6.1 必做的三件事

```bash
# 1. 只开 22
sudo ufw default deny incoming
sudo ufw allow 22/tcp
sudo ufw enable

# 2. 禁用密码登录
sudo sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh

# 3. 数据库不暴露公网
sudo ss -tlnp | grep 5432   # 必须是 127.0.0.1
```

### 6.2 `.env` 权限

```bash
sudo chown speedy:speedy /opt/speedy/.env
sudo chmod 600 /opt/speedy/.env
```

`SESSION_SECRET` 泄露 = 任何人都能伪造登录。泄露后立即换密钥并
`systemctl restart speedy`（所有旧 token 立即失效）。

### 6.3 作弊日志里的隐私

`logs/cheat.log` 记录了 uid 与坐标。不要公开这份日志。轮转建议：

```bash
# /etc/logrotate.d/speedy
/opt/speedy/logs/cheat.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
    copytruncate
}
```

---

## 七、容量与扩容

### 7.1 建议同时在线数

| 机器 | 建议上限 | 说明 |
| --- | --- | --- |
| 1 GB / 1 核 | 30 | 本项目默认 `MAX_ONLINE=30` |
| 2 GB / 2 核 | 60—80 | 需要把 `MAX_ONLINE` 调高 |
| 24 GB A1（4 OCPU） | 300+ | 单进程会先到达 Node 事件循环瓶颈 |

**单进程瓶颈**：Node 是单线程，20 tick/s 的模拟在 300 人时会有明显 GC 压力。
要更多人就按房间分片（多个进程 + 不同端口/子域），而不是单进程硬撑。

### 7.2 带宽先到上限怎么办

优先降下行：

1. 把 `BROADCAST_RATE` 从 10 降到 8（肉眼几乎无差别）
2. 快照里去掉远处玩家（按距离裁剪）
3. 宝石/宠物只在变化时下发（增量）

不要动 20Hz 的输入上报——那是手感的基础。

---

## 八、排障速查表

| 现象 | 最可能原因 | 命令 |
| --- | --- | --- |
| 页面 200 但连不上 WS | Worker 的 `ORIGIN_URL` 错 / Tunnel 挂了 | `journalctl -u cloudflared-speedy` |
| `/api/health` 530 | Origin DNS 1016 | `dig +short speedy-origin...` |
| 登录 500 | `.env` 缺 `SESSION_SECRET` 或 DB 不通 | `journalctl -u speedy -n 50` |
| 玩家频繁掉线 | 心跳超时 / 网络抖动 | `grep heartbeat logs/cheat.log` |
| 角色自己往前跑 | `INPUT_STALE_MS` 太大 | 改成 400—500 |
| 拾取宝石没反应 | 距离 > 2.2 / 宝石已被拿走 | `grep pick_gem cheat.log` |
| 偷宠物总失败 | 宠物是野生的 / 在冷却 / 主人离线 | `grep steal_pet cheat.log` |
| CPU 100% | 在线人数超限 / 死循环 | `top -H -p $(pgrep -f server/index.js)` |
| 磁盘满 | 日志 / Docker 镜像 | `du -sh /var/lib/docker /var/log` |
