# Vercel + Supabase 上线步骤

这份说明只记录需要粘到控制台的配置，不要把真实密码、令牌或连接串写进仓库。

## 1. Supabase

在 Supabase 项目里准备这些值：

- `DATABASE_URL`：`Connect` -> `Connection string` -> `Transaction pooler`
- `SUPABASE_URL`：`Project Settings` -> `API` -> `Project URL`
- `SUPABASE_SERVICE_ROLE_KEY`：`Project Settings` -> `API` -> `service_role key`

`DATABASE_URL` 里的 `[YOUR-PASSWORD]` 要替换成创建 Supabase 项目时设置的数据库密码。

如果密码包含 `@`、`#`、`/`、`:` 等符号，优先用 Supabase 页面生成的完整连接串，或先把密码做 URL 编码。

## 2. Supabase Storage

头像上传的长期保存应使用 Supabase Storage。先创建 bucket：

- Name: `avatars`
- Public bucket: on
- File size limit: `2 MB`
- Allowed MIME types:
  - `image/png`
  - `image/jpeg`
  - `image/webp`

当前代码已经可以在 Vercel 上使用 Supabase Postgres 保存用户和消息。管理员上传头像仍需要下一步接入 Supabase Storage；在接入前，线上请优先使用项目内置头像。

## 3. Vercel 环境变量

进入 Vercel 项目：

`Settings` -> `Environment Variables`

添加：

```text
ADMIN_PASSWORD=你的管理员密码
APP_SECRET=一串很长的随机密钥
DATABASE_URL=Supabase Transaction pooler 连接串
SUPABASE_URL=Supabase Project URL
SUPABASE_SERVICE_ROLE_KEY=Supabase service_role key
SUPABASE_STORAGE_BUCKET=avatars
```

生成 `APP_SECRET`：

```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

不要在 Vercel 生产环境设置 `ALLOW_DEV_DEFAULTS=1`。

## 4. 部署

本地登录 Vercel：

```powershell
npm i -g vercel
vercel login
```

在项目目录里预部署：

```powershell
vercel
```

生产部署：

```powershell
vercel --prod
```

部署完成后访问：

```text
https://你的项目名.vercel.app/
https://你的项目名.vercel.app/?admin=1
```

## 5. 验证

- 访客选择头像并提交代号后，应进入等待审核状态。
- 管理员从 `/?admin=1` 登录后，应能看到 pending 用户并批准。
- 批准后，用户应能进入频道并发送消息。
- 刷新页面后，用户状态和消息应仍然存在，说明 Supabase Postgres 已生效。
