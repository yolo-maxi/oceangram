import { describe, it, expect } from 'vitest';

// ── Voice Recording State Machine ──
// States: idle → recording → preview → sending
type VoiceState = 'idle' | 'recording' | 'preview' | 'sending';

interface VoiceStateMachine {
  state: VoiceState;
  transition(action: string): VoiceState;
}

function createVoiceStateMachine(): VoiceStateMachine {
  const machine: VoiceStateMachine = {
    state: 'idle',
    transition(action: string): VoiceState {
      switch (this.state) {
        case 'idle':
          if (action === 'startRecording') this.state = 'recording';
          break;
        case 'recording':
          if (action === 'stopRecording') this.state = 'preview';
          if (action === 'cancel') this.state = 'idle';
          break;
        case 'preview':
          if (action === 'send') this.state = 'sending';
          if (action === 'cancel') this.state = 'idle';
          if (action === 'reRecord') this.state = 'recording';
          break;
        case 'sending':
          if (action === 'sendSuccess') this.state = 'idle';
          if (action === 'sendFailed') this.state = 'preview';
          break;
      }
      return this.state;
    }
  };
  return machine;
}

// ── Duration Formatting ──
function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ── Waveform Data Processing ──
function normalizeWaveform(samples: number[], targetBars: number): number[] {
  if (samples.length === 0) return new Array(targetBars).fill(0);
  const result: number[] = [];
  const step = samples.length / targetBars;
  for (let i = 0; i < targetBars; i++) {
    const start = Math.floor(i * step);
    const end = Math.floor((i + 1) * step);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end && j < samples.length; j++) {
      sum += samples[j];
      count++;
    }
    result.push(count > 0 ? sum / count : 0);
  }
  // Normalize to 0-1
  const max = Math.max(...result, 1);
  return result.map(v => v / max);
}

// ── File Type Validation ──
function isValidVoiceFormat(mimeType: string): boolean {
  const valid = ['audio/ogg', 'audio/webm', 'audio/opus', 'audio/ogg; codecs=opus', 'audio/webm; codecs=opus'];
  return valid.some(v => mimeType.startsWith(v.split(';')[0]));
}

describe('Voice Recording State Machine', () => {
  it('starts in idle state', () => {
    const sm = createVoiceStateMachine();
    expect(sm.state).toBe('idle');
  });

  it('transitions idle → recording on startRecording', () => {
    const sm = createVoiceStateMachine();
    expect(sm.transition('startRecording')).toBe('recording');
  });

  it('transitions recording → preview on stopRecording', () => {
    const sm = createVoiceStateMachine();
    sm.transition('startRecording');
    expect(sm.transition('stopRecording')).toBe('preview');
  });

  it('transitions recording → idle on cancel', () => {
    const sm = createVoiceStateMachine();
    sm.transition('startRecording');
    expect(sm.transition('cancel')).toBe('idle');
  });

  it('transitions preview → sending on send', () => {
    const sm = createVoiceStateMachine();
    sm.transition('startRecording');
    sm.transition('stopRecording');
    expect(sm.transition('send')).toBe('sending');
  });

  it('transitions preview → idle on cancel', () => {
    const sm = createVoiceStateMachine();
    sm.transition('startRecording');
    sm.transition('stopRecording');
    expect(sm.transition('cancel')).toBe('idle');
  });

  it('transitions preview → recording on reRecord', () => {
    const sm = createVoiceStateMachine();
    sm.transition('startRecording');
    sm.transition('stopRecording');
    expect(sm.transition('reRecord')).toBe('recording');
  });

  it('transitions sending → idle on sendSuccess', () => {
    const sm = createVoiceStateMachine();
    sm.transition('startRecording');
    sm.transition('stopRecording');
    sm.transition('send');
    expect(sm.transition('sendSuccess')).toBe('idle');
  });

  it('transitions sending → preview on sendFailed', () => {
    const sm = createVoiceStateMachine();
    sm.transition('startRecording');
    sm.transition('stopRecording');
    sm.transition('send');
    expect(sm.transition('sendFailed')).toBe('preview');
  });

  it('ignores invalid transitions', () => {
    const sm = createVoiceStateMachine();
    expect(sm.transition('stopRecording')).toBe('idle'); // can't stop from idle
    expect(sm.transition('send')).toBe('idle'); // can't send from idle
  });
});

describe('Duration Formatting', () => {
  it('formats 0 seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
  });

  it('formats seconds only', () => {
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(45)).toBe('0:45');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(130)).toBe('2:10');
  });

  it('handles fractional seconds', () => {
    expect(formatDuration(5.7)).toBe('0:05');
  });
});

describe('Waveform Data Processing', () => {
  it('normalizes empty input', () => {
    const result = normalizeWaveform([], 10);
    expect(result).toHaveLength(10);
    expect(result.every(v => v === 0)).toBe(true);
  });

  it('normalizes to target bar count', () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80];
    const result = normalizeWaveform(samples, 4);
    expect(result).toHaveLength(4);
  });

  it('normalizes values to 0-1 range', () => {
    const samples = [5, 10, 15, 20, 25, 30];
    const result = normalizeWaveform(samples, 3);
    result.forEach(v => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    });
    // Last group should be max (1.0)
    expect(result[result.length - 1]).toBe(1);
  });
});

describe('File Type Validation', () => {
  it('accepts ogg audio', () => {
    expect(isValidVoiceFormat('audio/ogg')).toBe(true);
  });

  it('accepts webm audio', () => {
    expect(isValidVoiceFormat('audio/webm')).toBe(true);
  });

  it('accepts opus', () => {
    expect(isValidVoiceFormat('audio/opus')).toBe(true);
  });

  it('rejects mp3', () => {
    expect(isValidVoiceFormat('audio/mp3')).toBe(false);
  });

  it('rejects video', () => {
    expect(isValidVoiceFormat('video/webm')).toBe(false);
  });

  it('rejects non-audio', () => {
    expect(isValidVoiceFormat('text/plain')).toBe(false);
  });
});
