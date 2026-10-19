import { BUILDING_BALANCE, COLORS, DEPOT, EXTRACTION, RESOURCE_ORDER, STACKING, TIER_BALANCE, UPGRADE_COSTS, WALL_BALANCE, WORLD } from '../config/balance';
import { closestPointOnSegment, distance, lerpVec, pointInEllipse, segmentDistance } from '../core/geometry';
import { addBuilding, addNode, addSegment } from '../core/state';
import type {
  ArrowCollision,
  BuildingType,
  ConstructionPreview,
  Cost,
  GameState,
  LineSegment,
  Owner,
  Tier,
  Vec2,
} from '../core/types';
import { describeArrowImpact, resolveArrowImpact } from './combat';
import { findFirstArrowCollision } from './collision';
import {
  buildingCost,
  calculateLineCost,
  hasResources,
  isBuildingUnlocked,
  isTierUnlocked,
  missingResource,
  segmentUpgradeCost,
  spendResources,
} from './economy';
import { ensureConnectivity, recomputeConnectivity, splitSegment, tierAfter } from './graph';
import { baseProductionPerSecond, extractionAtPosition } from './extraction';
import { addWarning } from './notifications';
import { recordConsumed, spendManpower } from './storage';
import {
  cellsOf,
  consumeCost,
  constructionCostForCell,
  convertArrowCellsToCompleted,
  firstArrowGap,
  firstDamagedCell,
  hasCost,
  manpowerCost,
  physicalCost,
  repairCostForCell,
  serviceConstructionCostForCell,
  stackAddedLayerMultiplier,
  syncSegmentAggregate,
} from './cells';

export interface AnchorResult {
  nodeId?: string;
  segmentId?: string;
  point: Vec2;
  distance: number;
}

export interface ArrowImpactEvent {
  arrowId: string;
  tier: Tier;
  collision: ArrowCollision;
  damage: number;
  targetDestroyed: boolean;
}

export interface ConstructionUpdateResult {
  completed: string[];
  impacts: ArrowImpactEvent[];
  activated: string[];
}

function nodeConnectionRadius(state: GameState, nodeId: string, fallback: number): number {
  const buildingId = state.nodes.get(nodeId)?.buildingId;
  const building = buildingId ? state.buildings.get(buildingId) : undefined;
  return building?.type === 'depot' ? Math.max(fallback, DEPOT.connectionSocketRadius) : fallback;
}

export function findFriendlyAnchor(state: GameState, position: Vec2, maxDistance = WORLD.selectionRadius + 8): AnchorResult | null {
  ensureConnectivity(state);
  let best: AnchorResult | null = null;
  for (const node of state.nodes.values()) {
    if (node.owner !== 'player' || !node.connected) continue;
    const nodeDistance = distance(position, node.position);
    if (nodeDistance <= nodeConnectionRadius(state, node.id, maxDistance) && (!best || nodeDistance < best.distance)) {
      best = { nodeId: node.id, point: { ...node.position }, distance: nodeDistance };
    }
  }
  for (const segment of state.segments.values()) {
    if (segment.owner !== 'player' || segment.constructionState !== 'complete') continue;
    for (const cell of cellsOf(state, segment)) {
      if (!cell.connected || cell.state !== 'intact' || cell.health <= 0) continue;
      const closest = closestPointOnSegment(position, cell.start, cell.end);
      if (closest.distance <= maxDistance && (!best || closest.distance < best.distance)) {
        best = { segmentId: segment.id, point: closest.point, distance: closest.distance };
      }
    }
  }
  return best;
}

function pointInsideWorld(state: GameState, point: Vec2): boolean {
  return point.x >= 0 && point.y >= 0 && point.x <= state.worldSize.x && point.y <= state.worldSize.y;
}

