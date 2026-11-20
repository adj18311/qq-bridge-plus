# 发布流程方案（发布目录独立成仓库）

状态：**方案存档，暂不执行**。等确实需要"别人能 clone / 能看源码 / 能拿增量更新"时再照做。

## 为什么要有这一页

现在的做法是 zip：内部用 `D:\qq-bridge` 开发，对外发一个包。这套对朋友、小范围够用，但它做不了三件事：

- 用户没法 `git pull` 拿增量更新；
- 看不到源码，也没法和某个提交对上；
- 出了问题只能"请更新到 1.1.0"，说不出具体改在哪。

上游 `Derpyu520/qq-bridge` 的做法就是"仓库即发布物"：分支上打 tag，GitHub 自动生成 `Source code (zip)`。要做成那样，发布树必须自己有仓库。

## 前提：一个属于你自己的远程仓库

现在 `git remote` 指向 `Derpyu520/qq-bridge`，那是别人的仓库，推不上去也不该推。要么新建一个（建议**私有**），要么用自己的 GitHub 账号 fork 一份。

## 方案选择

| 方案 | 做法 | 评价 |
|---|---|---|
| **A. 发布目录单独成仓库**（推荐） | `D:\release` 自己 `git init`，推到自己的远程仓库 | 开发仓库与发布仓库彻底分开；发布仓库的历史干净、可以公开；不会把开发文档带出去 |
| B. 在开发仓库里开 `release` 孤儿分支 | `git checkout --orphan release`，把干净树放进去，打 tag | 只有一个仓库，但会把发布树又塞回仓库里——这正是 10-22 刚移出去的东西，不推荐 |

**选 A。** 理由很简单：发布树和开发树的生命周期不一样。发布树要给人看，开发树里有 `WORKLOG`、额度功能代码、个人人格卡，这些不该出现在公开仓库的任何一次提交里。

## A 方案的一次性搭建步骤

1. 在 GitHub 新建一个**空**仓库（不要勾 README / .gitignore / license），建议私有，名字例如 `qq-bridge-release`；
2. 进入发布目录：

   ```powershell
   cd D:\release
   git init -b main
   ```

3. 先放两个文件再提交：
   - `.gitignore`：`state/`、`config.json`、`node_modules/`、`*.zip`、`*.bak-*`、`~$*`
   - `.gitattributes`：`* text=auto eol=lf`
4. 首次提交：

   ```powershell
   git add -A
   git commit -m "release: 1.1.0"
   ```

5. 接上远程并推：

   ```powershell
   git remote add origin https://github.com/<你的账号>/qq-bridge-release.git
   git push -u origin main
   ```

6. 打 tag 并推：

   ```powershell
   git tag -a v1.1.0 -m "1.1.0"
   git push origin v1.1.0
   ```

7. 在 GitHub 上建 Release，指向 `v1.1.0`。这时自动会出现 `Source code (zip)` 和 `Source code (tar.gz)`——和上游那张图一样。要不要再手动附上 `release-pack.py` 打出来的 zip，二选一即可（自动源码包已经够用）。

## 以后每次发版

1. 在发布目录里改文件（文档、版本号、README）；
2. 从开发仓库把需要同步的代码文件复制过来；
3. `git add -A && git commit -m "release: X.Y.Z"`；
4. `git tag -a vX.Y.Z -m "X.Y.Z"`；
5. `git push && git push --tags`；
6. GitHub 建 Release，写发布说明；
7. 需要单独发 zip 时，用 `scripts/release-pack.py` 打一次并记录 sha256。

## 这套里唯一没解决的坑

**开发树到发布树仍然是手工同步。** 10-22 那次 `ed8df85` 漏同步一个测试、导致发布包门禁变红，就是这个原因。

建议补一个只读检查，加在 `release-pack.py` 里：

```
python scripts/release-pack.py --verify-sync --dev "D:\qq-bridge" --src "D:\release"
```

逻辑：对一份"两边都应该一致"的文件白名单（`src/**`、`plugins/**`、`dsh/agent-presets/**`、`scripts/**` 里的共用部分）逐文件比 hash，不一致就列出。它不负责同步，只负责在打包前喊一声"你漏同步了"。

## 边界与注意事项

- **开发仓库永远不外推**。里面有个人人格卡、worklog、额度功能代码、历史本机路径，推出去就是泄漏。
- **发布仓库的任何一次提交都会公开**（如果设为公开）。提交前跑一次 `privacy-scan`。
- 不提交 `config.json`、`state/`，即使 `.gitignore` 写了，也建议提交前 `git status` 亲眼确认一遍。
- 发布仓库里不要放 zip（GitHub Release 的资产是另一回事），否则仓库会随每个版本膨胀。
- 版本号一旦发出就不要覆盖重发。有问题改 `1.1.1`，不要拿 `1.1.0` 重打。

## 现在要不要做

不用。现在 zip 够用，这套的价值在"别人要长期用、要跟进更新"的时候才体现。

触发条件：用户超过十几个人、或者有人开始问"怎么更新"、或者你想把源码公开。
