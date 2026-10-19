import { BUILDING_BALANCE, DEPOT, EMPTY_COMMODITY_STOCK, EMPTY_STOCK, INITIAL_PLAYER_STOCK, LINE_CELL, STACKING, STORAGE, TIER_BALANCE, WALL_BALANCE, WORLD } from '../config/balance';
import type {
  Building,
  BuildingType,
  GameState,
  LineNode,
  LineCell,
  LineSegment,
  Owner,
  ResourceNode,
  StoneWall,
  StorageSite,
  TerrainFeature,
  Tier,
  Vec2,
  CommodityStock,
  DirectionalTraffic,
} from './types';

function emptyDirectionalTraffic(capacity: number): DirectionalTraffic {
  return { load: 0, capacity, loadRatio: 0, state: 'free', queuedPackets: 0, smoothedLoadRatio: 0 };
}

export function nextId(state: GameState, prefix: string): string {
  state.idCounter += 1;
  return `${prefix}-${state.idCounter}`;
}

export function createEmptyState(seed = 2405): GameState {
  return {
    seed,
    worldSize: { x: WORLD.width, y: WORLD.height },
    tick: 0,
    phase: 'playing',
    previousPhase: 'playing',
    speed: 1,
    nodes: new Map(),
    segments: new Map(),
    cells: new Map(),
    walls: new Map(),
    buildings: new Map(),
    resourceNodes: new Map(),
    packets: new Map(),
    storages: new Map(),
    supplyReservations: new Map(),
    transfers: new Map(),
    terrain: [],
    particles: [],
    impacts: [],
    floatingTexts: [],
    economy: {
      player: { stock: EMPTY_STOCK(), maxManpower: 180, discovered: new Set(['manpower', 'wood']) },
      enemy: { stock: EMPTY_STOCK(), maxManpower: 999, discovered: new Set(['manpower', 'wood', 'stone', 'coal', 'iron']) },
    },
    centerNode: { player: '', enemy: '' },
    centerBuilding: { player: '', enemy: '' },
    selection: { kind: 'none' },
    warnings: [],
    stats: {
      elapsed: 0,
      delivered: EMPTY_STOCK(),
      segmentsBuilt: 0,
      segmentsLost: 0,
      enemySegmentsDestroyed: 0,
      wallsBuilt: 0,
      wallsDestroyed: 0,
      arrowsImpacted: 0,
      packetsDelivered: 0,
      produced: EMPTY_STOCK(),
      consumed: EMPTY_STOCK(),
    },
    debug: { enabled: false, connectivity: true, routes: false, congestion: true, spatial: false, fps: 0, frameMs: 0 },
    idCounter: 0,
    topologyVersion: 0,
    routeVersion: -1,
    spatialVersion: 0,
    logisticsAcceleration: { player: false, enemy: false },
    supplyVersion: 0,
    supplyPlanVersion: -1,
    supplyPlanTopologyVersion: -1,
    congestionVersion: 0,
    supplyPlanCongestionVersion: -1,
    nextSupplyPlanTick: 0,
  };
}

export function addNode(
  state: GameState,
  owner: Owner,
  position: Vec2,
  kind: LineNode['kind'] = 'junction',
  explicitId?: string,
): LineNode {
  const node: LineNode = {
    id: explicitId ?? nextId(state, 'node'),
    owner,
    position: { ...position },
    kind,
    connected: false,
  };
  state.nodes.set(node.id, node);
  return node;
}

