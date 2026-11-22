# Operations notes

Field notes from running Speedy on Oracle Cloud Always Free, ordered by how
badly each item can break production.

---

## 1. Always Free limits

### 1.1 Instance shapes

Ampere A1 gives 4 OCPU and 24 GB total per tenancy across all A1 instances. Go
over that and OCI reclaims capacity, which means the instance is stopped and
deleted, not throttled.

The AMD shape, `VM.Standard.E2.1.Micro`, is 1/8 OCPU with 1 GB of memory, two
per account. The instance this project was measured on is 2 cores and 956 MB:
enough for 30 concurrent players, not enough for anything else.

Keep the game on its own small instance and leave the panel and database
elsewhere if you can.

### 1.2 Bandwidth

Outbound traffic is free up to 10 TB per month, then billed per GB. Inbound is
free.

Bandwidth estimate at 30 concurrent players:

| Traffic | Packet | Rate | Per player | 30 players |
| --- | --- | --- | --- | --- |
| Input (up) | ~150 B | 20 Hz | 3 KB/s | 90 KB/s |
| Snapshot (down) | 2 to 4 KB | 10 Hz | 25 KB/s | 750 KB/s |
| Self state (down) | ~200 B | 10 Hz | 2 KB/s | 60 KB/s |

About 6.5 Mbps peak, roughly 2.9 GB per hour. Eight hours a day lands near
700 GB a month, far under the cap. A browser left open and idle still consumes
bandwidth, so consider dropping idle sessions.

### 1.3 Compute

Free Tier instances are burstable with no CPU credit guarantee; sustained load
gets throttled. A 20 tick/s simulation costs 5 to 15 percent of one core on a
1 GB machine. Do not compile, run several containers, or host the database,
game and panel together.

### 1.4 Public IP

A rebuilt instance gets a new public IPv4. Behind a Cloudflare Tunnel this does
not matter, because the tunnel dials out, which is one reason to prefer it over
exposing ports. With Nginx and Let's Encrypt, an IP change needs a DNS update
and briefly breaks certificate renewal.

---

## 2. Network and dropped connections

### 2.1 Idle sockets getting cut

NAT gateways and security groups drop TCP connections that look idle, often
after 5 to 30 minutes.

The server pings both ways every 3 seconds and drops a connection that sends
nothing for 10 seconds. The client reconnects up to 5 times, one second apart.

If you change this code, do not remove the heartbeat or raise
`heartbeatIntervalMs` past about 30 seconds.

### 2.2 Tunnel reconnects

```bash
sudo journalctl -u cloudflared-speedy -n 100 --no-pager | grep -iE "error|retry|reconnect"
```

An occasional `Retrying connection in up to 1m4s` is normal and heals in
seconds. If it repeats, check outbound 7844/UDP and try HTTP/2 transport:

```bash
sudo tee -a /etc/cloudflared/speedy-game.yml <<'EOF'
protocol: http2
EOF
sudo systemctl restart cloudflared-speedy
```

### 2.3 Dashboard ingress not taking effect

A remote managed tunnel (`config_src: cloudflare`) reads its ingress from the
dashboard or API. Ingress written into the local YAML is ignored, and the two
configs then disagree.

```bash
sudo cloudflared tunnel --config /etc/cloudflared/speedy-game.yml tunnel info speedy-game
```

### 2.4 Precheck false alarm

cloudflared sometimes reports `UDP Connectivity FAIL` while HTTP/2 works and
traffic flows. Read the summary line:

```
SUMMARY: Environment is healthy. cloudflared will use 'quic' as primary protocol.
```

That line is the verdict.

---

## 3. PostgreSQL

### 3.1 Exposed database port

The dangerous default. A container started with `-p 5432:5432` listens on
`0.0.0.0`, which puts the database on the public internet.

```bash
sudo ss -tlnp | grep 5432
# want 127.0.0.1:5432, never 0.0.0.0:5432
```

Fix it in the panel's container settings, or as a backstop:

```bash
sudo ufw deny 5432
```

The project's `DATABASE_URL` uses loopback, so nothing else needs to change.

### 3.2 Connections failing after a container restart

The pool logs and recovers, but a restarted database container usually needs a
service restart:

```bash
sudo systemctl restart speedy
```

The unit already declares `After=docker.service`, so a full reboot orders
correctly.

### 3.3 Disk filling up

```bash
df -h /
sudo docker system df
sudo journalctl --disk-usage
```

```bash
sudo journalctl --vacuum-size=200M
sudo docker image prune -a
sudo truncate -s 0 /opt/speedy/logs/cheat.log   # after archiving it
```

Cap journald permanently:

```bash
sudo sed -i 's/^#SystemMaxUse=.*/SystemMaxUse=200M/' /etc/systemd/journald.conf
sudo systemctl restart systemd-journald
```

### 3.4 Backups

```bash
sudo bash /opt/speedy/deploy/backup-db.sh
```

It dumps through `docker exec`, gzips to `/var/backups/speedy`, verifies the
archive opens and contains the users table, then prunes anything older than 14
days.

