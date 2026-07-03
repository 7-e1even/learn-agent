#!/usr/bin/env node
// s10 免 key 演示：system prompt 的拼装是确定性的，技能目录是"热插拔"的。
//
//   node s10_prompt_assembly/demo.mjs
//
// 三个场景：
//   一、扫描 skills/ 目录，打印拼装出的技能目录 section 和整个 system prompt 的分段账单
//   二、字节稳定性：正确拼装两次逐字节一致；把时间戳塞进 system 的错误示范每次都变
//   三、热插拔：运行中新增一个 SKILL.md，重扫后目录里自动多出一行 —— 引擎零改动

import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt, loadSkills, formatSkillsSection } from "./prompt.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bar = (title) => console.log(`\n━━━ ${title} ━━━\n`);

// 与 agent.mjs 相同的拼装（身份 / 环境 / 工具指引 / 技能目录）
function assemble(skills) {
  const sections = [
    "你是一个运行在用户终端里的编程助手。",
    `## 环境\n当前目录：${process.cwd()}\n操作系统：${process.platform}`,
    "## 工具使用\n优先用专用工具操作文件；run_shell 用于其余一切。",
    formatSkillsSection(skills),
  ];
  return { sections, prompt: buildSystemPrompt(sections) };
}

// ─── 场景一：目录 section 长什么样 ───────────────────────────────────────

bar("场景一：扫描 skills/，拼出目录 section");

const skills = loadSkills(path.join(HERE, "skills"));
console.log(formatSkillsSection(skills));

const { sections, prompt } = assemble(skills);
console.log("\nsystem prompt 分段账单（顺序即拼接顺序）：");
const labels = ["① 身份", "② 环境", "③ 工具指引", "④ 技能目录"];
sections.forEach((s, i) => console.log(`  ${labels[i]}  ${Buffer.byteLength(s, "utf8")} 字节`));
console.log(`  合计 ${Buffer.byteLength(prompt, "utf8")} 字节（含段间空行）`);

const bodyBytes = skills.reduce((n, s) => n + Buffer.byteLength(s.body, "utf8"), 0);
console.log(
  `\n对比：${skills.length} 个技能的正文共 ${bodyBytes} 字节，一个都没进 prompt —— ` +
    `目录只花了 ${Buffer.byteLength(formatSkillsSection(skills), "utf8")} 字节。`,
);

// ─── 场景二：字节稳定性 ─────────────────────────────────────────────────

bar("场景二：确定性拼装 vs 塞时间戳的错误示范");

const again = assemble(loadSkills(path.join(HERE, "skills"))).prompt;
console.log(`正确拼装：重扫磁盘 + 重新拼装，两次结果${prompt === again ? "逐字节一致 ✅ → 前缀缓存命中" : "不一致 ❌"}`);

const wrong = () => buildSystemPrompt([`当前时间：${new Date().toISOString()}`, ...sections]);
const w1 = wrong();
await new Promise((r) => setTimeout(r, 5));
const w2 = wrong();
console.log(`错误示范：把"当前时间"塞进 system，两次结果${w1 === w2 ? "一致" : "不一致 ❌ → 每轮整个前缀全部 cache miss"}`);
console.log("易变信息的正确去处：附在最新一条用户消息尾部（见 agent.mjs 的 withVolatileReminder）。");

// ─── 场景三：热插拔 ─────────────────────────────────────────────────────

bar("场景三：运行中新增一个技能，重扫即出现");

// 在临时目录里演示，不污染本章自带的 skills/
const tmp = mkdtempSync(path.join(os.tmpdir(), "s10-skills-"));
try {
  cpSync(path.join(HERE, "skills"), tmp, { recursive: true });
  console.log(`第 1 轮扫描：${loadSkills(tmp).map((s) => s.name).join("、")}`);

  console.log('\n（用户在 agent 运行期间执行：mkdir skills/release-checklist && 写入 SKILL.md）\n');
  mkdirSync(path.join(tmp, "release-checklist"));
  writeFileSync(
    path.join(tmp, "release-checklist", "SKILL.md"),
    [
      "---",
      "name: release-checklist",
      "description: 发版前使用——按清单核对版本号、changelog、tag 和回滚方案。",
      "---",
      "",
      "# 发布检查清单",
      "1. 版本号已更新且与 tag 一致；2. changelog 写了本次改动；3. 回滚方案明确。",
    ].join("\n"),
  );

  const rescanned = loadSkills(tmp);
  console.log(`第 2 轮扫描：${rescanned.map((s) => s.name).join("、")}`);
  console.log("\n重扫后的目录 section 里多出的那一行：");
  const line = formatSkillsSection(rescanned)
    .split("\n")
    .find((l) => l.includes("release-checklist"));
  console.log(`  ${line}`);
  console.log("\n引擎一行代码没改 —— 每轮开工前重扫目录，新技能下一轮自动可见。");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
