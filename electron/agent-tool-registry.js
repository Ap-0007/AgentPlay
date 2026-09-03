/**
 * Agent tool registry
 */

import {
  formatClip,
  createSubtitleFixture,
  getLowerThirdRegion,
} from './utils';

const formats = [
  '16:9',
  '9:16',
  '1:1',
];

// Create clip and subtitle fixture for each format
const fixtures = formats.map((format) => {
  const clip = formatClip(format);
  const { title, text } = createSubtitleFixture(format);
  return { clip, subtitle: { title, text } };
});

/**
 * FFmpeg command documentation
 */
const ffmpegCommand = `
ffmpeg -i input.mp4 -vf \"scale=1920:1080\" output.mkv
`;

// Generate long Chinese and English lines
const chineseLines = [
  '\u4f60\u597d\u4e3a\u4e00\u4e2a\u4e8c\u5929',
  '\u4e00\u4e2a\u4e8c\u5929\u4f60\u597d',
];

const englishLines = [
  'This is a test line.',
  'Another test line.',
];

// Create two speaker configuration
const speakers = {
  speaker1: { name: 'Speaker 1', font: 'Arial' },
  speaker2: { name: 'Speaker 2', font: 'Times New Roman' },
};

/**
 * Lower-third region configuration
 */
const lowerThirdRegion = getLowerThirdRegion({
  style: 'high-detail',
});

// Export registry
export default {
  formats,
  ffmpegCommand,
  chineseLines,
  englishLines,
  speakers,
  lowerThirdRegion,
};