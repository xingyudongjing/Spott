# Spott Control Room

Spott 的独立运营后台，覆盖用户与局头治理、活动与群组审核、内容安全、积分双人审批、配置 Revision、聚合数据、不可变审计和受控导出。

## Local development

```bash
npm install
npm run dev
```

- Web: `http://localhost:3001`
- API: `NEXT_PUBLIC_API_URL`，本地默认 `http://127.0.0.1:4100/v1`
- Node.js: `>=24 <25`

本地开发时客户端仅向 localhost API 注入开发运营身份头；生产构建不会包含该行为。生产环境必须使用独立 Ops 会话、MFA、短会话和服务端 RBAC。

## Verification

```bash
npm run lint
npm run build
npm test
```

`npm test` 会验证全部运营模块可服务端渲染、浅色设计系统、统一 SVG 图标、真实 API 契约声明和移动端表格转换。

## Security boundaries

- 不与公开 Web 共享认证 Cookie、CSP 或部署域名。
- 敏感数据默认脱敏，查看用途与每次导出均写审计。
- 活动审核、内容处置和配置审批使用版本锁；重复写操作使用幂等键。
- 积分人工调整遵循“申请 → 审批 → 执行”，申请人与审批人分离。
- 导出文件加水印、短期有效并限制下载次数。
