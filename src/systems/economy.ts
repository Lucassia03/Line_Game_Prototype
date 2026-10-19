import { BUILDING_BALANCE, RESOURCE_ORDER, TIER_BALANCE, UPGRADE_COSTS } from '../config/balance';
import type { BuildingType, Cost, GameState, Owner, Resource, Tier } from '../core/types';
import { addManpower, availableStoredResource, consumeFromStorages, depositResource, refreshEconomyStock, storageAtNode, storagesCanCover } from './storage';

export function hasResources(state: GameState, owner: Owner, cost: Cost): boolean {
  return storagesCanCover(state, owner, cost);
}

export function missingResource(state: GameState, owner: Owner, cost: Cost): Resource | null {
  refreshEconomyStock(state, owner);
  return RESOURCE_ORDER.find((resource) => availableStoredResource(state, owner, resource) + 0.0001 < (cost[resource] ?? 0)) ?? null;
}

export function spendResources(state: GameState, owner: Owner, cost: Cost): boolean {
  return consumeFromStorages(state, owner, cost);
}

export function addResource(state: GameState, owner: Owner, resource: Resource, amount: number): number {
  if (resource === 'manpower') return addManpower(state, owner, amount);
  const center = storageAtNode(state, state.centerNode[owner]);
  return center ? depositResource(state, center, resource, amount) : 0;
}

export function isResourceUnlocked(state: GameState, owner: Owner, resource: Resource): boolean {
  const discovered = state.economy[owner].discovered;
  if (resource === 'manpower' || resource === 'wood') return true;
  if (resource === 'stone' || resource === 'coal') return discovered.has('wood');
  return discovered.has('stone') && discovered.has('coal');
}

export function isBuildingUnlocked(state: GameState, owner: Owner, type: BuildingType): boolean {
  if (type === 'center' || type === 'house' || type === 'woodCamp') return true;
  if (type === 'quarry' || type === 'coalMine') return isResourceUnlocked(state, owner, type === 'quarry' ? 'stone' : 'coal');
  if (type === 'ironMine') return isResourceUnlocked(state, owner, 'iron');
  return state.economy[owner].discovered.has('stone');
}

export function isTierUnlocked(state: GameState, owner: Owner, tier: Tier): boolean {
  if (tier === 'wood') return true;
  if (tier === 'stone') return state.economy[owner].discovered.has('stone');
  return state.economy[owner].discovered.has('iron') && state.economy[owner].discovered.has('coal');
}

export function calculateLineCost(tier: Tier, length: number): Cost {
  const factor = Math.max(0, length / 100);
  const cost: Cost = {};
  for (const resource of RESOURCE_ORDER) {
    const base = TIER_BALANCE[tier].costPer100[resource];
    if (base) cost[resource] = base * factor;
  }
  return cost;
}

export function segmentUpgradeCost(targetTier: Exclude<Tier, 'wood'>): Cost {
  return { ...UPGRADE_COSTS.segment[targetTier] };
}

export function recalculateManpowerCapacity(state: GameState, owner: Owner): void {
  let maximum = owner === 'player' ? 180 : 999;
  for (const building of state.buildings.values()) {
    if (building.owner === owner && building.type === 'house' && building.connected && building.health > 0) {
      maximum += building.level === 1 ? 80 : 150;
    }
  }
  state.economy[owner].maxManpower = maximum;
  // Capacity limits the direct workforce pool; lowering it never destroys existing Manpower.
  refreshEconomyStock(state, owner);
}

export function formatCost(cost: Cost): string {
  return RESOURCE_ORDER.filter((resource) => (cost[resource] ?? 0) > 0)
    .map((resource) => {
      const amount = cost[resource] ?? 0;
      const label = Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(1);
      return `${label} ${resource === 'manpower' ? 'MP' : resource.charAt(0).toUpperCase() + resource.slice(1)}`;
    })
    .join(' · ');
}

export function buildingCost(type: BuildingType): Cost {
  return { ...BUILDING_BALANCE[type].cost };
}
