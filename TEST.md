# 数据库连接测试

本页用于验证 safe db 支持的数据库连接。Docker Compose 提供 MySQL、PostgreSQL、SQL Server、MongoDB、Redis 和 Qdrant；SQLite 直接使用本地文件测试。

## 1. 启动测试数据库

在项目根目录执行：

```bash
npm run db:up
docker compose ps
```

等待 MySQL、PostgreSQL、SQL Server、MongoDB 和 Redis 的状态变为 `healthy`。Qdrant 没有配置容器健康检查，显示为 `Up` 即可。

也可以只启动需要测试的数据库：

```bash
docker compose up -d mysql
docker compose up -d postgres
```

## 2. safe db 连接参数

所有连接的主机均填写 `127.0.0.1`，SSH 隧道均关闭。以下账号和密码仅用于本地测试环境。

| 连接名称 | 类型 | 端口 | 用户名 | 密码 | 默认数据库 | 其他设置 |
| --- | --- | ---: | --- | --- | --- | --- |
| Docker MySQL | MySQL | 60001 | root | `SafeDb_123456` | safedb | - |
| Docker PostgreSQL | PostgreSQL | 60002 | postgres | `SafeDb_123456` | safedb | - |
| Docker SQL Server | SQL Server | 60003 | sa | `SafeDb_123456` | master | 关闭“传输加密”，开启“信任服务器证书” |
| Docker MongoDB | MongoDB | 60004 | root | `SafeDb_123456` | admin | 验证库填写 `admin`，关闭 TLS |
| Docker Redis | Redis | 60005 | default | `SafeDb_123456` | 0 | 关闭 TLS |
| Docker Qdrant | Qdrant | 60006 | - | - | - | API Key 留空，关闭 HTTPS，超时 30000 ms |

新建连接时建议先选择“只读”权限并点击“测试连接”。需要验证建表、写入、修改或删除功能时，再将本地测试连接切换为“审批”或“完全访问”。

## 3. 最小查询验证

连接保存成功后，可分别新建查询并执行以下内容。

### MySQL

```sql
SELECT VERSION() AS version, DATABASE() AS current_database;
```

### PostgreSQL

```sql
SELECT version(), current_database();
```

### SQL Server

```sql
SELECT @@VERSION AS version, DB_NAME() AS current_database;
```

### MongoDB

MongoDB 查询编辑器使用 JSON 数据库命令：

```json
{"ping": 1}
```

### Redis

Redis 查询编辑器每行接受一条 Redis CLI 命令：

```text
PING
SET safedb:test "connected"
GET safedb:test
```

其中 `SET` 需要“审批”或“完全访问”权限。

### Qdrant

Qdrant 查询编辑器使用受限 REST JSON：

```json
{
  "method": "GET",
  "path": "/collections"
}
```

### SQLite

SQLite 不需要 Docker。新建 SQLite 连接，选择一个临时目录并创建 `safedb-test.sqlite`，然后执行：

```sql
SELECT sqlite_version() AS version;
```

## 4. 停止与清理

停止容器并保留测试数据：

```bash
npm run db:down
```

停止容器并删除全部测试数据卷：

```bash
docker compose down -v
```

`docker compose down -v` 会永久删除这些容器中的测试数据，请只在确认不再需要数据时执行。
