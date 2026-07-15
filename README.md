# Spott

Spott 是面向日本本地活动的原生 iOS、Web/PWA、运营后台与后端平台。本仓库以 PostgreSQL 为唯一权威事实源，并通过版本化 REST/OpenAPI、事务 Outbox 和增量 Pull 在 iOS 与 Web 之间同步。

## 工程结构

- `Spott/`：SwiftUI iOS 应用、产品文档与 iOS 资源
- `apps/web`：Next.js 公开站、用户中心与局头工作台
- `apps/ops`：独立安全边界的运营后台
- `services/api`：NestJS + Fastify 模块化单体 API
- `services/worker`：Outbox、通知、候补、积分与媒体异步任务
- `packages/contracts`：OpenAPI 3.1 单一契约
- `packages/domain`：状态机、权限、账本与同步等纯领域逻辑
- `packages/design-tokens`：iOS/Web 共用语义设计令牌源
- `database`：PostgreSQL 18 显式 SQL 迁移与测试种子
- `infrastructure`：本地容器与 AWS 东京区域 IaC
- `docs`：ADR、Runbook、验收证据与数据治理材料

## 本地启动

要求 Node.js 24 LTS、pnpm 11、PostgreSQL 18 和 Redis 兼容服务。

如已安装 Docker，可一次启动 PostgreSQL、Redis、MinIO、ClamAV、Mailpit、迁移器和后台 worker：

```bash
pnpm infra:up
```

本地邮件收件箱位于 `http://localhost:8025`，MinIO 管理台位于 `http://localhost:9101`。

```bash
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Web 默认位于 `http://localhost:3000`，Ops 位于 `http://localhost:3001`，API 位于 `http://localhost:4100/v1`。iOS 工程使用 `Spott.xcodeproj`。

## 发布门禁

`pnpm check` 执行 Lint、TypeScript 严格检查、单元/属性测试与构建。集成、E2E、负载、iOS 构建和安全扫描由 CI 执行；对应证据记录在 `docs/acceptance`。
