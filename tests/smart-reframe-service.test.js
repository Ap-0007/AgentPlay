const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildSmartReframeDecision,
  matchesSmartReframeInstruction,
  requestedTrackingSubject,
  trackingMoments,
  validateTrackingPayload
} = require('../electron/smart-reframe-service')

test('smart reframe intent covers three aspect versions and one-sentence subject correction', () => {
  assert.equal(matchesSmartReframeInstruction('自动生成16:9、9:16和1:1三个版本，跟踪主要人物'), true)
  assert.equal(matchesSmartReframeInstruction('生成横屏、竖屏和方形版本，画面跟着右边穿红衣服的人'), true)
  assert.equal(matchesSmartReframeInstruction('改为跟踪左边拿手机的人'), true)
  assert.equal(matchesSmartReframeInstruction('能不能生成竖屏版本？'), false)
  assert.equal(requestedTrackingSubject('改为跟踪左边拿手机的人'), '左边拿手机的人')
  assert.equal(requestedTrackingSubject('自动生成三个比例版本'), '主要人物或主体')
})

test('five labelled keyframes freeze a bounded smooth subject path and three outputs', () => {
  const moments = trackingMoments(8)
  assert.deepEqual(moments.map((item) => item.seconds), [0.2, 2.1, 4, 5.9, 7.8])
  const payload = { observedSubject: '穿红衣服的人', frames: moments.map((item, index) => ({ label: item.label, box: { x: 0.08 + index * 0.15, y: 0.2, width: 0.2, height: 0.55 }, confidence: 0.94 })) }
  const tracking = validateTrackingPayload(payload, moments, '穿红衣服的人')
  assert.equal(tracking.frames.length, 5)
  assert.equal(tracking.minimumConfidence, 0.94)
  const decision = buildSmartReframeDecision({ instruction: '生成三个比例版本，跟踪穿红衣服的人', sourcePath: 'D:\\video\\source.mp4', width: 640, height: 360, durationSeconds: 8, tracking, model: { providerId: 'agnes', providerName: 'Agnes', model: 'agnes-2.5-flash', local: false } })
  assert.equal(decision.kind, 'media.smart-reframe')
  assert.deepEqual(decision.reframe.outputs.map((item) => [item.aspect, item.width, item.height]), [['16:9', 640, 360], ['9:16', 202, 360], ['1:1', 360, 360]])
  assert.equal(decision.reframe.subject.description, '穿红衣服的人')
  assert.equal(decision.reframe.tracking.frames.length, 5)
})

test('missing, duplicate or low-confidence boxes fail closed', () => {
  const moments = trackingMoments(6)
  const valid = moments.map((item) => ({ label: item.label, box: { x: 0.4, y: 0.2, width: 0.2, height: 0.6 }, confidence: 0.95 }))
  assert.throws(() => validateTrackingPayload({ frames: valid.slice(0, 4) }, moments, '人物'), /每个关键帧/)
  assert.throws(() => validateTrackingPayload({ frames: valid.map((item, index) => index === 4 ? { ...item, confidence: 0.4 } : item) }, moments, '人物'), /置信度/)
  assert.throws(() => validateTrackingPayload({ frames: valid.map((item, index) => index === 4 ? { ...item, label: valid[0].label } : item) }, moments, '人物'), /每个关键帧/)
})
