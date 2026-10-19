export type Id = string;

export interface Vec2 {
  x: number;
  y: number;
}

export type Owner = 'player' | 'enemy';
export type Resource = 'manpower' | 'wood' | 'stone' | 'coal' | 'iron';
export type CommodityResource = Exclude<Resource, 'manpower'>;
export type MaterialResource = CommodityResource;
export type Tier = 'wood' | 'stone' | 'iron';
export type BuildingType = 'center' | 'house' | 'woodCamp' | 'quarry' | 'coalMine' | 'ironMine' | 'depot';
export type GamePhase = 'menu' | 'tutorial' | 'playing' | 'paused' | 'victory' | 'defeat';

export type Cost = Partial<Record<Resource, number>>;
export type ResourceStock = Record<Resource, number>;
export type CommodityStock = Record<CommodityResource, number>;
export type TrafficState = 'free' | 'congested' | 'heavy';

export interface DirectionalTraffic {
  load: number;
  capacity: number;
  loadRatio: number;
  state: TrafficState;
  queuedPackets: number;
  smoothedLoadRatio: number;
}

export interface LineNode {
  id: Id;
  owner: Owner;
  position: Vec2;
  kind: 'center' | 'junction' | 'building' | 'stockpile';
  buildingId?: Id;
  connected: boolean;
}

export type LineCellState = 'planned' | 'building' | 'intact' | 'broken' | 'rebuilding';

export interface LineCell {
  id: Id;
  segmentId: Id;
  index: number;
  start: Vec2;
  end: Vec2;
  length: number;
  state: LineCellState;
  health: number;
  maxHealth: number;
  connected: boolean;
  constructionProgress: number;
  constructionSupply: Cost;
  constructionInTransit: Cost;
  repairSupply: Cost;
  repairInTransit: Cost;
  repairRequested: boolean;
  /** Direct workforce paid once for the current construction/stack layer. */
  constructionManpowerPaid: boolean;
  damageFlash: number;
}

export interface LineSegment {
  id: Id;
  owner: Owner;
  a: Id;
  b: Id;
  tier: Tier;
  health: number;
  maxHealth: number;
  armor: number;
  connected: boolean;
  congestion: number;
  capacity: number;
  trafficAB: DirectionalTraffic;
  trafficBA: DirectionalTraffic;
  constructionState: 'queued' | 'building' | 'attacking' | 'complete';
  buildProgress: number;
  damageFlash: number;
  constructionOrder: number;
  constructionCost: Cost;
  constructionDelivered: Cost;
  assaultSupply: Cost;
  assaultInTransit: Cost;
  attackTimer: number;
  arrowTargetKind?: ArrowTargetKind;
  arrowTargetId?: Id;
  arrowTargetMultiplier: number;
  supplyOriginNodeId?: Id;
  supplyOriginKind?: 'center' | 'depot' | 'stockpile';
  service: boolean;
  cellIds: Id[];
  frontierCell: number;
  stackLevel: number;
  stackTargetLevel: number;
  stackFrontierCell: number;
  waitingConstruction: Cost;
  waitingAssault: Cost;
  waitingRepair: Cost;
  trafficLoad: number;
  loadRatio: number;
  queuedPackets: number;
  congested: boolean;
  contributingStorageIds: Id[];
}

export interface StoneWall {
  id: Id;
  owner: Owner;
  start: Vec2;
  end: Vec2;
  health: number;
  maxHealth: number;
  thickness: number;
  damageFlash: number;
}

export interface Building {
  id: Id;
  owner: Owner;
  type: BuildingType;
  nodeId: Id;
  position: Vec2;
  health: number;
  maxHealth: number;
  connected: boolean;
  constructionComplete: boolean;
  level: number;
  productionTimer: number;
  productionAccumulator: number;
  extractionEfficiency: number;
  productionTargetStorageId?: Id;
  productionCirculationNodeId?: Id;
  resourceNodeId?: Id;
  damageFlash: number;
}

export interface ResourceNode {
  id: Id;
  type: MaterialResource;
  position: Vec2;
  amount: number;
  maxAmount: number;
  radius: number;
}

