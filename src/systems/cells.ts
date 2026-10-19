import { COMMODITY_ORDER, RESOURCE_ORDER, TIER_BALANCE } from '../config/balance';
import type { Cost, GameState, LineCell, LineSegment, Resource, Tier, Vec2 } from '../core/types';

export function cellsOf(state: GameState, segment: LineSegment): LineCell[] {
  return segment.cellIds.map((id) => state.cells.get(id)).filter((cell): cell is LineCell => Boolean(cell));
}

export function livingCellsOf(state: GameState, segment: LineSegment): LineCell[] {
  return cellsOf(state, segment).filter((cell) => cell.state !== 'planned' && cell.state !== 'broken' && cell.health > 0);
}

export function cellIsPassable(cell: LineCell | undefined): boolean {
  return Boolean(cell && cell.state === 'intact' && cell.health > 0);
}

export function segmentIsPassable(state: GameState, segment: LineSegment): boolean {
  return segment.constructionState === 'complete' && cellsOf(state, segment).every(cellIsPassable);
}

export function firstBrokenCell(state: GameState, segment: LineSegment): LineCell | undefined {
  return cellsOf(state, segment).find((cell) => cell.state === 'broken' || cell.health <= 0);
}

export function firstDamagedCell(state: GameState, segment: LineSegment): LineCell | undefined {
  return cellsOf(state, segment).find((cell) => cell.state === 'broken' || cell.health + 0.0001 < cell.maxHealth);
}

export function firstArrowGap(state: GameState, segment: LineSegment): LineCell | undefined {
  const cells = cellsOf(state, segment);
  const rearGap = cells.slice(0, segment.frontierCell).find((cell) => !cellIsPassable(cell));
  if (rearGap) return rearGap;
  const frontier = cells[segment.frontierCell];
  return frontier && (frontier.state === 'broken' || (frontier.constructionProgress > 0 && frontier.health <= 0))
    ? frontier
    : undefined;
}

export function syncSegmentAggregate(state: GameState, segment: LineSegment): void {
  const cells = cellsOf(state, segment);
  segment.health = cells.reduce((sum, cell) => sum + Math.max(0, cell.health), 0);
  segment.maxHealth = cells.reduce((sum, cell) => sum + cell.maxHealth, 0);
  segment.buildProgress = cells.length > 0
    ? Math.min(1, (segment.frontierCell + (cells[segment.frontierCell]?.constructionProgress ?? 0)) / cells.length)
    : 1;
}

export function costAmount(cost: Cost, resource: Resource): number {
  return Math.max(0, cost[resource] ?? 0);
}

export function addCost(target: Cost, resource: Resource, amount: number): void {
  target[resource] = costAmount(target, resource) + amount;
}

export function subtractCost(target: Cost, resource: Resource, amount: number): void {
  target[resource] = Math.max(0, costAmount(target, resource) - amount);
}

export function hasCost(delivered: Cost, required: Cost): boolean {
  return COMMODITY_ORDER.every((resource) => costAmount(delivered, resource) + 0.0001 >= costAmount(required, resource));
}

export function consumeCost(delivered: Cost, required: Cost): void {
  for (const resource of COMMODITY_ORDER) subtractCost(delivered, resource, costAmount(required, resource));
}

export function physicalCost(cost: Cost): Cost {
  const result: Cost = {};
  for (const resource of COMMODITY_ORDER) {
    const amount = costAmount(cost, resource);
    if (amount > 0.0001) result[resource] = amount;
  }
  return result;
}

export function manpowerCost(cost: Cost): number {
  return costAmount(cost, 'manpower');
}

export function scaleCost(cost: Cost, factor: number): Cost {
  const result: Cost = {};
  for (const resource of RESOURCE_ORDER) {
    const value = costAmount(cost, resource) * factor;
    if (value > 0.0001) result[resource] = value;
  }
  return result;
}

