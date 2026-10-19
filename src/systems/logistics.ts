import {
  BUILDING_BALANCE,
  COMMODITY_ORDER,
  COLORS,
  CONGESTION,
  DEPOT,
  LOGISTICS_ACCELERATION,
  STORAGE,
  TIER_BALANCE,
  WORLD,
} from '../config/balance';
import { distance, lerp, lerpVec } from '../core/geometry';
import { nextId } from '../core/state';
import type {
  Building,
  CommodityResource,
  Cost,
  GameState,
  LineCell,
  LineSegment,
  Owner,
  Packet,
  StorageSite,
  SupplyReservation,
} from '../core/types';
import {
  addCost,
  cellIsPassable,
  cellPoint,
  cellsOf,
  constructionCostForCell,
  costAmount,
  firstArrowGap,
  repairCostForCell,
  serviceConstructionCostForCell,
  stackAddedLayerMultiplier,
  subtractCost,
} from './cells';
import { spawnParticles } from './effects';
import { recalculateManpowerCapacity } from './economy';
import { actualProductionPerSecond } from './extraction';
import {
  directionalLoadKey,
  directionForTraversal,
  effectiveDirectionalCapacity,
  effectivePacketSpeed,
  ensureConnectivity,
  findCirculationLoop,
  findRecognizedLoop,
  findRoute,
  oppositeTraffic,
  resolveDirectionalSpeedMultiplier,
  trafficForDirection,
  trafficStateForRatio,
  type RouteResult,
} from './graph';
import { addWarning } from './notifications';
import {
  createCirculationTransferOrder,
  createTransferOrder,
  addManpower,
  availableInventory,
  availableStorageCapacity,
  depositResource,
  releaseIncomingCapacity,
  releaseStoredResource,
  refreshEconomyStock,
  reserveIncomingCapacity,
  reserveStoredResource,
  spendManpower,
  storageAtNode,
  storageIsAliveAndConnected,
  withdrawResource,
  withdrawReservedResource,
} from './storage';

const BASE_PACKET_SPEED = TIER_BALANCE.wood.packetSpeed;

function projectedNetworkLoad(state: GameState): Map<string, number> {
  const load = new Map<string, number>();
  for (const packet of state.packets.values()) {
    if (packet.traversingArrow) continue;
    for (let edgeIndex = packet.edgeIndex; edgeIndex < packet.segmentPath.length; edgeIndex += 1) {
      if (edgeIndex === packet.edgeIndex && (packet.progress > 0.0001 || packet.returning)) continue;
      const segmentId = packet.segmentPath[edgeIndex];
      const segment = segmentId ? state.segments.get(segmentId) : undefined;
      const fromNodeId = packet.nodePath[edgeIndex];
      if (!segment || !fromNodeId) continue;
      const key = directionalLoadKey(segment.id, directionForTraversal(segment, fromNodeId));
      load.set(key, (load.get(key) ?? 0) + packet.amount / STORAGE.packetUnitSize);
    }
  }
  return load;
}

export function createPacket(
  state: GameState,
  owner: Owner,
  resource: CommodityResource,
  amount: number,
  sourceNode: string,
  targetNode: string,
  purpose: Packet['purpose'] = 'income',
  targetSegmentId?: string,
  originKind: Packet['originKind'] = 'producer',
  targetCellId?: string,
  targetStorageId?: string,
  originStorageId?: string,
  routeOverride?: RouteResult,
  incomingCapacityReservation = 0,
  supplyReservationId?: string,
): Packet | null {
  if (amount <= 0 || state.packets.size >= WORLD.maxPackets) return null;
  const route = routeOverride ?? findRoute(state, owner, sourceNode, targetNode, projectedNetworkLoad(state));
  const source = state.nodes.get(sourceNode);
  if (!route || !source) return null;
  const packet: Packet = {
    id: nextId(state, 'packet'), owner, resource, amount, sourceNode, targetNode,
    nodePath: route.nodes, segmentPath: route.segments, edgeIndex: 0, progress: 0,
    position: { ...source.position }, waiting: 0, reroutes: 0, purpose,
    targetSegmentId, targetCellId, targetStorageId, originStorageId, originKind,
    cruiseSpeed: BASE_PACKET_SPEED, baseCruiseSpeed: BASE_PACKET_SPEED,
    cruiseSpeedMultiplier: 1, effectiveSpeedMultiplier: 1,
    arrowCellIndex: 0, arrowCellProgress: 0, arrowDirection: 1,
    traversingArrow: false, acceleratedByManpower: false, returning: false,
    incomingCapacityReservation, supplyReservationId,
    routingMode: 'destination', circulationNodeCycle: [], circulationSegmentCycle: [],
    circulationCycles: 0, circulationActive: false,
  };
  state.packets.set(packet.id, packet);
  return packet;
}

function releasePacketStorageReservation(state: GameState, packet: Packet): void {
  const oldTarget = packet.targetStorageId ? state.storages.get(packet.targetStorageId) : undefined;
  if (oldTarget && packet.incomingCapacityReservation > 0) {
    releaseIncomingCapacity(oldTarget, packet.incomingCapacityReservation);
  }
  packet.incomingCapacityReservation = 0;
  packet.targetStorageId = undefined;
}

function beginCirculationCycle(state: GameState, packet: Packet): boolean {
  const anchor = packet.circulationAnchorNodeId;
  if (!anchor) return false;
  const cachedValid = packet.circulationSegmentCycle.length > 1 && packet.circulationSegmentCycle.every((segmentId) => {
    const segment = state.segments.get(segmentId);
    return Boolean(segment && segment.constructionState === 'complete' && segment.connected);
  });
  const loop = cachedValid
    ? { nodes: packet.circulationNodeCycle, segments: packet.circulationSegmentCycle, cost: 0 }
    : findCirculationLoop(state, packet.owner, anchor);
  if (!loop || loop.segments.length < 2) {
    packet.circulationActive = false;
    packet.waiting = 0.25;
    return false;
  }
  packet.circulationNodeCycle = [...loop.nodes];
  packet.circulationSegmentCycle = [...loop.segments];
  packet.nodePath = [...loop.nodes];
  packet.segmentPath = [...loop.segments];
  packet.edgeIndex = 0;
  packet.progress = 0;
  packet.returning = false;
  packet.returnNodeId = undefined;
  packet.circulationActive = true;
  packet.position = { ...(state.nodes.get(anchor)?.position ?? packet.position) };
  return true;
}

function applyPacketRedirect(
  state: GameState,
  packet: Packet,
  fromNodeId: string,
  targetNodeId: string,
  routingMode: 'destination' | 'circulate',
): boolean {
  const targetNode = state.nodes.get(targetNodeId);
  if (!targetNode || targetNode.owner !== packet.owner || !targetNode.connected) return false;
  const targetStorage = routingMode === 'destination' ? storageAtNode(state, targetNodeId) : undefined;
  if (routingMode === 'destination' && !targetStorage) return false;
  if (routingMode === 'circulate' && !findCirculationLoop(state, packet.owner, targetNodeId)) return false;
  const route = findRoute(state, packet.owner, fromNodeId, targetNodeId, projectedNetworkLoad(state));
  if (!route) return false;
  const oldTarget = packet.targetStorageId ? state.storages.get(packet.targetStorageId) : undefined;
  const reusableReservation = oldTarget?.id === targetStorage?.id ? packet.incomingCapacityReservation : 0;
  if (targetStorage && Number.isFinite(targetStorage.maxStorage) &&
    availableStorageCapacity(targetStorage) + reusableReservation + 0.0001 < packet.amount) return false;
  releasePacketStorageReservation(state, packet);
  if (targetStorage && Number.isFinite(targetStorage.maxStorage)) {
    if (!reserveIncomingCapacity(targetStorage, packet.amount)) return false;
    packet.incomingCapacityReservation = packet.amount;
  }
  const oldCell = packet.targetCellId ? state.cells.get(packet.targetCellId) : undefined;
  const oldSegment = packet.targetSegmentId ? state.segments.get(packet.targetSegmentId) : undefined;
  const oldTransit = packet.purpose === 'construction' ? oldCell?.constructionInTransit :
    packet.purpose === 'repair' ? oldCell?.repairInTransit : packet.purpose === 'assault' ? oldSegment?.assaultInTransit : undefined;
  if (oldTransit) {
    subtractCost(oldTransit, packet.resource, packet.amount);
    state.supplyVersion += 1;
  }
  packet.routingMode = routingMode;
  packet.circulationActive = false;
  packet.circulationAnchorNodeId = routingMode === 'circulate' ? targetNodeId : undefined;
  packet.circulationNodeCycle = [];
  packet.circulationSegmentCycle = [];
  packet.pendingRedirectNodeId = undefined;
  packet.pendingRoutingMode = undefined;
  packet.targetSegmentId = undefined;
  packet.targetCellId = undefined;
  packet.supplyReservationId = undefined;
  packet.traversingArrow = false;
  packet.purpose = 'transfer';
  packet.targetStorageId = targetStorage?.id;
  packet.targetNode = targetNodeId;
  packet.nodePath = route.nodes;
  packet.segmentPath = route.segments;
  packet.edgeIndex = 0;
  packet.progress = 0;
  packet.returning = false;
  packet.returnNodeId = undefined;
  packet.position = { ...(state.nodes.get(fromNodeId)?.position ?? packet.position) };
  if (routingMode === 'circulate' && fromNodeId === targetNodeId) return beginCirculationCycle(state, packet);
  return true;
}

