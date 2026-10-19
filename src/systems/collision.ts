import { TIER_BALANCE, WALL_BALANCE, WORLD } from '../config/balance';
import { closestPointOnSegment, distance, lerpVec } from '../core/geometry';
import type { ArrowCollision, GameState, Owner, Tier, Vec2 } from '../core/types';
import { SpatialHash } from './spatialHash';

type CollisionKey = `wall:${string}` | `building:${string}` | `cell:${string}`;

const hostileIndex = new SpatialHash<CollisionKey>(150);
let indexedState: GameState | null = null;
let indexedTopology = -1;
let indexedWalls = -1;
let indexedBuildings = -1;
let indexedSpatialVersion = -1;

function ensureCollisionIndex(state: GameState): void {
  if (
    indexedState === state &&
    indexedTopology === state.topologyVersion &&
    indexedWalls === state.walls.size &&
    indexedBuildings === state.buildings.size &&
    indexedSpatialVersion === state.spatialVersion
  ) return;
  hostileIndex.clear();
  for (const wall of state.walls.values()) {
    const padding = wall.thickness / 2;
    hostileIndex.insert(`wall:${wall.id}`, {
      minX: Math.min(wall.start.x, wall.end.x) - padding,
      minY: Math.min(wall.start.y, wall.end.y) - padding,
      maxX: Math.max(wall.start.x, wall.end.x) + padding,
      maxY: Math.max(wall.start.y, wall.end.y) + padding,
    });
  }
  for (const building of state.buildings.values()) {
    const radius = buildingCollisionRadius(building.type);
    hostileIndex.insertPoint(`building:${building.id}`, building.position, radius);
  }
  for (const cell of state.cells.values()) {
    const segment = state.segments.get(cell.segmentId);
    if (!segment || cell.state === 'planned' || cell.state === 'broken' || cell.health <= 0) continue;
    const padding = TIER_BALANCE[segment.tier].width / 2;
    hostileIndex.insert(`cell:${cell.id}`, {
      minX: Math.min(cell.start.x, cell.end.x) - padding,
      minY: Math.min(cell.start.y, cell.end.y) - padding,
      maxX: Math.max(cell.start.x, cell.end.x) + padding,
      maxY: Math.max(cell.start.y, cell.end.y) + padding,
    });
  }
  indexedState = state;
  indexedTopology = state.topologyVersion;
  indexedWalls = state.walls.size;
  indexedBuildings = state.buildings.size;
  indexedSpatialVersion = state.spatialVersion;
}

export function buildingCollisionRadius(type: string): number {
  return type === 'center' ? 38 : 23;
}

function firstSweepContact(
  from: Vec2,
  to: Vec2,
  intersects: (point: Vec2) => boolean,
): number | null {
  if (intersects(from)) return 0;
  const steps = Math.max(1, Math.ceil(distance(from, to) / 3));
  let previousT = 0;
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    if (!intersects(lerpVec(from, to, t))) {
      previousT = t;
      continue;
    }
    let low = previousT;
    let high = t;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const middle = (low + high) / 2;
      if (intersects(lerpVec(from, to, middle))) high = middle;
      else low = middle;
    }
    return high;
  }
  return null;
}

function collisionPriority(kind: ArrowCollision['targetKind']): number {
  if (kind === 'wall') return 0;
  if (kind === 'building') return 1;
  return 2;
}

export function findFirstArrowCollision(
  state: GameState,
  owner: Owner,
  from: Vec2,
  to: Vec2,
  tier: Tier,
): ArrowCollision | null {
  const candidates: ArrowCollision[] = [];
  const tipRadius = WORLD.arrowTipRadius + TIER_BALANCE[tier].width * 0.18;
  ensureCollisionIndex(state);
  const nearby = hostileIndex.query({
    minX: Math.min(from.x, to.x) - tipRadius,
    minY: Math.min(from.y, to.y) - tipRadius,
    maxX: Math.max(from.x, to.x) + tipRadius,
    maxY: Math.max(from.y, to.y) + tipRadius,
  });

  for (const key of nearby) {
    if (!key.startsWith('wall:')) continue;
    const wall = state.walls.get(key.slice(5));
    if (!wall) continue;
    if (wall.owner === owner || wall.health <= 0) continue;
    const collisionRadius = tipRadius + wall.thickness / 2;
    const t = firstSweepContact(from, to, (point) => closestPointOnSegment(point, wall.start, wall.end).distance <= collisionRadius);
    if (t !== null) {
      candidates.push({
        targetKind: 'wall',
        targetId: wall.id,
        point: lerpVec(from, to, t),
        t,
        multiplier: WALL_BALANCE.impactMultipliers[tier],
      });
    }
  }

  for (const key of nearby) {
    if (!key.startsWith('building:')) continue;
    const building = state.buildings.get(key.slice(9));
    if (!building) continue;
    if (building.owner === owner || building.health <= 0) continue;
    const radius = tipRadius + buildingCollisionRadius(building.type);
    const t = firstSweepContact(from, to, (point) => distance(point, building.position) <= radius);
    if (t !== null) {
      candidates.push({
        targetKind: 'building',
        targetId: building.id,
        point: lerpVec(from, to, t),
        t,
        multiplier: 1,
      });
    }
  }

  for (const key of nearby) {
    if (!key.startsWith('cell:')) continue;
    const cell = state.cells.get(key.slice(5));
    const segment = cell ? state.segments.get(cell.segmentId) : undefined;
    if (!cell || !segment) continue;
    if (segment.owner === owner || cell.health <= 0 || cell.state === 'broken' || cell.state === 'planned') continue;
    const collisionRadius = tipRadius + TIER_BALANCE[segment.tier].width / 2;
    const collisionEnd = cell.state === 'building' ? lerpVec(cell.start, cell.end, cell.constructionProgress) : cell.end;
    const t = firstSweepContact(from, to, (point) => closestPointOnSegment(point, cell.start, collisionEnd).distance <= collisionRadius);
    if (t !== null) {
      candidates.push({
        targetKind: 'cell',
        targetId: cell.id,
        targetCellId: cell.id,
        point: lerpVec(from, to, t),
        t,
        multiplier: 1,
      });
    }
  }

  candidates.sort((a, b) => a.t - b.t || collisionPriority(a.targetKind) - collisionPriority(b.targetKind) || a.targetId.localeCompare(b.targetId));
  return candidates[0] ?? null;
}
