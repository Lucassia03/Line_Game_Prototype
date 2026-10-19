import { COMMODITY_ORDER, EMPTY_COMMODITY_STOCK, EMPTY_STOCK, INITIAL_PLAYER_STOCK, RESOURCE_ORDER } from '../config/balance';
import { addStorage, nextId } from '../core/state';
import type { CommodityResource, Cost, GameState, Owner, Resource, StorageSite, Vec2 } from '../core/types';
import { findRoute } from './graph';

export function storageAtNode(state: GameState, nodeId: string): StorageSite | undefined {
  return [...state.storages.values()].find((storage) => storage.nodeId === nodeId);
}

export function storageForBuilding(state: GameState, buildingId: string): StorageSite | undefined {
  const building = state.buildings.get(buildingId);
  return building ? storageAtNode(state, building.nodeId) : undefined;
}

export function storageIsAliveAndConnected(state: GameState, storage: StorageSite): boolean {
  const node = state.nodes.get(storage.nodeId);
  if (!node || node.owner !== storage.owner || !node.connected) return false;
  if (storage.kind === 'stockpile') return true;
  const buildingId = node.buildingId;
  const building = buildingId ? state.buildings.get(buildingId) : undefined;
  return Boolean(building && building.health > 0 && building.connected && building.constructionComplete);
}

export function refreshEconomyStock(state: GameState, owner?: Owner): void {
  const owners: Owner[] = owner ? [owner] : ['player', 'enemy'];
  for (const currentOwner of owners) {
    const aggregate = EMPTY_STOCK();
    aggregate.manpower = state.economy[currentOwner].stock.manpower;
    for (const storage of state.storages.values()) {
      if (storage.owner !== currentOwner) continue;
      for (const resource of COMMODITY_ORDER) aggregate[resource] += storage.inventory[resource];
    }
    state.economy[currentOwner].stock = aggregate;
  }
}

export function storedAmount(storage: StorageSite): number {
  return COMMODITY_ORDER.reduce((sum, resource) => sum + storage.inventory[resource], 0);
}

export function reservedAmount(storage: StorageSite): number {
  return COMMODITY_ORDER.reduce((sum, resource) => sum + storage.reserved[resource], 0);
}

export function availableInventory(storage: StorageSite, resource: CommodityResource): number {
  return Math.max(0, storage.inventory[resource] - storage.reserved[resource]);
}

export function availableStorageCapacity(storage: StorageSite): number {
  if (!Number.isFinite(storage.maxStorage)) return Number.POSITIVE_INFINITY;
  return Math.max(0, storage.maxStorage - storedAmount(storage) - storage.incomingReservedCapacity);
}

export function reserveIncomingCapacity(storage: StorageSite, amount: number): boolean {
  if (amount <= 0) return true;
  if (availableStorageCapacity(storage) + 0.0001 < amount) return false;
  storage.incomingReservedCapacity += amount;
  return true;
}

export function releaseIncomingCapacity(storage: StorageSite, amount: number): void {
  storage.incomingReservedCapacity = Math.max(0, storage.incomingReservedCapacity - Math.max(0, amount));
}

export function reserveStoredResource(storage: StorageSite, resource: CommodityResource, amount: number): boolean {
  if (amount <= 0) return true;
  if (availableInventory(storage, resource) + 0.0001 < amount) return false;
  storage.reserved[resource] += amount;
  return true;
}

export function releaseStoredResource(storage: StorageSite, resource: CommodityResource, amount: number): void {
  const remaining = storage.reserved[resource] - Math.max(0, amount);
  storage.reserved[resource] = remaining < 0.000000001 ? 0 : remaining;
}

export function withdrawReservedResource(storage: StorageSite, resource: CommodityResource, amount: number): boolean {
  if (amount <= 0) return true;
  if (storage.reserved[resource] + 0.0001 < amount || storage.inventory[resource] + 0.0001 < amount) return false;
  storage.inventory[resource] = Math.max(0, storage.inventory[resource] - amount);
  releaseStoredResource(storage, resource, amount);
  return true;
}

export function depositResource(
  state: GameState,
  storage: StorageSite,
  resource: CommodityResource,
  amount: number,
  incomingReservation = 0,
): number {
  if (amount <= 0) return 0;
  if (incomingReservation > 0) releaseIncomingCapacity(storage, incomingReservation);
  const capacity = availableStorageCapacity(storage);
  const accepted = Math.min(amount, capacity);
  storage.inventory[resource] += accepted;
  if (accepted > 0) {
    state.economy[storage.owner].discovered.add(resource);
    state.supplyVersion += 1;
  }
  refreshEconomyStock(state, storage.owner);
  return accepted;
}