/** Changes a packet objective in place; a mid-edge packet first reaches its legitimate next node. */
export function redirectPacket(
  state: GameState,
  packetId: string,
  targetNodeId: string,
  routingMode: 'destination' | 'circulate',
): boolean {
  const packet = state.packets.get(packetId);
  if (!packet || packet.owner !== 'player') return false;
  const targetNode = state.nodes.get(targetNodeId);
  if (!targetNode || targetNode.owner !== packet.owner || !targetNode.connected ||
    (routingMode === 'destination' && !storageAtNode(state, targetNodeId)) ||
    (routingMode === 'circulate' && !findCirculationLoop(state, packet.owner, targetNodeId))) return false;
  const currentNodeId = packet.nodePath[packet.edgeIndex] ?? packet.sourceNode;
  const departure = packet.traversingArrow ? packet.targetNode : packet.returning ? currentNodeId :
    packet.progress > 0.0001 ? packet.nodePath[packet.edgeIndex + 1] : currentNodeId;
  if (!departure || !findRoute(state, packet.owner, departure, targetNodeId)) return false;
  if (packet.traversingArrow || packet.progress > 0.0001 || packet.returning) {
    releasePacketStorageReservation(state, packet);
    packet.pendingRedirectNodeId = targetNodeId;
    packet.pendingRoutingMode = routingMode;
    return true;
  }
  return applyPacketRedirect(state, packet, currentNodeId, targetNodeId, routingMode);
}

export interface SupplyOrigin {
  nodeId: string;
  storageId: string;
  kind: 'center' | 'depot' | 'stockpile';
  routeCost: number;
}

export function findClosestSupplyOrigin(
  state: GameState,
  owner: Owner,
  targetNodeId: string,
  resource?: CommodityResource,
  minimumAmount = 0.0001,
): SupplyOrigin | null {
  ensureConnectivity(state);
  let best: SupplyOrigin | null = null;
  for (const storage of state.storages.values()) {
    if (storage.owner !== owner || !storageIsAliveAndConnected(state, storage)) continue;
    if (storage.kind === 'depot' && !storage.autoSupplyEnabled) continue;
    if (resource && availableInventory(storage, resource) + 0.0001 < minimumAmount) continue;
    const route = findRoute(state, owner, storage.nodeId, targetNodeId);
    if (!route) continue;
    if (!best || route.cost < best.routeCost - 0.0001 ||
      (Math.abs(route.cost - best.routeCost) <= 0.0001 && storage.kind === 'depot' && best.kind !== 'depot')) {
      best = { nodeId: storage.nodeId, storageId: storage.id, kind: storage.kind, routeCost: route.cost };
    }
  }
  return best;
}

function replenishDispatchBudgets(state: GameState, dt: number): void {
  for (const storage of state.storages.values()) {
    const bucketCap = storage.outboundRate * (storage.kind === 'depot' ? DEPOT.dispatchBucketSeconds : 1);
    storage.dispatchBudget = Math.min(bucketCap, storage.dispatchBudget + storage.outboundRate * dt);
    storage.dispatchedThisSecond *= Math.exp(-dt);
    if (Number.isFinite(storage.inboundRate)) {
      const inboundCap = storage.inboundRate * (storage.kind === 'depot' ? DEPOT.inboundBucketSeconds : 1);
      storage.inboundBudget = Math.min(inboundCap, storage.inboundBudget + storage.inboundRate * dt);
    }
    storage.receivedThisSecond *= Math.exp(-dt);
    storage.inboundQueuedPackets = 0;
  }
}

function candidateStorage(
  state: GameState,
  owner: Owner,
  resource: CommodityResource,
  targetNodeId: string,
  fixedStorageId?: string,
): { storage: StorageSite; routeCost: number } | null {
  let best: { storage: StorageSite; routeCost: number } | null = null;
  for (const storage of state.storages.values()) {
    if (storage.owner !== owner || (fixedStorageId && storage.id !== fixedStorageId)) continue;
    // Dispatch budget is intentionally not part of origin selection. A nearby
    // stocked Depot remains the chosen origin while its fixed-rate bucket
    // refills instead of silently moving the request to a farther storage.
    if (!storageIsAliveAndConnected(state, storage) || availableInventory(storage, resource) <= 0.0001) continue;
    const route = findRoute(state, owner, storage.nodeId, targetNodeId);
    if (!route) continue;
    if (!best || route.cost < best.routeCost - 0.0001 ||
      (Math.abs(route.cost - best.routeCost) <= 0.0001 && storage.kind === 'depot' && best.storage.kind !== 'depot')) {
      best = { storage, routeCost: route.cost };
    }
  }
  return best;
}

function applyAutomaticAcceleration(state: GameState, packet: Packet): void {
  if (!state.logisticsAcceleration[packet.owner]) return;
  const cost = LOGISTICS_ACCELERATION.manpowerCostPerPacket;
  if (!spendManpower(state, packet.owner, cost)) return;
  packet.cruiseSpeedMultiplier = Math.max(packet.cruiseSpeedMultiplier, LOGISTICS_ACCELERATION.speedMultiplier);
  packet.cruiseSpeed = packet.baseCruiseSpeed * packet.cruiseSpeedMultiplier;
  packet.effectiveSpeedMultiplier = packet.cruiseSpeedMultiplier;
  packet.acceleratedByManpower = true;
}

export function acceleratePacketWithManpower(state: GameState, packetId: string): boolean {
  const packet = state.packets.get(packetId);
  if (!packet || packet.acceleratedByManpower ||
    !spendManpower(state, packet.owner, LOGISTICS_ACCELERATION.manpowerCostPerPacket)) return false;
  packet.cruiseSpeedMultiplier = Math.max(packet.cruiseSpeedMultiplier, LOGISTICS_ACCELERATION.speedMultiplier);
  packet.cruiseSpeed = packet.baseCruiseSpeed * packet.cruiseSpeedMultiplier;
  packet.effectiveSpeedMultiplier = packet.cruiseSpeedMultiplier;
  packet.acceleratedByManpower = true;
  return true;
}

interface DispatchTarget {
  purpose: Packet['purpose'];
  targetNodeId: string;
  targetSegmentId?: string;
  targetCellId?: string;
  targetStorageId?: string;
  fixedStorageId?: string;
}

