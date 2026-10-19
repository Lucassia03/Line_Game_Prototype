import { COMMODITY_ORDER, CONGESTION, DEPOT, STACKING, TIER_BALANCE } from '../config/balance';
import { distance, lerpVec } from '../core/geometry';
import { addNode, addSegment } from '../core/state';
import type { DirectionalTraffic, GameState, LineSegment, Owner, Tier, TrafficState, Vec2 } from '../core/types';
import { cellIsPassable, cellsOf, segmentIsPassable, syncSegmentAggregate } from './cells';

export interface AdjacencyEdge {
  node: string;
  segment: string;
  direction: TravelDirection;
  weight: number;
}

export type TravelDirection = 'ab' | 'ba';

export function directionForTraversal(segment: LineSegment, fromNodeId: string): TravelDirection {
  return segment.a === fromNodeId ? 'ab' : 'ba';
}

export function directionalLoadKey(segmentId: string, direction: TravelDirection): string {
  return `${segmentId}:${direction}`;
}

export function trafficForDirection(segment: LineSegment, direction: TravelDirection): DirectionalTraffic {
  return direction === 'ab' ? segment.trafficAB : segment.trafficBA;
}

export function oppositeTraffic(segment: LineSegment, direction: TravelDirection): DirectionalTraffic {
  return direction === 'ab' ? segment.trafficBA : segment.trafficAB;
}

export function trafficStateForRatio(loadRatio: number): TrafficState {
  if (loadRatio > CONGESTION.heavyThreshold) return 'heavy';
  if (loadRatio > CONGESTION.normalThreshold) return 'congested';
  return 'free';
}

/** The sole authority for transient directional congestion speed effects. */
export function resolveDirectionalSpeedMultiplier(
  cruiseSpeedMultiplier: number,
  ownState: TrafficState,
  oppositeState: TrafficState,
): number {
  if (ownState === 'heavy') return CONGESTION.heavyEffectiveMultiplier;
  if (ownState === 'congested') return CONGESTION.normalEffectiveMultiplier;
  if (oppositeState === 'heavy') return cruiseSpeedMultiplier * CONGESTION.oppositeHeavyMultiplier;
  return cruiseSpeedMultiplier;
}

export interface RouteResult {
  nodes: string[];
  segments: string[];
  cost: number;
}

export function segmentLength(state: GameState, segment: LineSegment): number {
  const a = state.nodes.get(segment.a);
  const b = state.nodes.get(segment.b);
  return a && b ? distance(a.position, b.position) : 0;
}

export function effectiveDirectionalCapacity(_state: GameState, segment: LineSegment): number {
  const effectiveStack = Math.min(Math.max(1, segment.stackLevel), STACKING.maxLevelByTier[segment.tier]);
  const stackMultiplier = 1 + (effectiveStack - 1) * STACKING.capacityPerLayer;
  return TIER_BALANCE[segment.tier].lanesPerDirection * stackMultiplier;
}

/** Compatibility name; capacity is now per direction, never a shared pool. */
export function effectiveCapacity(state: GameState, segment: LineSegment): number {
  return effectiveDirectionalCapacity(state, segment);
}

export function effectivePacketSpeed(state: GameState, segment: LineSegment): number {
  const base = TIER_BALANCE[segment.tier].packetSpeed;
  const effectiveStack = Math.min(Math.max(1, segment.stackLevel), STACKING.maxLevelByTier[segment.tier]);
  const a = state.nodes.get(segment.a);
  const b = state.nodes.get(segment.b);
  if (!a || !b) return base * effectiveStack;
  const midpoint = lerpVec(a.position, b.position, 0.5);
  let depotBoost = 0;
  for (const building of state.buildings.values()) {
    if (building.owner === segment.owner && building.type === 'depot' && building.connected && distance(building.position, midpoint) <= DEPOT.radius) {
      depotBoost = DEPOT.packetSpeedBonus;
      break;
    }
  }
  const stackMultiplier = 1 + (effectiveStack - 1) * STACKING.speedPerLayer;
  return base * (1 + depotBoost) * stackMultiplier;
}

