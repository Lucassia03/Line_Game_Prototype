import { distance } from '../core/geometry';
import { addNode, addSegment } from '../core/state';
import type { GameState } from '../core/types';
import { ensureConnectivity } from './graph';

/** A deliberately simple campaign opponent: one slow, visible Arrow at a time. */
export function runEasyEnemyAI(state: GameState): boolean {
  ensureConnectivity(state);
  const activeAttack = [...state.segments.values()].some((segment) => segment.owner === 'enemy' &&
    (segment.constructionState === 'building' || segment.constructionState === 'attacking' || segment.constructionState === 'queued'));
  if (activeAttack) return false;

  const sources = [...state.nodes.values()].filter((node) => node.owner === 'enemy' && node.connected && node.kind !== 'building')
    .sort((left, right) => left.position.x - right.position.x || left.id.localeCompare(right.id));
  const source = sources[0];
  if (!source) return false;

  const playerNodes = [...state.nodes.values()].filter((node) => node.owner === 'player' && node.connected);
  const target = playerNodes.sort((left, right) => right.position.x - left.position.x || left.id.localeCompare(right.id))[0];
  if (!target || distance(source.position, target.position) < 80) return false;

  // The endpoint belongs to the AI and sits on the selected player node. Combat
  // collision stops the Arrow at the first real hostile obstacle along the way.
  const destination = addNode(state, 'enemy', target.position, 'junction');
  const arrow = addSegment(state, 'enemy', source.id, destination.id, 'wood', {
    constructionState: 'building',
    buildProgress: 0,
  });
  state.supplyVersion += 1;
  state.nextSupplyPlanTick = state.tick;
  return Boolean(arrow);
}
