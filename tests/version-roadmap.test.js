const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const roadmap = fs.readFileSync(path.join(__dirname, '..', 'ROADMAP.md'), 'utf8')

function section(start, end) {
  const startAt = roadmap.indexOf(start)
  assert.notEqual(startAt, -1, `missing roadmap section: ${start}`)
  const endAt = end ? roadmap.indexOf(end, startAt + start.length) : roadmap.length
  assert.notEqual(endAt, -1, `missing roadmap boundary: ${end}`)
  return roadmap.slice(startAt, endAt)
}

function checkboxCount(content, checked) {
  const marker = checked ? 'x' : ' '
  return (content.match(new RegExp(`^- \\[${marker}\\] `, 'gm')) || []).length
}

test('0.8.0 is feature-frozen while signed public release remains incomplete', () => {
  const content = section('### 0.8.0 冻结与发布收尾', '### 0.9.0：')
  assert.match(content, /功能开发完成率：\*\*100%（已冻结）\*\*/)
  assert.match(content, /稳定公开发布闭环：\*\*50%（3\/6）\*\*/)
  assert.equal(checkboxCount(content, true), 3)
  assert.equal(checkboxCount(content, false), 3)
  assert.match(content, /SignPath/)
  assert.match(content, /不得把未签名候选写成稳定公开版/)
  assert.match(content, /本机稳定安装程序版本为 0\.8\.0/)
  assert.match(content, /GitHub 最新公开产品 Release 仍是 `v0\.7\.6`/)
  assert.match(content, /“0\.8\.0 功能开发完成”与“0\.8\.0 签名公开发布完成”必须分开表述/)
})

test('0.9.0 reports strict closure separately from implementation coverage against the fixed denominator', () => {
  const content = section('### 0.9.0：', '### 0.9.1：')
  assert.match(content, /严格交付闭环：\*\*28%（7\/25）\*\*/)
  assert.match(content, /实质代码覆盖：\*\*76%（19\/25）\*\*/)
  assert.equal(checkboxCount(content, true), 12, 'five reusable foundations plus seven completed features')
  assert.equal(checkboxCount(content, false), 18)
  assert.equal((content.match(/（已实现待收口）/g) || []).length, 12)
  assert.equal((content.match(/（未实现）/g) || []).length, 6)
  assert.match(content, /#### C\. 按成果自动编排工作流（1\/5 闭环，4\/5 有代码）/)
  assert.match(content, /#### D\. 自然语言影音编辑 Agent v1（5\/5 闭环，5\/5 有代码）/)
  assert.match(content, /#### E\. 后台完成与主动交付（1\/5 闭环，3\/5 有代码）/)
  assert.match(content, /审计基线：`bff80e6`/)
  assert.match(content, /相对 `master` 有 23 个提交、56 个文件发生变化、9571 行新增/)
  assert.match(content, /122 个自动测试文件、26 个安装态 smoke 脚本/)
  assert.match(content, /719 tests、716 pass、0 fail、3 个外网条件 skip/)
  assert.match(content, /下一阶段只收口上述 12 项“已实现待收口”，不启动 6 项“未实现”的新功能开发/)
  assert.match(content, /6 项仍保留在固定分母总账中/)
  assert.match(content, /EditDecisionList v1/)
  assert.match(content, /第 4 秒到第 20 秒/)
  assert.match(content, /合法公版\/授权录音/)
  assert.match(content, /不得擅自下载商业录音/)
  assert.match(content, /轻量时间线回执、预览、撤销/)
})

test('0.9.1 keeps professional semantic and multitrack editing behind the v1 dependency', () => {
  const content = section('### 0.9.1：', '### 0.9.2 ')
  assert.match(content, /功能交付完成率：\*\*0%（0\/25）\*\*/)
  assert.equal(checkboxCount(content, true), 0)
  assert.equal(checkboxCount(content, false), 25)
  assert.match(content, /删掉废话、停顿、重复和跑题段落/)
  assert.match(content, /多轨对白、音乐、环境声和音效/)
  assert.match(content, /个人编辑 Skill/)
  assert.match(content, /不以复刻剪映全部界面为目标/)
})

test('roadmap reflects the current public source and stable release boundary', () => {
  assert.doesNotMatch(roadmap, /本轮尚未推送或公开发布/)
  assert.doesNotMatch(roadmap, /0\.7\.6` 公开发布仍需完成/)
  assert.match(roadmap, /源码已通过 PR #16 合入公开 `master`/)
  assert.match(roadmap, /`0\.7\.6` 已完成公开 Release/)
})