function crossesBlockingTerrain(state: GameState, from: Vec2, to: Vec2, padding = 8): boolean {
  const samples = Math.max(4, Math.ceil(distance(from, to) / 12));
  for (let index = 0; index <= samples; index += 1) {
    const point = lerpVec(from, to, index / samples);
    if (state.terrain.some((terrain) => terrain.blocking && pointInEllipse(point, terrain.position, terrain.radiusX + padding, terrain.radiusY + padding, terrain.rotation))) {
      return true;
    }
  }
  return false;
}

function hostileLineTooClose(state: GameState, from: Vec2, to: Vec2): boolean {
  for (const segment of state.segments.values()) {
    if (segment.owner !== 'enemy' || segment.constructionState !== 'complete') continue;
    for (const cell of cellsOf(state, segment)) {
      if (cell.state !== 'broken' && cell.health > 0 && segmentDistance(from, to, cell.start, cell.end) < WORLD.territoryRadius) return true;
    }
  }
  return false;
}

function wallBlocksPath(state: GameState, from: Vec2, to: Vec2, owner?: Owner): boolean {
  for (const wall of state.walls.values()) {
    if (owner && wall.owner === owner) continue;
    if (segmentDistance(from, to, wall.start, wall.end) <= wall.thickness / 2 + 3) return true;
  }
  return false;
}

function crossesFriendlyLine(state: GameState, from: Vec2, to: Vec2, ignoredSegment?: string, targetSegment?: string): boolean {
  for (const segment of state.segments.values()) {
    if (segment.owner !== 'player' || segment.id === targetSegment || segment.constructionState !== 'complete') continue;
    for (const cell of cellsOf(state, segment)) {
      if (cell.state === 'broken' || cell.health <= 0) continue;
      const separation = segmentDistance(from, to, cell.start, cell.end);
      const endpointTouch = distance(to, cell.start) < 4 || distance(to, cell.end) < 4 || distance(from, cell.start) < 4 || distance(from, cell.end) < 4;
      const departureT = Math.min(1, 12 / Math.max(1, distance(from, to)));
      const departure = lerpVec(from, to, departureT);
      const leavesAnchor = segment.id === ignoredSegment && closestPointOnSegment(from, cell.start, cell.end).distance < 4 &&
        closestPointOnSegment(departure, cell.start, cell.end).distance > 4;
      if (separation < 2.5 && !endpointTouch && !leavesAnchor) return true;
    }
  }
  return false;
}

function findStackTarget(state: GameState, from: Vec2, to: Vec2, tier?: Tier): LineSegment | undefined {
  return [...state.segments.values()].find((segment) => {
    if (segment.owner !== 'player' || segment.constructionState !== 'complete' || !segment.connected || segment.service ||
      segment.stackTargetLevel > segment.stackLevel || (tier && segment.tier !== tier)) return false;
    const a = state.nodes.get(segment.a)?.position;
    const b = state.nodes.get(segment.b)?.position;
    if (!a || !b) return false;
    const matchingEnds = (distance(from, a) <= STACKING.endpointTolerance && distance(to, b) <= STACKING.endpointTolerance) ||
      (distance(from, b) <= STACKING.endpointTolerance && distance(to, a) <= STACKING.endpointTolerance);
    return matchingEnds && segmentDistance(from, to, a, b) <= STACKING.geometryTolerance;
  });
}

export function findSnapTarget(state: GameState, position: Vec2, maxDistance = 22): AnchorResult | null {
  let best: AnchorResult | null = null;
  for (const node of state.nodes.values()) {
    if (node.owner !== 'player') continue;
    const d = distance(position, node.position);
    if (d <= nodeConnectionRadius(state, node.id, maxDistance) && (!best || d < best.distance)) {
      best = { nodeId: node.id, point: { ...node.position }, distance: d };
    }
  }
  for (const segment of state.segments.values()) {
    if (segment.owner !== 'player' || segment.constructionState !== 'complete') continue;
    for (const cell of cellsOf(state, segment)) {
      if (cell.state === 'broken' || cell.health <= 0) continue;
      const closest = closestPointOnSegment(position, cell.start, cell.end);
      if (closest.distance <= maxDistance && (!best || closest.distance < best.distance)) {
        best = { segmentId: segment.id, point: closest.point, distance: closest.distance };
      }
    }
  }
  return best;
}

