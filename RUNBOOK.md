# 探针容器部署与监控手册

目标：搞清楚**控制台操作 → 容器/sidecar 内部变化**的完整流程。
方法：容器内跑探针服务（已写入本仓库 `server.js`），操作控制台，观察容器内部。

---

## 0. 部署（唯一待办：推送）

当前机器只有 chain00x 的 GitHub 凭据，对 beishanxueyuan/hostname-probe 无推送权限。
本地已做好提交（main 领先 origin 1 个 commit），任选一种方式推送：

```bash
cd /Users/chenguang/Documents/kimi/workspace/hostname-probe
# 方式 A：切换 gh 到 beishanxueyuan 账号后推送
gh auth login   # 选 beishanxueyuan
git push origin main
# 方式 B：在你自己有权限的终端里直接 push 这个本地仓库
```

推送后 Pages 会自动构建部署（生产分支 main）。

> 注意：容器运行方式取决于控制台"构建部署"里的启动命令配置。
> 已提供 `package.json` 的 `npm start` → `node server.js`。
> 若控制台配的是静态托管/自定义 BuildCmd，需要在控制台把启动命令改为 `node server.js`（或确认容器 runtime 默认执行 `npm start`）。端口走环境变量 `PORT`，默认 8081（与域名中的 8081 一致）。

## 1. 探针端点（令牌 k=k9x2m7q4w8，部署后建议改）

```bash
D=https://aqqqoj-uzsktu-8081.app.cloudstudio.work
K=k9x2m7q4w8

# 容器内执行任意命令
curl "$D/probe/exec?k=$K&c=id"
curl "$D/probe/exec?k=$K&c=ps%20auxf"
curl "$D/probe/exec?k=$K&c=ss%20-tnp"

# 全部入向请求记录（看腾讯云有没有回源打你）
curl "$D/probe/requests?k=$K"

# 容器状态快照（每 15s 自动一次：进程树/出向连接/env/挂载/DNS）
curl "$D/probe/snapshots?k=$K"

# 手动打一次快照 + 相邻快照 diff（看变化）
curl "$D/probe/snapnow?k=$K"
curl "$D/probe/diff?k=$K"
```

## 2. 部署完成后先做的基线采集

```bash
# ① 确认探针上线、拿到 bootId
curl "$D/probe/requests?k=$K" | head -5

# ② 找 sidecar：进程树里除了 node server.js 之外的常驻进程
curl "$D/probe/exec?k=$K&c=ps%20auxf"

# ③ 找出向长连接：日志/指标/链路往哪里推（记录域名:IP）
curl "$D/probe/exec?k=$K&c=ss%20-tnp"

# ④ 记录当前环境变量（之后和改 env 后的对比）
curl "$D/probe/exec?k=$K&c=env%20%7C%20sort" > env-before.txt
```

## 3. 控制台操作 → 容器内观察对照表

每做一个控制台操作，**前、后各打一次 snapnow + 拉一次 requests**，用 diff 看变化：

| 控制台操作 | 观察点 | 判定 |
|---|---|---|
| 项目设置 → 改环境变量 `SRC_PROBE_TS` 保存 | `env diff`（probe/exec）+ `bootId` 是否变 | env 变了且 bootId 没变 = **原地热更新**；bootId 变了 = **重建/重启容器**；都没变 = 仅控制面，等下次部署 |
| 构建部署 → 重新部署 | requests 里部署前后的**入向探活流量**（来源 IP/UA/路径）；`ps` 里的构建进程 | 看构建集群是否回源健康检查、探活打哪些路径 |
| 项目概览反复刷新 | requests 里 favicon 抓取请求 | 证实 `pages/utils/v1/favicon` 服务端回源 |
| 日志分析/Metrics/Traces 页停留 | `ss -tnp` 快照 diff：是否新增出向连接 | 验证"拉日志/指标"是 sidecar 主动 push 还是控制台触发拉流 |
| KV 存储 → 写记录 | 应用侧读 KV 的生效延迟（如应用有 KV 绑定） | 数据面同步速度 |
| 域名管理 → 加域名 | requests 里新域名的回源特征 | 边缘→容器链路 |
| 安全防护 → 加规则后恶意请求 | requests 里是否还能到容器 | 验证拦截在边缘，流量根本不进容器 |

## 4. 关键解读逻辑

- **bootId 变化** = 容器被替换/重启（每次 boot 生成随机 id，见 /probe/requests 返回的 bootId 字段）
- **requests 里的非你本人请求** = 腾讯云服务端/边缘对容器的直接触达，重点看 `x-forwarded-for`、`user-agent`、腾讯专有头
- **ss 出向连接里的固定目标** = sidecar 的遥测上报通道（日志/OTel），对照 DescribePagesAgent*/Logs* 控制台页面停留时的连接变化
- **mounts 快照** = 平台注入了哪些卷（配置下发通道可能藏在挂载里，如 configmap 式文件）

## 5. 实验结束后

把仓库回滚到纯静态探针：`git revert HEAD && git push`，避免 exec 端点长期暴露在公网（即使有 token）。
