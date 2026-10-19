import type { SettingsData } from './types';

const STORAGE_KEY = 'line-rts-settings-v1';

const defaults: SettingsData = {
  masterVolume: 0.45,
  muted: false,
  edgeScroll: true,
  screenShake: true,
  showTutorial: true,
};

export function loadSettings(): SettingsData {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return { ...defaults };
    return { ...defaults, ...(JSON.parse(saved) as Partial<SettingsData>) };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(settings: SettingsData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Settings are non-critical when storage is unavailable.
  }
}
