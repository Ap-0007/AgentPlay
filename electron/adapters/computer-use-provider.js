function computerUseProvider() {
  // Define synthetic clip and subtitle fixtures for each aspect ratio
  const clips = [
    // 16:9 clip with long Chinese lines
    { format: 'mp4', aspectRatio: 16 / 9, content: 'This is a test.' },
    { format: 'mp4', aspectRatio: 9 / 16, content: 'Another test in 9-16.' },
    // 1:1 clip with English lines and punctuation
    { format: 'mp4', aspectRatio: 1 / 1, content: 'Testing with long Chinese lines and punctuation!' }
  ];

  const subtitleFixtures = clips.map((clip) => ({
    ...clip,
    format: 'srt',
    startTime: 0.0,
    endTime: clip.content.length / 100
  }));

  // Define FFmpeg command for generating subtitles
  const ffmpegCommand = `ffmpeg -i input.mp4 -vf 'subtitles=srt subtitle.txt' output.srt`;

  // Define D4 verifier evidence configuration
  const d4VerifierEvidence = {
    aspectRatio: {
      16_9: { x: 0.5, y: 0.5, width: 1, height: 1 },
      9_16: { x: 0.5, y: 0.5, width: 1, height: 1 },
      1_1: { x: 0.5, y: 0.5, width: 1, height: 1 }
    },
    fontSize: {
      min: 20,
      max: 24
    },
    safeMargins: {
      top: 10,
      bottom: 10,
      left: 10,
      right: 10
    },
    clip: {
      testClip: 'test-clip'
    }
  };

  // Define generator function for FFmpeg command
  const generateFFmpegCommand = (inputFile) => {
    return ffmpegCommand.replace('input.mp4', inputFile);
  };

  // Generate and inject subtitles
  const injectedSubtitles = subtitleFixtures.map((fixture) => {
    fixture.content = `# ${fixture.startTime} --> ${fixture.endTime}\n${fixture.content}`;
    return fixture;
  });

  // Return computed values
  return {
    clips,
    subtitleFixtures,
    ffmpegCommand: generateFFmpegCommand('input.mp4'),
    d4VerifierEvidence,
    injectedSubtitles
  };
}

export default computerUseProvider;