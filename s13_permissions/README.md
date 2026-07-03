# s13 · 权限与审批：在"模型意图"和"真副作用"之间加一道闸

> **格言：能不能干这件事，别问模型，问规则链——第一个命中的说了算。**

前十二篇的 agent 有一双手（`run_shell`、`write_file`），却没有任何约束：模型说 `git push`
它就 push，说读 `.env` 它就读。demo 里无所谓，放到真项目里，这是个会删库、会外泄密钥、
会往生产分支乱推的东西。本章给这双手装一层闸——但不是靠"求模型别乱来"，而是靠一条
**声明式、有序**的规则链。

## 每次都弹窗问，和什么都不问，都是错的

给危险操作装闸，最容易掉进的两个极端：

- **什么都不问**：全放行。等于没装闸，迟早出事。
- **什么都问**：每个工具调用都弹窗等用户点"允许"。跑个测试要点二十次确认，没人受得了——最后用户一定会习惯性狂点"允许",闸形同虚设。

正解是中间那条：**大部分操作按预设规则自动裁决，只有拿不准的才问。** 于是问题变成
"怎么把'裁决'写成一套可预测、可复现的东西"，而不是每次交给模型或用户临场判断。

答案是一条规则链，每条规则形如"**什么工具 / 什么命令前缀 / 什么路径 → allow / deny / ask**"，
从上到下**首匹配**。这又是全系列那条老原则的一次现身（s03 看门狗、s11 闸门）：
**凡是重要的判定，都不交给自由心证，交给确定性的数据结构。**

## 先跑演示（不需要 API key）

```sh
node s13_permissions/demo.mjs
```

一条全局规则链 + 7 个工具调用请求，看首匹配怎么裁决（真实运行输出）：

```
━━━ 场景 A：只有全局规则（首匹配 + 三态）━━━
  ✅ 放行    run_shell(git status)         命中规则 [allow "git status…"]
  🚫 硬拒   run_shell(git push origin main) 命中规则 [deny "git push…"]
  🚫 硬拒   run_shell(rm -rf node_modules)  命中规则 [deny "rm -rf…"]
  ❓ 问用户   read_file(.env.local)          无规则命中 → default
  ✅ 放行    read_file(src/engine.ts)       命中规则 [allow src/**]
  ❓ 问用户   run_shell(npm test)            无规则命中 → default
  ❓ 问用户   write_file(src/new.ts)         无规则命中 → default
```

## 设计：三个关键决定

### ① 三态，不是两态：allow / deny / ask

只有"允许/拒绝"两态是不够的——大量操作属于"这次得看情况"，既不能默认放行也不该直接拒绝。
所以 verdict 有三态，`ask` 是一等公民：**命中 `ask` 就把决定权交还用户**（弹一次审批），
用户的选择还可以"记住"，下次同类操作升级成 `allow`。没有 `ask` 这一档，你就只能在
"太松"和"太紧"之间二选一。

### ② 首匹配 + 顺序即优先级

规则链从上到下扫，**第一个命中的规则直接定案，后面的不看了**。这带来一个极简的心智模型：
危险的 `deny` 放最上面（`git push` / `rm -rf` 谁也别想绕过），安全的 `allow` 放中间
（`git status` / 读 `src/**` 免打扰），剩下没人认领的，靠链尾的 `default: "ask"` 兜底。

```js
export function evaluatePermission(rules, req, defaultVerdict = "ask") {
  for (const rule of rules) {
    if (ruleMatches(rule, req)) return { verdict: rule.verdict, rule };
  }
  return { verdict: defaultVerdict, rule: null };   // 不认识的操作，就问
}
```

一条规则里可以给多个选择器（工具名 + 命令前缀 + 路径 glob），**都命中才算命中**（AND）。
命令前缀匹配前记得先 `trimStart()`——模型偶尔会在命令前带个空格，`" git push"` 不该逃过
`git push` 的 deny。这种小地方不做，闸就有缝。

