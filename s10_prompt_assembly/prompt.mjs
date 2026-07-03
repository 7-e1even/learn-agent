// prompt.mjs —— system prompt 的分段拼装 + 技能目录的按需加载。
//
// 从真实产品 Reina 的 packages/core/src/engine-prompt.ts 与 skills.ts 简化移植：
//   · 分段拼装：sections 数组 + 确定性拼接（顺序固定、无时间戳、空段消失）
//   · 技能三层结构：skills/<名字>/SKILL.md（frontmatter + 正文）
//     → prompt 里只注入"目录"（每技能一行），正文靠 load_skill 工具按需取
//   · 扫描结果按名字排序 —— readdir 的顺序不可依赖，
//     排序是"目录 section 字节稳定"的前提（s07 的缓存纪律）

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** 分段拼装：这就是全部秘密 —— 但每个约束都有讲究。
 *  · filter(Boolean)：空 section 干净消失，不留孤零零的空行
 *  · join("\n\n")：段间距固定，任何一段内容不变则整体字节不变
 *  · 调用方约定：sections 里绝不放本轮才变的东西（时间、任务进度……），
 *    那些放进最后一条用户消息（见 agent.mjs 的 withVolatileReminder） */
export function buildSystemPrompt(sections) {
  return sections.filter(Boolean).join("\n\n");
}

// 单个 SKILL.md 的上限。超限直接跳过——技能正文本来就该精炼，
// 一个 1MB 的"技能"多半是有人把数据文件塞错了地方。（Reina 用 1MB）
const MAX_SKILL_BYTES = 256 * 1024;

/** 扫描 skills 目录：每个子目录一个技能，入口固定叫 SKILL.md。
 *  没有目录、没有 SKILL.md、超限 —— 一律静默跳过，扫描永不抛错。 */
export function loadSkills(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // 目录不存在 = 没有技能，不是错误
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "SKILL.md");
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) continue;
    skills.push(parseSkill(content, entry.name, file));
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** 解析 SKILL.md：frontmatter 给目录用（name + description），
 *  正文给 load_skill 用。没有 frontmatter 时退化：目录名当 name，
 *  第一段话当 description —— 宽容的解析器让用户少一个报错可踩。 */
function parseSkill(content, dirName, file) {
  const fm = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
  const fields = {};
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (m) fields[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  const body = (fm ? content.slice(fm[0].length) : content).trim();
  return {
    name: fields.name ?? dirName,
    description: fields.description ?? firstParagraph(body) ?? `技能 ${dirName}`,
    body,
    path: file,
  };
}

function firstParagraph(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((p) => p.replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim())
    .find(Boolean)
    ?.slice(0, 120);
}

/** 技能目录 section：每个技能只占一行（名字 + 一句话描述）。
 *  正文一个字都不进来 —— 这就是"渐进式披露"：
 *  目录告诉模型"存在什么"，load_skill 才展开"具体是什么"。 */
export function formatSkillsSection(skills) {
  if (skills.length === 0) {
    return [
      "## 技能",
      "当前没有安装技能。在 skills/<名字>/SKILL.md 添加后，下一轮对话自动可见。",
    ].join("\n");
  }
  return [
    "## 技能（只有目录，正文按需加载）",
    '下面每行是一个技能的名字和适用场景。当任务和描述匹配时，先调用 load_skill("名字") 读取完整指引再动手——不要只凭目录里的一句话自行发挥。',
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join("\n");
}