export function validateLineConstruction(
  state: GameState,
  anchor: AnchorResult,
  rawTarget: Vec2,
  tier: Tier,
): ConstructionPreview {
  ensureConnectivity(state);
  const snap = findSnapTarget(state, rawTarget);
  const to = snap?.point ?? rawTarget;
  const from = anchor.point;
  const length = distance(from, to);
  const overlappingRoute = findStackTarget(state, from, to);
  const stackTarget = findStackTarget(state, from, to, tier);
  const stackNextLevel = stackTarget ? Math.max(stackTarget.stackLevel + 1, stackTarget.stackTargetLevel + 1) : undefined;
  const baseCost = calculateLineCost(tier, length);
  const layerMultiplier = stackNextLevel ?? 1;
  const cost: Cost = {};
  for (const resource of RESOURCE_ORDER) if ((baseCost[resource] ?? 0) > 0) cost[resource] = (baseCost[resource] ?? 0) * layerMultiplier;
  const collision = findFirstArrowCollision(state, 'player', from, to, tier);
  const base: ConstructionPreview = {
    valid: false,
    reason: '',
    from,
    to,
    cost,
    anchorNodeId: anchor.nodeId,
    anchorSegmentId: anchor.segmentId,
    targetNodeId: snap?.nodeId,
    impact: collision ? describeArrowImpact(state, tier, collision) : undefined,
    stackTargetSegmentId: stackTarget?.id,
    stackNextLevel,
  };
  if (!isTierUnlocked(state, 'player', tier)) return { ...base, reason: `${tier.toUpperCase()} Line is not unlocked` };
  if (overlappingRoute && !stackTarget) return { ...base, reason: `Stack layers must match the existing ${overlappingRoute.tier} material` };
  if (stackTarget && STACKING.maxLevelByTier[tier] <= 1) {
    return { ...base, reason: 'Wood Lines cannot stack; use Stone or Iron' };
  }
  if (stackTarget && stackNextLevel && stackNextLevel > STACKING.maxLevelByTier[tier]) {
    return { ...base, reason: `${tier === 'stone' ? 'Stone Lines are limited to stack x2' : 'Maximum stack level reached'}` };
  }
  if (!pointInsideWorld(state, to)) return { ...base, reason: 'Outside the operational area' };
  if (length < WORLD.minSegmentLength) return { ...base, reason: 'Segment is too short' };
  if (crossesBlockingTerrain(state, from, to)) return { ...base, reason: 'Blocked by impassable terrain' };
  if (!stackTarget && crossesFriendlyLine(state, from, to, anchor.segmentId, snap?.segmentId)) return { ...base, reason: 'Crossing requires a junction' };
  return {
    ...base,
    valid: true,
    reason: stackTarget
      ? `Add stack layer ${stackNextLevel} · supplied cell by cell`
      : collision ? `Will engage ${base.impact?.targetLabel ?? 'hostile target'} until destroyed` : 'Release to launch resource-paced Arrow',
  };
}

function resolveAnchorNode(state: GameState, anchor: AnchorResult): string | null {
  if (anchor.nodeId) return anchor.nodeId;
  if (anchor.segmentId) return splitSegment(state, anchor.segmentId, anchor.point)?.nodeId ?? null;
  return null;
}

function hasEarlierPendingOrder(state: GameState, owner: Owner, order: number): boolean {
  return order > 0 && [...state.segments.values()].some(
    (segment) => segment.owner === owner && segment.constructionOrder > 0 && segment.constructionOrder < order && segment.constructionState !== 'complete',
  );
}

