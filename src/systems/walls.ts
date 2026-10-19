import { BUILDING_BALANCE, COLORS, TIER_BALANCE, WALL_BALANCE } from '../config/balance';
import { closestPointOnSegment, distance, dot, normalize, pointInEllipse, segmentDistance, sub } from '../core/geometry';
import { addWall } from '../core/state';
import type { Cost, GameState, Owner, StoneWall, Vec2, WallConstructionPreview } from '../core/types';
import { missingResource, spendResources } from './economy';

function wallCost(length: number): Cost {
  const factor = Math.max(0.4, length / 100);
  return {
    manpower: Math.ceil((WALL_BALANCE.costPer100.manpower ?? 0) * factor),
    stone: Math.ceil((WALL_BALANCE.costPer100.stone ?? 0) * factor),
  };
}

export function isWallUnlocked(state: GameState, owner: Owner): boolean {
  return state.economy[owner].discovered.has('stone');
}

export function snapWallPoint(state: GameState, owner: Owner, point: Vec2): { point: Vec2; snapped: boolean; wallId?: string } {
  let best: { point: Vec2; distance: number; wallId: string } | null = null;
  for (const wall of state.walls.values()) {
    if (wall.owner !== owner) continue;
    for (const endpoint of [wall.start, wall.end]) {
      const d = distance(point, endpoint);
      if (d <= WALL_BALANCE.snapDistance && (!best || d < best.distance)) best = { point: endpoint, distance: d, wallId: wall.id };
    }
  }
  return best ? { point: { ...best.point }, snapped: true, wallId: best.wallId } : { point: { ...point }, snapped: false };
}

function intersectsTerrain(state: GameState, from: Vec2, to: Vec2): boolean {
  const samples = Math.max(4, Math.ceil(distance(from, to) / 6));
  for (let index = 0; index <= samples; index += 1) {
    const t = index / samples;
    const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    if (state.terrain.some((terrain) => terrain.blocking && pointInEllipse(
      point,
      terrain.position,
      terrain.radiusX + WALL_BALANCE.thickness / 2,
      terrain.radiusY + WALL_BALANCE.thickness / 2,
      terrain.rotation,
    ))) return true;
  }
  return false;
}

function sharedEndpoint(newStart: Vec2, newEnd: Vec2, wall: StoneWall): { shared: Vec2; newOther: Vec2; oldOther: Vec2 } | null {
  const pairs = [
    { a: newStart, b: wall.start, newOther: newEnd, oldOther: wall.end },
    { a: newStart, b: wall.end, newOther: newEnd, oldOther: wall.start },
    { a: newEnd, b: wall.start, newOther: newStart, oldOther: wall.end },
    { a: newEnd, b: wall.end, newOther: newStart, oldOther: wall.start },
  ];
  const match = pairs.find((pair) => distance(pair.a, pair.b) < 1.5);
  return match ? { shared: match.b, newOther: match.newOther, oldOther: match.oldOther } : null;
}

function invalidWallIntersection(from: Vec2, to: Vec2, wall: StoneWall): boolean {
  const separation = segmentDistance(from, to, wall.start, wall.end);
  if (separation > (WALL_BALANCE.thickness + wall.thickness) / 2) return false;
  const joint = sharedEndpoint(from, to, wall);
  if (!joint) return true;
  const intoExisting = normalize(sub(joint.oldOther, joint.shared));
  const newDirection = normalize(sub(joint.newOther, joint.shared));
  return dot(intoExisting, newDirection) > 0.15;
}

