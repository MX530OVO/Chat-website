# 暗号频道

一个可以部署到云服务器的赛博风聊天室。访客先提交代号和头像，管理员审核通过后才能进入频道聊天。

## 本地预览

Windows 上可以直接双击：

```text
启动聊天网站.bat
```

本地预览默认管理员口令是：

```text
727577
```

启动后打开聊天页：

```text
http://127.0.0.1:8787
```

头像选择页：

```text
http://127.0.0.1:8787/avatars.html
```

管理员控制台：

```text
http://127.0.0.1:8787/?admin=1
```

管理员控制台是隐藏入口。普通访客打开首页看不到管理按钮；你自己在地址后加 `?admin=1` 才会加载控制台。旧的 `/admin.html` 会自动跳回聊天室并打开控制台。

## 手动启动

首次运行前安装依赖：

```powershell
python -m pip install -r requirements.txt
```

正式运行时必须设置环境变量：

```powershell
$env:ADMIN_PASSWORD="换成你的管理员口令"
$env:APP_SECRET="换成一串足够长的随机密钥"
$env:DATABASE_PATH="data/chat.sqlite3"
python server.py
```

## Docker 部署

在服务器项目目录中设置环境变量后启动：

```bash
export ADMIN_PASSWORD="换成你的管理员口令"
export APP_SECRET="换成一串足够长的随机密钥"
docker compose up -d --build
```

默认端口是 `8787`。如果要改外部端口：

```bash
PORT=8080 docker compose up -d --build
```

## 头像

- `public/assets/avatar-source.jpg` 是这次提供的原始头像拼图。
- `public/assets/avatars/` 里是从拼图裁切出的 10 张独立头像。
- 服务启动时会把这些头像同步到 `data/avatars/`，并出现在头像选择页和聊天头像库里。
- 头像选择页保存后，会写入本机选择；如果本机已有代号，也会同步到服务器身份。

## 数据和备份

- Docker 部署时，数据库保存在 `chat-data` 数据卷里的 `/data/chat.sqlite3`。
- 本地手动运行时，默认数据库是 `data/chat.sqlite3`。
- 头像文件保存在数据库同目录下的 `avatars` 文件夹，例如本地默认是 `data/avatars`。
- 聊天消息长期保存；管理员撤回消息后，数据库仍保留记录，前端显示“已撤回”。
- 管理员清屏只会清空当前频道显示，数据库记录不会被物理删除。

## 管理能力

- 管理员控制台内置在聊天室页面里：登录后可以在同一个页面完成全部管理。
- 审核待进入用户。
- 拒绝申请。
- 按设备码封禁用户，并默认附带 IP 指纹封禁。
- 撤回最近消息。
- 清空当前频道显示。
- 上传、改名、排序、启用或停用可选头像。

## 生产建议

- 不要在公网使用本地默认口令。
- `APP_SECRET` 应该使用随机长字符串。
- 如果要绑定域名和 HTTPS，可以在服务器前面加 Nginx、Caddy 或云平台反向代理。