export function buildAdjacency(
  state: GameState,
  owner: Owner,
  connectedOnly = false,
  projectedLoad?: ReadonlyMap<string, number>,
): Map<string, AdjacencyEdge[]> {
  const adjacency = new Map<string, AdjacencyEdge[]>();
  for (const node of state.nodes.values()) {
    if (node.owner === owner) adjacency.set(node.id, []);
  }
  for (const segment of state.segments.values()) {
    if (segment.owner !== owner || !segmentIsPassable(state, segment) || (connectedOnly && !segment.connected)) continue;
    const length = segmentLength(state, segment);
    const capacity = Math.max(0.0001, effectiveDirectionalCapacity(state, segment));
    const addEdge = (from: string, to: string, direction: TravelDirection): void => {
      const own = trafficForDirection(segment, direction);
      const opposite = oppositeTraffic(segment, direction);
      const projectedRatio = (own.load + (projectedLoad?.get(directionalLoadKey(segment.id, direction)) ?? 0)) / capacity;
      const loadRatio = Math.max(own.loadRatio, projectedRatio);
      const ownState = trafficStateForRatio(loadRatio);
      const infrastructureCruise = effectivePacketSpeed(state, segment) / Math.max(1, TIER_BALANCE.wood.packetSpeed);
      const speedMultiplier = resolveDirectionalSpeedMultiplier(infrastructureCruise, ownState, opposite.state);
      const speed = Math.max(1, TIER_BALANCE.wood.packetSpeed * speedMultiplier);
      const excess = Math.max(0, loadRatio - CONGESTION.normalThreshold);
      const congestionWeight = 1 + excess * excess * CONGESTION.routePenalty;
      adjacency.get(from)?.push({ node: to, segment: segment.id, direction, weight: (length / speed) * congestionWeight });
    };
    addEdge(segment.a, segment.b, 'ab');
    addEdge(segment.b, segment.a, 'ba');
  }
  return adjacency;
}

export function recomputeConnectivity(state: GameState): void {
  for (const node of state.nodes.values()) node.connected = false;
  for (const segment of state.segments.values()) {
    segment.connected = false;
    for (const cell of cellsOf(state, segment)) cell.connected = false;
  }

  for (const owner of ['player', 'enemy'] as const) {
    const center = state.centerNode[owner];
    const adjacency = buildAdjacency(state, owner);
    const visited = new Set<string>();
    const queue: string[] = [];
    if (center && state.nodes.has(center)) {
      visited.add(center);
      queue.push(center);
    }
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      const node = state.nodes.get(current);
      if (node) node.connected = true;
      for (const edge of adjacency.get(current) ?? []) {
        const segment = state.segments.get(edge.segment);
        if (segment) segment.connected = true;
        if (!visited.has(edge.node)) {
          visited.add(edge.node);
          queue.push(edge.node);
        }
      }
    }
  }

  // A broken route is not a graph edge, but surviving cells on either reachable
  // side retain their local physical connectivity up to the first gap.
  for (const segment of state.segments.values()) {
    const cells = cellsOf(state, segment);
    if (segment.constructionState === 'complete') {
      if (segment.connected && cells.every(cellIsPassable)) {
        for (const cell of cells) cell.connected = true;
      } else {
        if (state.nodes.get(segment.a)?.connected) {
          for (const cell of cells) {
            if (!cellIsPassable(cell)) break;
            cell.connected = true;
          }
        }
        if (state.nodes.get(segment.b)?.connected) {
          for (let index = cells.length - 1; index >= 0; index -= 1) {
            const cell = cells[index];
            if (!cell || !cellIsPassable(cell)) break;
            cell.connected = true;
          }
        }
      }
    } else if (state.nodes.get(segment.a)?.connected) {
      for (const cell of cells.slice(0, segment.frontierCell)) {
        if (!cellIsPassable(cell)) break;
        cell.connected = true;
      }
    }
    syncSegmentAggregate(state, segment);
  }

  for (const building of state.buildings.values()) {
    building.connected = building.constructionComplete && Boolean(state.nodes.get(building.nodeId)?.connected);
  }
  state.routeVersion = state.topologyVersion;
}

export function ensureConnectivity(state: GameState): void {
  if (state.routeVersion !== state.topologyVersion) recomputeConnectivity(state);
}