export function addSegment(
  state: GameState,
  owner: Owner,
  a: string,
  b: string,
  tier: Tier,
  options: Partial<Pick<LineSegment, 'constructionState' | 'buildProgress' | 'constructionOrder' | 'constructionCost' | 'constructionDelivered' | 'assaultSupply' | 'assaultInTransit' | 'attackTimer' | 'arrowTargetKind' | 'arrowTargetId' | 'arrowTargetMultiplier' | 'supplyOriginNodeId' | 'supplyOriginKind' | 'service' | 'health' | 'stackLevel'>> = {},
): LineSegment {
  const config = TIER_BALANCE[tier];
  const nodeA = state.nodes.get(a);
  const nodeB = state.nodes.get(b);
  if (!nodeA || !nodeB) throw new Error(`Cannot create segment with missing nodes: ${a}, ${b}`);
  const length = Math.hypot(nodeB.position.x - nodeA.position.x, nodeB.position.y - nodeA.position.y);
  const constructionState = options.constructionState ?? 'complete';
  const requestedStackLevel = Math.max(1, Math.floor(options.stackLevel ?? 1));
  const stackLevel = Math.min(requestedStackLevel, STACKING.maxLevelByTier[tier]);
  const cellCount = Math.max(1, Math.ceil(length / LINE_CELL.length));
  const complete = constructionState === 'complete';
  const cellIds: string[] = [];
  let aggregateHealth = 0;
  let aggregateMaxHealth = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const startT = Math.min(1, (index * LINE_CELL.length) / Math.max(1, length));
    const endT = Math.min(1, ((index + 1) * LINE_CELL.length) / Math.max(1, length));
    const start = { x: nodeA.position.x + (nodeB.position.x - nodeA.position.x) * startT, y: nodeA.position.y + (nodeB.position.y - nodeA.position.y) * startT };
    const end = { x: nodeA.position.x + (nodeB.position.x - nodeA.position.x) * endT, y: nodeA.position.y + (nodeB.position.y - nodeA.position.y) * endT };
    const maxHealth = complete ? config.completedCellHealth : config.arrowCellHealth;
    const cell: LineCell = {
      id: nextId(state, 'cell'), segmentId: '', index, start, end, length: Math.hypot(end.x - start.x, end.y - start.y),
      state: complete ? 'intact' : 'planned', health: complete ? maxHealth : 0, maxHealth,
      connected: complete, constructionProgress: complete ? 1 : 0,
      constructionSupply: {}, constructionInTransit: {}, repairSupply: {}, repairInTransit: {}, repairRequested: false, damageFlash: 0,
      constructionManpowerPaid: complete,
    };
    state.cells.set(cell.id, cell);
    cellIds.push(cell.id);
    aggregateHealth += cell.health;
    aggregateMaxHealth += cell.maxHealth;
  }
  const segment: LineSegment = {
    id: nextId(state, 'line'),
    owner,
    a,
    b,
    tier,
    health: options.health ?? aggregateHealth,
    maxHealth: aggregateMaxHealth,
    armor: config.armor,
    connected: false,
    congestion: 0,
    capacity: config.lanesPerDirection,
    trafficAB: emptyDirectionalTraffic(config.lanesPerDirection * stackLevel),
    trafficBA: emptyDirectionalTraffic(config.lanesPerDirection * stackLevel),
    constructionState,
    buildProgress: options.buildProgress ?? 1,
    damageFlash: 0,
    constructionOrder: options.constructionOrder ?? 0,
    constructionCost: { ...(options.constructionCost ?? {}) },
    constructionDelivered: { ...(options.constructionDelivered ?? {}) },
    assaultSupply: { ...(options.assaultSupply ?? {}) },
    assaultInTransit: { ...(options.assaultInTransit ?? {}) },
    attackTimer: options.attackTimer ?? 0,
    arrowTargetKind: options.arrowTargetKind,
    arrowTargetId: options.arrowTargetId,
    arrowTargetMultiplier: options.arrowTargetMultiplier ?? 1,
    supplyOriginNodeId: options.supplyOriginNodeId,
    supplyOriginKind: options.supplyOriginKind,
    service: options.service ?? false,
    cellIds,
    frontierCell: complete ? cellCount : 0,
    stackLevel,
    stackTargetLevel: stackLevel,
    stackFrontierCell: cellCount,
    waitingConstruction: {},
    waitingAssault: {},
    waitingRepair: {},
    trafficLoad: 0,
    loadRatio: 0,
    queuedPackets: 0,
    congested: false,
    contributingStorageIds: [],
  };
  for (const cellId of cellIds) {
    const cell = state.cells.get(cellId);
    if (cell) cell.segmentId = segment.id;
  }
  if (options.health !== undefined && aggregateHealth > 0) {
    const ratio = Math.max(0, Math.min(1, options.health / aggregateHealth));
    for (const cellId of cellIds) {
      const cell = state.cells.get(cellId);
      if (cell) cell.health = cell.maxHealth * ratio;
    }
  }
  state.segments.set(segment.id, segment);
  state.topologyVersion += 1;
  return segment;
}