export interface Packet {
  id: Id;
  owner: Owner;
  resource: CommodityResource;
  amount: number;
  sourceNode: Id;
  targetNode: Id;
  nodePath: Id[];
  segmentPath: Id[];
  edgeIndex: number;
  progress: number;
  position: Vec2;
  waiting: number;
  reroutes: number;
  purpose: 'income' | 'construction' | 'assault' | 'repair' | 'transfer' | 'depot-resupply';
  targetSegmentId?: Id;
  targetCellId?: Id;
  targetStorageId?: Id;
  originStorageId?: Id;
  originKind: 'producer' | 'center' | 'depot' | 'stockpile';
  cruiseSpeed: number;
  baseCruiseSpeed: number;
  cruiseSpeedMultiplier: number;
  effectiveSpeedMultiplier: number;
  arrowCellIndex: number;
  arrowCellProgress: number;
  arrowDirection: 1 | -1;
  traversingArrow: boolean;
  acceleratedByManpower: boolean;
  returning: boolean;
  returnNodeId?: Id;
  /** Capacity held at a finite target storage while this packet is in flight. */
  incomingCapacityReservation: number;
  supplyReservationId?: Id;
  routingMode: 'destination' | 'circulate';
  circulationAnchorNodeId?: Id;
  circulationNodeCycle: Id[];
  circulationSegmentCycle: Id[];
  circulationCycles: number;
  circulationActive: boolean;
  pendingRedirectNodeId?: Id;
  pendingRoutingMode?: 'destination' | 'circulate';
}

export interface StorageSite {
  id: Id;
  owner: Owner;
  nodeId: Id;
  kind: 'center' | 'depot' | 'stockpile';
  inventory: CommodityStock;
  /** Subset of inventory committed to not-yet-dispatched automatic requests. */
  reserved: CommodityStock;
  /** Total capacity held for packets already routed to this storage. */
  incomingReservedCapacity: number;
  maxStorage: number;
  autoSupplyEnabled: boolean;
  dispatchBudget: number;
  outboundRate: number;
  queuedTransfers: number;
  dispatchedThisSecond: number;
  inboundBudget: number;
  inboundRate: number;
  receivedThisSecond: number;
  inboundQueuedPackets: number;
}

export interface SupplyReservation {
  id: Id;
  owner: Owner;
  requestKey: string;
  purpose: 'construction' | 'assault' | 'repair';
  storageId: Id;
  resource: CommodityResource;
  amount: number;
  targetNodeId: Id;
  targetSegmentId: Id;
  targetCellId: Id;
  arrowDirection: 1 | -1;
  projectedArrival: number;
  createdTick: number;
}

export interface TransferOrder {
  id: Id;
  owner: Owner;
  sourceStorageId?: Id;
  targetStorageId?: Id;
  targetNodeId: Id;
  routingMode: 'destination' | 'circulate';
  resource: CommodityResource;
  amount: number;
  remaining: number;
  reserved: number;
}

export interface TerrainFeature {
  id: Id;
  kind: 'ridge' | 'water' | 'rough';
  position: Vec2;
  radiusX: number;
  radiusY: number;
  rotation: number;
  blocking: boolean;
}

export interface ParticleEffect {
  id: Id;
  kind: 'spark' | 'smoke' | 'delivery' | 'destruction' | 'impact';
  position: Vec2;
  velocity: Vec2;
  color: string;
  life: number;
  maxLife: number;
  size: number;
}

export interface ImpactEffect {
  id: Id;
  position: Vec2;
  color: string;
  life: number;
  maxLife: number;
  radius: number;
  power: number;
}

export interface FloatingText {
  id: Id;
  position: Vec2;
  text: string;
  color: string;
  life: number;
}

export interface Economy {
  stock: ResourceStock;
  maxManpower: number;
  discovered: Set<Resource>;
}