export function constructLine(
  state: GameState,
  anchor: AnchorResult,
  target: Vec2,
  tier: Tier,
  order = 0,
): LineSegment | null {
  const preview = validateLineConstruction(state, anchor, target, tier);
  if (!preview.valid) return null;
  if (preview.stackTargetSegmentId) {
    const stacked = state.segments.get(preview.stackTargetSegmentId);
    if (!stacked || stacked.stackTargetLevel > stacked.stackLevel || stacked.stackLevel >= STACKING.maxLevelByTier[stacked.tier]) return null;
    stacked.stackTargetLevel = stacked.stackLevel + 1;
    stacked.stackFrontierCell = 0;
    for (const cell of cellsOf(state, stacked)) {
      cell.constructionSupply = {};
      cell.constructionInTransit = {};
      cell.constructionManpowerPaid = false;
    }
    state.supplyVersion += 1;
    state.nextSupplyPlanTick = state.tick;
    return stacked;
  }
  const queued = hasEarlierPendingOrder(state, 'player', order);
  const startNodeId = resolveAnchorNode(state, anchor);
  if (!startNodeId) return null;
  const snap = findSnapTarget(state, target);
  let endNodeId = snap?.nodeId;
  if (!endNodeId && snap?.segmentId) {
    const split = splitSegment(state, snap.segmentId, snap.point);
    if (!split) return null;
    endNodeId = split.nodeId;
  }
  if (!endNodeId) endNodeId = addNode(state, 'player', preview.to).id;
  if (endNodeId === startNodeId) return null;
  const segment = addSegment(state, 'player', startNodeId, endNodeId, tier, {
    constructionState: queued ? 'queued' : 'building',
    buildProgress: 0,
    constructionOrder: order,
    constructionCost: preview.cost,
  });
  state.stats.segmentsBuilt += 1;
  state.supplyVersion += 1;
  state.nextSupplyPlanTick = state.tick;
  return segment;
}

export interface BuildingValidation {
  valid: boolean;
  reason: string;
  cost: Cost;
  anchor: AnchorResult | null;
  resourceNodeId?: string;
  extractionEfficiency: number;
  baseProductionPerSecond: number;
  actualProductionPerSecond: number;
}

export function validateBuildingPlacement(state: GameState, type: Exclude<BuildingType, 'center'>, position: Vec2): BuildingValidation {
  const cost = buildingCost(type);
  const sampleBuilding = { type, level: 1, extractionEfficiency: 1 } as Parameters<typeof baseProductionPerSecond>[0];
  const sample = extractionAtPosition(state, type, position);
  const baseRate = baseProductionPerSecond(sampleBuilding);
  const actualRate = baseRate * sample.efficiency;
  const details = { extractionEfficiency: sample.efficiency, baseProductionPerSecond: baseRate, actualProductionPerSecond: actualRate };
  if (!isBuildingUnlocked(state, 'player', type)) return { valid: false, reason: 'Resource hierarchy requirement not met', cost, anchor: null, ...details };
  if (!pointInsideWorld(state, position)) return { valid: false, reason: 'Outside the operational area', cost, anchor: null, ...details };
  if (state.terrain.some((terrain) => terrain.blocking && pointInEllipse(position, terrain.position, terrain.radiusX + 25, terrain.radiusY + 25, terrain.rotation))) {
    return { valid: false, reason: 'Cannot build on impassable terrain', cost, anchor: null, ...details };
  }
  for (const building of state.buildings.values()) {
    if (distance(position, building.position) < 58) return { valid: false, reason: 'Too close to another building', cost, anchor: null, ...details };
  }
  for (const wall of state.walls.values()) {
    if (closestPointOnSegment(position, wall.start, wall.end).distance < wall.thickness / 2 + 26) {
      return { valid: false, reason: 'Too close to a Stone Wall', cost, anchor: null, ...details };
    }
  }
  const anchor = findFriendlyAnchor(state, position, WORLD.buildingConnectionRange);
  if (!anchor) return { valid: false, reason: 'Must be near a connected friendly Line', cost, anchor: null, ...details };
  if (crossesBlockingTerrain(state, anchor.point, position, 6)) return { valid: false, reason: 'Connection is blocked by terrain', cost, anchor, ...details };
  if (wallBlocksPath(state, anchor.point, position)) return { valid: false, reason: 'Connection is blocked by a Stone Wall', cost, anchor, ...details };
  const config = BUILDING_BALANCE[type];
  const resourceNodeId = sample.resourceNodeId;
  if (config.requiredNode && (!resourceNodeId || sample.efficiency < EXTRACTION.minimumPlacementEfficiency)) {
    return { valid: false, reason: `Outside useful ${config.requiredNode} extraction range`, cost, anchor, resourceNodeId, ...details };
  }
  if (hostileLineTooClose(state, anchor.point, position)) return { valid: false, reason: 'Enemy Line controls this ground', cost, anchor, resourceNodeId, ...details };
  const missing = missingResource(state, 'player', cost);
  if (missing) return { valid: false, reason: missing === 'manpower' ? 'Insufficient Manpower' : `Insufficient ${missing}`, cost, anchor, resourceNodeId, ...details };
  const efficiencyLabel = config.requiredNode ? ` · ${Math.round(sample.efficiency * 100)}% efficiency · ${(actualRate * 60).toFixed(1)}/min` : '';
  return { valid: true, reason: `Click to construct${efficiencyLabel}`, cost, anchor, resourceNodeId, ...details };
}

