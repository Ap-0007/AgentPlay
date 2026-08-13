const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..', '..')
const modules = [
  'src/components/AgentPanel.tsx',
  'src/components/agent-panel/RuntimeSettings.tsx',
  'src/components/agent-panel/useVoiceInput.ts',
  'src/components/agent-panel/useLinkMediaTasks.ts',
  'src/components/agent-panel/useDocumentAnalysisTasks.ts',
  'src/components/agent-panel/useMediaCreativeTasks.ts',
  'src/components/agent-panel/intentRouter.ts',
  'src/components/agent-panel/taskCommandDispatcher.ts',
  'src/components/agent-panel/AgentHome.tsx',
  'src/components/agent-panel/AgentComposer.tsx',
  'src/components/agent-panel/suggestions.ts'
]

function agentPanelSource() {
  return modules.map((relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')).join('\n')
}

module.exports = { agentPanelSource }