function dispatchStoredResource(
  state: GameState,
  owner: Owner,
  resource: CommodityResource,
  desiredAmount: number,
  target: DispatchTarget,
): Packet | null {
  if (desiredAmount <= 0.0001) return null;
  const candidate = candidateStorage(state, owner, resource, target.targetNodeId, target.fixedStorageId);
  if (!candidate) return null;
  const storage = candidate.storage;
  let amount = Math.min(desiredAmount, STORAGE.packetUnitSize, availableInventory(storage, resource));
  const targetStorage = target.targetStorageId ? state.storages.get(target.targetStorageId) : undefined;
  if (targetStorage) amount = Math.min(amount, availableStorageCapacity(targetStorage));
  if (amount <= 0.0001 || storage.dispatchBudget + 0.0001 < amount) return null;
  const incomingReservation = targetStorage && Number.isFinite(targetStorage.maxStorage) ? amount : 0;
  if (incomingReservation > 0 && targetStorage && !reserveIncomingCapacity(targetStorage, incomingReservation)) return null;
  const packet = createPacket(
    state, owner, resource, amount, storage.nodeId, target.targetNodeId, target.purpose,
    target.targetSegmentId, storage.kind, target.targetCellId, target.targetStorageId, storage.id,
    undefined, incomingReservation,
  );
  if (!packet || !withdrawResource(storage, resource, amount)) {
    if (packet) state.packets.delete(packet.id);
    if (incomingReservation > 0 && targetStorage) releaseIncomingCapacity(targetStorage, incomingReservation);
    return null;
  }
  storage.dispatchBudget -= amount;
  storage.dispatchedThisSecond += amount;
  applyAutomaticAcceleration(state, packet);
  refreshEconomyStock(state, owner);
  return packet;
}

interface SupplyDemand {
  key: string;
  purpose: 'construction' | 'repair' | 'assault';
  owner: Owner;
  segment: LineSegment;
  cell: LineCell;
  required: Cost;
  supply: Cost;
  transit: Cost;
  waiting: Cost;
}

interface SupplyEntryOption {
  nodeId: string;
  direction: 1 | -1;
  localTravelTime: number;
}

function entryOptions(state: GameState, segment: LineSegment, cell: LineCell): SupplyEntryOption[] {
  const a = state.nodes.get(segment.a);
  const b = state.nodes.get(segment.b);
  const cells = cellsOf(state, segment);
  const distanceFromA = cells.slice(0, cell.index).reduce((sum, candidate) => sum + candidate.length, 0) + cell.length * 0.5;
  const totalLength = cells.reduce((sum, candidate) => sum + candidate.length, 0);
  const directionalSpeed = (direction: 'ab' | 'ba'): number => {
    const cruise = effectivePacketSpeed(state, segment) / Math.max(1, BASE_PACKET_SPEED);
    return Math.max(1, BASE_PACKET_SPEED * resolveDirectionalSpeedMultiplier(
      cruise, trafficForDirection(segment, direction).state, oppositeTraffic(segment, direction).state,
    ));
  };
  if (segment.constructionState !== 'complete') {
    // Upcoming cells may be supplied ahead of time, but a physical rear cut
    // must be rebuilt before dispatch resumes. Packets wait at the frontier.
    const upstreamClear = cells.slice(0, Math.min(cell.index, segment.frontierCell)).every(cellIsPassable);
    return a?.connected && upstreamClear ? [{ nodeId: a.id, direction: 1, localTravelTime: distanceFromA / directionalSpeed('ab') }] : [];
  }
  const options: SupplyEntryOption[] = [];
  if (a?.connected && cells.slice(0, cell.index).every(cellIsPassable)) {
    options.push({ nodeId: a.id, direction: 1, localTravelTime: distanceFromA / directionalSpeed('ab') });
  }
  if (b?.connected && cells.slice(cell.index + 1).every(cellIsPassable)) {
    options.push({ nodeId: b.id, direction: -1, localTravelTime: (totalLength - distanceFromA) / directionalSpeed('ba') });
  }
  return options;
}