```bash
sudo crontab -e
# 10 3 * * * /usr/bin/bash /opt/speedy/deploy/backup-db.sh >> /var/log/speedy-backup.log 2>&1
```

Rehearse a restore once, or the backup does not exist:

```bash
gunzip -c /var/backups/speedy/speedy-20261122-031000.sql.gz | \
  sudo docker exec -i <container> psql -U speedy -d speedy_test
```

### 3.5 Losing gem counts

Gems flush in batches every 5 seconds, so a `kill -9` loses up to 5 seconds of
pickups. `SIGTERM`, which `systemctl stop` and `restart` send, flushes first and
exits cleanly. Never stop the service with `kill -9`.

---

## 4. Node and process management

### 4.1 Memory ceiling

```bash
sudo systemctl status speedy      # Memory field
sudo journalctl -u speedy -n 100 | grep -iE "heap|oom"
```

The unit sets `MemoryMax=512M`; going over means systemd kills and restarts it.
Frequent restarts mean either far more than 30 players or an attack. Check
`/api/health` for the online count and the size of `logs/cheat.log`.

### 4.2 Restart storms

systemd allows 10 restarts in 60 seconds, then stops:

```
StartLimitIntervalSec=60
StartLimitBurst=10
```

```bash
sudo systemctl reset-failed speedy
sudo systemctl start speedy
```

### 4.3 Time zone

The server logs UTC in ISO 8601 with a Z suffix. To show local time in
`journalctl`:

```bash
sudo timedatectl set-timezone America/New_York
sudo systemctl restart speedy
```

---

## 5. Cloudflare

### 5.1 Error 1016, origin DNS

The Worker cannot resolve `ORIGIN_URL`.

1. `dig +short speedy-origin.<your-domain>`
2. Confirm the record is a CNAME to `<TunnelID>.cfargotunnel.com`
3. `sudo systemctl status cloudflared-speedy`
4. `curl http://127.0.0.1:8080/api/health` on the origin

### 5.2 Worker deploy rejects the name

```
Expected "name" to be of type string, alphanumeric and lowercase with dashes only
```

Worker names are lowercase. `"name": "speedy"`, not `"Speedy"`.

### 5.3 DNS collisions

Do not point one hostname at both a Worker and a tunnel:

| Hostname | Target | Purpose |
| --- | --- | --- |
| `speedy.<domain>` | Worker | Player entry point |
| `speedy-origin.<domain>` | Tunnel | Worker only, never public |

### 5.4 WebSocket dropped by the edge

The Workers runtime recycles WebSocket connections during deployments. That is
expected, and the client reconnects, so players see a brief reconnect banner. If
it happens constantly, check that the Worker forwards the `Upgrade` header.

---

## 6. Security

### 6.1 Three things to do first

```bash
sudo ufw default deny incoming
sudo ufw allow 22/tcp
sudo ufw enable

sudo sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh

sudo ss -tlnp | grep 5432      # must be 127.0.0.1
```

### 6.2 File permissions

```bash
sudo chown speedy:speedy /opt/speedy/.env
sudo chmod 600 /opt/speedy/.env
```

A leaked `SESSION_SECRET` lets anyone forge a session. Rotate it and restart;
every existing ticket becomes invalid at once.

### 6.3 The cheat log

`logs/cheat.log` contains user ids and coordinates. Do not publish it. Rotate:

```
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

## 7. Capacity

### 7.1 Concurrent players

| Machine | Practical ceiling | Notes |
| --- | --- | --- |
| 1 GB, 1 core | 30 | The project default |
| 2 GB, 2 cores | 60 to 80 | Raise `MAX_ONLINE` |
| 24 GB A1, 4 OCPU | 300+ | The event loop becomes the limit first |

One Node process is single threaded. Beyond roughly 300 players, GC pressure
shows up as tick jitter. Scale by sharding rooms across processes and ports
rather than pushing one process harder.

### 7.2 Bandwidth ceiling

Reduce downlink before anything else:

1. `BROADCAST_RATE` from 10 to 8, which is hard to notice
2. Cull distant players from the snapshot by radius
3. Send gems and pets only when they change

Never lower the 20Hz input rate. That is what the controls feel like.

---

## 8. Quick reference

| Symptom | Likely cause | Command |
| --- | --- | --- |
| Page loads, socket never opens | Wrong `ORIGIN_URL` or tunnel down | `journalctl -u cloudflared-speedy` |
| `/api/health` returns 530 | Origin DNS, error 1016 | `dig +short speedy-origin...` |
| Sign in returns 500 | Missing `SESSION_SECRET` or no database | `journalctl -u speedy -n 50` |
| Players drop repeatedly | Heartbeat or path loss | `grep heartbeat logs/cheat.log` |
| Character slides on its own | `INPUT_STALE_MS` too high | set 400 to 500 |
| Pickup does nothing | Beyond 2.2 m, or the gem is gone | `grep pick_gem cheat.log` |
| Steal always fails | Wild pet, cooldown, or owner offline | `grep steal_pet cheat.log` |
| CPU pinned | Too many players, or a loop | `top -H -p $(pgrep -f server/index.js)` |
| Disk full | Logs or Docker images | `du -sh /var/lib/docker /var/log` |
