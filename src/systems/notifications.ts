import { nextId } from '../core/state';
import type { GameState, WarningMessage } from '../core/types';

export function addWarning(state: GameState, text: string, kind: WarningMessage['kind'] = 'warning', life = 3.2): void {
  const existing = state.warnings.find((warning) => warning.text === text);
  if (existing) {
    existing.life = Math.max(existing.life, life);
    return;
  }
  state.warnings.push({ id: nextId(state, 'warning'), text, kind, life });
  if (state.warnings.length > 5) state.warnings.shift();
}

export function updateNotifications(state: GameState, dt: number): void {
  for (const warning of state.warnings) warning.life -= dt;
  state.warnings = state.warnings.filter((warning) => warning.life > 0);
}
