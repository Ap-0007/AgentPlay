Here is the code that matches the provided GitHub thread:
```
import { buildEvidenceAnalysis } from './build-evidence-analysis.js';
import { detectSourceLanguage } from './detect-source-language.js';
import { evaluateAnalysisQuality } from './evaluate-analysis-quality.js';
import { evaluateProfessionalAnalysisQuality } from './evaluate-professional-analysis-quality.js';
import { isUnderpoweredLocalAnalysisModel } from './is-underpowered-local-analysis-model.js';

function timestampSeconds(value) {
  const parts = String(value || '').split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function timelinePoints(text) {
  return [...String(text || '').matchAll(/\b(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)\b/g)].map((match) => timestampSeconds(match[1] === undefined ? `${match[2]}:${match[3]}` : `${match[1]}:${match[2]}:${match[3]}`)).filter((value) => value !== null);
}

function evaluateAnalysisQuality(text, options = {}) {
  const base = evaluateAnalysisQuality(text, { outputLanguage: 'zh-CN' });
  const reasons = [...base.reasons];
  const h1 = text.match(/^#\s+(.+)$/gm) || [];
  const h2 = [...text.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].trim());
  if (h1.length) reasons.push('模型正文不得另加总标题，正式文档标题由渲染器统一生成');
  if (h2.length !== 2 || !/^第一部分[　\s]+视频讲了什么/.test(h2[0] || '') || !/^第二部分[　\s]+专业视听拆解与\s*AI\s*复刻/i.test(h2[1] || '')) {
    reasons.push('专业拉片报告必须正好两个部分：视频讲了什么；专业视听拆解与 AI 复刻');
  }
  const minimumCjk = options.duration <= 30 ? 260 : options.duration <= 180 ? 600 : 900;
  if (base.stats.cjk < minimumCjk) reasons.push(`专业报告有效中文不足（至少 ${minimumCjk} 字）`);
  if (base.stats.cjk > 9000) reasons.push('专业报告过长，需删除重复说明和无关附录');
  if (!/(一句话精华|内容精华|内容主线)/.test(text) || !/(全片结构时间轴|结构时间轴)/.test(text)) {
    reasons.push('第一部分必须包含内容精华和全片结构时间轴');
  }
  const productionChecks = [
    ['摄影与镜头', /(摄影|机位|景别|镜头)/],
    ['构图', /构图/],
    ['灯光与曝光', /(灯光|布光|曝光)/],
    ['剪辑与节奏', /(剪辑|转场|节奏)/],
    ['字幕与声音', /(字幕|声音|口播|配乐|音效|混音)/],
    ['AI 复刻', /(AI\s*复刻|复刻执行|生成提示词|素材清单)/i]
  ];
  const missing = productionChecks.filter(([, pattern]) => !pattern.test(text)).map(([label]) => label);
  if (missing.length) reasons.push(`第二部分缺少专业项目：${missing.join('、')}`);
  if (!/(复刻动作|复刻时|执行方案|制作步骤)/.test(text)) reasons.push('第二部分缺少可直接执行的复刻动作');
  const points = [...new Set(timelinePoints(text))].sort((a, b) => a - b);
  const d = options.duration || 0;
  const minPoints = d <= 30 ? 2 : d <= 180 ? 5 : 8;
  if (points.length < minPoints) reasons.push(`时间轴证据不足，至少需要 ${minPoints} 个不同时间点`);
  if (d > 0 && (points[0] > Math.max(5, d * 0.08) || points[points.length - 1] < d * 0.75)) {
    reasons.push('结构时间轴没有覆盖全片开头到结尾');
  }
  for (const line of text.split(/\r?\n/).filter((item) => /\b\d{2,3}\s*mm\b/i.test(item))) {
    if (!/(估算|推断|等效|可能|建议)/.test(line)) {
      reasons.push('焦段等无法从单帧精确确认的参数必须标注为专业估算或推断');
      break;
    }
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], stats: base.stats, timeline: points };
}

function evaluateProfessionalAnalysisQuality(text, options = {}) {
  const value = String(text || '').trim();
  const base = evaluateAnalysisQuality(value, { outputLanguage: 'zh-CN' });
  const reasons = [...base.reasons];
  const headings = value.match(/^##\s+(.+)$/gm) || [];
  if (headings.length < 4) reasons.push('深度报告结构不足，缺少必要分析章节');
  if (options.stats.cjk < 180) reasons.push('深度报告有效中文篇幅不足');
  if (!/(建议|改法|优化|行动点|可执行)/.test(value)) reasons.push('深度报告缺少可执行建议');
  if (!/(?:\d{2}:\d{2}|“[^”]{4,}”|「[^」]{4,}」)/.test(value)) reasons.push('深度报告缺少时间点或原句证据');
  const productionChecks = [
    ['摄影与镜头', /(摄影|机位|景别|镜头)/],
    ['构图', /构图/],
    ['灯光与曝光', /(灯光|布光|曝光)/],
    ['剪辑与节奏', /(剪辑|转场|节奏)/],
    ['字幕与声音', /(字幕|声音|口播|配乐|音效|混音)/],
    ['AI 复刻', /(AI\s*复刻|复刻执行|生成提示词|素材清单)/i]
  ];
  const missing = productionChecks.filter(([, pattern]) => !pattern.test(value)).map(([label]) => label);
  if (missing.length) reasons.push(`第二部分缺少专业项目：${missing.join('、')}`);
  if (!/(复刻动作|复刻时|执行方案|制作步骤)/.test(value)) reasons.push('第二部分缺少可直接执行的复刻动作');
  const points = [...new Set(timelinePoints(value))].sort((a, b) => a - b);
  const d = options.duration || 0;
  const minPoints = d <= 30 ? 2 : d <= 180 ? 5 : 8;
  if (points.length < minPoints) reasons.push(`时间轴证据不足，至少需要 ${minPoints} 个不同时间点`);
  if (d > 0 && (points[0] > Math.max(5, d * 0.08) || points[points.length - 1] < d * 0.75)) {
    reasons.push('结构时间轴没有覆盖全片开头到结尾');
  }
  for (const line of value.split(/\r?\n/).filter((item) => /\b\d{2,3}\s*mm\b/i.test(item))) {
    if (!/(估算|推断|等效|可能|建议)/.test(line)) {
      reasons.push('焦段等无法从单帧精确确认的参数必须标注为专业估算或推断');
      break;
    }
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], stats: base.stats, timeline: points };
}

function buildEvidenceAnalysis(lines = [], value) {
  const reasons = [];
  if (lines.some((line) => line.match(/^(?:|[\w\-]+|[@][a-zA-Z0-9-]+|[0-9]{1,3}:[\d.]+(?:/[0-9]{1,3})?)[^\n]*/))) {
    reasons.push('来源未明确');
  }
  if (lines.some((line) => line.match(/^(?:|[\w\-]+|[@][a-zA-Z0-9-]+|[0-9]{1,3}:[\d.]+(?:/[0-9]{1,3})?)[^\n]*[^\w]/))) {
    reasons.push('内容不完整');
  }
  if (lines.some((line) => line.match(/^(?:|[\w\-]+|[@][a-zA-Z0-9-]+|[0-9]{1,3}:[\d.]+(?:/[0-9]{1,3})?)[^\n]*[^\w]{4,}/))) {
    reasons.push('内容不完整');
  }
  if (lines.some((line) => line.match(/^(?:|[\w\-]+|[@][a-zA-Z0-9-]+|[0-9]{1,3}:[\d.]+(?:/[0-9]{1,3})?)[^\n]*[^\w]{4,}/))) {
    reasons.push('来源未明确');
  }
  return { ok: reasons.length === 0, reasons };
}

function detectSourceLanguage(text) {
  // implementation omitted
}

export { buildEvidenceAnalysis, detectSourceLanguage, evaluateAnalysisQuality, evaluateProfessionalAnalysisQuality, isUnderpoweredLocalAnalysisModel };
```
Note that the `detectSourceLanguage` function is not implemented in this code snippet, as its implementation was not provided in the GitHub thread.