export function withdrawResource(storage: StorageSite, resource: CommodityResource, amount: number): boolean {
  if (amount <= 0) return true;
  if (availableInventory(storage, resource) + 0.0001 < amount) return false;
  storage.inventory[resource] = Math.max(0, storage.inventory[resource] - amount);
  return true;
}

export function totalStoredResource(state: GameState, owner: Owner, resource: CommodityResource): number {
  let amount = 0;
  for (const storage of state.storages.values()) if (storage.owner === owner) amount += storage.inventory[resource];
  return amount;
}

export function availableStoredResource(state: GameState, owner: Owner, resource: Resource): number {
  if (resource === 'manpower') return Math.max(0, state.economy[owner].stock.manpower);
  let amount = 0;
  for (const storage of state.storages.values()) {
    if (storage.owner === owner && storageIsAliveAndConnected(state, storage)) amount += availableInventory(storage, resource);
  }
  return amount;
}

export function storagesCanCover(state: GameState, owner: Owner, cost: Cost): boolean {
  return RESOURCE_ORDER.every((resource) => {
    return availableStoredResource(state, owner, resource) + 0.0001 >= (cost[resource] ?? 0);
  });
}

/** Immediate non-logistical purchases consume real inventories; packet dispatch never calls this. */
export function consumeFromStorages(state: GameState, owner: Owner, cost: Cost): boolean {
  if (!storagesCanCover(state, owner, cost)) return false;
  const manpower = cost.manpower ?? 0;
  if (manpower > 0) state.economy[owner].stock.manpower = Math.max(0, state.economy[owner].stock.manpower - manpower);
  for (const resource of COMMODITY_ORDER) {
    let remaining = cost[resource] ?? 0;
    const candidates = [...state.storages.values()]
      .filter((storage) => storage.owner === owner && availableInventory(storage, resource) > 0 && storageIsAliveAndConnected(state, storage))
      .sort((a, b) => (a.kind === 'center' ? -1 : 0) - (b.kind === 'center' ? -1 : 0));
    for (const storage of candidates) {
      const used = Math.min(remaining, availableInventory(storage, resource));
      storage.inventory[resource] -= used;
      remaining -= used;
      if (remaining <= 0.0001) break;
    }
  }
  recordConsumed(state, cost);
  state.supplyVersion += 1;
  refreshEconomyStock(state, owner);
  return true;
}

export function recordConsumed(state: GameState, cost: Cost): void {
  for (const resource of RESOURCE_ORDER) state.stats.consumed[resource] += cost[resource] ?? 0;
}

export function availableManpower(state: GameState, owner: Owner): number {
  return Math.max(0, state.economy[owner].stock.manpower);
}

export function addManpower(state: GameState, owner: Owner, amount: number): number {
  if (amount <= 0) return 0;
  const economy = state.economy[owner];
  const accepted = Math.min(amount, Math.max(0, economy.maxManpower - economy.stock.manpower));
  economy.stock.manpower += accepted;
  if (accepted > 0) economy.discovered.add('manpower');
  return accepted;
}

export function spendManpower(state: GameState, owner: Owner, amount: number, record = true): boolean {
  if (amount <= 0) return true;
  if (availableManpower(state, owner) + 0.0001 < amount) return false;
  state.economy[owner].stock.manpower = Math.max(0, state.economy[owner].stock.manpower - amount);
  if (record) state.stats.consumed.manpower += amount;
  return true;
}

export interface StockedOrigin {
  storage: StorageSite;
  routeCost: number;
}

export function closestStockedStorage(
  state: GameState,
  owner: Owner,
  targetNodeId: string,
  resource: CommodityResource,
  amount: number,
  fixedStorageId?: string,
): StockedOrigin | null {
  let best: StockedOrigin | null = null;
  for (const storage of state.storages.values()) {
    if (storage.owner !== owner || (fixedStorageId && storage.id !== fixedStorageId)) continue;
    if (!storageIsAliveAndConnected(state, storage) || availableInventory(storage, resource) + 0.0001 < amount) continue;
    const route = findRoute(state, owner, storage.nodeId, targetNodeId);
    if (!route) continue;
    if (!best || route.cost < best.routeCost - 0.0001 ||
      (Math.abs(route.cost - best.routeCost) <= 0.0001 && storage.kind === 'depot' && best.storage.kind !== 'depot')) {
      best = { storage, routeCost: route.cost };
    }
  }
  return best;
}