export interface GameStats {
  elapsed: number;
  delivered: ResourceStock;
  segmentsBuilt: number;
  segmentsLost: number;
  enemySegmentsDestroyed: number;
  wallsBuilt: number;
  wallsDestroyed: number;
  arrowsImpacted: number;
  packetsDelivered: number;
  produced: ResourceStock;
  consumed: ResourceStock;
}

export interface WarningMessage {
  id: Id;
  text: string;
  kind: 'danger' | 'warning' | 'info';
  life: number;
}

export interface Selection {
  kind: 'segment' | 'building' | 'resource' | 'wall' | 'storage' | 'packet' | 'packets' | 'none';
  id?: Id;
  ids?: Id[];
}

export interface DebugState {
  enabled: boolean;
  connectivity: boolean;
  routes: boolean;
  congestion: boolean;
  spatial: boolean;
  fps: number;
  frameMs: number;
}

export interface GameState {
  seed: number;
  worldSize: Vec2;
  tick: number;
  phase: GamePhase;
  previousPhase: GamePhase;
  speed: number;
  nodes: Map<Id, LineNode>;
  segments: Map<Id, LineSegment>;
  cells: Map<Id, LineCell>;
  walls: Map<Id, StoneWall>;
  buildings: Map<Id, Building>;
  resourceNodes: Map<Id, ResourceNode>;
  packets: Map<Id, Packet>;
  storages: Map<Id, StorageSite>;
  supplyReservations: Map<Id, SupplyReservation>;
  transfers: Map<Id, TransferOrder>;
  terrain: TerrainFeature[];
  particles: ParticleEffect[];
  impacts: ImpactEffect[];
  floatingTexts: FloatingText[];
  economy: Record<Owner, Economy>;
  centerNode: Record<Owner, Id>;
  centerBuilding: Record<Owner, Id>;
  selection: Selection;
  warnings: WarningMessage[];
  stats: GameStats;
  debug: DebugState;
  idCounter: number;
  topologyVersion: number;
  routeVersion: number;
  spatialVersion: number;
  logisticsAcceleration: Record<Owner, boolean>;
  supplyVersion: number;
  supplyPlanVersion: number;
  supplyPlanTopologyVersion: number;
  congestionVersion: number;
  supplyPlanCongestionVersion: number;
  nextSupplyPlanTick: number;
}

export type BuildTool =
  | { kind: 'line'; tier: Tier }
  | { kind: 'building'; building: Exclude<BuildingType, 'center'> }
  | { kind: 'wall' }
  | { kind: 'repair' }
  | { kind: 'upgrade' }
  | { kind: 'transfer'; sourceStorageId: Id; resource: CommodityResource; amount: number }
  | { kind: 'redirect'; sourceKind: 'building' | 'storage' | 'packet'; sourceId: Id; sourceIds?: Id[] }
  | { kind: 'select' };

export interface RedirectPreview {
  valid: boolean;
  reason: string;
  from: Vec2;
  to: Vec2;
  nodePath: Id[];
  routingMode: 'destination' | 'circulate';
}

export interface ConstructionPreview {
  valid: boolean;
  reason: string;
  from: Vec2;
  to: Vec2;
  cost: Cost;
  anchorNodeId?: Id;
  anchorSegmentId?: Id;
  targetNodeId?: Id;
  impact?: ArrowImpactPreview;
  stackTargetSegmentId?: Id;
  stackNextLevel?: number;
}

export type ArrowTargetKind = 'cell' | 'building' | 'wall';

export interface ArrowCollision {
  targetKind: ArrowTargetKind;
  targetId: Id;
  point: Vec2;
  t: number;
  multiplier: number;
  targetCellId?: Id;
}

export interface ArrowImpactPreview extends ArrowCollision {
  targetLabel: string;
  baseDamage: number;
  estimatedDamage: number;
}

export interface WallConstructionPreview {
  valid: boolean;
  reason: string;
  from: Vec2;
  to: Vec2;
  cost: Cost;
  snappedStart: boolean;
  snappedEnd: boolean;
}

export interface SettingsData {
  masterVolume: number;
  muted: boolean;
  edgeScroll: boolean;
  screenShake: boolean;
  showTutorial: boolean;
}
