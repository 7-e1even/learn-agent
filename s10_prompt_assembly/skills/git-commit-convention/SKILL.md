---
name: git-commit-convention
description: 写 git 提交信息、整理提交历史时使用——Conventional Commits 的格式、类型选择和拆分原则。
---

# Git 提交规范

## 格式

```
<type>(<scope>): <subject>

<body>

<footer>
```

- `type` 必选，`scope` 可选（改动涉及的模块/目录名），`subject` 必选。
- subject 用祈使句（"add" 不是 "added"），不加句号，不超过 50 字符。
- body 讲**为什么改**，不复述 diff 里能看到的"改了什么"。
- 一次提交只做一件事：重构和功能修改不混在同一个提交里。

## type 怎么选

| type | 用于 |
|---|---|
| feat | 新功能（用户可感知的行为变化） |
| fix | 修 bug（引用 issue 编号写进 footer） |
| refactor | 不改行为的结构调整 |
| test | 只增改测试 |
| docs | 只改文档/注释 |
| chore | 构建、依赖、CI 等工程杂务 |

拿不准 feat 还是 fix：问"用户之前的预期是什么"——之前就该这样但没做到 = fix；之前没有这个预期 = feat。

## footer

- 不兼容变更：以 `BREAKING CHANGE:` 开头，说明迁移方法。
- 关联 issue：`Closes #123`。

## 提交前自查

1. `git diff --staged` 过一遍：有没有混进无关文件（调试代码、锁文件意外变更）？
2. 这个提交单独 revert 时，代码库还能编译/测试通过吗？不能 → 拆分方式有问题。
3. subject 能让三个月后的自己一眼看懂吗？