export function constructionCostForCell(cell: LineCell, tier: Tier, layer = 1): Cost {
  return scaleCost(TIER_BALANCE[tier].costPer100, (cell.length / 100) * layer);
}

/** Distributes an attached building project's existing total cost over its service Arrow cells. */
export function serviceConstructionCostForCell(state: GameState, segment: LineSegment, cell: LineCell): Cost {
  const cells = cellsOf(state, segment);
  const totalLength = cells.reduce((sum, candidate) => sum + candidate.length, 0);
  const factor = totalLength > 0 ? cell.length / totalLength : 1 / Math.max(1, cells.length);
  return scaleCost(segment.constructionCost, factor);
}

export function repairCostForCell(tier: Tier): Cost {
  return { ...TIER_BALANCE[tier].assaultCost };
}

export function convertArrowCellsToCompleted(state: GameState, segment: LineSegment): void {
  const newMaximum = TIER_BALANCE[segment.tier].completedCellHealth;
  for (const cell of cellsOf(state, segment)) {
    const ratio = cell.maxHealth > 0 ? Math.max(0, Math.min(1, cell.health / cell.maxHealth)) : 0;
    cell.maxHealth = newMaximum;
    cell.health = newMaximum * ratio;
    if (cell.health > 0) cell.state = 'intact';
    cell.constructionProgress = 1;
  }
  segment.frontierCell = segment.cellIds.length;
  syncSegmentAggregate(state, segment);
}

export function markCellBroken(state: GameState, cell: LineCell): void {
  if (cell.state === 'broken') return;
  const segment = state.segments.get(cell.segmentId);
  cell.health = 0;
  cell.state = 'broken';
  cell.connected = false;
  cell.repairRequested = segment?.owner === 'player' && segment.constructionState !== 'complete';
  cell.damageFlash = 1;
  if (segment) syncSegmentAggregate(state, segment);
  state.topologyVersion += 1;
  state.spatialVersion += 1;
  state.supplyVersion += 1;
  state.nextSupplyPlanTick = state.tick;
}

export function cellPoint(cell: LineCell, progress: number): Vec2 {
  const t = Math.max(0, Math.min(1, progress));
  return { x: cell.start.x + (cell.end.x - cell.start.x) * t, y: cell.start.y + (cell.end.y - cell.start.y) * t };
}

export interface ConstructionSupplyProgress {
  delivered: number;
  inTransit: number;
  required: number;
  built: number;
  ratio: number;
}

/** Resource-weighted progress used by the Arrow construction advancement bar. */
export function constructionSupplyProgress(state: GameState, segment: LineSegment): ConstructionSupplyProgress {
  let delivered = 0;
  let inTransit = 0;
  let required = 0;
  let built = 0;
  const stacking = segment.stackTargetLevel > segment.stackLevel;
  const layer = stacking ? segment.stackTargetLevel : 1;
  for (const cell of cellsOf(state, segment)) {
    const cost = segment.service ? serviceConstructionCostForCell(state, segment, cell) : constructionCostForCell(cell, segment.tier, layer);
    for (const resource of COMMODITY_ORDER) {
      const amount = costAmount(cost, resource);
      required += amount;
      if ((stacking && cell.index < segment.stackFrontierCell) || (!stacking && cell.index < segment.frontierCell)) built += amount;
      delivered += Math.min(amount, costAmount(cell.constructionSupply, resource));
      inTransit += Math.min(amount, costAmount(cell.constructionInTransit, resource));
    }
  }
  const accounted = Math.min(required, built + delivered + inTransit);
  return { delivered, inTransit, required, built, ratio: required > 0 ? accounted / required : 1 };
}

export function stackCumulativeMultiplier(level: number): number {
  const n = Math.max(1, Math.floor(level));
  return (n * (n + 1)) / 2;
}

export function stackAddedLayerMultiplier(nextLevel: number): number {
  return Math.max(1, Math.floor(nextLevel));
}
