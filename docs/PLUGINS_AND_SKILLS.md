# AgentPlay 插件与 Skill 开发

AgentPlay 0.8.0 的插件接口是声明式扩展层：插件可以提供精简的 `SKILL.md` 工作流，并把新的工具名称映射到 AgentPlay 已有受控工具。运行时不执行第三方 JavaScript、Python、Shell、DLL 或任意二进制，因此插件不能绕过主进程任务恢复、质量评分、云端/付费审批和文件安全边界。

## 最小目录

```text
video-notes/
├─ agentplay-plugin.json
└─ skills/
   └─ video-notes/
      └─ SKILL.md
```

安装时选择 `video-notes` 文件夹。通过结构、路径和权限校验后，AgentPlay 把它复制到受管插件目录并保持禁用；用户查看权限并确认启用后，贡献项才会进入统一工具注册表。清单的权限集合发生变化时，旧授权立即失效。

## 清单格式

```json
{
  "schemaVersion": 1,
  "id": "video-notes",
  "name": "视频笔记助手",
  "version": "1.0.0",
  "description": "把当前视频整理成结构化笔记",
  "publisher": "你的名称",
  "permissions": ["app.read"],
  "skills": ["skills/video-notes/SKILL.md"],
  "tools": [{
    "name": "summarize-current-video",
    "description": "读取当前视频字幕并生成摘要",
    "target": "summarize_video",
    "parameters": { "type": "object", "properties": {} }
  }]
}
```

约束：

- `id`、Skill 名和工具局部名使用小写字母、数字与短横线；插件目录名必须等于 `id`。
- `version` 使用 SemVer。
- Skill 路径必须位于插件目录内，真实路径和符号链接也不能越界。
- 工具只能映射内置工具，不能覆盖内置名称、串联另一个插件工具或声明任意执行器。
- v1 支持的权限为 `app.read`、`player.control`、`file.read`、`file.write`、`network`、`cloud`、`paid`。其中 `network/cloud/paid` 为将来受控能力预留，当前没有可映射执行器。
- `read-only` 工具要求 `app.read`；播放器控制要求 `player.control`；交互式文件动作和本地写入要求 `file.write`。

## SKILL.md

```markdown
---
name: video-notes
description: Use when the user asks for structured notes from the current video.
---

# Video notes

1. Read subtitle evidence.
2. Separate facts from inference.
3. Return concise notes in the user's interface language.
```

Skill 应短小，只描述领域流程与质量要求。它不会扩大工具权限，也不能把模型文字当作真实执行回执。详细规则可放在插件内 `references/`，但当前运行时只加载清单明确列出的 `SKILL.md`；需要确定性执行时应先向 AgentPlay 项目贡献一个经过审核的内置工具，再由插件映射。

## 生命周期与安全

1. 安装：用户选择目录，应用复制到临时受管目录，完整校验后原子启用安装结果；失败不留下半安装插件。
2. 启用：显示并确认完整权限清单，权限摘要与启用状态一起持久化。
3. 执行：模型看到 Skill 和别名工具；真正执行仍进入统一工具注册表、模式策略、调用预算和运行账本。
4. 更新：重新安装新版本前先移除旧版本；权限变化必须重新确认。
5. 移除：应用将插件移动到 `.trash` 可恢复目录，不直接永久删除。
6. 旧插件：根目录里的 `.js` 文件只显示为“已隔离停用”，内容不会被读取或执行。

仓库示例见 `examples/agentplay-plugin-video-notes/`。提交第三方插件前，请至少验证：清单校验、默认禁用、权限撤销、工具真实回执、失败不伪报、Windows 安装版冷启动。