export function findRoute(
  state: GameState,
  owner: Owner,
  start: string,
  goal: string,
  projectedLoad?: ReadonlyMap<string, number>,
): RouteResult | null {
  ensureConnectivity(state);
  if (start === goal) return { nodes: [start], segments: [], cost: 0 };
  const adjacency = buildAdjacency(state, owner, true, projectedLoad);
  if (!adjacency.has(start) || !adjacency.has(goal)) return null;

  const distances = new Map<string, number>([[start, 0]]);
  const previous = new Map<string, { node: string; segment: string }>();
  const open = new Set<string>([start]);

  while (open.size > 0) {
    let current = '';
    let currentDistance = Infinity;
    for (const candidate of open) {
      const candidateDistance = distances.get(candidate) ?? Infinity;
      if (candidateDistance < currentDistance) {
        current = candidate;
        currentDistance = candidateDistance;
      }
    }
    if (!current || current === goal) break;
    open.delete(current);
    for (const edge of adjacency.get(current) ?? []) {
      const nextDistance = currentDistance + edge.weight;
      if (nextDistance < (distances.get(edge.node) ?? Infinity)) {
        distances.set(edge.node, nextDistance);
        previous.set(edge.node, { node: current, segment: edge.segment });
        open.add(edge.node);
      }
    }
  }

  if (!previous.has(goal)) return null;
  const nodes = [goal];
  const segments: string[] = [];
  let cursor = goal;
  while (cursor !== start) {
    const step = previous.get(cursor);
    if (!step) return null;
    nodes.push(step.node);
    segments.push(step.segment);
    cursor = step.node;
  }
  nodes.reverse();
  segments.reverse();
  return { nodes, segments, cost: distances.get(goal) ?? 0 };
}

/** Finds one deterministic physical cycle through an anchor without looping inside a simulation tick. */
export function findCirculationLoop(state: GameState, owner: Owner, anchor: string): RouteResult | null {
  ensureConnectivity(state);
  const adjacency = buildAdjacency(state, owner, true);
  const starts = [...(adjacency.get(anchor) ?? [])]
    .sort((left, right) => left.weight - right.weight || left.segment.localeCompare(right.segment) || left.node.localeCompare(right.node));
  let best: RouteResult | null = null;
  for (const first of starts) {
    const distances = new Map<string, number>([[first.node, first.weight]]);
    const previous = new Map<string, { node: string; segment: string }>();
    const open = new Set<string>([first.node]);
    while (open.size > 0) {
      let current = '';
      let currentDistance = Infinity;
      for (const candidate of open) {
        const value = distances.get(candidate) ?? Infinity;
        if (value < currentDistance) { current = candidate; currentDistance = value; }
      }
      if (!current || current === anchor) break;
      open.delete(current);
      for (const edge of adjacency.get(current) ?? []) {
        if (edge.segment === first.segment || (edge.node === anchor && current === first.node)) continue;
        const nextDistance = currentDistance + edge.weight;
        if (nextDistance + 0.000001 < (distances.get(edge.node) ?? Infinity)) {
          distances.set(edge.node, nextDistance);
          previous.set(edge.node, { node: current, segment: edge.segment });
          open.add(edge.node);
        }
      }
    }
    if (!previous.has(anchor)) continue;
    const tailNodes = [anchor];
    const tailSegments: string[] = [];
    let cursor = anchor;
    while (cursor !== first.node) {
      const step = previous.get(cursor);
      if (!step) break;
      tailNodes.push(step.node);
      tailSegments.push(step.segment);
      cursor = step.node;
    }
    if (cursor !== first.node) continue;
    tailNodes.reverse();
    tailSegments.reverse();
    const candidate: RouteResult = {
      nodes: [anchor, ...tailNodes],
      segments: [first.segment, ...tailSegments],
      cost: distances.get(anchor) ?? Infinity,
    };
    if (!best || candidate.cost < best.cost - 0.000001 ||
      (Math.abs(candidate.cost - best.cost) <= 0.000001 && candidate.segments.join(':') < best.segments.join(':'))) best = candidate;
  }
  return best;
}

/** Finds a closed, 3+ road loop with exactly one road linking it to the rest of the network. */
export function findRecognizedLoop(state: GameState, owner: Owner, anchor: string): RouteResult | null {
  const loop = findCirculationLoop(state, owner, anchor);
  if (!loop || loop.segments.length < 3 || new Set(loop.segments).size !== loop.segments.length) return null;
  const loopNodes = new Set(loop.nodes.slice(0, -1));
  const loopSegments = new Set(loop.segments);
  let exits = 0;
  for (const segment of state.segments.values()) {
    if (segment.owner !== owner || segment.constructionState !== 'complete' || !segment.connected || loopSegments.has(segment.id)) continue;
    if (loopNodes.has(segment.a) || loopNodes.has(segment.b)) exits += 1;
  }
  return exits === 1 ? loop : null;
}

