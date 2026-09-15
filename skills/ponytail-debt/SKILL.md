---
name: ponytail-debt
modes: work, learn
description: 把代码里所有 ponytail: 捷径注释收拢成一份债务台账——哪些地方当时为了省事砍了上限、升级触发条件是什么，防止「临时方案」悄悄变成永久。当用户问「之前偷懒留了哪些坑/有没有 ponytail 标记/看看欠的债/整理简化点」时用。只读只报告，不改代码；用户明确要存档才写文件。
---

# Ponytail Debt · 捷径债务台账

每个故意的 ponytail 简化都用一条 `ponytail:` 注释标了它的上限和升级路径。本技能把这些收进一张台账，让「缓一缓」不至于悄悄变成「就这样了」。

## 扫描

在工作区里 grep 注释标记（跳过 `node_modules`、`.git`、构建产物；按栈补其它注释前缀）：

用 search_files 工具，正则 `(#|//) ?ponytail:`；工作区大或要精确行号时可用 run_shell 跑 `grep -rnE '(#|//) ?ponytail:' .`。

每一处命中 = 台账一行。带注释前缀能把「正文里只是提到这个约定」的句子挡在台账外。

## 输出

按文件分组，一行一个标记：

`<文件>:<行>, 当时简化了什么。ceiling: 砍到的上限。upgrade: 该回来重看的触发条件。`

约定是 `ponytail: <上限>, <升级路径>`，所以直接从句子里抽上限和触发条件。想给每行加责任人，就补 `git blame -L<行>,<行>`。

**腐化风险**：任何没写升级路径/触发条件的 `ponytail:` 注释，打 `no-trigger` 标签——这些才是会无声烂掉的。

末尾给 `<N> 个标记, <M> 个 no-trigger`。一个没有就 `No ponytail: debt. Clean ledger.`（没欠债，账本干净）。

## 边界

- 只读、只报告，**什么都不改**。
- 要留档时才把台账写进文件（如 `PONYTAIL-DEBT.md`），且要先问用户。
- 一次性报告。

---

> 改编自 github.com/DietrichGebert/ponytail 的 ponytail-debt（MIT）。扫描命令已换成本项目的 search_files / run_shell。
