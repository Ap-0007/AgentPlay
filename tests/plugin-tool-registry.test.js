const test = require('node:test')
const assert = require('node:assert/strict')
const {
  listAgentTools, getAgentTool, executeAgentTool, replacePluginContributions, listAgentSkillInstructions
} = require('../electron/agent-tool-registry')

test('enabled plugin aliases enter the unified registry but only execute mapped built-in tools', async () => {
  replacePluginContributions({
    tools: [{
      name: 'plugin_video_notes_summarize_current_video', pluginId: 'video-notes',
      description: '读取当前视频字幕并生成摘要', target: 'summarize_video',
      parameters: {}, required: [], category: 'plugin', risk: 'read-only', cost: 2
    }],
    skills: [{ pluginId: 'video-notes', name: 'video-notes', description: '结构化视频笔记', instructions: 'Only use subtitle evidence.' }]
  })
  try {
    assert.ok(listAgentTools().some((item) => item.function.name === 'plugin_video_notes_summarize_current_video'))
    assert.equal(getAgentTool('plugin_video_notes_summarize_current_video').pluginId, 'video-notes')
    assert.match(listAgentSkillInstructions(), /Only use subtitle evidence/)
    const result = await executeAgentTool('plugin_video_notes_summarize_current_video', {}, {}, {
      summarize: async () => ({ success: true, desc: '读取了字幕', transcript: 'hello' })
    })
    assert.equal(result.success, true)
    assert.equal(result.tool, 'plugin_video_notes_summarize_current_video')
    assert.equal(result.mappedTool, 'summarize_video')
    assert.equal(result.pluginId, 'video-notes')
    assert.equal(result.verified, true)
  } finally {
    replacePluginContributions({ tools: [], skills: [] })
  }
})

test('plugin registry rejects shadowing, plugin-to-plugin chains and unknown built-in targets', () => {
  assert.throws(() => replacePluginContributions({ tools: [{ name: 'pause', target: 'pause', pluginId: 'bad' }], skills: [] }), /冲突/)
  assert.throws(() => replacePluginContributions({ tools: [{ name: 'plugin_a_x', target: 'plugin_b_y', pluginId: 'a' }], skills: [] }), /内置工具/)
  assert.throws(() => replacePluginContributions({ tools: [{ name: 'plugin_a_x', target: 'missing', pluginId: 'a' }], skills: [] }), /内置工具/)
})