export function splitSegment(state: GameState, segmentId: string, position: Vec2): { nodeId: string; segmentIds: [string, string] } | null {
  const original = state.segments.get(segmentId);
  if (!original || original.constructionState !== 'complete') return null;
  const oldCells = cellsOf(state, original);
  const hasStagedSupply = oldCells.some((cell) => cell.repairRequested || COMMODITY_ORDER.some((resource) =>
    (cell.constructionSupply[resource] ?? 0) > 0.0001 ||
    (cell.constructionInTransit[resource] ?? 0) > 0.0001 ||
    (cell.repairSupply[resource] ?? 0) > 0.0001 ||
    (cell.repairInTransit[resource] ?? 0) > 0.0001));
  const hasTargetedPackets = [...state.packets.values()].some((packet) => packet.targetSegmentId === original.id);
  if (original.stackTargetLevel > original.stackLevel || hasStagedSupply || hasTargetedPackets) return null;
  const node = addNode(state, original.owner, position);
  state.segments.delete(original.id);
  const first = addSegment(state, original.owner, original.a, node.id, original.tier, {
    constructionState: 'complete',
    buildProgress: 1,
    service: original.service,
    stackLevel: original.stackLevel,
  });
  const second = addSegment(state, original.owner, node.id, original.b, original.tier, {
    constructionState: 'complete',
    buildProgress: 1,
    service: original.service,
    stackLevel: original.stackLevel,
  });
  const applyOriginalState = (replacement: LineSegment): void => {
    for (const cell of cellsOf(state, replacement)) {
      const midpoint = lerpVec(cell.start, cell.end, 0.5);
      let nearest = oldCells[0];
      let nearestDistance = Infinity;
      for (const oldCell of oldCells) {
        const d = distance(midpoint, lerpVec(oldCell.start, oldCell.end, 0.5));
        if (d < nearestDistance) { nearest = oldCell; nearestDistance = d; }
      }
      if (!nearest) continue;
      const ratio = nearest.maxHealth > 0 ? nearest.health / nearest.maxHealth : 0;
      cell.health = cell.maxHealth * ratio;
      cell.state = nearest.state === 'broken' ? 'broken' : 'intact';
      cell.repairRequested = nearest.repairRequested;
    }
    syncSegmentAggregate(state, replacement);
  };
  applyOriginalState(first);
  applyOriginalState(second);
  // Inserting a stockpile/junction must preserve the position of traffic on
  // this edge. Rewrite paths in both directions, including circulation loops.
  const aPosition = state.nodes.get(original.a)!.position;
  const bPosition = state.nodes.get(original.b)!.position;
  const fraction = distance(aPosition, position) / Math.max(0.0001, distance(aPosition, bPosition));
  for (const packet of state.packets.values()) {
    for (let index = packet.segmentPath.length - 1; index >= 0; index -= 1) {
      if (packet.segmentPath[index] !== original.id) continue;
      const forward = packet.nodePath[index] === original.a;
      const splitAt = forward ? fraction : 1 - fraction;
      packet.segmentPath.splice(index, 1, ...(forward ? [first.id, second.id] : [second.id, first.id]));
      packet.nodePath.splice(index + 1, 0, node.id);
      if (packet.edgeIndex > index) packet.edgeIndex += 1;
      else if (packet.edgeIndex === index) {
        if (packet.progress < splitAt) packet.progress /= Math.max(0.0001, splitAt);
        else {
          packet.edgeIndex += 1;
          packet.progress = (packet.progress - splitAt) / Math.max(0.0001, 1 - splitAt);
        }
      }
    }
    for (let index = packet.circulationSegmentCycle.length - 1; index >= 0; index -= 1) {
      if (packet.circulationSegmentCycle[index] !== original.id) continue;
      const forward = packet.circulationNodeCycle[index] === original.a;
      packet.circulationSegmentCycle.splice(index, 1, ...(forward ? [first.id, second.id] : [second.id, first.id]));
      packet.circulationNodeCycle.splice(index + 1, 0, node.id);
    }
  }
  for (const cell of oldCells) state.cells.delete(cell.id);
  state.topologyVersion += 1;
  recomputeConnectivity(state);
  return { nodeId: node.id, segmentIds: [first.id, second.id] };
}

export function getOtherNode(segment: LineSegment, nodeId: string): string | null {
  if (segment.a === nodeId) return segment.b;
  if (segment.b === nodeId) return segment.a;
  return null;
}

export function connectedSegments(state: GameState, owner: Owner): LineSegment[] {
  ensureConnectivity(state);
  return [...state.segments.values()].filter((segment) => segment.owner === owner && segment.connected && segment.constructionState === 'complete');
}

export function tierAfter(tier: Tier): Tier | null {
  if (tier === 'wood') return 'stone';
  if (tier === 'stone') return 'iron';
  return null;
}
