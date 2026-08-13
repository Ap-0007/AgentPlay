const crypto = require('crypto')

class AgentRunLedger {
  constructor({ requestId, mode = 'work', maxTurns = 8, maxToolCalls = 12, maxElapsedMs = 180000, now = () => Date.now() } = {}) {
    this.now = now
    this.id = String(requestId || `agent-${crypto.randomUUID()}`)
    this.mode = mode
    this.startedAt = this.now()
    this.completedAt = null
    this.status = 'running'
    this.steps = []
    this.budget = { turns: 0, maxTurns, toolCalls: 0, maxToolCalls, elapsedMs: 0, maxElapsedMs }
  }

  beginTurn() {
    this.budget.turns += 1
    return this.withinTime()
  }

  withinTime() {
    this.budget.elapsedMs = Math.max(0, this.now() - this.startedAt)
    return this.budget.elapsedMs <= this.budget.maxElapsedMs
  }

  beginTool(tool, args = {}) {
    const label = tool?.description || tool?.name || '未知工具'
    const blocked = !this.withinTime()
      ? '已达到本次任务时间预算'
      : this.budget.toolCalls >= this.budget.maxToolCalls
        ? '已达到本次任务工具调用预算'
        : ''
    const step = {
      id: `step-${this.steps.length + 1}`,
      tool: tool?.name || '',
      label,
      status: blocked ? 'blocked' : 'running',
      detail: blocked,
      args,
      startedAt: this.now(),
      completedAt: blocked ? this.now() : null,
      evidence: null
    }
    this.steps.push(step)
    if (blocked) {
      this.status = 'blocked'
      return { allowed: false, step, error: blocked }
    }
    this.budget.toolCalls += 1
    return { allowed: true, step }
  }

  finishTool(step, result) {
    if (!step) return result
    step.completedAt = this.now()
    step.status = result?.success === false || result?.error ? 'failed' : 'completed'
    step.detail = String(result?.desc || result?.error || '')
    step.evidence = {
      kind: result?.execution === 'main' ? 'tool-result' : 'dispatch-receipt',
      value: String(result?.desc || result?.error || result?.action || ''),
      verified: result?.verified === true
    }
    if (step.status === 'failed' && this.status === 'running') this.status = 'partial'
    return result
  }

  finish({ cancelled = false, failed = false } = {}) {
    this.completedAt = this.now()
    this.budget.elapsedMs = Math.max(0, this.completedAt - this.startedAt)
    if (cancelled) this.status = 'cancelled'
    else if (failed) this.status = 'failed'
    else if (this.status === 'running') this.status = this.steps.some((step) => step.status === 'failed') ? 'partial' : 'completed'
    return this.snapshot()
  }

  snapshot() {
    return {
      id: this.id,
      mode: this.mode,
      status: this.status,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      budget: { ...this.budget },
      steps: this.steps.map((step) => ({ ...step, args: { ...step.args }, evidence: step.evidence ? { ...step.evidence } : null }))
    }
  }
}

module.exports = { AgentRunLedger }
