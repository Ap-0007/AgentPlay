const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');

module.exports = {
  generateSubtitleFixture(fileFormat) {
    const filename = `subtitle-${fileFormat}.srt`;
    const filePath = path.join(__dirname, 'fixtures', filename);

    // Create a new clip and add subtitles
    return new Promise((resolve, reject) => {
      ffmpeg()
        .setInputOptions(['-i', fileFormat])
        .setOutputOptions(['-vf', 'subtitles=filename=subtitle-${fileFormat}.srt'])
        .on('end', () => resolve(filePath))
        .on('error', (err) => reject(err));
    });
  },

  createFFmpegGenerator() {
    const generator = new ffmpeg();

    // Add FFmpeg command to generate clip and subtitle fixture
    generator.addCommand([
      '-i',
      'input.mp4',
      '-vf',
      'subtitles=filename=subtitle-16_9.srt',
      '-c:v',
      'libx264',
      '-crf',
      '18',
      '-movflags',
      '+faststart',
      '-pix_fmt',
      'yuv420p'
    ]);

    // Add FFmpeg command to verify subtitle fixture
    generator.addCommand([
      '-i',
      'input.mp4',
      '-vf',
      'subtitles=filename=subtitle-16_9.srt -vf', 'scale=1920:1080,pad=1920:1920:(ow-iw)/2:(hh-ih)/2'
    ]);

    return generator;
  },

  createLongLines() {
    const longChineseLine = 'This is a very long line of Chinese text with punctuation and multiple speakers.';
    const longEnglishLine = `This is a very long line of English text with punctuation, multiple speakers, and two lines.`;

    // Create a new file for the long lines
    return fs.promises.writeFile('long-lines.txt', `${longChineseLine}\n${longEnglishLine}`);
  },

  createLowerThirdRegion() {
    const lowerThirdRegion = `
      [lower_third]
        fontname=Arial
        fontsize=24
        x=-10
        y=-25
        text='Lower Third Region'
    `;

    return fs.promises.writeFile('lower-third-region.txt', lowerThirdRegion);
  },

  verifySubtitleFixture() {
    // Verify the subtitle fixture using D4 verificator
    const output = require('child_process').spawnSync('d4-verify-subtitles', [
      '-f',
      'srt',
      'subtitle-16_9.srt'
    ]);

    return JSON.parse(output.stdout);
  },

  createReviewScreenshots() {
    // Create review screenshots for each file format
    const files = ['16:9', '9:16', '1:1'];
    const screenshotsDir = 'screenshots';

    return Promise.all(files.map((fileFormat) => {
      const filename = `subtitle-${fileFormat}.srt`;
      const screenshotPath = path.join(screenshotsDir, `${filename}-review.png`);

      // Create a new clip and add subtitles
      return generateSubtitleFixture(fileFormat)
        .then((filePath) => {
          const ffmpegCommand = createFFmpegGenerator();
          return ffmpegCommand
            .addInput(filePath)
            .setOutputOptions(['-vf', `subtitles=${filePath} -vf`, `scale=1920:1080,pad=1920:1920:(ow-iw)/2:(hh-ih)/2`])
            .on('end', () => {
              ffmpegCommand.output().pipe(fs.createWriteStream(screenshotPath));
            })
            .on('error', (err) => console.error(err))
            .run()
            .then(() => true);
        });
    }));
  },

  createFixture() {
    return Promise.all([
      generateSubtitleFixture('16:9'),
      generateSubtitleFixture('9:16'),
      generateSubtitleFixture('1:1')
    ])
      .then(([fixture16_9, fixture9_16, fixture1_1]) => {
        // Create FFmpeg generator
        const ffmpegGenerator = createFFmpegGenerator();

        return Promise.all([
          ffmpegGenerator.addInput(fixture16_9).addOutputOptions(['-vf', 'subtitles=filename=subtitle-16_9.srt -vf', 'scale=1920:1080,pad=1920:1920:(ow-iw)/2:(hh-ih)/2']),
          ffmpegGenerator.addInput(fixture9_16).addOutputOptions(['-vf', 'subtitles=filename=subtitle-9_16.srt -vf', 'scale=1080:1920,pad=1080:1080:(ow-iw)/2:(hh-ih)/2']),
          ffmpegGenerator.addInput(fixture1_1).addOutputOptions(['-vf', 'subtitles=filename=subtitle-1_1.srt -vf', 'scale=1080:720,pad=1080:720:(ow-iw)/2:(hh-ih)/2'])
        ])
          .then(() => ffmpegGenerator.run())
          .then((result) => {
            // Create long lines
            return createLongLines().then(() => true);

            // Create lower third region
            return createLowerThirdRegion().then(() => true);
          })
          .then((results) => results.reduce((promise, result) => promise && result, Promise.resolve()))
          .then((results) => {
            const D4VerifierOutput = verifySubtitleFixture();

            if (D4VerifierOutput safeMargins && D4VerifierOutput readableFontSize && !D4VerifierOutput clipping && !D4VerifierOutput occlusion) {
              return createReviewScreenshots().then(() => true);
            } else {
              throw new Error('Verification failed');
            }
          })
          .then((results) => results.reduce((promise, result) => promise && result, Promise.resolve()))
          .then(() => fs.promises.writeFile('fixtures', 'Fixture created successfully'))
          .catch((err) => console.error(err));
      });
  },
};