export function validateWallPlacement(
  state: GameState,
  rawFrom: Vec2,
  rawTo: Vec2,
  owner: Owner = 'player',
): WallConstructionPreview {
  const startSnap = snapWallPoint(state, owner, rawFrom);
  const endSnap = snapWallPoint(state, owner, rawTo);
  const from = startSnap.point;
  const to = endSnap.point;
  const length = distance(from, to);
  const cost = wallCost(length);
  const base: WallConstructionPreview = {
    valid: false,
    reason: '',
    from,
    to,
    cost,
    snappedStart: startSnap.snapped,
    snappedEnd: endSnap.snapped,
  };
  if (!isWallUnlocked(state, owner)) return { ...base, reason: 'Deliver Stone to unlock Stone Walls' };
  if (from.x < 20 || from.y < 20 || to.x < 20 || to.y < 20 || from.x > state.worldSize.x - 20 || to.x > state.worldSize.x - 20 || from.y > state.worldSize.y - 20 || to.y > state.worldSize.y - 20) {
    return { ...base, reason: 'Outside the operational area' };
  }
  if (length < WALL_BALANCE.minLength) return { ...base, reason: 'Wall section is too short' };
  if (length > WALL_BALANCE.maxLength) return { ...base, reason: `Maximum Wall length is ${WALL_BALANCE.maxLength}` };
  if (intersectsTerrain(state, from, to)) return { ...base, reason: 'Wall intersects impassable terrain' };

  for (const building of state.buildings.values()) {
    const radius = building.type === 'center' ? 38 : 23;
    if (closestPointOnSegment(building.position, from, to).distance <= radius + WALL_BALANCE.thickness / 2) {
      return { ...base, reason: `Wall intersects ${BUILDING_BALANCE[building.type].label}` };
    }
  }
  for (const resource of state.resourceNodes.values()) {
    if (closestPointOnSegment(resource.position, from, to).distance <= resource.radius + WALL_BALANCE.thickness / 2) {
      return { ...base, reason: `Wall intersects ${resource.type} deposit` };
    }
  }
  for (const cell of state.cells.values()) {
    const segment = state.segments.get(cell.segmentId);
    if (!segment || cell.state === 'planned' || cell.state === 'broken' || cell.health <= 0) continue;
    const lineWidth = TIER_BALANCE[segment.tier].width;
    if (segmentDistance(from, to, cell.start, cell.end) <= (WALL_BALANCE.thickness + lineWidth) / 2 + 1) {
      return { ...base, reason: 'Wall intersects a Line' };
    }
  }
  for (const wall of state.walls.values()) {
    if (invalidWallIntersection(from, to, wall)) return { ...base, reason: 'Wall intersects an existing Wall' };
  }
  const missing = missingResource(state, owner, cost);
  if (missing) return { ...base, reason: missing === 'manpower' ? 'Insufficient Manpower' : `Insufficient ${missing}` };
  return { ...base, valid: true, reason: startSnap.snapped || endSnap.snapped ? 'Snapped · release to build Wall' : 'Release to build Stone Wall' };
}

export function constructWall(state: GameState, rawFrom: Vec2, rawTo: Vec2, owner: Owner = 'player'): StoneWall | null {
  const preview = validateWallPlacement(state, rawFrom, rawTo, owner);
  if (!preview.valid || !spendResources(state, owner, preview.cost)) return null;
  const wall = addWall(state, owner, preview.from, preview.to);
  if (owner === 'player') state.stats.wallsBuilt += 1;
  return wall;
}

export function repairWall(state: GameState, wallId: string): boolean {
  const wall = state.walls.get(wallId);
  if (!wall || wall.owner !== 'player' || wall.health >= wall.maxHealth) return false;
  const cost: Cost = { manpower: 2, stone: 2 };
  if (!spendResources(state, 'player', cost)) return false;
  wall.health = Math.min(wall.maxHealth, wall.health + 55);
  state.floatingTexts.push({
    id: `repair-wall-${state.tick}-${wall.id}`,
    position: { x: (wall.start.x + wall.end.x) / 2, y: (wall.start.y + wall.end.y) / 2 },
    text: '+55',
    color: COLORS.player,
    life: 1,
  });
  return true;
}

export function stoneWallCostPer100(): Cost {
  return { ...WALL_BALANCE.costPer100 };
}
