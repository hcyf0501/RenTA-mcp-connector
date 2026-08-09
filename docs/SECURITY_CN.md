# 私有发布与安全说明

## 发布前检查

1. 确认 `config/.env` 不在 Git 索引中，并且 `.gitignore` 已生效。
2. 不提交账号、密码、API Token、私钥、证书、个人绝对路径、日志或运行产物。
3. 不把测试用 HTTP 地址当作正式默认地址。正式环境应配置 HTTPS 域名，并在 `config/.env` 中由每位用户填写。
4. 运行 `node --test tests/server.test.mjs` 和插件校验，再检查 `git diff --cached`。

## GitHub 私有仓库

在 GitHub 创建名为 `renta-mcp-connector` 的 **Private** 仓库。不要在网页上初始化 README、LICENSE 或 .gitignore，以免与本地发布目录产生首次合并冲突。仅邀请确实需要使用连接器的成员，并为默认分支启用合并审查和推送保护。

在 WSL 中，从该目录执行：

```bash
cd /path/to/renta-mcp-connector
git init
git branch -M main
git add .
git diff --cached --check
git diff --cached
git commit -m "feat: add private RenTA MCP connector"
git remote add origin git@github.com:<OWNER>/renta-mcp-connector.git
git push -u origin main
git tag -a v0.1.0 -m "Initial private MCP connector release"
git push origin v0.1.0
```

使用 SSH Key 或 GitHub Fine-grained Token 登录 GitHub；不要把密码或 Token 写入命令、脚本或仓库文件。

## 平台访问控制

私有仓库不是 RenTA 的权限边界。获得平台地址的人仍可能绕过连接器直接发送 HTTP 请求。因此生产平台必须在服务器端验证 Token、用户身份和调用权限，并按用户或组织记录审计日志。Token 应可撤销、最小权限、可设置有效期；一旦疑似泄露，立即在平台端吊销并重新签发。

## 更新流程

每次发布前在干净环境中复制 `config/.env.example` 为 `config/.env`，填入测试凭据，运行本地测试。确认后删除或保留为未跟踪文件，再提交源代码。不要把模型权重、`node_modules`、演示生成的论文或平台返回的用户数据加入仓库。
