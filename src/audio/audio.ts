import type { SettingsData } from '../core/types';

export type SoundName = 'build' | 'complete' | 'select' | 'impactWood' | 'impactStone' | 'impactIron' | 'delivery' | 'destroy' | 'error' | 'victory' | 'defeat';

export class ProceduralAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private lastPlayed = new Map<SoundName, number>();
  private settings: SettingsData;

  constructor(settings: SettingsData) {
    this.settings = settings;
  }

  unlock(): void {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.connect(this.context.destination);
      this.syncVolume();
    }
    if (this.context.state === 'suspended') void this.context.resume();
  }

  setSettings(settings: SettingsData): void {
    this.settings = settings;
    this.syncVolume();
  }

  play(name: SoundName): void {
    if (this.settings.muted) return;
    this.unlock();
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;
    const nowMs = performance.now();
    const throttle = name.startsWith('impact') ? 55 : name === 'delivery' ? 80 : 0;
    if (nowMs - (this.lastPlayed.get(name) ?? -Infinity) < throttle) return;
    this.lastPlayed.set(name, nowMs);

    const recipes: Record<SoundName, { frequency: number; end: number; duration: number; type: OscillatorType; gain: number; delay?: number }> = {
      build: { frequency: 180, end: 285, duration: 0.11, type: 'square', gain: 0.055 },
      complete: { frequency: 340, end: 680, duration: 0.18, type: 'sine', gain: 0.07 },
      select: { frequency: 520, end: 460, duration: 0.055, type: 'sine', gain: 0.035 },
      impactWood: { frequency: 145, end: 72, duration: 0.11, type: 'square', gain: 0.045 },
      impactStone: { frequency: 105, end: 44, duration: 0.2, type: 'triangle', gain: 0.07 },
      impactIron: { frequency: 78, end: 28, duration: 0.34, type: 'sawtooth', gain: 0.1 },
      delivery: { frequency: 720, end: 980, duration: 0.08, type: 'sine', gain: 0.025 },
      destroy: { frequency: 92, end: 34, duration: 0.3, type: 'sawtooth', gain: 0.085 },
      error: { frequency: 170, end: 120, duration: 0.16, type: 'square', gain: 0.045 },
      victory: { frequency: 330, end: 990, duration: 0.75, type: 'triangle', gain: 0.08 },
      defeat: { frequency: 210, end: 55, duration: 0.9, type: 'sawtooth', gain: 0.07 },
    };
    const recipe = recipes[name];
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = recipe.type;
    oscillator.frequency.setValueAtTime(recipe.frequency, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, recipe.end), context.currentTime + recipe.duration);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(recipe.gain, context.currentTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + recipe.duration);
    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start();
    oscillator.stop(context.currentTime + recipe.duration + 0.02);
  }

  private syncVolume(): void {
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(this.settings.muted ? 0 : this.settings.masterVolume, this.context.currentTime, 0.02);
    }
  }
}
