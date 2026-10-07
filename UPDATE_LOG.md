# 更新日志

给用这个仓库的人看的：每次更新改了什么、修了什么、要不要你动手。逐条的技术记录在 [CHANGELOG.md](CHANGELOG.md)。

## 0.3.1 · 2026-10-07

桥接自身的运行逻辑一行没动。这次修的是验证脚本，外加一处自称版本的对齐。

### 两个校验脚本不再因为找不到 DSH 的包而崩

`npm run verify:adaptation` 和 `npm run verify:persona` 都要拿 `@deepseek-ai/dsh-persona` 的 schema 去校验 preset。它们原先只去 DSH 安装目录里翻这个包。新一点的 DSH 把它连同其它内部包一起收进了 `app.asar`，磁盘上根本没有可加载的路径，于是两个脚本直接以「找不到模块」退出。

这不是你的 DSH 装坏了，是脚本假设得太多：它默认 DSH 的内部包一定躺在磁盘上。

现在的顺序是，先在 DSH 安装目录里找，找不到就退回仓库自己固定版本的依赖（`@deepseek-ai/dsh-persona@0.2.0-rc.2`，和本仓库适配的那版 DSH 对齐）。两边都取不到时，`verify:adaptation` 把这几项标成跳过并写清原因，不再整个崩掉。教训大概是：校验脚本最好只依赖它自己管得住的东西。

### 另外两处假报错

`mcp 路径指向本仓库` 这条断言原先只看路径里有没有 `qq-bridge` 这个目录名。仓库目录叫别的名字就会红，现在改成跟当前仓库根路径比较。

`verify:adaptation` 原先会直接读 `config.json`。干净克隆里只有 `config.example.json`，所以一跑就崩。现在缺这个文件时跳过那条模型检查。

### 0.3.0 的版本身份本来就是错的

`package.json` 写着 0.3.0，但两个插件和三个 MCP 服务里还是 `0.2.0-r3`。那几条「版本必须一致」的自检在 0.3.0 上本来就是红的。这次一并对齐到 0.3.1。

### 你自己怎么验

```bash
npm ci        # 不要加 --omit=dev，校验用的依赖在 devDependencies 里
node scripts/verify-persona-config.mjs        # 这条不需要 DSH 在跑

# 下面这条需要一个正在运行的 DSH，默认连 127.0.0.1:3080
# 端口不同就用 DSH_BASE_URL 指过去：
#   PowerShell  $env:DSH_BASE_URL='http://127.0.0.1:19387'; npm run verify:adaptation
#   bash        DSH_BASE_URL=http://127.0.0.1:19387 npm run verify:adaptation
npm run verify:adaptation
```

干净克隆里第一条组合命令实测全绿；`verify:adaptation` 在这台机器上 72 项通过、0 失败。

第一次跑如果看到两三处失败，多半是这两种情况。一是 DSH 不在默认端口，用 `DSH_BASE_URL` 指过去就好。二是你从另一份 checkout 跑的：脚本里有几条检查看的是本机 DSH 的配置（MCP 的命令路径、已安装的 preset bundle 是否与仓库源一致），它们只对你实际接线的那份仓库成立。DSH 把自己的包装在 `app.asar` 里时，「守卫名单与 DSH 真实工具名对账」那一项会记为跳过，这是预期，不是失败。

### 要你动手吗

不用。配置不用改，桥接不用重启。想复现验证的话，重装一次依赖（`npm ci`）就够。