export function constructBuilding(state: GameState, type: Exclude<BuildingType, 'center'>, position: Vec2): string | null {
  const validation = validateBuildingPlacement(state, type, position);
  if (!validation.valid || !validation.anchor) return null;
  const anchorNodeId = resolveAnchorNode(state, validation.anchor);
  if (!anchorNodeId) return null;
  const buildingNode = addNode(state, 'player', position, 'building');
  const building = addBuilding(state, 'player', type, position, buildingNode.id, validation.resourceNodeId, false);
  building.extractionEfficiency = validation.extractionEfficiency;
  addSegment(state, 'player', anchorNodeId, buildingNode.id, 'wood', {
    constructionState: 'building',
    buildProgress: 0,
    constructionCost: validation.cost,
    service: true,
  });
  return building.id;
}

function constructionSpeedMultiplier(state: GameState, segment: LineSegment): number {
  const source = state.nodes.get(segment.a);
  if (!source) return 0;
  const incident = [...state.segments.values()].filter(
    (candidate) => candidate.id !== segment.id && candidate.owner === segment.owner && candidate.connected &&
      candidate.constructionState === 'complete' && (candidate.a === source.id || candidate.b === source.id),
  );
  const averageCongestion = incident.length > 0
    ? incident.reduce((total, candidate) => total + candidate.congestion, 0) / incident.length
    : 0;
  let depotBoost = 0;
  for (const building of state.buildings.values()) {
    if (building.owner === segment.owner && building.type === 'depot' && building.connected && distance(building.position, source.position) <= DEPOT.radius) {
      depotBoost = DEPOT.packetSpeedBonus;
      break;
    }
  }
  return (1 + depotBoost) / (1 + averageCongestion * 0.2);
}

function storedTargetCollision(state: GameState, segment: LineSegment, tip: Vec2): ArrowCollision | null {
  const kind = segment.arrowTargetKind;
  const id = segment.arrowTargetId;
  if (!kind || !id) return null;
  const alive = kind === 'wall'
    ? (state.walls.get(id)?.health ?? 0) > 0
    : kind === 'cell'
      ? (state.cells.get(id)?.health ?? 0) > 0 && state.cells.get(id)?.state !== 'broken'
      : (state.buildings.get(id)?.health ?? 0) > 0;
  if (!alive) return null;
  return {
    targetKind: kind,
    targetId: id,
    point: { ...tip },
    t: 0,
    multiplier: segment.arrowTargetMultiplier,
  };
}

function releaseArrowTarget(segment: LineSegment): void {
  segment.constructionState = 'building';
  segment.arrowTargetKind = undefined;
  segment.arrowTargetId = undefined;
  segment.arrowTargetMultiplier = 1;
  segment.attackTimer = 0;
}

