import { BUILDING_BALANCE, COLORS, TIER_BALANCE } from '../config/balance';
import type {
  ArrowCollision,
  ArrowImpactPreview,
  Building,
  GameState,
  LineCell,
  Owner,
  StoneWall,
  Tier,
} from '../core/types';
import { spawnImpactEffect, spawnParticles } from './effects';
import { recomputeConnectivity } from './graph';
import { addWarning } from './notifications';
import { markCellBroken, syncSegmentAggregate } from './cells';

export interface ArrowImpactResolution {
  damage: number;
  targetDestroyed: boolean;
  targetKind: ArrowCollision['targetKind'];
  targetId: string;
}

function buildingArmor(building: Building): number {
  if (building.type === 'center') return 7;
  if (building.type === 'depot') return 3;
  return 1;
}

function targetLabel(state: GameState, collision: ArrowCollision): string {
  if (collision.targetKind === 'wall') return 'Stone Wall';
  if (collision.targetKind === 'cell') {
    const cell = state.cells.get(collision.targetCellId ?? collision.targetId);
    const segment = cell ? state.segments.get(cell.segmentId) : undefined;
    return segment ? `${segment.tier.charAt(0).toUpperCase()}${segment.tier.slice(1)} Line` : 'Enemy Line';
  }
  const building = state.buildings.get(collision.targetId);
  return building ? BUILDING_BALANCE[building.type].label : 'Enemy structure';
}

export function describeArrowImpact(state: GameState, tier: Tier, collision: ArrowCollision): ArrowImpactPreview {
  const baseDamage = TIER_BALANCE[tier].damagePerSupply;
  let estimatedDamage = baseDamage * collision.multiplier;
  if (collision.targetKind === 'cell') {
    const cell = state.cells.get(collision.targetCellId ?? collision.targetId);
    const segment = cell ? state.segments.get(cell.segmentId) : undefined;
    if (segment) estimatedDamage = Math.max(1, estimatedDamage - segment.armor);
  } else if (collision.targetKind === 'building') {
    const building = state.buildings.get(collision.targetId);
    if (building) estimatedDamage = Math.max(1, estimatedDamage - buildingArmor(building));
  }
  return {
    ...collision,
    targetLabel: targetLabel(state, collision),
    baseDamage,
    estimatedDamage,
  };
}

export function applyDamageToCell(state: GameState, target: LineCell, rawDamage: number, attackerOwner: Owner): number {
  const segment = state.segments.get(target.segmentId);
  if (!segment || target.state === 'broken' || target.health <= 0) return 0;
  const actualDamage = Math.max(1, rawDamage - segment.armor);
  target.health = Math.max(0, target.health - actualDamage);
  target.damageFlash = 0.28;
  segment.damageFlash = 0.24;
  if (target.health <= 0) {
    markCellBroken(state, target);
    const midpoint = { x: (target.start.x + target.end.x) / 2, y: (target.start.y + target.end.y) / 2 };
    spawnParticles(state, midpoint, segment.owner === 'player' ? COLORS.player : COLORS.enemy, 16, 'destruction', 1.1);
    if (segment.owner === 'player') state.stats.segmentsLost += 1;
    if (segment.owner === 'enemy' && attackerOwner === 'player') state.stats.enemySegmentsDestroyed += 1;
    recomputeConnectivity(state);
  } else {
    syncSegmentAggregate(state, segment);
  }
  return actualDamage;
}

export function applyDamageToBuilding(state: GameState, target: Building, rawDamage: number): number {
  const actualDamage = Math.max(1, rawDamage - buildingArmor(target));
  target.health -= actualDamage;
  target.damageFlash = 0.28;
  if (target.type === 'center' && target.owner === 'player') addWarning(state, 'LINE CENTER UNDER ATTACK', 'danger', 2.2);
  if (target.health <= 0 && target.type !== 'center') {
    target.health = 0;
    const node = state.nodes.get(target.nodeId);
    if (node) node.buildingId = undefined;
    state.buildings.delete(target.id);
    state.spatialVersion += 1;
    state.supplyVersion += 1;
    state.nextSupplyPlanTick = state.tick;
    if (state.selection.kind === 'building' && state.selection.id === target.id) state.selection = { kind: 'none' };
    spawnParticles(state, target.position, target.owner === 'player' ? COLORS.player : COLORS.enemy, 22, 'destruction', 1.25);
  }
  return actualDamage;
}

export function applyDamageToWall(state: GameState, target: StoneWall, rawDamage: number, attackerOwner: Owner): number {
  const actualDamage = Math.max(0, rawDamage);
  target.health -= actualDamage;
  target.damageFlash = 0.32;
  if (target.health <= 0) {
    target.health = 0;
    state.walls.delete(target.id);
    state.spatialVersion += 1;
    if (attackerOwner === 'player' && target.owner === 'enemy') state.stats.wallsDestroyed += 1;
    if (state.selection.kind === 'wall' && state.selection.id === target.id) state.selection = { kind: 'none' };
    const midpoint = { x: (target.start.x + target.end.x) / 2, y: (target.start.y + target.end.y) / 2 };
    spawnParticles(state, midpoint, COLORS.stone, 30, 'destruction', 1.5);
  }
  return actualDamage;
}

export function resolveArrowImpact(
  state: GameState,
  tier: Tier,
  attackerOwner: Owner,
  collision: ArrowCollision,
): ArrowImpactResolution {
  const description = describeArrowImpact(state, tier, collision);
  const rawDamage = description.baseDamage * description.multiplier;
  let damage = 0;
  let targetDestroyed = false;

  if (collision.targetKind === 'wall') {
    const wall = state.walls.get(collision.targetId);
    if (wall) {
      damage = applyDamageToWall(state, wall, rawDamage, attackerOwner);
      targetDestroyed = !state.walls.has(wall.id);
    }
  } else if (collision.targetKind === 'cell') {
    const cell = state.cells.get(collision.targetCellId ?? collision.targetId);
    if (cell) {
      damage = applyDamageToCell(state, cell, rawDamage, attackerOwner);
      targetDestroyed = cell.state === 'broken';
    }
  } else {
    const building = state.buildings.get(collision.targetId);
    if (building) {
      damage = applyDamageToBuilding(state, building, rawDamage);
      targetDestroyed = building.health <= 0;
    }
  }

  const power = tier === 'iron' ? 2.2 : tier === 'stone' ? 1.35 : 0.85;
  spawnImpactEffect(state, collision.point, COLORS[tier], power);
  state.floatingTexts.push({
    id: `impact-damage-${state.tick}-${collision.targetId}`,
    position: { ...collision.point },
    text: `-${Math.round(damage)}`,
    color: COLORS[tier],
    life: 1.15,
  });
  state.stats.arrowsImpacted += 1;
  evaluateVictory(state);
  return { damage, targetDestroyed, targetKind: collision.targetKind, targetId: collision.targetId };
}

export function evaluateVictory(state: GameState): 'victory' | 'defeat' | null {
  const playerCenter = state.buildings.get(state.centerBuilding.player);
  const enemyCenter = state.buildings.get(state.centerBuilding.enemy);
  if (!playerCenter || playerCenter.health <= 0) {
    state.phase = 'defeat';
    return 'defeat';
  }
  if (!enemyCenter || enemyCenter.health <= 0) {
    state.phase = 'victory';
    return 'victory';
  }
  return null;
}