function collectSupplyDemands(state: GameState): SupplyDemand[] {
  const demands: SupplyDemand[] = [];
  for (const segment of [...state.segments.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    const cells = cellsOf(state, segment);
    if (segment.owner === 'player') {
      const requested = segment.constructionState === 'complete'
        ? cells.find((cell) => cell.repairRequested)
        : firstArrowGap(state, segment) ?? cells.slice(0, segment.frontierCell + 1).find((cell) => cell.repairRequested);
      if (requested) {
        requested.repairRequested = true;
        demands.push({
          key: `repair:${segment.id}:${requested.id}`, purpose: 'repair', owner: segment.owner, segment, cell: requested,
          required: repairCostForCell(segment.tier), supply: requested.repairSupply, transit: requested.repairInTransit,
          waiting: segment.waitingRepair,
        });
      }
    }
    if (segment.stackTargetLevel > segment.stackLevel && segment.constructionState === 'complete') {
      for (const cell of cells.slice(segment.stackFrontierCell, segment.stackFrontierCell + STORAGE.constructionLookaheadCells)) demands.push({
        key: `stack:${segment.id}:${segment.stackTargetLevel}:${cell.id}`, purpose: 'construction', owner: segment.owner, segment, cell,
        required: constructionCostForCell(cell, segment.tier, stackAddedLayerMultiplier(segment.stackTargetLevel)),
        supply: cell.constructionSupply, transit: cell.constructionInTransit, waiting: segment.waitingConstruction,
      });
    } else if (segment.constructionState === 'building' && !firstArrowGap(state, segment)) {
      for (const cell of cells.slice(segment.frontierCell, segment.frontierCell + STORAGE.constructionLookaheadCells)) demands.push({
        key: `construction:${segment.id}:${cell.id}`, purpose: 'construction', owner: segment.owner, segment, cell,
        required: segment.service ? serviceConstructionCostForCell(state, segment, cell) : constructionCostForCell(cell, segment.tier), supply: cell.constructionSupply,
        transit: cell.constructionInTransit, waiting: segment.waitingConstruction,
      });
    }
    if (segment.constructionState === 'attacking' && !firstArrowGap(state, segment)) {
      const cell = cells[Math.min(segment.frontierCell, segment.cellIds.length - 1)];
      if (cell) demands.push({
        key: `assault:${segment.id}:${cell.id}`, purpose: 'assault', owner: segment.owner, segment, cell,
        required: TIER_BALANCE[segment.tier].assaultCost, supply: segment.assaultSupply,
        transit: segment.assaultInTransit, waiting: segment.waitingAssault,
      });
    }
  }
  const priority = { repair: 0, construction: 1, assault: 2 } as const;
  return demands.sort((left, right) => priority[left.purpose] - priority[right.purpose] ||
    left.cell.index - right.cell.index || left.key.localeCompare(right.key));
}

function releaseAllAutomaticReservations(state: GameState): void {
  for (const reservation of state.supplyReservations.values()) {
    const storage = state.storages.get(reservation.storageId);
    if (storage) releaseStoredResource(storage, reservation.resource, reservation.amount);
  }
  state.supplyReservations.clear();
  for (const segment of state.segments.values()) {
    segment.waitingConstruction = {};
    segment.waitingAssault = {};
    segment.waitingRepair = {};
    segment.contributingStorageIds = [];
  }
}

interface AllocationCandidate {
  storage: StorageSite;
  entry: SupplyEntryOption;
  route: RouteResult;
  arrival: number;
}

function interceptCirculatingCommodity(
  state: GameState,
  demand: SupplyDemand,
  entries: SupplyEntryOption[],
  resource: CommodityResource,
  missing: number,
): number {
  // A loop is a buffer/circulator. Never let it become the only construction
  // supplier for a newly placed structure's service route.
  if (missing <= 0.0001 || demand.segment.service) return 0;
  let best: { packet: Packet; entry: SupplyEntryOption; route: RouteResult } | null = null;
  for (const packet of [...state.packets.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    if (packet.owner !== demand.owner || packet.resource !== resource || packet.routingMode !== 'circulate' ||
      packet.traversingArrow || packet.progress > 0.0001 || packet.returning || packet.amount > missing + 0.0001) continue;
    const currentNodeId = packet.nodePath[packet.edgeIndex] ?? packet.circulationAnchorNodeId;
    if (!currentNodeId) continue;
    for (const entry of entries) {
      const route = findRoute(state, demand.owner, currentNodeId, entry.nodeId, projectedNetworkLoad(state));
      if (!route) continue;
      if (!best || route.cost + entry.localTravelTime < best.route.cost + best.entry.localTravelTime - 0.000001 ||
        (Math.abs(route.cost + entry.localTravelTime - best.route.cost - best.entry.localTravelTime) <= 0.000001 && packet.id < best.packet.id)) {
        best = { packet, entry, route };
      }
    }
  }
  if (!best) return 0;
  const packet = best.packet;
  packet.routingMode = 'destination';
  packet.circulationAnchorNodeId = undefined;
  packet.circulationNodeCycle = [];
  packet.circulationSegmentCycle = [];
  packet.circulationActive = false;
  packet.purpose = demand.purpose;
  packet.targetNode = best.entry.nodeId;
  packet.targetSegmentId = demand.segment.id;
  packet.targetCellId = demand.cell.id;
  packet.targetStorageId = undefined;
  packet.nodePath = best.route.nodes;
  packet.segmentPath = best.route.segments;
  packet.edgeIndex = 0;
  packet.progress = 0;
  packet.arrowDirection = best.entry.direction;
  addCost(demand.transit, resource, packet.amount);
  if (packet.originStorageId && !demand.segment.contributingStorageIds.includes(packet.originStorageId)) {
    demand.segment.contributingStorageIds.push(packet.originStorageId);
  }
  return packet.amount;
}

function planAutomaticSupply(state: GameState): void {
  releaseAllAutomaticReservations(state);
  const demands = collectSupplyDemands(state);
  const recognizedLoopStorageIds = new Set(demands.some((demand) => demand.segment.service)
    ? [...state.storages.values()].filter((storage) => findRecognizedLoop(state, storage.owner, storage.nodeId)).map((storage) => storage.id)
    : []);
  const projectedQueue = new Map<string, number>();
  const projectedLoad = projectedNetworkLoad(state);
  for (const storage of state.storages.values()) {
    projectedQueue.set(storage.id, storage.queuedTransfers * STORAGE.packetUnitSize);
  }

  for (const demand of demands) {
    const entries = entryOptions(state, demand.segment, demand.cell);
    if (entries.length === 0) continue;
    for (const resource of COMMODITY_ORDER) {
      let missing = costAmount(demand.required, resource) - costAmount(demand.supply, resource) - costAmount(demand.transit, resource);
      missing -= interceptCirculatingCommodity(state, demand, entries, resource, missing);
      while (missing > 0.0001) {
        let best: AllocationCandidate | null = null;
        let bestAmount = 0;
        for (const storage of state.storages.values()) {
          if (storage.owner !== demand.owner || !storageIsAliveAndConnected(state, storage) ||
            (storage.kind === 'depot' && !storage.autoSupplyEnabled) ||
            (demand.segment.service && recognizedLoopStorageIds.has(storage.id))) continue;
          const amount = Math.min(missing, STORAGE.packetUnitSize, availableInventory(storage, resource));
          if (amount <= 0.0001) continue;
          for (const entry of entries) {
            const route = findRoute(state, demand.owner, storage.nodeId, entry.nodeId, projectedLoad);
            if (!route) continue;
            const queued = projectedQueue.get(storage.id) ?? 0;
            const dispatchWait = Math.max(0, queued + amount - storage.dispatchBudget) / Math.max(0.0001, storage.outboundRate);
            const arrival = dispatchWait + route.cost + entry.localTravelTime;
            if (!best || arrival < best.arrival - 0.000001 ||
              (Math.abs(arrival - best.arrival) <= 0.000001 && `${storage.id}:${entry.nodeId}` < `${best.storage.id}:${best.entry.nodeId}`)) {
              best = { storage, entry, route, arrival };
              bestAmount = amount;
            }
          }
        }
        if (!best || bestAmount <= 0.0001 || !reserveStoredResource(best.storage, resource, bestAmount)) break;
        const reservation: SupplyReservation = {
          id: nextId(state, 'reservation'), owner: demand.owner, requestKey: demand.key, purpose: demand.purpose,
          storageId: best.storage.id, resource, amount: bestAmount, targetNodeId: best.entry.nodeId,
          targetSegmentId: demand.segment.id, targetCellId: demand.cell.id, arrowDirection: best.entry.direction,
          projectedArrival: best.arrival, createdTick: state.tick,
        };
        state.supplyReservations.set(reservation.id, reservation);
        addCost(demand.waiting, resource, bestAmount);
        if (!demand.segment.contributingStorageIds.includes(best.storage.id)) demand.segment.contributingStorageIds.push(best.storage.id);
        if (!demand.segment.supplyOriginNodeId) {
          demand.segment.supplyOriginNodeId = best.storage.nodeId;
          demand.segment.supplyOriginKind = best.storage.kind;
        }
        projectedQueue.set(best.storage.id, (projectedQueue.get(best.storage.id) ?? 0) + bestAmount);
        for (let edgeIndex = 0; edgeIndex < best.route.segments.length; edgeIndex += 1) {
          const segmentId = best.route.segments[edgeIndex];
          const fromNodeId = best.route.nodes[edgeIndex];
          const routeSegment = segmentId ? state.segments.get(segmentId) : undefined;
          if (!routeSegment || !fromNodeId) continue;
          const key = directionalLoadKey(routeSegment.id, directionForTraversal(routeSegment, fromNodeId));
          projectedLoad.set(key, (projectedLoad.get(key) ?? 0) + bestAmount / STORAGE.packetUnitSize);
        }
        missing -= bestAmount;
      }
    }
  }
  state.supplyPlanVersion = state.supplyVersion;
  state.supplyPlanTopologyVersion = state.topologyVersion;
  state.supplyPlanCongestionVersion = state.congestionVersion;
  state.nextSupplyPlanTick = state.tick + Math.max(1, Math.ceil(STORAGE.allocationCadenceSeconds / WORLD.fixedStep));
}

function demandTransit(state: GameState, reservation: SupplyReservation): Cost | undefined {
  const segment = state.segments.get(reservation.targetSegmentId);
  const cell = state.cells.get(reservation.targetCellId);
  if (!segment || !cell) return undefined;
  if (reservation.purpose === 'construction') return cell.constructionInTransit;
  if (reservation.purpose === 'repair') return cell.repairInTransit;
  return segment.assaultInTransit;
}

function dispatchAutomaticReservations(state: GameState): void {
  const ordered = [...state.supplyReservations.values()].sort(
    (left, right) => left.projectedArrival - right.projectedArrival || left.createdTick - right.createdTick || left.id.localeCompare(right.id),
  );
  for (const reservation of ordered) {
    const storage = state.storages.get(reservation.storageId);
    const transit = demandTransit(state, reservation);
    if (!storage || !transit || !storageIsAliveAndConnected(state, storage) ||
      (storage.kind === 'depot' && !storage.autoSupplyEnabled) || storage.dispatchBudget + 0.0001 < reservation.amount) continue;
    const route = findRoute(state, reservation.owner, storage.nodeId, reservation.targetNodeId, projectedNetworkLoad(state));
    if (!route) continue;
    const packet = createPacket(
      state, reservation.owner, reservation.resource, reservation.amount, storage.nodeId, reservation.targetNodeId,
      reservation.purpose, reservation.targetSegmentId, storage.kind, reservation.targetCellId, undefined, storage.id,
      route, 0, reservation.id,
    );
    if (!packet || !withdrawReservedResource(storage, reservation.resource, reservation.amount)) {
      if (packet) state.packets.delete(packet.id);
      continue;
    }
    packet.arrowDirection = reservation.arrowDirection;
    addCost(transit, reservation.resource, reservation.amount);
    const segment = state.segments.get(reservation.targetSegmentId);
    const waiting = segment ? reservation.purpose === 'construction' ? segment.waitingConstruction :
      reservation.purpose === 'repair' ? segment.waitingRepair : segment.waitingAssault : undefined;
    if (waiting) subtractCost(waiting, reservation.resource, reservation.amount);
    storage.dispatchBudget -= reservation.amount;
    storage.dispatchedThisSecond += reservation.amount;
    applyAutomaticAcceleration(state, packet);
    state.supplyReservations.delete(reservation.id);
  }
  refreshEconomyStock(state);
}

function dispatchTransfers(state: GameState): void {
  for (const order of [...state.transfers.values()]) {
    if (order.remaining <= 0.0001) continue;
    const targetStorage = order.targetStorageId ? state.storages.get(order.targetStorageId) : undefined;
    const targetNode = state.nodes.get(order.targetNodeId);
    if (!targetNode || !targetNode.connected || targetNode.owner !== order.owner) continue;
    if (order.routingMode === 'destination' && (!targetStorage || !storageIsAliveAndConnected(state, targetStorage))) continue;
    if (order.routingMode === 'circulate' && !findCirculationLoop(state, order.owner, order.targetNodeId)) continue;
    const fixedSource = order.sourceStorageId ? state.storages.get(order.sourceStorageId) : undefined;
    let packet: Packet | null = null;
    if (fixedSource) {
      const additional = Math.min(Math.max(0, order.remaining - order.reserved), availableInventory(fixedSource, order.resource));
      if (additional > 0 && reserveStoredResource(fixedSource, order.resource, additional)) order.reserved += additional;
      const destinationCapacity = targetStorage ? availableStorageCapacity(targetStorage) : Number.POSITIVE_INFINITY;
      const amount = Math.min(order.remaining, order.reserved, STORAGE.packetUnitSize, destinationCapacity);
      if (amount > 0.0001 && fixedSource.dispatchBudget + 0.0001 >= amount && storageIsAliveAndConnected(state, fixedSource)) {
        const route = findRoute(state, order.owner, fixedSource.nodeId, order.targetNodeId, projectedNetworkLoad(state));
        const incomingReservation = targetStorage && Number.isFinite(targetStorage.maxStorage) ? amount : 0;
        if (route && (incomingReservation <= 0 || (targetStorage && reserveIncomingCapacity(targetStorage, incomingReservation)))) {
          packet = createPacket(
            state, order.owner, order.resource, amount, fixedSource.nodeId, order.targetNodeId, 'transfer',
            undefined, fixedSource.kind, undefined, targetStorage?.id, fixedSource.id, route, incomingReservation,
          );
          if (!packet || !withdrawReservedResource(fixedSource, order.resource, amount)) {
            if (packet) state.packets.delete(packet.id);
            if (incomingReservation > 0 && targetStorage) releaseIncomingCapacity(targetStorage, incomingReservation);
            packet = null;
          } else {
            if (order.routingMode === 'circulate') {
              packet.routingMode = 'circulate';
              packet.circulationAnchorNodeId = order.targetNodeId;
            }
            order.reserved = Math.max(0, order.reserved - amount);
            fixedSource.dispatchBudget -= amount;
            fixedSource.dispatchedThisSecond += amount;
            applyAutomaticAcceleration(state, packet);
            refreshEconomyStock(state, order.owner);
          }
        }
      }
    } else {
      if (!targetStorage) continue;
      packet = dispatchStoredResource(state, order.owner, order.resource, order.remaining, {
        purpose: 'transfer', targetNodeId: targetStorage.nodeId, targetStorageId: targetStorage.id,
      });
    }
    if (!packet) continue;
    order.remaining = Math.max(0, order.remaining - packet.amount);
    if (order.remaining <= 0.0001) {
      const source = order.sourceStorageId ? state.storages.get(order.sourceStorageId) : undefined;
      if (source) source.queuedTransfers = Math.max(0, source.queuedTransfers - 1);
      state.transfers.delete(order.id);
    }
  }
}

export function updateOutboundSupply(state: GameState, dt = WORLD.fixedStep): void {
  replenishDispatchBudgets(state, dt);
  const planExpired = state.tick >= state.nextSupplyPlanTick;
  if (planExpired || state.supplyPlanVersion !== state.supplyVersion ||
    state.supplyPlanTopologyVersion !== state.topologyVersion || state.supplyPlanCongestionVersion !== state.congestionVersion) {
    planAutomaticSupply(state);
  }
  dispatchTransfers(state);
  dispatchAutomaticReservations(state);
}

export function requestManualTransfer(
  state: GameState,
  sourceStorageId: string | undefined,
  targetStorageId: string,
  resource: CommodityResource,
  amount: number,
  owner: Owner = 'player',
): string | null {
  return createTransferOrder(state, owner, sourceStorageId, targetStorageId, resource, amount);
}

export function requestCirculatingTransfer(
  state: GameState,
  sourceStorageId: string,
  targetNodeId: string,
  resource: CommodityResource,
  amount: number,
  owner: Owner = 'player',
): string | null {
  if (!findCirculationLoop(state, owner, targetNodeId)) return null;
  return createCirculationTransferOrder(state, owner, sourceStorageId, targetNodeId, resource, amount);
}

export function redirectStorageContents(
  state: GameState,
  sourceStorageId: string,
  targetNodeId: string,
  routingMode: 'destination' | 'circulate',
): number {
  const source = state.storages.get(sourceStorageId);
  if (!source || source.owner !== 'player') return 0;
  const targetStorage = routingMode === 'destination' ? storageAtNode(state, targetNodeId) : undefined;
  if (routingMode === 'destination' && (!targetStorage || targetStorage.id === source.id)) return 0;
  let created = 0;
  for (const resource of COMMODITY_ORDER) {
    const amount = availableInventory(source, resource);
    if (amount <= 0.0001) continue;
    const id = routingMode === 'destination'
      ? createTransferOrder(state, source.owner, source.id, targetStorage!.id, resource, amount)
      : requestCirculatingTransfer(state, source.id, targetNodeId, resource, amount, source.owner);
    if (id) created += 1;
  }
  return created;
}

interface ProductionTarget {
  storage: StorageSite;
  route: RouteResult;
}

function chooseProductionTarget(state: GameState, building: Building, amount: number): ProductionTarget | null {
  const fixedId = building.productionTargetStorageId;
  const candidates = [...state.storages.values()]
    .filter((storage) => storage.owner === building.owner && storageIsAliveAndConnected(state, storage) &&
      (!fixedId ? storage.kind === 'depot' : storage.id === fixedId) && availableStorageCapacity(storage) + 0.0001 >= amount)
    .map((storage) => ({ storage, route: findRoute(state, building.owner, building.nodeId, storage.nodeId, projectedNetworkLoad(state)) }))
    .filter((candidate): candidate is ProductionTarget => Boolean(candidate.route))
    .sort((left, right) => left.route.cost - right.route.cost || left.storage.id.localeCompare(right.storage.id));
  if (candidates[0]) return candidates[0];
  if (fixedId) return null;
  const center = storageAtNode(state, state.centerNode[building.owner]);
  if (!center || !storageIsAliveAndConnected(state, center)) return null;
  const route = findRoute(state, building.owner, building.nodeId, center.nodeId, projectedNetworkLoad(state));
  return route ? { storage: center, route } : null;
}

export function setProductionDestination(state: GameState, buildingId: string, storageId?: string): boolean {
  const building = state.buildings.get(buildingId);
  const storage = storageId ? state.storages.get(storageId) : undefined;
  const resource = building ? BUILDING_BALANCE[building.type].productionResource : undefined;
  if (!building || !resource || resource === 'manpower' ||
    (storageId && (!storage || storage.owner !== building.owner))) return false;
  building.productionTargetStorageId = storageId;
  building.productionCirculationNodeId = undefined;
  return true;
}

export function setProductionCirculation(state: GameState, buildingId: string, nodeId: string): boolean {
  const building = state.buildings.get(buildingId);
  const resource = building ? BUILDING_BALANCE[building.type].productionResource : undefined;
  const node = state.nodes.get(nodeId);
  if (!building || !resource || resource === 'manpower' || !node || node.owner !== building.owner ||
    !findRecognizedLoop(state, building.owner, nodeId)) return false;
  building.productionTargetStorageId = undefined;
  building.productionCirculationNodeId = nodeId;
  return true;
}

export function updateProduction(state: GameState, dt: number): void {
  ensureConnectivity(state);
  recalculateManpowerCapacity(state, 'player');
  recalculateManpowerCapacity(state, 'enemy');
  let disconnectedPlayerBuildings = 0;
  for (const building of state.buildings.values()) {
    if (building.type === 'center' || building.type === 'depot' || building.health <= 0 || !building.constructionComplete) continue;
    if (!building.connected) {
      if (building.owner === 'player') disconnectedPlayerBuildings += 1;
      continue;
    }
    const config = BUILDING_BALANCE[building.type];
    if (!config.productionResource) continue;
    const deposit = building.resourceNodeId ? state.resourceNodes.get(building.resourceNodeId) : undefined;
    if (building.resourceNodeId && (!deposit || deposit.amount <= 0)) continue;
    const generated = actualProductionPerSecond(building) * dt;
    if (config.productionResource === 'manpower') {
      const accepted = addManpower(state, building.owner, generated);
      state.stats.produced.manpower += accepted;
      continue;
    }
    building.productionAccumulator += deposit ? Math.min(generated, Math.max(0, deposit.amount - building.productionAccumulator)) : generated;
    building.productionTimer -= dt;
    if (building.productionTimer > 0) continue;
    building.productionTimer += STORAGE.productionDispatchCadenceSeconds;
    const finalDepositRemainder = deposit && deposit.amount < STORAGE.packetUnitSize && building.productionAccumulator + 0.0001 >= deposit.amount;
    if (building.productionAccumulator + 0.0001 < STORAGE.packetUnitSize && !finalDepositRemainder) continue;
    const amount = Math.min(STORAGE.packetUnitSize, building.productionAccumulator, deposit?.amount ?? Number.POSITIVE_INFINITY);
    if (amount <= 0.0001) continue;
    const circulationNodeId = building.productionCirculationNodeId;
    if (circulationNodeId) {
      const loop = findCirculationLoop(state, building.owner, circulationNodeId);
      const route = loop ? findRoute(state, building.owner, building.nodeId, circulationNodeId, projectedNetworkLoad(state)) : null;
      if (!route) continue;
      const packet = createPacket(
        state, building.owner, config.productionResource, amount, building.nodeId, circulationNodeId,
        'income', undefined, 'producer', undefined, undefined, undefined, route,
      );
      if (!packet) continue;
      packet.routingMode = 'circulate';
      packet.circulationAnchorNodeId = circulationNodeId;
      building.productionAccumulator = Math.max(0, building.productionAccumulator - amount);
      state.stats.produced[config.productionResource] += amount;
      if (deposit) deposit.amount -= amount;
      continue;
    }
    const target = chooseProductionTarget(state, building, amount);
    if (!target) continue;
    const incomingReservation = Number.isFinite(target.storage.maxStorage) ? amount : 0;
    if (incomingReservation > 0 && !reserveIncomingCapacity(target.storage, incomingReservation)) continue;
    const packet = createPacket(
      state, building.owner, config.productionResource, amount, building.nodeId, target.storage.nodeId,
      'income', undefined, 'producer', undefined, target.storage.id, undefined, target.route, incomingReservation,
    );
    if (!packet) {
      if (incomingReservation > 0) releaseIncomingCapacity(target.storage, incomingReservation);
      continue;
    }
    building.productionAccumulator = Math.max(0, building.productionAccumulator - amount);
    state.stats.produced[config.productionResource] += amount;
    if (deposit) deposit.amount -= amount;
  }
  if (disconnectedPlayerBuildings > 0 && state.tick % 150 === 0) {
    addWarning(state, `${disconnectedPlayerBuildings} building${disconnectedPlayerBuildings === 1 ? '' : 's'} disconnected`, 'warning');
  }
}

function currentPacketSegment(packet: Packet): string | undefined {
  return packet.segmentPath[packet.edgeIndex];
}

export function packetSpeedOnSegment(state: GameState, packet: Packet, segment: LineSegment, fromNodeId: string): number {
  const infrastructureMultiplier = effectivePacketSpeed(state, segment) / Math.max(1, packet.baseCruiseSpeed);
  packet.cruiseSpeedMultiplier = Math.max(packet.cruiseSpeedMultiplier, infrastructureMultiplier);
  packet.cruiseSpeed = packet.baseCruiseSpeed * packet.cruiseSpeedMultiplier;
  const direction = directionForTraversal(segment, fromNodeId);
  packet.effectiveSpeedMultiplier = resolveDirectionalSpeedMultiplier(
    packet.cruiseSpeedMultiplier,
    trafficForDirection(segment, direction).state,
    oppositeTraffic(segment, direction).state,
  );
  return packet.baseCruiseSpeed * packet.effectiveSpeedMultiplier;
}

function reroutePacket(state: GameState, packet: Packet, currentNodeId?: string): boolean {
  const nodeId = currentNodeId ?? packet.nodePath[Math.min(packet.edgeIndex, packet.nodePath.length - 1)] ?? packet.sourceNode;
  if (packet.routingMode === 'circulate') {
    const anchor = packet.circulationAnchorNodeId;
    if (!anchor) { packet.waiting = 0.25; return false; }
    if (nodeId === anchor) return beginCirculationCycle(state, packet);
    const circulationRoute = findRoute(state, packet.owner, nodeId, anchor);
    packet.reroutes += 1;
    if (!circulationRoute) { packet.waiting = 0.25; return false; }
    packet.nodePath = circulationRoute.nodes;
    packet.segmentPath = circulationRoute.segments;
    packet.edgeIndex = 0;
    packet.progress = 0;
    packet.returning = false;
    packet.returnNodeId = undefined;
    packet.circulationActive = false;
    packet.position = { ...(state.nodes.get(nodeId)?.position ?? packet.position) };
    return true;
  }
  const route = findRoute(state, packet.owner, nodeId, packet.targetNode);
  packet.reroutes += 1;
  if (!route) {
    if (packet.purpose === 'income' || packet.purpose === 'transfer' || packet.purpose === 'depot-resupply') {
      return retargetPacketToStorage(state, packet, nodeId);
    }
    packet.waiting = 0.25;
    return false;
  }
  packet.nodePath = route.nodes;
  packet.segmentPath = route.segments;
  packet.edgeIndex = 0;
  packet.progress = 0;
  packet.returning = false;
  packet.returnNodeId = undefined;
  packet.position = { ...(state.nodes.get(nodeId)?.position ?? packet.position) };
  return true;
}

function beginArrowTraversal(state: GameState, packet: Packet): boolean {
  const segment = packet.targetSegmentId ? state.segments.get(packet.targetSegmentId) : undefined;
  const target = packet.targetCellId ? state.cells.get(packet.targetCellId) : undefined;
  if (!segment || !target) return false;
  packet.traversingArrow = true;
  packet.arrowCellIndex = packet.arrowDirection === 1 ? 0 : segment.cellIds.length - 1;
  packet.arrowCellProgress = 0;
  return true;
}

function retargetPacketToStorage(state: GameState, packet: Packet, currentNodeId?: string): boolean {
  if (packet.routingMode === 'circulate') { packet.waiting = 0.25; return false; }
  releasePacketStorageReservation(state, packet);
  const fromNode = currentNodeId ?? packet.nodePath[Math.min(packet.edgeIndex, packet.nodePath.length - 1)] ?? packet.sourceNode;
  const candidates = [...state.storages.values()]
    .filter((storage) => storage.owner === packet.owner && storageIsAliveAndConnected(state, storage) && availableStorageCapacity(storage) + 0.0001 >= packet.amount)
    .map((storage) => ({ storage, route: findRoute(state, packet.owner, fromNode, storage.nodeId, projectedNetworkLoad(state)) }))
    .filter((candidate): candidate is { storage: StorageSite; route: RouteResult } => Boolean(candidate.route))
    .sort((left, right) => left.route.cost - right.route.cost ||
      (left.storage.kind === 'depot' ? -1 : 1) - (right.storage.kind === 'depot' ? -1 : 1) || left.storage.id.localeCompare(right.storage.id));
  const best = candidates[0];
  if (!best) {
    packet.waiting = 0.5;
    return false;
  }
  const reservation = Number.isFinite(best.storage.maxStorage) ? packet.amount : 0;
  if (reservation > 0 && !reserveIncomingCapacity(best.storage, reservation)) return false;
  packet.targetStorageId = best.storage.id;
  packet.targetNode = best.storage.nodeId;
  packet.nodePath = best.route.nodes;
  packet.segmentPath = best.route.segments;
  packet.edgeIndex = 0;
  packet.progress = 0;
  packet.position = { ...(state.nodes.get(fromNode)?.position ?? packet.position) };
  packet.incomingCapacityReservation = reservation;
  packet.purpose = packet.purpose === 'income' ? 'income' : 'transfer';
  packet.targetSegmentId = undefined;
  packet.targetCellId = undefined;
  packet.traversingArrow = false;
  packet.returning = false;
  return true;
}

function deliverPacket(state: GameState, packet: Packet): void {
  let delivered = packet.amount;
  let text = `+${Math.floor(delivered)} ${packet.resource}`;
  if (packet.purpose === 'income' || packet.purpose === 'transfer' || packet.purpose === 'depot-resupply') {
    const storage = packet.targetStorageId ? state.storages.get(packet.targetStorageId) : storageAtNode(state, packet.targetNode);
    if (!storage || !storageIsAliveAndConnected(state, storage)) {
      retargetPacketToStorage(state, packet, packet.targetNode);
      return;
    }
    if (Number.isFinite(storage.inboundRate) && storage.inboundBudget + 0.0001 < packet.amount) {
      storage.inboundQueuedPackets += 1;
      packet.waiting = Math.max(packet.waiting, 0.08);
      return;
    }
    delivered = depositResource(state, storage, packet.resource, packet.amount, packet.incomingCapacityReservation);
    packet.incomingCapacityReservation = 0;
    if (Number.isFinite(storage.inboundRate)) {
      storage.inboundBudget = Math.max(0, storage.inboundBudget - delivered);
      storage.receivedThisSecond += delivered;
    }
    if (delivered + 0.0001 < packet.amount) {
      packet.amount -= delivered;
      if (Number.isFinite(storage.maxStorage) && reserveIncomingCapacity(storage, packet.amount)) {
        packet.incomingCapacityReservation = packet.amount;
      }
      packet.waiting = 0.5;
      return;
    }
    if (packet.owner === 'player' && packet.purpose === 'income') state.stats.delivered[packet.resource] += delivered;
  } else {
    const segment = packet.targetSegmentId ? state.segments.get(packet.targetSegmentId) : undefined;
    const cell = packet.targetCellId ? state.cells.get(packet.targetCellId) : undefined;
    if (!segment || !cell) {
      retargetPacketToStorage(state, packet, packet.targetNode);
      return;
    }
    if (packet.purpose === 'construction') {
      addCost(cell.constructionSupply, packet.resource, packet.amount);
      subtractCost(cell.constructionInTransit, packet.resource, packet.amount);
      addCost(segment.constructionDelivered, packet.resource, packet.amount);
      text = `${packet.amount.toFixed(1)} ${packet.resource} → CELL ${cell.index + 1}`;
    } else if (packet.purpose === 'repair') {
      addCost(cell.repairSupply, packet.resource, packet.amount);
      subtractCost(cell.repairInTransit, packet.resource, packet.amount);
      text = `${packet.amount.toFixed(1)} ${packet.resource} → REBUILD`;
    } else {
      addCost(segment.assaultSupply, packet.resource, packet.amount);
      subtractCost(segment.assaultInTransit, packet.resource, packet.amount);
      text = `${packet.amount.toFixed(1)} ${packet.resource} → ATTACK`;
    }
  }
  state.floatingTexts.push({ id: nextId(state, 'text'), position: { ...packet.position }, text, color: COLORS[packet.resource], life: 1.35 });
  state.stats.packetsDelivered += 1;
  spawnParticles(state, packet.position, COLORS[packet.resource], 6, 'delivery');
  state.packets.delete(packet.id);
}

function moveArrowPacket(state: GameState, packet: Packet, dt: number): void {
  const segment = packet.targetSegmentId ? state.segments.get(packet.targetSegmentId) : undefined;
  const target = packet.targetCellId ? state.cells.get(packet.targetCellId) : undefined;
  if (!segment || !target) { packet.waiting = 0.3; return; }
  const cells = cellsOf(state, segment);
  if (packet.pendingRedirectNodeId && packet.pendingRoutingMode) {
    // Return physically to this Arrow's graph entry before following the new
    // destination. Reverse progress without recreating or teleporting cargo.
    const current = cells[packet.arrowCellIndex];
    if (!current) { packet.waiting = 0.2; return; }
    if (packet.arrowCellProgress > 0) {
      if (!cellIsPassable(current) && current.state !== 'building') { packet.waiting = 0.2; return; }
      const speed = packetSpeedOnSegment(state, packet, segment, packet.arrowDirection === 1 ? segment.b : segment.a);
      packet.arrowCellProgress = Math.max(0, packet.arrowCellProgress - speed * dt / Math.max(1, current.length));
      packet.position = cellPoint(current, packet.arrowDirection === 1 ? packet.arrowCellProgress : 1 - packet.arrowCellProgress);
      return;
    }
    const previous = cells[packet.arrowCellIndex - packet.arrowDirection];
    if (previous) {
      if (!cellIsPassable(previous)) { packet.waiting = 0.2; return; }
      packet.arrowCellIndex -= packet.arrowDirection;
      packet.arrowCellProgress = 1;
      return;
    }
    if (!applyPacketRedirect(state, packet, packet.targetNode, packet.pendingRedirectNodeId, packet.pendingRoutingMode)) packet.waiting = 0.2;
    return;
  }
  const targetIndex = target.index;
  // A lookahead packet advances only over built cells, never jumps visually to
  // the future target or delivers through unbuilt infrastructure.
  const preceding = packet.arrowDirection === 1 ? cells.slice(0, packet.arrowCellIndex) : cells.slice(packet.arrowCellIndex + 1);
  if (preceding.some((cell) => !cellIsPassable(cell))) {
    packet.waiting = 0.2;
    const firstGap = packet.arrowDirection === 1
      ? preceding.find((cell) => !cellIsPassable(cell))
      : [...preceding].reverse().find((cell) => !cellIsPassable(cell));
    if (firstGap) {
      packet.arrowCellIndex = firstGap.index;
      packet.arrowCellProgress = 0;
      packet.position = packet.arrowDirection === 1 ? { ...firstGap.start } : { ...firstGap.end };
    }
    return;
  }
  const current = cells[packet.arrowCellIndex];
  if (!current) { packet.waiting = 0.2; return; }
  if (current.index === targetIndex) {
    if (packet.purpose === 'assault') {
      const targetProgress = segment.constructionState === 'attacking' ? current.constructionProgress : 1;
      const speed = packetSpeedOnSegment(state, packet, segment, packet.arrowDirection === 1 ? segment.a : segment.b);
      packet.arrowCellProgress = Math.min(targetProgress, packet.arrowCellProgress + (speed * dt) / Math.max(1, current.length));
      packet.position = cellPoint(current, packet.arrowDirection === 1 ? packet.arrowCellProgress : 1 - packet.arrowCellProgress);
      if (packet.arrowCellProgress + 0.0001 < targetProgress) return;
    } else packet.position = packet.arrowDirection === 1 ? { ...current.start } : { ...current.end };
    deliverPacket(state, packet);
    return;
  }
  if (!cellIsPassable(current)) { packet.waiting = 0.2; return; }
  const speed = packetSpeedOnSegment(state, packet, segment, packet.arrowDirection === 1 ? segment.a : segment.b);
  packet.arrowCellProgress += (speed * dt) / Math.max(1, current.length);
  const visualProgress = packet.arrowDirection === 1 ? packet.arrowCellProgress : 1 - packet.arrowCellProgress;
  packet.position = cellPoint(current, visualProgress);
  if (packet.arrowCellProgress >= 1) {
    packet.arrowCellIndex += packet.arrowDirection;
    packet.arrowCellProgress = 0;
  }
}

function cellAtPacketProgress(state: GameState, segment: LineSegment, fromNodeId: string, progress: number): LineCell | undefined {
  const cells = cellsOf(state, segment);
  if (cells.length === 0) return undefined;
  const alongA = segment.a === fromNodeId ? progress : 1 - progress;
  const totalLength = cells.reduce((sum, cell) => sum + cell.length, 0);
  const position = Math.max(0, Math.min(0.999999, alongA)) * totalLength;
  let traversed = 0;
  for (const cell of cells) {
    traversed += cell.length;
    if (position < traversed) return cell;
  }
  return cells[cells.length - 1];
}

function placePacketAtUpstreamCellBoundary(state: GameState, packet: Packet, segment: LineSegment, fromNodeId: string, cell: LineCell): void {
  const cells = cellsOf(state, segment);
  const totalLength = Math.max(1, cells.reduce((sum, candidate) => sum + candidate.length, 0));
  let startDistance = 0;
  for (const candidate of cells) {
    if (candidate.id === cell.id) break;
    startDistance += candidate.length;
  }
  const endDistance = startDistance + cell.length;
  const fromA = segment.a === fromNodeId;
  const upstreamDistance = fromA ? startDistance : totalLength - endDistance;
  packet.progress = Math.max(0, Math.min(1, upstreamDistance / totalLength));
  packet.position = fromA ? { ...cell.start } : { ...cell.end };
}

function updateNormalPacket(state: GameState, packet: Packet, dt: number, occupancy: Map<string, number>): void {
  if (packet.progress <= 0.0001 && packet.pendingRedirectNodeId && packet.pendingRoutingMode) {
    const nodeId = packet.nodePath[packet.edgeIndex] ?? packet.sourceNode;
    if (!applyPacketRedirect(state, packet, nodeId, packet.pendingRedirectNodeId, packet.pendingRoutingMode)) packet.waiting = 0.25;
    return;
  }
  if (packet.segmentPath.length === 0) {
    if (packet.nodePath[0] === packet.targetNode) {
      if (packet.routingMode === 'circulate') {
        beginCirculationCycle(state, packet);
        return;
      }
      if (packet.targetCellId && beginArrowTraversal(state, packet)) return;
      deliverPacket(state, packet);
    } else reroutePacket(state, packet);
    return;
  }
  const segmentId = currentPacketSegment(packet);
  const segment = segmentId ? state.segments.get(segmentId) : undefined;
  const fromNodeId = packet.nodePath[packet.edgeIndex];
  const toNodeId = packet.nodePath[packet.edgeIndex + 1];
  const fromNode = fromNodeId ? state.nodes.get(fromNodeId) : undefined;
  const toNode = toNodeId ? state.nodes.get(toNodeId) : undefined;
  if (!segment || segment.constructionState !== 'complete' || !fromNode || !toNode) {
    reroutePacket(state, packet, fromNodeId);
    return;
  }
  const currentCell = cellAtPacketProgress(state, segment, fromNode.id, packet.progress);
  if (!cellIsPassable(currentCell)) {
    if (!packet.returning) {
      const alternate = findRoute(state, packet.owner, fromNode.id, packet.targetNode);
      if (alternate && packet.progress <= 0.0001) {
        reroutePacket(state, packet, fromNode.id);
        return;
      }
      if (alternate && packet.progress > 0.0001) {
        packet.returning = true;
        packet.returnNodeId = fromNode.id;
      } else if (!alternate) {
        packet.waiting = 0.2;
        if (currentCell) placePacketAtUpstreamCellBoundary(state, packet, segment, fromNode.id, currentCell);
        return;
      }
    }
    // A packet caught inside a newly destroyed cell retreats from that cell's
    // legitimate upstream boundary; it never crosses the physical gap.
    if (currentCell) placePacketAtUpstreamCellBoundary(state, packet, segment, fromNode.id, currentCell);
  }
  const packetSpeed = packetSpeedOnSegment(state, packet, segment, fromNode.id);
  const edgeLength = Math.max(1, distance(fromNode.position, toNode.position));
  if (packet.returning) {
    packet.progress = Math.max(0, packet.progress - (packetSpeed * dt) / edgeLength);
    packet.position = lerpVec(fromNode.position, toNode.position, packet.progress);
    if (packet.progress <= 0 && !packet.pendingRedirectNodeId) reroutePacket(state, packet, fromNode.id);
    return;
  }
  if (packet.progress <= 0.0001) {
    const direction = directionForTraversal(segment, fromNode.id);
    const loadKey = directionalLoadKey(segment.id, direction);
    const entering = occupancy.get(loadKey) ?? 0;
    const capacity = effectiveDirectionalCapacity(state, segment);
    const packetLoad = packet.amount / STORAGE.packetUnitSize;
    if (entering > 0.0001 && (entering + packetLoad) / Math.max(0.0001, capacity) > CONGESTION.severeQueueThreshold) {
      packet.waiting = 0.12;
      trafficForDirection(segment, direction).queuedPackets += 1;
      return;
    }
    occupancy.set(loadKey, entering + packetLoad);
  }
  packet.progress += (packetSpeed * dt) / edgeLength;
  packet.position = lerpVec(fromNode.position, toNode.position, Math.min(1, packet.progress));
  if (packet.progress < 1) return;
  packet.edgeIndex += 1;
  packet.progress = 0;
  packet.position = { ...toNode.position };
  if (packet.pendingRedirectNodeId && packet.pendingRoutingMode) {
    const targetNodeId = packet.pendingRedirectNodeId;
    const routingMode = packet.pendingRoutingMode;
    if (!applyPacketRedirect(state, packet, toNode.id, targetNodeId, routingMode)) packet.waiting = 0.25;
    return;
  }
  if (packet.edgeIndex >= packet.segmentPath.length) {
    if (packet.routingMode === 'circulate') {
      if (packet.circulationActive) packet.circulationCycles += 1;
      beginCirculationCycle(state, packet);
      return;
    }
    if (packet.targetCellId && beginArrowTraversal(state, packet)) return;
    deliverPacket(state, packet);
  }
}

export function updateLogistics(state: GameState, dt: number): void {
  ensureConnectivity(state);
  updateOutboundSupply(state, dt);
  const occupancy = new Map<string, number>();
  for (const packet of state.packets.values()) {
    const segmentId = !packet.traversingArrow ? currentPacketSegment(packet) : undefined;
    const segment = segmentId ? state.segments.get(segmentId) : undefined;
    const fromNodeId = packet.nodePath[packet.edgeIndex];
    if (segment && fromNodeId && (packet.progress > 0.0001 || packet.returning)) {
      const key = directionalLoadKey(segment.id, directionForTraversal(segment, fromNodeId));
      occupancy.set(key, (occupancy.get(key) ?? 0) + packet.amount / STORAGE.packetUnitSize);
    }
  }
  for (const segment of state.segments.values()) {
    let changed = false;
    const capacity = effectiveDirectionalCapacity(state, segment);
    for (const direction of ['ab', 'ba'] as const) {
      const traffic = trafficForDirection(segment, direction);
      const previousRatio = traffic.loadRatio;
      const previousState = traffic.state;
      traffic.capacity = capacity;
      traffic.load = occupancy.get(directionalLoadKey(segment.id, direction)) ?? 0;
      traffic.loadRatio = traffic.load / Math.max(0.0001, capacity);
      traffic.state = trafficStateForRatio(traffic.loadRatio);
      traffic.queuedPackets = 0;
      traffic.smoothedLoadRatio = lerp(traffic.smoothedLoadRatio, traffic.loadRatio, Math.min(1, dt * CONGESTION.smoothingPerSecond));
      if (previousState !== traffic.state || Math.abs(previousRatio - traffic.loadRatio) >= CONGESTION.significantLoadChange) changed = true;
    }
    segment.trafficLoad = segment.trafficAB.load + segment.trafficBA.load;
    segment.loadRatio = Math.max(segment.trafficAB.loadRatio, segment.trafficBA.loadRatio);
    segment.congested = segment.trafficAB.state !== 'free' || segment.trafficBA.state !== 'free';
    segment.queuedPackets = 0;
    segment.congestion = Math.max(segment.trafficAB.smoothedLoadRatio, segment.trafficBA.smoothedLoadRatio);
    if (changed) state.congestionVersion += 1;
  }
  for (const packet of state.packets.values()) {
    if (packet.traversingArrow || packet.progress > 0.0001 || packet.waiting <= dt) continue;
    const segmentId = currentPacketSegment(packet);
    const segment = segmentId ? state.segments.get(segmentId) : undefined;
    const fromNodeId = packet.nodePath[packet.edgeIndex];
    if (segment && fromNodeId) trafficForDirection(segment, directionForTraversal(segment, fromNodeId)).queuedPackets += 1;
  }
  for (const packet of [...state.packets.values()]) {
    if (packet.waiting > 0) {
      packet.waiting = Math.max(0, packet.waiting - dt);
      if (packet.waiting > 0) continue;
    }
    if (packet.traversingArrow) moveArrowPacket(state, packet, dt);
    else updateNormalPacket(state, packet, dt, occupancy);
  }
  refreshEconomyStock(state);
  for (const segment of state.segments.values()) {
    segment.queuedPackets = segment.trafficAB.queuedPackets + segment.trafficBA.queuedPackets;
  }
  const congested = [...state.segments.values()].some((segment) => segment.owner === 'player' && segment.congested);
  if (congested && state.tick % 180 === 0) addWarning(state, 'Heavy traffic is queueing packets at Line entries', 'warning');
}