function activateNextQueued(state: GameState, owner: Owner): string | null {
  const activeOrdered = [...state.segments.values()].some(
    (segment) => segment.owner === owner && segment.constructionOrder > 0 &&
      (segment.constructionState === 'building' || segment.constructionState === 'attacking'),
  );
  if (activeOrdered) return null;
  const next = [...state.segments.values()]
    .filter((segment) => segment.owner === owner && segment.constructionState === 'queued')
    .sort((a, b) => a.constructionOrder - b.constructionOrder)[0];
  if (!next) return null;
  const source = state.nodes.get(next.a);
  if (!source?.connected) return null;
  next.constructionState = 'building';
  next.buildProgress = 0;
  return next.id;
}

export function updateConstruction(state: GameState, dt: number): ConstructionUpdateResult {
  ensureConnectivity(state);
  const result: ConstructionUpdateResult = { completed: [], impacts: [], activated: [] };
  const activeArrows = [...state.segments.values()].filter(
    (segment) => segment.constructionState === 'building' || segment.constructionState === 'attacking',
  );

  for (const segment of activeArrows) {
    if (!state.segments.has(segment.id)) continue;
    const source = state.nodes.get(segment.a);
    const destination = state.nodes.get(segment.b);
    if (!source || !destination) continue;
    if (!source.connected) {
      if (segment.owner === 'player' && state.tick % 90 === 0) addWarning(state, 'Arrow supply line cut — construction and damage paused', 'danger');
      continue;
    }

    const gap = firstArrowGap(state, segment);
    if (gap) {
      gap.repairRequested = true;
      if (segment.owner === 'player' && state.tick % 90 === 0) addWarning(state, 'Arrow cut — rebuilding the first missing cell before the frontier', 'danger');
      continue;
    }

    const cells = cellsOf(state, segment);
    const frontier = cells[Math.min(segment.frontierCell, Math.max(0, cells.length - 1))];
    const tip = frontier
      ? lerpVec(frontier.start, frontier.end, segment.frontierCell >= cells.length ? 1 : frontier.constructionProgress)
      : { ...source.position };
    if (segment.constructionState === 'attacking') {
      const collision = storedTargetCollision(state, segment, tip);
      if (!collision) {
        releaseArrowTarget(segment);
        continue;
      }
      segment.attackTimer = Math.max(0, segment.attackTimer - dt);
      const assaultCost = TIER_BALANCE[segment.tier].assaultCost;
      if (segment.attackTimer > 0 || !hasCost(segment.assaultSupply, assaultCost)) continue;
      if (!spendManpower(state, segment.owner, manpowerCost(assaultCost))) continue;
      consumeCost(segment.assaultSupply, assaultCost);
      recordConsumed(state, physicalCost(assaultCost));
      state.supplyVersion += 1;
      const resolution = resolveArrowImpact(state, segment.tier, segment.owner, collision);
      segment.attackTimer = TIER_BALANCE[segment.tier].assaultInterval / Math.max(0.1, constructionSpeedMultiplier(state, segment));
      result.impacts.push({
        arrowId: segment.id,
        tier: segment.tier,
        collision,
        damage: resolution.damage,
        targetDestroyed: resolution.targetDestroyed,
      });
      if (resolution.targetDestroyed) releaseArrowTarget(segment);
      continue;
    }

    if (!frontier) continue;
    const required = segment.service ? serviceConstructionCostForCell(state, segment, frontier) : constructionCostForCell(frontier, segment.tier, 1);
    if (!hasCost(frontier.constructionSupply, required)) continue;
    if (!frontier.constructionManpowerPaid) {
      if (!spendManpower(state, segment.owner, manpowerCost(required))) continue;
      frontier.constructionManpowerPaid = true;
    }
    if (frontier.state === 'planned') frontier.state = 'building';
    const oldProgress = frontier.constructionProgress;
    const buildTime = Math.max(0.08, (frontier.length / 100) * TIER_BALANCE[segment.tier].buildSecondsPer100);
    const nextProgress = Math.min(1, oldProgress + (dt / buildTime) * constructionSpeedMultiplier(state, segment));
    const oldTip = lerpVec(frontier.start, frontier.end, oldProgress);
    const nextTip = lerpVec(frontier.start, frontier.end, nextProgress);
    const collision = findFirstArrowCollision(state, segment.owner, oldTip, nextTip, segment.tier);

    if (collision) {
      const collisionProgress = oldProgress + (nextProgress - oldProgress) * collision.t;
      const addedStructure = frontier.maxHealth * Math.max(0, collisionProgress - oldProgress);
      frontier.constructionProgress = collisionProgress;
      frontier.health = Math.min(frontier.maxHealth * collisionProgress, Math.max(0, frontier.health) + addedStructure);
      segment.constructionState = 'attacking';
      segment.arrowTargetKind = collision.targetKind;
      segment.arrowTargetId = collision.targetId;
      segment.arrowTargetMultiplier = collision.multiplier;
      segment.attackTimer = 0;
      continue;
    }

    const addedStructure = frontier.maxHealth * Math.max(0, nextProgress - oldProgress);
    frontier.constructionProgress = nextProgress;
    frontier.health = Math.min(frontier.maxHealth * nextProgress, Math.max(0, frontier.health) + addedStructure);
    if (nextProgress >= 1) {
      consumeCost(frontier.constructionSupply, required);
      recordConsumed(state, physicalCost(required));
      state.supplyVersion += 1;
      state.nextSupplyPlanTick = state.tick;
      frontier.state = 'intact';
      frontier.connected = true;
      segment.frontierCell += 1;
      state.spatialVersion += 1;
      syncSegmentAggregate(state, segment);
    }
    if (segment.frontierCell >= cells.length) {
      segment.constructionState = 'complete';
      segment.buildProgress = 1;
      convertArrowCellsToCompleted(state, segment);
      state.topologyVersion += 1;
      if (segment.service) {
        const buildingId = state.nodes.get(segment.b)?.buildingId;
        const building = buildingId ? state.buildings.get(buildingId) : undefined;
        if (building) building.constructionComplete = true;
      }
      result.completed.push(segment.id);
    }
  }

  // Stack additions are supplied and constructed one cell at a time while the
  // underlying completed route remains available to logistics.
  for (const segment of state.segments.values()) {
    segment.stackTargetLevel = Math.min(segment.stackTargetLevel, STACKING.maxLevelByTier[segment.tier]);
    if (segment.stackTargetLevel <= segment.stackLevel || segment.constructionState !== 'complete') continue;
    const cells = cellsOf(state, segment);
    const cell = cells[segment.stackFrontierCell];
    if (!cell) {
      segment.stackLevel = segment.stackTargetLevel;
      segment.stackFrontierCell = cells.length;
      state.topologyVersion += 1;
      continue;
    }
    const required = constructionCostForCell(cell, segment.tier, stackAddedLayerMultiplier(segment.stackTargetLevel));
    if (!hasCost(cell.constructionSupply, required)) continue;
    if (!cell.constructionManpowerPaid) {
      if (!spendManpower(state, segment.owner, manpowerCost(required))) continue;
      cell.constructionManpowerPaid = true;
    }
    consumeCost(cell.constructionSupply, required);
    recordConsumed(state, physicalCost(required));
    state.supplyVersion += 1;
    state.nextSupplyPlanTick = state.tick;
    segment.stackFrontierCell += 1;
  }

  // Delivered repair bundles are the only source of cell regeneration.
  for (const segment of state.segments.values()) {
    const repairCost = repairCostForCell(segment.tier);
    for (const cell of cellsOf(state, segment)) {
      if (!cell.repairRequested || !hasCost(cell.repairSupply, repairCost)) continue;
      if (!spendManpower(state, segment.owner, manpowerCost(repairCost))) continue;
      consumeCost(cell.repairSupply, repairCost);
      recordConsumed(state, physicalCost(repairCost));
      state.supplyVersion += 1;
      state.nextSupplyPlanTick = state.tick;
      const wasBroken = cell.state === 'broken' || cell.health <= 0;
      if (wasBroken) cell.state = 'rebuilding';
      const partialFrontier = segment.constructionState !== 'complete' && cell.index === segment.frontierCell && cell.constructionProgress < 1;
      const repairTargetHealth = partialFrontier ? cell.maxHealth * cell.constructionProgress : cell.maxHealth;
      cell.health = Math.min(repairTargetHealth, cell.health + TIER_BALANCE[segment.tier].repairHealthPerSupply);
      if (cell.health > 0) cell.state = partialFrontier ? 'building' : 'intact';
      cell.repairRequested = cell.health + 0.0001 < repairTargetHealth;
      cell.damageFlash = 0;
      syncSegmentAggregate(state, segment);
      if (wasBroken) {
        state.topologyVersion += 1;
        state.spatialVersion += 1;
      }
      state.floatingTexts.push({ id: `repair-${state.tick}-${cell.id}`, position: lerpVec(cell.start, cell.end, 0.5), text: `+${TIER_BALANCE[segment.tier].repairHealthPerSupply}`, color: COLORS.player, life: 1 });
    }
  }

  if (result.completed.length > 0) recomputeConnectivity(state);
  for (const owner of ['player', 'enemy'] as const) {
    const activated = activateNextQueued(state, owner);
    if (activated) result.activated.push(activated);
  }
  return result;
}