### ③ workspace 覆盖 global，靠"排在前面"就够了

同一套机制天然支持分层：全局规则（`~/.reina`，对所有项目生效）+ 项目规则（`.reina`，只这个项目）。
合并时**把项目规则排在全局前面**，首匹配就让项目规则自动覆盖全局——不需要任何"优先级"字段。

演示的场景 B 里，一个可信的 demo 项目预授权了 `npm test` 和写 `src/**`：

```
━━━ 场景 B：叠加 workspace 规则（项目里预授权，覆盖全局）━━━
  ✅ 放行    run_shell(npm test)            命中规则 [allow "npm test…"]   （被 workspace 提升）
  ✅ 放行    write_file(src/new.ts)         命中规则 [allow src/**]        （被 workspace 提升）
  🚫 硬拒   run_shell(git push origin main) 命中规则 [deny "git push…"]    （global 的 deny 仍在）
```

注意最后一条：项目能把 `npm test` 从"问"提升到"放行"，**却提不动 `git push` 的 deny**——
因为那条 deny 在 global 里、且排在更前面。**放权是加白名单，不是拆闸。** 这条边界很重要：
你可以让某个信得过的项目少弹几次窗，但不该让项目配置能解除全局的硬拒。

## 接进真实 agent

免 key 版是纯函数；接进 s01 的循环也只是薄薄一层：**派发工具之前**先 `evaluatePermission`——
`allow` 直接执行，`deny` 回一条 observation 告诉模型"这个不许，换个方式"，`ask` 挂起循环、
向用户发一个审批请求，拿到答复再继续（复用 s05 的中断/恢复思路：审批期间循环是暂停的）。
危险操作的裁决因此永远发生在**副作用之前**，而不是"先跑了再说"。

## 真实产品对照

本章对应 Reina 的 `packages/core/src/permissions.ts`：`PermissionRule` 的形状、`evaluatePermission`
的首匹配、`ruleMatches` 里的 `commandPrefix` / `pathGlob` 选择器、一个自己写的 `globMatches`
小匹配器，以及"workspace 规则合并时排在 global 之前"的覆盖语义——和本章一致。生产版还多两件
本章略过的事：规则文件按 mtime 缓存（避免每次求值都读盘），以及 shell 命令的审批走
`shell-approval.ts` 做更细的命令解析（把一行 `a && b` 拆成多条分别裁决，别让危险命令躲在
`&&` 后面）。三态里的 `ask` 对应桌面端弹出的审批卡片，用户点"总是允许"就把这条固化进
workspace 规则——正是②③的闭环。

Claude Code 侧同款：它的权限系统也是 allow/deny/ask 三态 + 规则匹配，`~/.claude/settings.json`
里的 `permissions.allow` / `deny` 就是这条链，项目级 `.claude/settings.local.json` 覆盖全局——
和本章的 workspace-over-global 一模一样。

## 动手挑战

1. 给 `ask` 加"记住选择"：用户对 `run_shell(npm test)` 点了一次"总是允许"，就往 workspace 规则里
   追加一条 `allow`，下次同类请求不再问。想清楚——记住的粒度该是"这条命令"还是"这个前缀"？
   记太宽（`allow run_shell *`）等于拆闸，记太窄（整条命令逐字匹配）等于没记。
2. 本章的 `commandPrefix` 是纯前缀匹配，`git push` 能拦住 `git push origin main`，但拦得住
   `git   push`（多个空格）或 `git push；rm -rf /`（拼接命令）吗？跑一下试试，然后想想为什么
   Reina 要专门写一个 `shell-approval.ts` 把命令**解析**后再逐段裁决，而不是简单比前缀。

---

| [← 上一章：合体](../s12_full_agent/README.md) | [目录](../README.md) | [下一章：Provider 兼容层 →](../s14_provider_compat/README.md) |
|---|---|---|
