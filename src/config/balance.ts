import type { BuildingType, CommodityResource, CommodityStock, Cost, Resource, ResourceStock, Tier } from '../core/types';

export const WORLD = {
  width: 2400,
  height: 1400,
  grid: 40,
  territoryRadius: 27,
  minSegmentLength: 24,
  buildingConnectionRange: 145,
  resourceBuildRange: 105,
  selectionRadius: 18,
  fixedStep: 1 / 30,
  maxPackets: 850,
  arrowTipRadius: 8,
} as const;

export interface TierBalance {
  costPer100: Cost;
  armor: number;
  damagePerSupply: number;
  assaultCost: Cost;
  assaultInterval: number;
  /** Independent physical lanes available in each direction. */
  lanesPerDirection: number;
  packetSpeed: number;
  buildSecondsPer100: number;
  width: number;
  arrowCellHealth: number;
  completedCellHealth: number;
  repairHealthPerSupply: number;
}

export const TIER_BALANCE: Record<Tier, TierBalance> = {
  wood: {
    costPer100: { manpower: 7, wood: 5 },
    armor: 0,
    damagePerSupply: 35,
    assaultCost: { manpower: 1, wood: 1 },
    assaultInterval: 1.1,
    lanesPerDirection: 1,
    packetSpeed: 78,
    buildSecondsPer100: 0.75,
    width: 7,
    arrowCellHealth: 42,
    completedCellHealth: 115,
    repairHealthPerSupply: 38,
  },
  stone: {
    costPer100: { manpower: 11, stone: 8 },
    armor: 3,
    damagePerSupply: 80,
    assaultCost: { manpower: 2, stone: 1 },
    assaultInterval: 1.05,
    lanesPerDirection: 2,
    packetSpeed: 108,
    buildSecondsPer100: 1.15,
    width: 10,
    arrowCellHealth: 92,
    completedCellHealth: 270,
    repairHealthPerSupply: 72,
  },
  iron: {
    costPer100: { manpower: 18, coal: 6, iron: 10 },
    armor: 8,
    damagePerSupply: 180,
    assaultCost: { manpower: 3, coal: 1, iron: 1 },
    assaultInterval: 1,
    lanesPerDirection: 3,
    packetSpeed: 145,
    buildSecondsPer100: 1.7,
    width: 13,
    arrowCellHealth: 175,
    completedCellHealth: 560,
    repairHealthPerSupply: 125,
  },
};

export interface BuildingBalance {
  cost: Cost;
  health: number;
  productionResource?: Resource;
  productionAmount?: number;
  productionSeconds?: number;
  requiredNode?: Resource;
  maxLevel: number;
  label: string;
}

export const BUILDING_BALANCE: Record<BuildingType, BuildingBalance> = {
  center: { cost: {}, health: 2400, maxLevel: 1, label: 'Line Center' },
  house: {
    cost: { manpower: 20, wood: 38 }, health: 250, productionResource: 'manpower', productionAmount: 12,
    productionSeconds: 8, maxLevel: 2, label: 'House',
  },
  woodCamp: {
    cost: { manpower: 24 }, health: 190, productionResource: 'wood', productionAmount: 12,
    productionSeconds: 6.5, requiredNode: 'wood', maxLevel: 1, label: 'Wood Camp',
  },
  quarry: {
    cost: { manpower: 34, wood: 42 }, health: 270, productionResource: 'stone', productionAmount: 10,
    productionSeconds: 9, requiredNode: 'stone', maxLevel: 1, label: 'Quarry',
  },
  coalMine: {
    cost: { manpower: 36, wood: 46 }, health: 260, productionResource: 'coal', productionAmount: 9,
    productionSeconds: 9.5, requiredNode: 'coal', maxLevel: 1, label: 'Coal Mine',
  },
  ironMine: {
    cost: { manpower: 55, wood: 55, stone: 38, coal: 32 }, health: 340, productionResource: 'iron', productionAmount: 7,
    productionSeconds: 12, requiredNode: 'iron', maxLevel: 1, label: 'Iron Mine',
  },
  depot: {
    cost: { manpower: 28, wood: 32, stone: 14 }, health: 330, maxLevel: 1, label: 'Depot',
  },
};

export const UPGRADE_COSTS = {
  segment: {
    stone: { manpower: 14, stone: 12 },
    iron: { manpower: 24, coal: 9, iron: 15 },
  } satisfies Record<'stone' | 'iron', Cost>,
  house: { manpower: 32, wood: 48, stone: 16 } satisfies Cost,
} as const;