export function addStorage(
  state: GameState,
  owner: Owner,
  nodeId: string,
  kind: StorageSite['kind'],
  inventory: CommodityStock = EMPTY_COMMODITY_STOCK(),
): StorageSite {
  const existing = [...state.storages.values()].find((storage) => storage.nodeId === nodeId);
  if (existing) return existing;
  const outboundRate = kind === 'depot' ? DEPOT.maxOutboundUnitsPerSecond
    : kind === 'center' ? STORAGE.centerOutboundUnitsPerSecond
      : STORAGE.stockpileOutboundUnitsPerSecond;
  const storage: StorageSite = {
    id: nextId(state, 'storage'), owner, nodeId, kind, inventory: { ...inventory },
    reserved: EMPTY_COMMODITY_STOCK(), incomingReservedCapacity: 0,
    maxStorage: kind === 'depot' ? DEPOT.maxStorage : Number.POSITIVE_INFINITY,
    autoSupplyEnabled: true,
    dispatchBudget: 0, outboundRate, queuedTransfers: 0, dispatchedThisSecond: 0,
    inboundBudget: kind === 'depot' ? 0 : Number.POSITIVE_INFINITY,
    inboundRate: kind === 'depot' ? DEPOT.maxInboundUnitsPerSecond : Number.POSITIVE_INFINITY,
    receivedThisSecond: 0,
    inboundQueuedPackets: 0,
  };
  state.storages.set(storage.id, storage);
  return storage;
}

export function addWall(
  state: GameState,
  owner: Owner,
  start: Vec2,
  end: Vec2,
  health?: number,
): StoneWall {
  const wall: StoneWall = {
    id: nextId(state, 'wall'),
    owner,
    start: { ...start },
    end: { ...end },
    health: health ?? WALL_BALANCE.health,
    maxHealth: WALL_BALANCE.health,
    thickness: WALL_BALANCE.thickness,
    damageFlash: 0,
  };
  state.walls.set(wall.id, wall);
  state.spatialVersion += 1;
  return wall;
}

export function addBuilding(
  state: GameState,
  owner: Owner,
  type: BuildingType,
  position: Vec2,
  nodeId?: string,
  resourceNodeId?: string,
  constructionComplete = true,
): Building {
  const config = BUILDING_BALANCE[type];
  const node = nodeId ? state.nodes.get(nodeId) : addNode(state, owner, position, type === 'center' ? 'center' : 'building');
  if (!node) throw new Error(`Missing building node ${nodeId}`);
  node.kind = type === 'center' ? 'center' : 'building';
  const building: Building = {
    id: nextId(state, 'building'),
    owner,
    type,
    nodeId: node.id,
    position: { ...position },
    health: config.health,
    maxHealth: config.health,
    connected: false,
    constructionComplete,
    level: 1,
    productionTimer: STORAGE.productionDispatchCadenceSeconds * 0.35,
    productionAccumulator: 0,
    extractionEfficiency: 1,
    resourceNodeId,
    damageFlash: 0,
  };
  node.buildingId = building.id;
  state.buildings.set(building.id, building);
  state.spatialVersion += 1;
  if (type === 'center') {
    state.centerNode[owner] = node.id;
    state.centerBuilding[owner] = building.id;
    const initial = owner === 'player'
      ? INITIAL_PLAYER_STOCK
      : { manpower: 999, wood: 999, stone: 999, coal: 999, iron: 999 };
    addStorage(state, owner, node.id, 'center', {
      wood: initial.wood, stone: initial.stone, coal: initial.coal, iron: initial.iron,
    });
    state.economy[owner].stock = { ...initial };
  } else if (type === 'depot') {
    addStorage(state, owner, node.id, 'depot');
  }
  return building;
}

export function addResourceNode(
  state: GameState,
  type: ResourceNode['type'],
  position: Vec2,
  amount: number,
  radius = 29,
): ResourceNode {
  const node: ResourceNode = { id: nextId(state, 'resource'), type, position: { ...position }, amount, maxAmount: amount, radius };
  state.resourceNodes.set(node.id, node);
  return node;
}

export function addTerrain(state: GameState, feature: Omit<TerrainFeature, 'id'>): TerrainFeature {
  const terrain = { ...feature, id: nextId(state, 'terrain') };
  state.terrain.push(terrain);
  return terrain;
}
