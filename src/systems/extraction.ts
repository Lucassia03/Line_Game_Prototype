import { BUILDING_BALANCE, EXTRACTION, WORLD } from '../config/balance';
import { distance } from '../core/geometry';
import type { Building, BuildingType, GameState, MaterialResource, Vec2 } from '../core/types';

export interface ExtractionSample {
  resourceNodeId?: string;
  efficiency: number;
}

export function extractorResource(type: BuildingType): MaterialResource | undefined {
  const required = BUILDING_BALANCE[type].requiredNode;
  return required && required !== 'manpower' ? required : undefined;
}

function circleIntersectionArea(radiusA: number, radiusB: number, separation: number): number {
  if (separation >= radiusA + radiusB) return 0;
  if (separation <= Math.abs(radiusA - radiusB)) {
    const smaller = Math.min(radiusA, radiusB);
    return Math.PI * smaller * smaller;
  }
  const a = radiusA * radiusA;
  const b = radiusB * radiusB;
  const d = Math.max(0.000001, separation);
  const angleA = Math.acos(Math.max(-1, Math.min(1, (d * d + a - b) / (2 * d * radiusA))));
  const angleB = Math.acos(Math.max(-1, Math.min(1, (d * d + b - a) / (2 * d * radiusB))));
  const lens = 0.5 * Math.sqrt(Math.max(0, (-d + radiusA + radiusB) * (d + radiusA - radiusB) * (d - radiusA + radiusB) * (d + radiusA + radiusB)));
  return a * angleA + b * angleB - lens;
}

export function extractionEfficiencyForGeometry(
  resource: MaterialResource,
  buildingPosition: Vec2,
  depositPosition: Vec2,
  depositRadius: number,
): number {
  const separation = distance(buildingPosition, depositPosition);
  if (separation > WORLD.resourceBuildRange) return 0;
  const extractionRadius = EXTRACTION.radiusByResource[resource];
  const overlap = circleIntersectionArea(extractionRadius, depositRadius, separation);
  const depositArea = Math.PI * depositRadius * depositRadius;
  const coverage = depositArea > 0 ? Math.max(0, Math.min(1, overlap / depositArea)) : 0;
  return Math.max(0, Math.min(1, Math.pow(coverage, EXTRACTION.falloffExponent)));
}

export function extractionAtPosition(state: GameState, type: BuildingType, position: Vec2): ExtractionSample {
  const resource = extractorResource(type);
  if (!resource) return { efficiency: 1 };
  let best: ExtractionSample = { efficiency: 0 };
  for (const node of state.resourceNodes.values()) {
    if (node.type !== resource || node.amount <= 0) continue;
    const efficiency = extractionEfficiencyForGeometry(resource, position, node.position, node.radius);
    if (efficiency > best.efficiency + 0.000001 ||
      (Math.abs(efficiency - best.efficiency) <= 0.000001 && node.id.localeCompare(best.resourceNodeId ?? '') < 0)) {
      best = { resourceNodeId: node.id, efficiency };
    }
  }
  return best;
}

export function baseProductionPerSecond(building: Building): number {
  const config = BUILDING_BALANCE[building.type];
  const baseAmount = config.productionAmount ?? 0;
  const amount = building.type === 'house' && building.level > 1 ? baseAmount * 1.75 : baseAmount;
  const baseSeconds = config.productionSeconds ?? 1;
  const seconds = building.type === 'house' && building.level > 1 ? baseSeconds * 0.72 : baseSeconds;
  return seconds > 0 ? amount / seconds : 0;
}

export function actualProductionPerSecond(building: Building): number {
  return baseProductionPerSecond(building) * Math.max(0, Math.min(1, building.extractionEfficiency));
}