/** A route is simulated as independently damageable cells of this length. */
export const LINE_CELL = {
  length: 32,
  seamSize: 2.4,
  frontierInterpolationSeconds: 0.12,
} as const;

export const DEPOT = {
  radius: 260,
  packetSpeedBonus: 0.15,
  /** Shared by every resource in a Depot. */
  maxStorage: 100,
  maxOutboundUnitsPerSecond: 12,
  /** Independent ingress budget; storage capacity still gates acceptance. */
  maxInboundUnitsPerSecond: 40,
  dispatchBucketSeconds: 1,
  inboundBucketSeconds: 1,
  /** Logical socket used for reliable multi-Line hub connections. */
  connectionSocketRadius: 40,
} as const;

export const STORAGE = {
  centerOutboundUnitsPerSecond: 36,
  stockpileOutboundUnitsPerSecond: 18,
  /** All production and project allocation is divided into packets no larger than this. */
  packetUnitSize: 2,
  /** Producers retain fractional output between these physical dispatch opportunities. */
  productionDispatchCadenceSeconds: 1,
  /** Project reservations are reconsidered at this deterministic cadence or on a state-version change. */
  allocationCadenceSeconds: 0.25,
  /** Rolling construction pipeline; does not reserve an entire long Arrow. */
  constructionLookaheadCells: 12,
} as const;

export const LOGISTICS_ACCELERATION = {
  manpowerCostPerPacket: 2,
  speedMultiplier: 1.75,
} as const;

export const STACKING = {
  geometryTolerance: 5,
  endpointTolerance: 8,
  renderOffset: 2.4,
  maxRenderedLayers: 7,
  speedPerLayer: 1,
  capacityPerLayer: 1,
  /** Wood cannot stack, Stone stops at x2, and Iron has no gameplay cap. */
  maxLevelByTier: {
    wood: 1,
    stone: 2,
    iron: Number.POSITIVE_INFINITY,
  } satisfies Record<Tier, number>,
} as const;

export const CONGESTION = {
  normalThreshold: 1,
  heavyThreshold: 2,
  severeQueueThreshold: 2.75,
  routePenalty: 2.4,
  smoothingPerSecond: 5,
  normalEffectiveMultiplier: 1,
  heavyEffectiveMultiplier: 0.25,
  oppositeHeavyMultiplier: 0.5,
  /** A version update is warranted only when the load ratio changes by this much. */
  significantLoadChange: 0.2,
} as const;

/**
 * Extractors use true circle-overlap coverage against deposit geometry. The
 * per-resource radius is the reach of the extractor footprint, not a hidden
 * production tier.
 */
export const EXTRACTION = {
  buildingRadius: 22,
  minimumPlacementEfficiency: 0.000001,
  falloffExponent: 1.15,
  radiusByResource: {
    wood: 82,
    stone: 80,
    coal: 79,
    iron: 78,
  } satisfies Record<Exclude<Resource, 'manpower'>, number>,
} as const;

export const WALL_BALANCE = {
  costPer100: { manpower: 14, stone: 18 } satisfies Cost,
  health: 300,
  thickness: 16,
  minLength: 28,
  maxLength: 180,
  snapDistance: 22,
  impactMultipliers: {
    wood: 0.4,
    stone: 1,
    iron: 2,
  } satisfies Record<Tier, number>,
} as const;

export const COLORS: Record<Resource | Tier | 'player' | 'enemy' | 'neutral' | 'logistics', string> = {
  manpower: '#f2d785',
  wood: '#c78b52',
  stone: '#aab7b6',
  coal: '#6b7280',
  iron: '#a7d8de',
  player: '#73e3a0',
  enemy: '#f05d6f',
  neutral: '#84908a',
  logistics: '#62d7f0',
};

export const INITIAL_PLAYER_STOCK: ResourceStock = {
  manpower: 130,
  wood: 105,
  stone: 0,
  coal: 0,
  iron: 0,
};

export const EMPTY_STOCK = (): ResourceStock => ({ manpower: 0, wood: 0, stone: 0, coal: 0, iron: 0 });
export const EMPTY_COMMODITY_STOCK = (): CommodityStock => ({ wood: 0, stone: 0, coal: 0, iron: 0 });

export const TIER_ORDER: Tier[] = ['wood', 'stone', 'iron'];
export const RESOURCE_ORDER: Resource[] = ['manpower', 'wood', 'stone', 'coal', 'iron'];
export const COMMODITY_ORDER: CommodityResource[] = ['wood', 'stone', 'coal', 'iron'];