export function repairSegment(state: GameState, segmentId: string): boolean {
  const segment = state.segments.get(segmentId);
  const cell = segment ? firstDamagedCell(state, segment) : undefined;
  if (!segment || segment.owner !== 'player' || !cell) return false;
  cell.repairRequested = true;
  state.supplyVersion += 1;
  state.nextSupplyPlanTick = state.tick;
  return true;
}

export function repairBuilding(state: GameState, buildingId: string): boolean {
  const building = state.buildings.get(buildingId);
  if (!building || building.owner !== 'player' || building.health >= building.maxHealth) return false;
  const cost: Cost = { manpower: 3, wood: 2 };
  if (!spendResources(state, 'player', cost)) return false;
  building.health = Math.min(building.maxHealth, building.health + 65);
  return true;
}

export function upgradeSegment(state: GameState, segmentId: string): boolean {
  const segment = state.segments.get(segmentId);
  if (!segment || segment.owner !== 'player' || segment.constructionState !== 'complete') return false;
  const target = tierAfter(segment.tier);
  if (!target || target === 'wood' || !isTierUnlocked(state, 'player', target)) return false;
  const cost = segmentUpgradeCost(target);
  if (!spendResources(state, 'player', cost)) return false;
  const balance = TIER_BALANCE[target];
  segment.tier = target;
  for (const cell of cellsOf(state, segment)) {
    const previousHealthRatio = cell.maxHealth > 0 ? cell.health / cell.maxHealth : 0;
    cell.maxHealth = balance.completedCellHealth;
    cell.health = cell.maxHealth * Math.max(0.5, previousHealthRatio);
  }
  syncSegmentAggregate(state, segment);
  segment.armor = balance.armor;
  segment.capacity = balance.lanesPerDirection;
  state.topologyVersion += 1;
  return true;
}

export function upgradeHouse(state: GameState, buildingId: string): boolean {
  const building = state.buildings.get(buildingId);
  if (!building || building.owner !== 'player' || building.type !== 'house' || building.level >= 2) return false;
  if (!hasResources(state, 'player', UPGRADE_COSTS.house) || !spendResources(state, 'player', UPGRADE_COSTS.house)) return false;
  building.level = 2;
  building.maxHealth += 120;
  building.health += 120;
  return true;
}

export function arrowDamagePerSupply(tier: Tier): number {
  return TIER_BALANCE[tier].damagePerSupply;
}

export function wallImpactMultiplier(tier: Tier): number {
  return WALL_BALANCE.impactMultipliers[tier];
}