export function createStockpileAtNode(state: GameState, owner: Owner, nodeId: string): StorageSite | null {
  const node = state.nodes.get(nodeId);
  if (!node || node.owner !== owner || !node.connected) return null;
  const existing = storageAtNode(state, nodeId);
  if (existing) return existing;
  node.kind = 'stockpile';
  return addStorage(state, owner, nodeId, 'stockpile', EMPTY_COMMODITY_STOCK());
}

export function createTransferOrder(
  state: GameState,
  owner: Owner,
  sourceStorageId: string | undefined,
  targetStorageId: string,
  resource: CommodityResource,
  amount: number,
): string | null {
  const target = state.storages.get(targetStorageId);
  const source = sourceStorageId ? state.storages.get(sourceStorageId) : undefined;
  if (!target || target.owner !== owner || (sourceStorageId && (!source || source.owner !== owner)) || amount <= 0) return null;
  const order = {
    id: nextId(state, 'transfer'), owner, sourceStorageId, targetStorageId, targetNodeId: target.nodeId,
    routingMode: 'destination' as const, resource,
    amount, remaining: amount, reserved: 0,
  };
  if (source) {
    order.reserved = Math.min(amount, availableInventory(source, resource));
    reserveStoredResource(source, resource, order.reserved);
  }
  state.transfers.set(order.id, order);
  if (source) source.queuedTransfers += 1;
  state.supplyVersion += 1;
  return order.id;
}

export function createCirculationTransferOrder(
  state: GameState,
  owner: Owner,
  sourceStorageId: string,
  targetNodeId: string,
  resource: CommodityResource,
  amount: number,
): string | null {
  const source = state.storages.get(sourceStorageId);
  const targetNode = state.nodes.get(targetNodeId);
  if (!source || source.owner !== owner || !targetNode || targetNode.owner !== owner || amount <= 0) return null;
  const reserved = Math.min(amount, availableInventory(source, resource));
  if (reserved <= 0 || !reserveStoredResource(source, resource, reserved)) return null;
  const order = {
    id: nextId(state, 'transfer'), owner, sourceStorageId, targetNodeId,
    routingMode: 'circulate' as const, resource, amount, remaining: amount, reserved,
  };
  state.transfers.set(order.id, order);
  source.queuedTransfers += 1;
  state.supplyVersion += 1;
  return order.id;
}

export function cancelTransferOrder(state: GameState, orderId: string): boolean {
  const order = state.transfers.get(orderId);
  if (!order) return false;
  const source = order.sourceStorageId ? state.storages.get(order.sourceStorageId) : undefined;
  if (source && order.reserved > 0) releaseStoredResource(source, order.resource, order.reserved);
  if (source) source.queuedTransfers = Math.max(0, source.queuedTransfers - 1);
  state.transfers.delete(order.id);
  state.supplyVersion += 1;
  return true;
}

export function setDepotAutoSupply(state: GameState, storageId: string, enabled: boolean): boolean {
  const storage = state.storages.get(storageId);
  if (!storage || storage.kind !== 'depot' || storage.autoSupplyEnabled === enabled) return false;
  storage.autoSupplyEnabled = enabled;
  state.supplyVersion += 1;
  state.nextSupplyPlanTick = state.tick;
  return true;
}

export function toggleDepotAutoSupply(state: GameState, storageId: string): boolean {
  const storage = state.storages.get(storageId);
  return storage ? setDepotAutoSupply(state, storageId, !storage.autoSupplyEnabled) : false;
}

export function storagePosition(state: GameState, storage: StorageSite): Vec2 {
  return state.nodes.get(storage.nodeId)?.position ?? { x: 0, y: 0 };
}

export function resourceConservationDelta(state: GameState, resource: Resource): number {
  const stored = resource === 'manpower'
    ? state.economy.player.stock.manpower
    : totalStoredResource(state, 'player', resource);
  const packets = [...state.packets.values()].filter((packet) => packet.owner === 'player' && packet.resource === resource)
    .reduce((sum, packet) => sum + packet.amount, 0);
  let staged = 0;
  for (const segment of state.segments.values()) {
    if (segment.owner !== 'player') continue;
    staged += segment.assaultSupply[resource] ?? 0;
    for (const cellId of segment.cellIds) {
      const cell = state.cells.get(cellId);
      if (cell) staged += (cell.constructionSupply[resource] ?? 0) + (cell.repairSupply[resource] ?? 0);
    }
  }
  const left = INITIAL_PLAYER_STOCK[resource] + state.stats.produced[resource];
  const right = stored + packets + staged + state.stats.consumed[resource];
  return left - right;
}
