import { describe, expect, it } from 'vitest';
import {
  BUILDING_BALANCE,
  COMMODITY_ORDER,
  CONGESTION,
  DEPOT,
  INITIAL_PLAYER_STOCK,
  LINE_CELL,
  LOGISTICS_ACCELERATION,
  RESOURCE_ORDER,
  STORAGE,
  TIER_BALANCE,
  WALL_BALANCE,
  WORLD,
} from '../config/balance';
import { addBuilding, addNode, addResourceNode, addSegment, addWall, createEmptyState } from '../core/state';
import type { BuildTool, Cost, GameState, LineCell, LineSegment, Resource, StorageSite, Tier } from '../core/types';
import { applyDamageToCell, evaluateVictory, resolveArrowImpact } from '../systems/combat';
import {
  constructBuilding,
  constructLine,
  findFriendlyAnchor,
  repairSegment,
  updateConstruction,
  validateBuildingPlacement,
  validateLineConstruction,
} from '../systems/construction';
import { findFirstArrowCollision } from '../systems/collision';
import { isResourceUnlocked, isTierUnlocked } from '../systems/economy';
import {
  buildAdjacency,
  effectiveDirectionalCapacity,
  findCirculationLoop,
  findRoute,
  recomputeConnectivity,
  resolveDirectionalSpeedMultiplier,
  splitSegment,
} from '../systems/graph';
import {
  acceleratePacketWithManpower,
  createPacket,
  packetSpeedOnSegment,
  redirectPacket,
  requestCirculatingTransfer,
  requestManualTransfer,
  setProductionDestination,
  updateLogistics,
  updateProduction,
} from '../systems/logistics';
import { actualProductionPerSecond, extractionAtPosition } from '../systems/extraction';
import {
  cellsOf,
  constructionCostForCell,
  costAmount,
  stackAddedLayerMultiplier,
  stackCumulativeMultiplier,
} from '../systems/cells';
import {
  createStockpileAtNode,
  availableStorageCapacity,
  depositResource,
  reserveIncomingCapacity,
  releaseIncomingCapacity,
  refreshEconomyStock,
  resourceConservationDelta,
  setDepotAutoSupply,
  storageAtNode,
  storedAmount,
} from '../systems/storage';
import { constructWall, validateWallPlacement } from '../systems/walls';
import { SelectionIndex } from '../systems/selection';
import { InputController } from '../input/controller';
import { dispatchImmediateUICommand, MIN_CONTROL_TARGET_CSS_PX } from '../ui/commands';
import { claimUIControlPointer, UIInteractionGuard } from '../ui/interaction';

function stateWithCenters(): GameState {
  const state = createEmptyState(11);
  const playerCenter = addNode(state, 'player', { x: 100, y: 100 }, 'center');
  addBuilding(state, 'player', 'center', playerCenter.position, playerCenter.id);
  const enemyCenter = addNode(state, 'enemy', { x: 2100, y: 100 }, 'center');
  addBuilding(state, 'enemy', 'center', enemyCenter.position, enemyCenter.id);
  recomputeConnectivity(state);
  return state;
}

function playerCenterStorage(state: GameState): StorageSite {
  const storage = storageAtNode(state, state.centerNode.player);
  if (!storage) throw new Error('player Center storage missing');
  return storage;
}

function clearPlayerStorage(state: GameState): void {
  state.economy.player.stock.manpower = 0;
  for (const storage of state.storages.values()) {
    if (storage.owner !== 'player') continue;
    for (const resource of COMMODITY_ORDER) storage.inventory[resource] = 0;
  }
  refreshEconomyStock(state, 'player');
}

function grant(state: GameState, values: Cost, storage = playerCenterStorage(state)): void {
  state.economy.player.stock.manpower += values.manpower ?? 0;
  if ((values.manpower ?? 0) > 0) state.economy.player.discovered.add('manpower');
  for (const resource of COMMODITY_ORDER) {
    storage.inventory[resource] += values[resource] ?? 0;
    if ((values[resource] ?? 0) > 0) state.economy.player.discovered.add(resource);
  }
  refreshEconomyStock(state, 'player');
}

function advanceTicks(state: GameState, ticks: number, production = false): void {
  for (let tick = 0; tick < ticks; tick += 1) {
    state.tick += 1;
    updateConstruction(state, WORLD.fixedStep);
    if (production) updateProduction(state, WORLD.fixedStep);
    updateLogistics(state, WORLD.fixedStep);
  }
}

function advanceUntil(state: GameState, predicate: () => boolean, maximumTicks = 6000): boolean {
  for (let tick = 0; tick < maximumTicks; tick += 1) {
    if (predicate()) return true;
    advanceTicks(state, 1);
  }
  return predicate();
}

function arrowFromCenter(state: GameState, x: number, y = 100, tier: Tier = 'wood'): LineSegment {
  const anchor = { nodeId: state.centerNode.player, point: { ...state.nodes.get(state.centerNode.player)!.position }, distance: 0 };
  const arrow = constructLine(state, anchor, { x, y }, tier);
  if (!arrow) throw new Error('Arrow construction failed');
  return arrow;
}

function connectedDepot(
  state: GameState,
  position: { x: number; y: number },
  fromNodeId = state.centerNode.player,
  tier: Tier = 'wood',
  stackLevel = 1,
): { storage: StorageSite; line: LineSegment } {
  const node = addNode(state, 'player', position, 'building');
  const line = addSegment(state, 'player', fromNodeId, node.id, tier, { stackLevel });
  addBuilding(state, 'player', 'depot', position, node.id);
  recomputeConnectivity(state);
  const storage = storageAtNode(state, node.id);
  if (!storage) throw new Error('Depot storage missing');
  return { storage, line };
}

function fillCell(cell: LineCell, tier: Tier, layer = 1): void {
  const cost = constructionCostForCell(cell, tier, layer);
  for (const resource of COMMODITY_ORDER) cell.constructionSupply[resource] = cost[resource] ?? 0;
}

function completeOneSuppliedCell(state: GameState, arrow: LineSegment): void {
  const previous = arrow.frontierCell;
  const completed = advanceUntil(state, () => arrow.frontierCell > previous, 120);
  expect(completed).toBe(true);
}

interface PointerHarness {
  controller: InputController;
  emit: (type: string, event: Record<string, unknown>) => void;
  captured: Set<number>;
  setTool: (tool: BuildTool) => void;
  restore: () => void;
}

function pointerHarness(state: GameState, initialTier: Tier = 'wood'): PointerHarness {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { addEventListener: () => undefined, innerWidth: 1200, innerHeight: 800 },
  });
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const captured = new Set<number>();
  const canvas = {
    addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => listeners.set(type, listener),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: (pointerId: number) => captured.add(pointerId),
    hasPointerCapture: (pointerId: number) => captured.has(pointerId),
    releasePointerCapture: (pointerId: number) => captured.delete(pointerId),
  } as unknown as HTMLCanvasElement;
  const camera = {
    zoom: 1,
    screenToWorld: (point: { x: number; y: number }) => ({ ...point }),
    setPointer: () => undefined,
    update: () => undefined,
    panByScreen: () => undefined,
    zoomAt: () => undefined,
    setKey: () => undefined,
  } as never;
  let tool: BuildTool = { kind: 'line', tier: initialTier };
  const controller = new InputController(canvas, camera, {
    state: () => state,
    tool: () => tool,
    setTool: (next) => { tool = next; },
    togglePause: () => undefined,
    changeSpeed: () => undefined,
    toggleMute: () => undefined,
    toggleDebug: () => undefined,
    toggleDebugFlag: () => undefined,
    toggleTutorial: () => undefined,
    toggleLogisticsAcceleration: () => undefined,
    upgradeSelected: () => undefined,
    onAction: () => undefined,
    settings: () => ({ muted: true, masterVolume: 0, edgeScroll: false, screenShake: false, showTutorial: false }),
  }, { unlock: () => undefined } as never);
  return {
    controller,
    captured,
    setTool: (next) => { tool = next; },
    emit: (type, event) => listeners.get(type)?.({
      pointerId: 1, button: 0, clientX: 0, clientY: 0, shiftKey: false, altKey: false,
      preventDefault: () => undefined, ...event,
    }),
    restore: () => {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    },
  };
}

describe('captured pointer construction gestures', () => {
  it('box-selects commodity packets over roads with Alt and redirects them to a Line point', () => {
    const state = stateWithCenters();
    const end = addNode(state, 'player', { x: 700, y: 100 });
    const road = addSegment(state, 'player', state.centerNode.player, end.id, 'stone');
    recomputeConnectivity(state);
    const destination = createStockpileAtNode(state, 'player', end.id)!;
    const packets = [0.2, 0.3].map((progress) => {
      const packet = createPacket(state, 'player', 'wood', 2, road.a, road.b, 'transfer', undefined, 'center', undefined, destination.id)!;
      packet.progress = progress;
      packet.position = { x: 100 + 600 * progress, y: 100 };
      return packet;
    });
    const harness = pointerHarness(state);
    try {
      harness.emit('pointerdown', { clientX: 210, clientY: 95, altKey: true });
      harness.emit('pointermove', { clientX: 300, clientY: 115 });
      expect(harness.controller.selectionBox).not.toBeNull();
      harness.emit('pointerup', { clientX: 300, clientY: 115 });
      expect(state.selection.kind).toBe('packets');
      expect(state.selection.ids).toEqual(packets.map((packet) => packet.id).sort());
      const positions = packets.map((packet) => ({ ...packet.position }));
      harness.setTool({ kind: 'redirect', sourceKind: 'packet', sourceId: packets[0]!.id, sourceIds: state.selection.ids });
      harness.emit('pointerdown', { clientX: 450, clientY: 100 });
      harness.emit('pointerup', { clientX: 450, clientY: 100 });
      const stockpile = [...state.storages.values()].find((storage) => state.nodes.get(storage.nodeId)?.position.x === 450)!;
      expect(stockpile).toBeDefined();
      expect(packets.map((packet) => packet.position)).toEqual(positions);
      expect(packets.every((packet) => packet.pendingRedirectNodeId === stockpile.nodeId)).toBe(true);
      expect(state.selection.kind).toBe('packets');
      expect(advanceUntil(state, () => packets.every((packet) => !state.packets.has(packet.id)), 1600)).toBe(true);
      expect(stockpile.inventory.wood).toBeCloseTo(4);
    } finally { harness.restore(); }
  });

  it('selects from empty terrain, honors Y, and cancels a selection box', () => {
    const state = stateWithCenters();
    const packet = createPacket(state, 'player', 'wood', 2, state.centerNode.player, state.centerNode.player)!;
    packet.position = { x: 400, y: 400 };
    const harness = pointerHarness(state);
    try {
      harness.emit('pointerdown', { clientX: 350, clientY: 350 });
      harness.emit('pointermove', { clientX: 450, clientY: 450 });
      harness.emit('pointerup', { clientX: 450, clientY: 450 });
      expect(state.selection.ids).toEqual([packet.id]);
      harness.controller.bypassPackets = true;
      harness.emit('pointerdown', { clientX: 350, clientY: 350 });
      harness.emit('pointerup', { clientX: 450, clientY: 450 });
      expect(state.selection.kind).toBe('none');
      harness.emit('pointerdown', { clientX: 350, clientY: 350 });
      harness.emit('pointercancel', {});
      expect(harness.controller.selectionBox).toBeNull();
    } finally { harness.restore(); }
  });

  it('cannot start or finish a world action while a HUD pointer gesture owns input', () => {
    const state = stateWithCenters();
    const end = addNode(state, 'player', { x: 360, y: 100 });
    addSegment(state, 'player', state.centerNode.player, end.id, 'wood');
    recomputeConnectivity(state);
    const harness = pointerHarness(state);
    try {
      const before = state.segments.size;
      harness.controller.setUIInteractionActive(true);
      harness.emit('pointerdown', { clientX: 230, clientY: 100 });
      harness.emit('pointermove', { clientX: 520, clientY: 220 });
      harness.emit('pointerup', { clientX: 520, clientY: 220 });
      expect(harness.controller.preview).toBeNull();
      expect(harness.captured.size).toBe(0);
      expect(state.segments.size).toBe(before);
      harness.controller.setUIInteractionActive(false);
    } finally {
      harness.restore();
    }
  });

  it('drags from a friendly Line cell to create an Arrow and captures the pointer', () => {
    const state = stateWithCenters();
    const end = addNode(state, 'player', { x: 360, y: 100 });
    addSegment(state, 'player', state.centerNode.player, end.id, 'wood');
    recomputeConnectivity(state);
    const harness = pointerHarness(state);
    try {
      const before = state.segments.size;
      harness.emit('pointerdown', { clientX: 230, clientY: 100 });
      expect(harness.captured.has(1)).toBe(true);
      harness.emit('pointermove', { clientX: 520, clientY: 220 });
      expect(harness.controller.preview?.valid).toBe(true);
      harness.emit('pointerup', { clientX: 520, clientY: 220 });
      expect(state.segments.size).toBeGreaterThan(before);
      expect(state.selection.kind).toBe('segment');
      expect(harness.captured.has(1)).toBe(false);
    } finally {
      harness.restore();
    }
  });

  it('drags exactly over a matching completed Line to start stacking', () => {
    const state = stateWithCenters();
    grant(state, { manpower: 100, stone: 100 });
    const end = addNode(state, 'player', { x: 360, y: 100 });
    const line = addSegment(state, 'player', state.centerNode.player, end.id, 'stone');
    recomputeConnectivity(state);
    const harness = pointerHarness(state, 'stone');
    try {
      harness.controller.selectedTier = 'stone';
      harness.emit('pointerdown', { clientX: 100, clientY: 100 });
      harness.emit('pointermove', { clientX: 360, clientY: 100 });
      expect(harness.controller.preview?.stackTargetSegmentId).toBe(line.id);
      harness.emit('pointerup', { clientX: 360, clientY: 100 });
      expect(line.stackTargetLevel).toBe(2);
      expect(state.segments.size).toBe(1);
    } finally {
      harness.restore();
    }
  });

  it('clears captured drag state on pointer cancellation without constructing', () => {
    const state = stateWithCenters();
    const end = addNode(state, 'player', { x: 360, y: 100 });
    addSegment(state, 'player', state.centerNode.player, end.id, 'wood');
    recomputeConnectivity(state);
    const harness = pointerHarness(state);
    try {
      const before = state.segments.size;
      harness.emit('pointerdown', { clientX: 230, clientY: 100 });
      harness.emit('pointermove', { clientX: 520, clientY: 220 });
      expect(harness.controller.preview).not.toBeNull();
      harness.emit('pointercancel', { clientX: 520, clientY: 220 });
      expect(harness.controller.preview).toBeNull();
      expect(harness.captured.has(1)).toBe(false);
      harness.emit('pointerup', { clientX: 520, clientY: 220 });
      expect(state.segments.size).toBe(before);
    } finally {
      harness.restore();
    }
  });
});

describe('HUD command and target contracts', () => {
  it('claims HUD pointer-down before a world action and blocks refresh through click completion', () => {
    const guard = new UIInteractionGuard();
    let propagationStopped = false;
    let worldActions = 0;
    claimUIControlPointer({ pointerId: 9, stopPropagation: () => { propagationStopped = true; } }, guard);
    if (!propagationStopped) worldActions += 1;
    expect(worldActions).toBe(0);
    expect(guard.blocksRefresh).toBe(true);
    expect(guard.release(8)).toBe(false);
    expect(guard.blocksRefresh).toBe(true);
    expect(guard.release(9)).toBe(true);
    expect(guard.blocksRefresh).toBe(false);
  });

  it('keeps every shared important control target at least 44 CSS pixels', () => {
    expect(MIN_CONTROL_TARGET_CSS_PX).toBeGreaterThanOrEqual(44);
  });

  it('dispatches acceleration, transfer, auto-contribution, and Upgrade as real commands', () => {
    const calls: string[] = [];
    const hooks = {
      setTool: (tool: BuildTool) => calls.push(`${tool.kind}:${tool.kind === 'transfer' ? `${tool.sourceStorageId}:${tool.resource}:${tool.amount}` : ''}`),
      toggleLogisticsAcceleration: () => calls.push('acceleration'),
      upgradeSelected: () => calls.push('upgrade'),
      toggleDepotAutoSupply: (storageId: string) => calls.push(`auto:${storageId}`),
    };
    dispatchImmediateUICommand({ kind: 'acceleration' }, hooks);
    dispatchImmediateUICommand({ kind: 'transfer', sourceStorageId: 'depot-1', resource: 'iron', amount: 7 }, hooks);
    dispatchImmediateUICommand({ kind: 'toggle-auto', storageId: 'depot-1' }, hooks);
    dispatchImmediateUICommand({ kind: 'upgrade' }, hooks);
    expect(calls).toEqual(['acceleration', 'transfer:depot-1:iron:7', 'auto:depot-1', 'upgrade']);
  });
});

describe('resource hierarchy remains intact', () => {
  it('unlocks Stone and Coal after Wood, then Iron after Stone and Coal', () => {
    const state = createEmptyState();
    state.economy.player.discovered = new Set<Resource>(['manpower']);
    expect(isResourceUnlocked(state, 'player', 'stone')).toBe(false);
    expect(isResourceUnlocked(state, 'player', 'coal')).toBe(false);
    state.economy.player.discovered.add('wood');
    expect(isResourceUnlocked(state, 'player', 'stone')).toBe(true);
    expect(isResourceUnlocked(state, 'player', 'coal')).toBe(true);
    expect(isResourceUnlocked(state, 'player', 'iron')).toBe(false);
    state.economy.player.discovered.add('stone');
    state.economy.player.discovered.add('coal');
    expect(isResourceUnlocked(state, 'player', 'iron')).toBe(true);
    expect(isTierUnlocked(state, 'player', 'iron')).toBe(false);
    state.economy.player.discovered.add('iron');
    expect(isTierUnlocked(state, 'player', 'iron')).toBe(true);
  });
});

describe('Manpower is direct workforce, never a commodity packet', () => {
  it('lets Houses add Manpower directly without Depot storage, reservations, or routing', () => {
    const state = stateWithCenters();
    const depot = connectedDepot(state, { x: 320, y: 160 }).storage;
    const houseNode = addNode(state, 'player', { x: 300, y: 60 }, 'building');
    addSegment(state, 'player', state.centerNode.player, houseNode.id, 'wood');
    addBuilding(state, 'player', 'house', houseNode.position, houseNode.id);
    recomputeConnectivity(state);
    const before = state.economy.player.stock.manpower;
    const storedBefore = storedAmount(depot);
    advanceTicks(state, Math.ceil(2 / WORLD.fixedStep), true);
    expect(state.economy.player.stock.manpower).toBeGreaterThan(before);
    expect([...state.packets.values()].some((packet) => (packet.resource as string) === 'manpower')).toBe(false);
    expect(storedAmount(depot)).toBe(storedBefore);
    expect(depot.incomingReservedCapacity).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(depot.inventory, 'manpower')).toBe(false);
    expect(COMMODITY_ORDER.includes('manpower' as never)).toBe(false);
  });

  it('pays construction workforce directly while shipping only physical materials', () => {
    const state = stateWithCenters();
    clearPlayerStorage(state);
    grant(state, { manpower: 20, wood: 20 });
    const arrow = arrowFromCenter(state, 180);
    const cell = cellsOf(state, arrow)[0]!;
    fillCell(cell, 'wood');
    const before = state.economy.player.stock.manpower;
    updateConstruction(state, WORLD.fixedStep);
    expect(state.economy.player.stock.manpower).toBeLessThan(before);
    expect(cell.constructionManpowerPaid).toBe(true);
    expect([...state.packets.values()].some((packet) => (packet.resource as string) === 'manpower')).toBe(false);
  });
});

describe('unlimited, resource-paced cell construction', () => {
  it('prioritizes rebuilding a rear cut and then resumes the prefetched construction stream', () => {
    const state = stateWithCenters();
    clearPlayerStorage(state);
    grant(state, { manpower: 500, wood: 150 });
    const arrow = arrowFromCenter(state, 700);
    expect(advanceUntil(state, () => arrow.frontierCell >= 3, 1000)).toBe(true);
    const broken = cellsOf(state, arrow)[1]!;
    applyDamageToCell(state, broken, 10000, 'enemy');
    const frontier = arrow.frontierCell;
    advanceTicks(state, 1);
    expect(arrow.frontierCell).toBe(frontier);
    expect([...state.supplyReservations.values()].some((reservation) => reservation.targetSegmentId === arrow.id && reservation.purpose === 'construction')).toBe(false);
    expect([...state.packets.values()].some((packet) => packet.targetCellId === broken.id && packet.purpose === 'repair')).toBe(true);
    expect(advanceUntil(state, () => broken.state === 'intact' && arrow.frontierCell > frontier, 2000)).toBe(true);
  });

  it('streams multiple Depot bundles before the first delivery and bounds lookahead commitments', () => {
    const state = stateWithCenters();
    const depot = connectedDepot(state, { x: 100, y: 650 }).storage;
    clearPlayerStorage(state);
    grant(state, { manpower: 500, wood: 100 }, depot);
    depot.dispatchBudget = 0;
    const arrow = arrowFromCenter(state, 1800);
    const before = resourceConservationDelta(state, 'wood');
    advanceTicks(state, 30);
    const packets = [...state.packets.values()].filter((packet) => packet.targetSegmentId === arrow.id);
    expect(arrow.frontierCell).toBe(0);
    expect(state.stats.packetsDelivered).toBe(0);
    expect(packets.length).toBeGreaterThan(4);
    expect(new Set(packets.map((packet) => packet.targetCellId)).size).toBeGreaterThan(4);
    const shipped = 100 - depot.inventory.wood;
    expect(shipped).toBeGreaterThan(8);
    expect(shipped).toBeLessThanOrEqual(DEPOT.maxOutboundUnitsPerSecond + 0.0001);
    const reservedTargets = [...state.supplyReservations.values()].map((reservation) => reservation.targetCellId);
    expect(new Set([...packets.map((packet) => packet.targetCellId), ...reservedTargets]).size).toBeLessThanOrEqual(STORAGE.constructionLookaheadCells);
    expect(resourceConservationDelta(state, 'wood')).toBeCloseTo(before);
  });

  it('keeps prefetched packets at built cells and conserves supplies through completion', () => {
    const state = stateWithCenters();
    clearPlayerStorage(state);
    grant(state, { manpower: 500, wood: 100 });
    const arrow = arrowFromCenter(state, 680);
    const before = resourceConservationDelta(state, 'wood');
    for (let tick = 0; tick < 4500 && arrow.constructionState !== 'complete'; tick += 1) {
      advanceTicks(state, 1);
      const frontier = cellsOf(state, arrow)[arrow.frontierCell];
      if (frontier) {
        for (const packet of state.packets.values()) {
          if (packet.targetSegmentId === arrow.id && packet.traversingArrow) expect(packet.position.x).toBeLessThanOrEqual(frontier.end.x + 0.001);
        }
      }
    }
    expect(arrow.constructionState).toBe('complete');
    expect(resourceConservationDelta(state, 'wood')).toBeCloseTo(before);
  });

  it('validates an Arrow longer than the former 245-unit cap and divides it into fixed cells', () => {
    const state = stateWithCenters();
    const anchor = findFriendlyAnchor(state, { x: 100, y: 100 });
    expect(anchor).not.toBeNull();
    if (!anchor) return;
    const preview = validateLineConstruction(state, anchor, { x: 900, y: 330 }, 'wood');
    expect(preview.valid).toBe(true);
    const arrow = constructLine(state, anchor, preview.to, 'wood');
    expect(arrow).not.toBeNull();
    if (!arrow) return;
    expect(arrow.cellIds.length).toBeGreaterThan(Math.ceil(245 / LINE_CELL.length));
    const cells = cellsOf(state, arrow);
    expect(cells.slice(0, -1).every((cell) => Math.abs(cell.length - LINE_CELL.length) < 0.0001)).toBe(true);
    expect(cells.at(-1)?.length).toBeLessThanOrEqual(LINE_CELL.length);
  });

  it('lets a long Arrow eventually reach its destination when physical supplies remain available', () => {
    const state = stateWithCenters();
    clearPlayerStorage(state);
    grant(state, { manpower: 5000, wood: 5000 });
    const arrow = arrowFromCenter(state, 720, 260);
    expect(advanceUntil(state, () => arrow.constructionState === 'complete', 6500)).toBe(true);
    expect(arrow.frontierCell).toBe(arrow.cellIds.length);
    expect(findRoute(state, 'player', arrow.a, arrow.b)).not.toBeNull();
  });

  it('does not reserve the final route cost and grows exactly one supplied cell at a time', () => {
    const state = stateWithCenters();
    clearPlayerStorage(state);
    const before = { ...state.economy.player.stock };
    const arrow = arrowFromCenter(state, 700);
    expect(state.economy.player.stock).toEqual(before);
    advanceTicks(state, 60);
    expect(arrow.frontierCell).toBe(0);
    grant(state, { manpower: 50 });
    const cells = cellsOf(state, arrow);
    const first = cells[0]!;
    fillCell(first, arrow.tier);
    completeOneSuppliedCell(state, arrow);
    expect(arrow.frontierCell).toBe(1);
    advanceTicks(state, 90);
    expect(arrow.frontierCell).toBe(1);
    fillCell(cells[1]!, arrow.tier);
    completeOneSuppliedCell(state, arrow);
    expect(arrow.frontierCell).toBe(2);
  });

  it('pauses on resource exhaustion and automatically resumes after new stock is dispatched', () => {
    const state = stateWithCenters();
    clearPlayerStorage(state);
    grant(state, { manpower: 50 });
    const arrow = arrowFromCenter(state, 500);
    const first = cellsOf(state, arrow)[0]!;
    fillCell(first, arrow.tier);
    completeOneSuppliedCell(state, arrow);
    advanceTicks(state, 120);
    expect(arrow.frontierCell).toBe(1);
    grant(state, { manpower: 50, wood: 50 });
    expect(advanceUntil(state, () => arrow.frontierCell >= 2, 800)).toBe(true);
  });

  it('requires delivered rebuild supply when the partially built frontier cell is destroyed', () => {
    const state = stateWithCenters();
    clearPlayerStorage(state);
    grant(state, { manpower: 50 });
    const arrow = arrowFromCenter(state, 360);
    const frontier = cellsOf(state, arrow)[0]!;
    fillCell(frontier, arrow.tier);
    advanceTicks(state, 1);
    const progressBeforeCut = frontier.constructionProgress;
    expect(progressBeforeCut).toBeGreaterThan(0);
    applyDamageToCell(state, frontier, 10000, 'enemy');
    expect(frontier.state).toBe('broken');
    advanceTicks(state, 8);
    expect(frontier.constructionProgress).toBe(progressBeforeCut);
    expect(arrow.frontierCell).toBe(0);
    expect(frontier.repairRequested).toBe(true);
    frontier.repairSupply = { ...TIER_BALANCE[arrow.tier].assaultCost };
    advanceTicks(state, 1);
    expect(frontier.state).toBe('building');
    expect(arrow.frontierCell).toBe(0);
    advanceTicks(state, 2);
    expect(frontier.constructionProgress).toBeGreaterThan(progressBeforeCut);
  });
});

describe('independent cell durability and physical cuts', () => {
  it('damages only the intersected cell and retains every other cell in the route', () => {
    const state = stateWithCenters();
    const end = addNode(state, 'enemy', { x: 1800, y: 100 });
    const line = addSegment(state, 'enemy', state.centerNode.enemy, end.id, 'wood');
    const cells = cellsOf(state, line);
    const target = cells[2]!;
    const neighborBefore = cells[1]!.health;
    applyDamageToCell(state, target, 20, 'player');
    expect(target.health).toBeLessThan(target.maxHealth);
    expect(cells[1]!.health).toBe(neighborBefore);
    expect(state.segments.has(line.id)).toBe(true);
  });

  it('uses lower Arrow-cell durability and fixed completed-cell durability independent of route length', () => {
    const state = stateWithCenters();
    const shortEnd = addNode(state, 'player', { x: 180, y: 100 });
    const longEnd = addNode(state, 'player', { x: 700, y: 100 });
    const shortLine = addSegment(state, 'player', state.centerNode.player, shortEnd.id, 'stone');
    const longLine = addSegment(state, 'player', state.centerNode.player, longEnd.id, 'stone');
    const arrowEnd = addNode(state, 'player', { x: 700, y: 220 });
    const arrow = addSegment(state, 'player', state.centerNode.player, arrowEnd.id, 'stone', { constructionState: 'building', buildProgress: 0 });
    expect(cellsOf(state, shortLine)[0]!.maxHealth).toBe(TIER_BALANCE.stone.completedCellHealth);
    expect(cellsOf(state, longLine)[0]!.maxHealth).toBe(TIER_BALANCE.stone.completedCellHealth);
    expect(cellsOf(state, arrow)[0]!.maxHealth).toBe(TIER_BALANCE.stone.arrowCellHealth);
    expect(TIER_BALANCE.stone.arrowCellHealth).toBeLessThan(TIER_BALANCE.stone.completedCellHealth);
  });

  it('turns a destroyed middle cell into a real gap, disconnects downstream, and leaves later cells present', () => {
    const state = stateWithCenters();
    const end = addNode(state, 'player', { x: 500, y: 100 });
    const line = addSegment(state, 'player', state.centerNode.player, end.id, 'wood');
    recomputeConnectivity(state);
    const cells = cellsOf(state, line);
    const middle = cells[Math.floor(cells.length / 2)]!;
    applyDamageToCell(state, middle, 10000, 'enemy');
    expect(middle.state).toBe('broken');
    expect(state.segments.has(line.id)).toBe(true);
    expect(cells.at(-1)?.health).toBeGreaterThan(0);
    expect(end.connected).toBe(false);
    expect(findRoute(state, 'player', state.centerNode.player, end.id)).toBeNull();
    const holeCollision = findFirstArrowCollision(state, 'enemy', middle.start, middle.end, 'wood');
    expect(holeCollision).not.toBeNull();
    expect(holeCollision?.targetCellId).not.toBe(middle.id);
  });

  it('rebuilds the exact broken cell with supplied packets and restores connectivity', () => {
    const state = stateWithCenters();
    clearPlayerStorage(state);
    grant(state, { manpower: 50, wood: 50 });
    const end = addNode(state, 'player', { x: 360, y: 100 });
    const line = addSegment(state, 'player', state.centerNode.player, end.id, 'wood');
    recomputeConnectivity(state);
    const middle = cellsOf(state, line)[3]!;
    applyDamageToCell(state, middle, 10000, 'enemy');
    expect(repairSegment(state, line.id)).toBe(true);
    expect(advanceUntil(state, () => middle.state === 'intact', 1200)).toBe(true);
    recomputeConnectivity(state);
    expect(findRoute(state, 'player', state.centerNode.player, end.id)).not.toBeNull();
  });

  it('does not let packets cross a destroyed cell or delete the caught resources', () => {
    const state = stateWithCenters();
    const end = addNode(state, 'player', { x: 420, y: 100 });
    const line = addSegment(state, 'player', state.centerNode.player, end.id, 'wood');
    recomputeConnectivity(state);
    const stockpile = createStockpileAtNode(state, 'player', end.id)!;
    const packet = createPacket(state, 'player', 'wood', 7, state.centerNode.player, end.id, 'transfer', undefined, 'center', undefined, stockpile.id);
    expect(packet).not.toBeNull();
    const middle = cellsOf(state, line)[4]!;
    applyDamageToCell(state, middle, 10000, 'enemy');
    advanceTicks(state, 300);
    expect(stockpile.inventory.wood).toBe(0);
    expect(packet && state.packets.has(packet.id)).toBe(true);
    expect(packet?.amount).toBe(7);
  });

  it('retreats a packet caught inside a cut to a real boundary and reroutes it without losing resources', () => {
    const state = stateWithCenters();
    const end = addNode(state, 'player', { x: 500, y: 100 });
    const detour = addNode(state, 'player', { x: 100, y: 350 });
    const direct = addSegment(state, 'player', state.centerNode.player, end.id, 'wood');
    addSegment(state, 'player', state.centerNode.player, detour.id, 'wood');
    addSegment(state, 'player', detour.id, end.id, 'wood');
    recomputeConnectivity(state);
    const stockpile = createStockpileAtNode(state, 'player', end.id)!;
    playerCenterStorage(state).inventory.wood -= 7;
    refreshEconomyStock(state, 'player');
    const packet = createPacket(state, 'player', 'wood', 7, state.centerNode.player, end.id, 'transfer', undefined, 'center', undefined, stockpile.id)!;
    expect(packet.segmentPath[0]).toBe(direct.id);
    expect(advanceUntil(state, () => packet.progress > 0.35, 300)).toBe(true);
    const directCells = cellsOf(state, direct);
    const currentCell = directCells[Math.min(directCells.length - 1, Math.floor(packet.progress * directCells.length))]!;
    applyDamageToCell(state, currentCell, 10000, 'enemy');
    expect(advanceUntil(state, () => packet.reroutes > 0, 500)).toBe(true);
    expect(packet.amount).toBe(7);
    expect(advanceUntil(state, () => !state.packets.has(packet.id), 1400)).toBe(true);
    expect(stockpile.inventory.wood).toBeCloseTo(7);
    expect(Math.abs(resourceConservationDelta(state, 'wood'))).toBeLessThan(0.0001);
  });
});

describe('Arrow cut gating, supplied repair, and continuous assault', () => {
  function attackingArrow(state: GameState): { arrow: LineSegment; wallId: string; rear: LineCell } {
    const end = addNode(state, 'player', { x: 360, y: 100 });
    const arrow = addSegment(state, 'player', state.centerNode.player, end.id, 'wood', { constructionState: 'building', buildProgress: 0 });
    const cells = cellsOf(state, arrow);
    for (const cell of cells.slice(0, 3)) {
      cell.state = 'intact'; cell.health = cell.maxHealth; cell.constructionProgress = 1;
    }
    arrow.frontierCell = 3;
    const frontier = cells[3]!;
    frontier.state = 'building'; frontier.constructionProgress = 0.55; frontier.health = frontier.maxHealth * 0.55;
    const tip = { x: frontier.start.x + (frontier.end.x - frontier.start.x) * 0.55, y: 100 };
    const wall = addWall(state, 'enemy', { x: tip.x, y: 60 }, { x: tip.x, y: 140 });
    arrow.constructionState = 'attacking'; arrow.arrowTargetKind = 'wall'; arrow.arrowTargetId = wall.id;
    arrow.arrowTargetMultiplier = WALL_BALANCE.impactMultipliers.wood; arrow.attackTimer = 0;
    return { arrow, wallId: wall.id, rear: cells[1]! };
  }

  it('stops a cut Arrow immediately, requests the first rebuild, and resumes the same assault after repair', () => {
    const state = stateWithCenters();
    const { arrow, wallId, rear } = attackingArrow(state);
    const wall = state.walls.get(wallId)!;
    applyDamageToCell(state, rear, 10000, 'enemy');
    arrow.assaultSupply = { ...TIER_BALANCE.wood.assaultCost };
    const before = wall.health;
    updateConstruction(state, WORLD.fixedStep);
    expect(wall.health).toBe(before);
    expect(rear.repairRequested).toBe(true);
    expect(arrow.constructionState).toBe('attacking');
    rear.repairSupply = { ...TIER_BALANCE.wood.assaultCost };
    updateConstruction(state, WORLD.fixedStep);
    expect(rear.state).toBe('intact');
    updateConstruction(state, WORLD.fixedStep);
    expect(wall.health).toBeLessThan(before);
    expect(state.segments.has(arrow.id)).toBe(true);
  });

  it('requests visible repair packets, uses the assault bundle, and never performs an instant global repair', () => {
    const state = stateWithCenters();
    clearPlayerStorage(state);
    grant(state, { manpower: 20, wood: 20 });
    const end = addNode(state, 'player', { x: 260, y: 100 });
    const line = addSegment(state, 'player', state.centerNode.player, end.id, 'wood');
    recomputeConnectivity(state);
    const cell = cellsOf(state, line)[2]!;
    cell.health -= 30;
    const damagedHealth = cell.health;
    const storedBefore = { ...playerCenterStorage(state).inventory };
    expect(repairSegment(state, line.id)).toBe(true);
    expect(cell.health).toBe(damagedHealth);
    expect(playerCenterStorage(state).inventory).toEqual(storedBefore);
    advanceTicks(state, 2);
    const repairPackets = [...state.packets.values()].filter((packet) => packet.purpose === 'repair' && packet.targetCellId === cell.id);
    expect(repairPackets.length).toBeGreaterThan(0);
    for (const resource of COMMODITY_ORDER) {
      const shipped = repairPackets.filter((packet) => packet.resource === resource).reduce((sum, packet) => sum + packet.amount, 0);
      expect(shipped).toBeCloseTo(costAmount(TIER_BALANCE.wood.assaultCost, resource));
    }
    expect(repairPackets.some((packet) => (packet.resource as string) === 'manpower')).toBe(false);
    expect(cell.health).toBe(damagedHealth);
    expect(advanceUntil(state, () => cell.health > damagedHealth, 600)).toBe(true);
  });

  it('keeps the first-obstruction, repeated supplied-damage, Arrow-survival, and resume invariants', () => {
    const state = stateWithCenters();
    clearPlayerStorage(state);
    grant(state, { manpower: 2000, wood: 2000 });
    const first = addWall(state, 'enemy', { x: 220, y: 55 }, { x: 220, y: 145 });
    const second = addWall(state, 'enemy', { x: 300, y: 55 }, { x: 300, y: 145 });
    const arrow = arrowFromCenter(state, 420);
    expect(advanceUntil(state, () => arrow.constructionState === 'attacking', 1800)).toBe(true);
    const firstBefore = first.health;
    advanceTicks(state, 160);
    expect(first.health).toBeLessThan(firstBefore);
    expect(second.health).toBe(second.maxHealth);
    expect(state.segments.has(arrow.id)).toBe(true);
    first.health = 1;
    expect(advanceUntil(state, () => !state.walls.has(first.id), 600)).toBe(true);
    expect(state.segments.has(arrow.id)).toBe(true);
    expect(advanceUntil(state, () => arrow.constructionState === 'attacking' && arrow.arrowTargetId === second.id, 1200)).toBe(true);
  });
});

describe('real local storage, transfers, and fixed dispatch throughput', () => {
  function connectedDepotAndStockpile(state: GameState): { depot: StorageSite; stockpile: StorageSite; route: LineSegment } {
    const depotNode = addNode(state, 'player', { x: 260, y: 100 }, 'building');
    addBuilding(state, 'player', 'depot', depotNode.position, depotNode.id);
    const target = addNode(state, 'player', { x: 520, y: 100 });
    const trunk = addSegment(state, 'player', state.centerNode.player, depotNode.id, 'wood');
    const route = addSegment(state, 'player', depotNode.id, target.id, 'wood');
    recomputeConnectivity(state);
    const depot = storageAtNode(state, depotNode.id)!;
    const stockpile = createStockpileAtNode(state, 'player', target.id)!;
    expect(trunk.connected).toBe(true);
    return { depot, stockpile, route };
  }

  it('never lets an empty Depot materialize Center Wood', () => {
    const state = stateWithCenters();
    const { depot, stockpile } = connectedDepotAndStockpile(state);
    const center = playerCenterStorage(state);
    expect(depot.inventory.wood).toBe(0);
    expect(center.inventory.wood).toBeGreaterThan(0);
    requestManualTransfer(state, depot.id, stockpile.id, 'wood', 6);
    advanceTicks(state, 60);
    expect([...state.packets.values()].some((packet) => packet.originStorageId === depot.id && packet.resource === 'wood')).toBe(false);
    expect(stockpile.inventory.wood).toBe(0);
  });

  it('requires Center Wood to travel visibly into a Depot before that Depot can dispatch it', () => {
    const state = stateWithCenters();
    const { depot, stockpile } = connectedDepotAndStockpile(state);
    const center = playerCenterStorage(state);
    requestManualTransfer(state, center.id, depot.id, 'wood', 10);
    expect(advanceUntil(state, () => [...state.packets.values()].some((packet) => packet.targetStorageId === depot.id), 30)).toBe(true);
    expect(depot.inventory.wood).toBe(0);
    expect(advanceUntil(state, () => depot.inventory.wood >= 9.999, 1200)).toBe(true);
    requestManualTransfer(state, depot.id, stockpile.id, 'wood', 6);
    expect(advanceUntil(state, () => [...state.packets.values()].some((packet) => packet.originStorageId === depot.id), 120)).toBe(true);
    expect(advanceUntil(state, () => stockpile.inventory.wood >= 5.999, 1200)).toBe(true);
  });

  it('uses the weighted closest stocked endpoint for completed-cell repair supply', () => {
    const state = stateWithCenters();
    const end = addNode(state, 'player', { x: 500, y: 100 });
    const line = addSegment(state, 'player', state.centerNode.player, end.id, 'wood');
    addBuilding(state, 'player', 'depot', end.position, end.id);
    recomputeConnectivity(state);
    const depot = storageAtNode(state, end.id)!;
    grant(state, { manpower: 10, wood: 10 }, depot);
    const target = cellsOf(state, line).at(-1)!;
    applyDamageToCell(state, target, 20, 'enemy');
    expect(repairSegment(state, line.id)).toBe(true);
    updateLogistics(state, 1);
    const packets = [...state.packets.values()].filter((packet) => packet.purpose === 'repair' && packet.targetCellId === target.id);
    expect(packets.length).toBeGreaterThan(0);
    expect(packets.every((packet) => packet.originStorageId === depot.id)).toBe(true);
    expect(packets.every((packet) => packet.arrowDirection === -1)).toBe(true);
  });

  it('caps one Depot across simultaneous demand and ignores connected Line stack level', () => {
    const state = stateWithCenters();
    const { depot, stockpile, route } = connectedDepotAndStockpile(state);
    clearPlayerStorage(state);
    grant(state, { wood: 100 }, depot);
    route.tier = 'iron';
    route.stackLevel = 5;
    requestManualTransfer(state, depot.id, stockpile.id, 'wood', 30);
    requestManualTransfer(state, depot.id, stockpile.id, 'wood', 30);
    requestManualTransfer(state, depot.id, stockpile.id, 'wood', 30);
    const before = depot.inventory.wood;
    advanceTicks(state, 30);
    const dispatched = before - depot.inventory.wood;
    expect(dispatched).toBeGreaterThan(0);
    expect(dispatched).toBeLessThanOrEqual(DEPOT.maxOutboundUnitsPerSecond + 0.001);
    expect(state.transfers.size).toBeGreaterThan(0);
  });

  it('moves resources A to a chosen stockpile B, keeps them there, and reuses that local stock for construction', () => {
    const state = stateWithCenters();
    const target = addNode(state, 'player', { x: 420, y: 100 });
    addSegment(state, 'player', state.centerNode.player, target.id, 'wood');
    recomputeConnectivity(state);
    const stockpile = createStockpileAtNode(state, 'player', target.id)!;
    const center = playerCenterStorage(state);
    requestManualTransfer(state, center.id, stockpile.id, 'wood', 12);
    expect(advanceUntil(state, () => state.packets.size > 0, 30)).toBe(true);
    expect(stockpile.inventory.wood).toBe(0);
    expect(advanceUntil(state, () => stockpile.inventory.wood >= 11.999, 1600)).toBe(true);
    const arrow = constructLine(state, { nodeId: target.id, point: { ...target.position }, distance: 0 }, { x: 650, y: 100 }, 'wood');
    expect(arrow).not.toBeNull();
    expect(advanceUntil(state, () => [...state.packets.values()].some((packet) => packet.targetSegmentId === arrow?.id), 120)).toBe(true);
    const packet = [...state.packets.values()].find((candidate) => candidate.targetSegmentId === arrow?.id);
    expect(packet?.originStorageId).toBe(stockpile.id);
  });

  it('conserves each initial resource across storage, packets, staging, and consumption', () => {
    const state = stateWithCenters();
    const target = addNode(state, 'player', { x: 360, y: 100 });
    addSegment(state, 'player', state.centerNode.player, target.id, 'wood');
    recomputeConnectivity(state);
    const stockpile = createStockpileAtNode(state, 'player', target.id)!;
    requestManualTransfer(state, playerCenterStorage(state).id, stockpile.id, 'wood', 20);
    advanceTicks(state, 120);
    expect(Math.abs(resourceConservationDelta(state, 'wood'))).toBeLessThan(0.0001);
    expect(Math.abs(resourceConservationDelta(state, 'manpower'))).toBeLessThan(0.0001);
    expect(INITIAL_PLAYER_STOCK.wood).toBeGreaterThan(0);
  });
});

describe('stacking and persistent packet acceleration', () => {
  it('uses exact triangular cumulative and incremental layer multipliers', () => {
    expect([1, 2, 3, 4, 5].map(stackCumulativeMultiplier)).toEqual([1, 3, 6, 10, 15]);
    expect([1, 2, 3, 4].map(stackAddedLayerMultiplier)).toEqual([1, 2, 3, 4]);
  });

  it('allows only same-material Stone/Iron stacks, caps Stone at x2, and rejects Wood stacking', () => {
    const state = stateWithCenters();
    grant(state, { manpower: 200, stone: 100, coal: 100, iron: 100 });
    const end = addNode(state, 'player', { x: 260, y: 100 });
    const wood = addSegment(state, 'player', state.centerNode.player, end.id, 'wood', { stackLevel: 4 });
    recomputeConnectivity(state);
    const anchor = { nodeId: state.centerNode.player, point: { x: 100, y: 100 }, distance: 0 };
    expect(validateLineConstruction(state, anchor, end.position, 'wood').reason).toContain('cannot stack');
    expect(constructLine(state, anchor, end.position, 'wood')).toBeNull();
    expect(validateLineConstruction(state, anchor, end.position, 'stone').reason).toContain('match');
    expect(wood.stackLevel).toBe(1);

    const stoneEnd = addNode(state, 'player', { x: 260, y: 180 });
    const stone = addSegment(state, 'player', state.centerNode.player, stoneEnd.id, 'stone');
    const stoneStack = constructLine(state, anchor, stoneEnd.position, 'stone');
    expect(stoneStack?.id).toBe(stone.id);
    for (const cell of cellsOf(state, stone)) fillCell(cell, stone.tier, 2);
    advanceTicks(state, stone.cellIds.length + 2);
    expect(stone.stackLevel).toBe(2);
    expect(validateLineConstruction(state, anchor, stoneEnd.position, 'stone').reason).toContain('limited to stack x2');
    expect(constructLine(state, anchor, stoneEnd.position, 'stone')).toBeNull();
  });

  it('creates one Iron route and charges only the incremental layer 2 then layer 3 costs', () => {
    const state = stateWithCenters();
    grant(state, { manpower: 200, stone: 100, coal: 100, iron: 100 });
    const end = addNode(state, 'player', { x: 260, y: 100 });
    const line = addSegment(state, 'player', state.centerNode.player, end.id, 'iron');
    recomputeConnectivity(state);
    const anchor = { nodeId: state.centerNode.player, point: { x: 100, y: 100 }, distance: 0 };
    const same = constructLine(state, anchor, end.position, 'iron');
    expect(same?.id).toBe(line.id);
    expect(state.segments.size).toBe(1);
    expect(line.stackTargetLevel).toBe(2);
    for (const cell of cellsOf(state, line)) fillCell(cell, line.tier, 2);
    advanceTicks(state, line.cellIds.length + 2);
    expect(line.stackLevel).toBe(2);
    expect(line.stackFrontierCell).toBe(line.cellIds.length);
    const layerTwoCost = constructionCostForCell(cellsOf(state, line)[0]!, 'iron', 2);
    const base = constructionCostForCell(cellsOf(state, line)[0]!, 'iron', 1);
    expect(layerTwoCost.iron).toBeCloseTo((base.iron ?? 0) * 2);
    constructLine(state, anchor, end.position, 'iron');
    for (const cell of cellsOf(state, line)) fillCell(cell, line.tier, 3);
    advanceTicks(state, line.cellIds.length + 2);
    expect(line.stackLevel).toBe(3);
  });

  it('raises packet cruise speed at x2 and x3 stacks and never lowers it on later x1 infrastructure', () => {
    const state = stateWithCenters();
    const n1 = addNode(state, 'player', { x: 132, y: 100 });
    const n2 = addNode(state, 'player', { x: 164, y: 100 });
    const n3 = addNode(state, 'player', { x: 196, y: 100 });
    const first = addSegment(state, 'player', state.centerNode.player, n1.id, 'iron', { stackLevel: 2 });
    const second = addSegment(state, 'player', n1.id, n2.id, 'iron', { stackLevel: 1 });
    const third = addSegment(state, 'player', n2.id, n3.id, 'iron', { stackLevel: 3 });
    recomputeConnectivity(state);
    const destination = createStockpileAtNode(state, 'player', n3.id)!;
    const packet = createPacket(state, 'player', 'wood', 1, state.centerNode.player, n3.id, 'transfer', undefined, 'center', undefined, destination.id)!;
    advanceTicks(state, 1);
    expect(packet.cruiseSpeed).toBeGreaterThanOrEqual(TIER_BALANCE.iron.packetSpeed * 2);
    expect(advanceUntil(state, () => packet.edgeIndex >= 1, 90)).toBe(true);
    const x2Speed = packet.cruiseSpeed;
    advanceTicks(state, 1);
    expect(packet.cruiseSpeed).toBe(x2Speed);
    expect(second.stackLevel).toBe(1);
    expect(advanceUntil(state, () => packet.edgeIndex >= 2, 90)).toBe(true);
    advanceTicks(state, 1);
    expect(packet.cruiseSpeed).toBeGreaterThanOrEqual(TIER_BALANCE.iron.packetSpeed * 3);
    expect(first.stackLevel).toBe(2);
    expect(third.stackLevel).toBe(3);
  });

  it('preserves acquired cruise speed through rerouting and ends it when the packet is delivered', () => {
    const state = stateWithCenters();
    const a = addNode(state, 'player', { x: 180, y: 70 });
    const b = addNode(state, 'player', { x: 180, y: 130 });
    const goal = addNode(state, 'player', { x: 280, y: 100 });
    const fast = addSegment(state, 'player', state.centerNode.player, a.id, 'stone', { stackLevel: 2 });
    const blocked = addSegment(state, 'player', a.id, goal.id, 'stone');
    addSegment(state, 'player', state.centerNode.player, b.id, 'stone');
    addSegment(state, 'player', b.id, goal.id, 'stone');
    recomputeConnectivity(state);
    const destination = createStockpileAtNode(state, 'player', goal.id)!;
    const packet = createPacket(state, 'player', 'wood', 1, state.centerNode.player, goal.id, 'transfer', undefined, 'center', undefined, destination.id)!;
    expect(advanceUntil(state, () => packet.edgeIndex >= 1, 180)).toBe(true);
    const acquired = packet.cruiseSpeed;
    applyDamageToCell(state, cellsOf(state, blocked)[0]!, 10000, 'enemy');
    advanceTicks(state, 3);
    expect(packet.cruiseSpeed).toBe(acquired);
    expect(packet.reroutes).toBeGreaterThan(0);
    expect(advanceUntil(state, () => !state.packets.has(packet.id), 500)).toBe(true);
    const fresh = createPacket(state, 'player', 'wood', 1, state.centerNode.player, state.centerNode.player)!;
    expect(fresh.cruiseSpeed).toBe(fresh.baseCruiseSpeed);
    expect(fast.stackLevel).toBe(2);
  });

  it('spends direct pooled Manpower for a persistent packet boost', () => {
    const state = stateWithCenters();
    const storage = playerCenterStorage(state);
    const end = addNode(state, 'player', { x: 300, y: 100 });
    addSegment(state, 'player', state.centerNode.player, end.id, 'wood');
    recomputeConnectivity(state);
    const destination = createStockpileAtNode(state, 'player', end.id)!;
    const packet = createPacket(state, 'player', 'wood', 1, state.centerNode.player, end.id, 'transfer', undefined, 'center', undefined, destination.id, storage.id)!;
    const before = state.economy.player.stock.manpower;
    expect(acceleratePacketWithManpower(state, packet.id)).toBe(true);
    expect(state.economy.player.stock.manpower).toBeCloseTo(before - LOGISTICS_ACCELERATION.manpowerCostPerPacket);
    expect(packet.cruiseSpeed).toBeGreaterThan(packet.baseCruiseSpeed);
    const accelerated = packet.cruiseSpeed;
    advanceTicks(state, 20);
    expect(packet.cruiseSpeed).toBe(accelerated);
    expect(state.packets.has(packet.id)).toBe(true);
  });
});

describe('passive Walls, passive completed Lines, local collision, and victory', () => {
  it('places Walls outside friendly territory while retaining physical collision rejection', () => {
    const state = stateWithCenters();
    grant(state, { manpower: 100, stone: 100 });
    const remote = validateWallPlacement(state, { x: 700, y: 500 }, { x: 800, y: 500 });
    expect(remote.valid).toBe(true);
    const wall = constructWall(state, remote.from, remote.to);
    expect(wall).not.toBeNull();
    const overlap = validateWallPlacement(state, { x: 740, y: 450 }, { x: 740, y: 550 });
    expect(overlap.valid).toBe(false);
    expect(overlap.reason).toContain('Wall');
  });

  it('never lets Walls attack, transport, launch Lines, claim territory, or join the graph', () => {
    const state = stateWithCenters();
    const wall = addWall(state, 'player', { x: 300, y: 60 }, { x: 300, y: 140 });
    const enemyEnd = addNode(state, 'enemy', { x: 320, y: 100 });
    const enemyLine = addSegment(state, 'enemy', state.centerNode.enemy, enemyEnd.id, 'iron');
    const before = enemyLine.health;
    advanceTicks(state, 300);
    expect(enemyLine.health).toBe(before);
    expect(buildAdjacency(state, 'player').has(wall.id)).toBe(false);
    expect(state.packets.size).toBe(0);
    expect(state.nodes.has(wall.id)).toBe(false);
  });

  it('never causes passive damage from completed player or enemy Lines', () => {
    const state = stateWithCenters();
    const playerEnd = addNode(state, 'player', { x: 400, y: 100 });
    const enemyEnd = addNode(state, 'enemy', { x: 405, y: 105 });
    const playerLine = addSegment(state, 'player', state.centerNode.player, playerEnd.id, 'iron');
    const enemyLine = addSegment(state, 'enemy', state.centerNode.enemy, enemyEnd.id, 'iron');
    const before = [playerLine.health, enemyLine.health];
    advanceTicks(state, 600, true);
    expect([playerLine.health, enemyLine.health]).toEqual(before);
    expect(state.stats.arrowsImpacted).toBe(0);
  });

  it('applies exact Wood, Stone, and Iron Wall multipliers with Iron strongest', () => {
    const values = (['wood', 'stone', 'iron'] as const).map((tier) => {
      const state = stateWithCenters();
      const wall = addWall(state, 'enemy', { x: 300, y: 60 }, { x: 300, y: 140 }, 1000);
      return resolveArrowImpact(state, tier, 'player', {
        targetKind: 'wall', targetId: wall.id, point: { x: 300, y: 100 }, t: 0.5,
        multiplier: WALL_BALANCE.impactMultipliers[tier],
      }).damage;
    });
    expect(values).toEqual([14, 80, 360]);
    expect(values[2]).toBeGreaterThan(values[1]!);
    expect(values[1]).toBeGreaterThan(values[0]!);
  });

  it('damages only the first living enemy cell and recalculates enemy connectivity when it breaks', () => {
    const state = stateWithCenters();
    const mid = addNode(state, 'enemy', { x: 1900, y: 100 });
    const end = addNode(state, 'enemy', { x: 1700, y: 100 });
    const bridge = addSegment(state, 'enemy', state.centerNode.enemy, mid.id, 'wood');
    const downstream = addSegment(state, 'enemy', mid.id, end.id, 'wood');
    recomputeConnectivity(state);
    const cell = cellsOf(state, bridge)[2]!;
    const other = cellsOf(state, bridge)[3]!;
    const otherBefore = other.health;
    resolveArrowImpact(state, 'iron', 'player', {
      targetKind: 'cell', targetId: cell.id, targetCellId: cell.id,
      point: { x: (cell.start.x + cell.end.x) / 2, y: 100 }, t: 0.5, multiplier: 1,
    });
    expect(cell.state).toBe('broken');
    expect(other.health).toBe(otherBefore);
    expect(state.segments.has(bridge.id)).toBe(true);
    expect(downstream.connected).toBe(false);
    expect(end.connected).toBe(false);
  });

  it('triggers victory when the enemy Line Center is destroyed', () => {
    const state = stateWithCenters();
    const center = state.buildings.get(state.centerBuilding.enemy)!;
    center.health = 100;
    resolveArrowImpact(state, 'iron', 'player', {
      targetKind: 'building', targetId: center.id, point: { ...center.position }, t: 1, multiplier: 1,
    });
    expect(evaluateVictory(state)).toBe('victory');
    expect(state.phase).toBe('victory');
  });
});

describe('small physical production packets and extraction output', () => {
  it('emits smaller packets more frequently without changing the configured production rate and preserves fractions', () => {
    const state = stateWithCenters();
    const producerNode = addNode(state, 'player', { x: 280, y: 100 }, 'building');
    addSegment(state, 'player', state.centerNode.player, producerNode.id, 'wood');
    const deposit = addResourceNode(state, 'wood', producerNode.position, 500, 34);
    const producer = addBuilding(state, 'player', 'woodCamp', producerNode.position, producerNode.id, deposit.id);
    recomputeConnectivity(state);
    const elapsed = 16;
    const fractionalTicks = Math.round(0.5 / WORLD.fixedStep);
    for (let tick = 0; tick < fractionalTicks; tick += 1) updateProduction(state, WORLD.fixedStep);
    expect(state.packets.size).toBe(0);
    expect(producer.productionAccumulator).toBeGreaterThan(0);
    expect(producer.productionAccumulator).toBeLessThan(STORAGE.packetUnitSize);
    for (let tick = fractionalTicks; tick < Math.round(elapsed / WORLD.fixedStep); tick += 1) updateProduction(state, WORLD.fixedStep);
    const packets = [...state.packets.values()].filter((packet) => packet.purpose === 'income' && packet.resource === 'wood');
    expect(STORAGE.packetUnitSize).toBeLessThan(BUILDING_BALANCE.woodCamp.productionAmount ?? Infinity);
    expect(packets.every((packet) => packet.amount <= STORAGE.packetUnitSize + 0.0001)).toBe(true);
    expect(packets.length).toBeGreaterThan(2);
    const expected = actualProductionPerSecond(producer) * elapsed;
    expect(state.stats.produced.wood + producer.productionAccumulator).toBeCloseTo(expected, 3);
    expect(producer.productionAccumulator).toBeGreaterThanOrEqual(0);
    expect(producer.productionAccumulator).toBeLessThan(STORAGE.packetUnitSize + 0.0001);
  });

  it('uses one smooth geometry formula for preview and simulation across every extractor type', () => {
    const cases = [
      ['woodCamp', 'wood'], ['quarry', 'stone'], ['coalMine', 'coal'], ['ironMine', 'iron'],
    ] as const;
    for (const [buildingType, resource] of cases) {
      const state = stateWithCenters();
      grant(state, { manpower: 1000, wood: 1000, stone: 1000, coal: 1000, iron: 1000 });
      state.economy.player.discovered = new Set<Resource>(RESOURCE_ORDER);
      const position = { x: 430, y: 320 };
      addNode(state, 'player', position);
      addSegment(state, 'player', state.centerNode.player, [...state.nodes.values()].at(-1)!.id, 'wood');
      addResourceNode(state, resource, position, 1000, 29);
      recomputeConnectivity(state);
      const optimal = extractionAtPosition(state, buildingType, position).efficiency;
      const medium = extractionAtPosition(state, buildingType, { x: position.x + 74, y: position.y }).efficiency;
      const poor = extractionAtPosition(state, buildingType, { x: position.x + WORLD.resourceBuildRange - 1, y: position.y }).efficiency;
      const invalid = extractionAtPosition(state, buildingType, { x: position.x + WORLD.resourceBuildRange + 1, y: position.y }).efficiency;
      expect(optimal).toBeGreaterThan(medium);
      expect(medium).toBeGreaterThan(poor);
      expect(poor).toBeGreaterThan(0);
      expect(invalid).toBe(0);
      const mediumPreview = validateBuildingPlacement(state, buildingType, { x: position.x + 74, y: position.y });
      const poorPreview = validateBuildingPlacement(state, buildingType, { x: position.x + WORLD.resourceBuildRange - 1, y: position.y });
      const invalidPreview = validateBuildingPlacement(state, buildingType, { x: position.x + WORLD.resourceBuildRange + 1, y: position.y });
      expect(mediumPreview.extractionEfficiency).toBeCloseTo(medium, 6);
      expect(poorPreview.extractionEfficiency).toBeCloseTo(poor, 6);
      expect(poorPreview.valid).toBe(true);
      expect(invalidPreview.extractionEfficiency).toBe(0);
      expect(invalidPreview.valid).toBe(false);
      const preview = validateBuildingPlacement(state, buildingType, position);
      expect(preview.valid).toBe(true);
      const buildingId = constructBuilding(state, buildingType, position);
      expect(buildingId).not.toBeNull();
      const building = buildingId ? state.buildings.get(buildingId) : undefined;
      expect(building?.extractionEfficiency).toBeCloseTo(preview.extractionEfficiency, 6);
      expect(building ? actualProductionPerSecond(building) : 0).toBeCloseTo(preview.actualProductionPerSecond, 6);
    }
  });
});

describe('Depot capacity, destination reservations, and production routing', () => {
  it('conserves resources through physical building construction, production, reservations, transit, and storage', () => {
    const state = stateWithCenters();
    const anchor = addNode(state, 'player', { x: 390, y: 300 });
    addSegment(state, 'player', state.centerNode.player, anchor.id, 'wood');
    recomputeConnectivity(state);
    const buildingId = constructBuilding(state, 'house', { x: 420, y: 320 });
    expect(buildingId).not.toBeNull();
    expect(advanceUntil(state, () => Boolean(buildingId && state.buildings.get(buildingId)?.constructionComplete), 6000)).toBe(true);
    advanceTicks(state, 1200, true);
    for (const resource of RESOURCE_ORDER) expect(Math.abs(resourceConservationDelta(state, resource))).toBeLessThan(0.0001);
  });

  it('never overbooks or overfills shared Depot capacity and releases capacity after outbound dispatch', () => {
    const state = stateWithCenters();
    const { storage } = connectedDepot(state, { x: 300, y: 100 });
    clearPlayerStorage(state);
    expect(reserveIncomingCapacity(storage, 60)).toBe(true);
    expect(reserveIncomingCapacity(storage, 41)).toBe(false);
    expect(availableStorageCapacity(storage)).toBeCloseTo(DEPOT.maxStorage - 60);
    expect(depositResource(state, storage, 'wood', 60, 60)).toBe(60);
    expect(storage.incomingReservedCapacity).toBe(0);
    expect(depositResource(state, storage, 'stone', 80)).toBe(40);
    expect(storedAmount(storage)).toBe(DEPOT.maxStorage);
    expect(depositResource(state, storage, 'iron', 1)).toBe(0);
    storage.dispatchBudget = STORAGE.packetUnitSize;
    expect(requestManualTransfer(state, storage.id, playerCenterStorage(state).id, 'wood', STORAGE.packetUnitSize)).not.toBeNull();
    state.tick += 1;
    updateLogistics(state, 0);
    expect(storedAmount(storage)).toBe(DEPOT.maxStorage - STORAGE.packetUnitSize);
    expect(availableStorageCapacity(storage)).toBeCloseTo(STORAGE.packetUnitSize);
    releaseIncomingCapacity(storage, 999);
    expect(storage.incomingReservedCapacity).toBe(0);
  });

  it('chooses the best actual route, falls through full Depots, and lets an explicit destination override automatic choice', () => {
    const state = stateWithCenters();
    const producerNode = addNode(state, 'player', { x: 500, y: 100 }, 'building');
    addSegment(state, 'player', state.centerNode.player, producerNode.id, 'wood');
    const resource = addResourceNode(state, 'wood', producerNode.position, 500, 35);
    const producer = addBuilding(state, 'player', 'woodCamp', producerNode.position, producerNode.id, resource.id);
    const farByGeometry = connectedDepot(state, { x: 270, y: 100 }).storage;
    const detour = addNode(state, 'player', { x: 100, y: 700 });
    addSegment(state, 'player', state.centerNode.player, detour.id, 'wood');
    const closeNode = addNode(state, 'player', { x: 530, y: 100 }, 'building');
    addSegment(state, 'player', detour.id, closeNode.id, 'wood');
    addBuilding(state, 'player', 'depot', closeNode.position, closeNode.id);
    recomputeConnectivity(state);
    const closeByGeometry = storageAtNode(state, closeNode.id)!;
    producer.productionAccumulator = STORAGE.packetUnitSize;
    producer.productionTimer = 0;
    updateProduction(state, 0);
    const automatic = [...state.packets.values()].at(-1)!;
    expect(automatic.targetStorageId).toBe(farByGeometry.id);
    state.packets.delete(automatic.id);
    releaseIncomingCapacity(farByGeometry, automatic.incomingCapacityReservation);
    farByGeometry.inventory.wood = DEPOT.maxStorage;
    producer.productionAccumulator = STORAGE.packetUnitSize;
    producer.productionTimer = 0;
    updateProduction(state, 0);
    const nextAvailable = [...state.packets.values()].at(-1)!;
    expect(nextAvailable.targetStorageId).toBe(closeByGeometry.id);
    state.packets.delete(nextAvailable.id);
    releaseIncomingCapacity(closeByGeometry, nextAvailable.incomingCapacityReservation);
    expect(setProductionDestination(state, producer.id, closeByGeometry.id)).toBe(true);
    producer.productionAccumulator = STORAGE.packetUnitSize;
    producer.productionTimer = 0;
    updateProduction(state, 0);
    const explicit = [...state.packets.values()].at(-1)!;
    expect(explicit.targetStorageId).toBe(closeByGeometry.id);
    state.packets.delete(explicit.id);
    releaseIncomingCapacity(closeByGeometry, explicit.incomingCapacityReservation);
    setProductionDestination(state, producer.id, undefined);
    closeByGeometry.inventory.wood = DEPOT.maxStorage;
    producer.productionAccumulator = STORAGE.packetUnitSize;
    producer.productionTimer = 0;
    updateProduction(state, 0);
    expect([...state.packets.values()].at(-1)?.targetStorageId).toBe(playerCenterStorage(state).id);
  });
});

describe('independent high-capacity Depot intake', () => {
  it('accepts several inbound Lines under a fixed ingress cap while outbound dispatch continues', () => {
    const state = stateWithCenters();
    clearPlayerStorage(state);
    grant(state, { manpower: 100, wood: 20 });
    const hub = connectedDepot(state, { x: 420, y: 100 });
    const depot = hub.storage;
    depot.inventory.wood = 20;
    const sources = [{ x: 420, y: 0 }, { x: 520, y: 100 }, { x: 420, y: 200 }].map((position) => {
      const node = addNode(state, 'player', position);
      addSegment(state, 'player', node.id, state.nodes.get(depot.nodeId)!.id, 'stone');
      return node;
    });
    recomputeConnectivity(state);
    expect([...state.segments.values()].filter((segment) => segment.a === depot.nodeId || segment.b === depot.nodeId).length).toBeGreaterThanOrEqual(4);
    for (const [index, source] of sources.entries()) {
      const packet = createPacket(state, 'player', index === 0 ? 'stone' : index === 1 ? 'coal' : 'iron', 10, source.id, depot.nodeId, 'income', undefined, 'producer', undefined, depot.id)!;
      packet.progress = 0.98;
    }
    const center = playerCenterStorage(state);
    const centerBefore = center.inventory.wood;
    depot.dispatchBudget = STORAGE.packetUnitSize;
    expect(requestManualTransfer(state, depot.id, center.id, 'wood', 10)).not.toBeNull();
    advanceTicks(state, Math.ceil(6 / WORLD.fixedStep));
    const inbound = depot.inventory.stone + depot.inventory.coal + depot.inventory.iron;
    expect(inbound).toBeGreaterThan(0);
    expect(inbound).toBeLessThanOrEqual(DEPOT.maxInboundUnitsPerSecond + 0.001);
    expect(center.inventory.wood).toBeGreaterThan(centerBefore);
    expect(storedAmount(depot)).toBeLessThanOrEqual(DEPOT.maxStorage + 0.0001);
    expect(depot.inboundRate).toBe(DEPOT.maxInboundUnitsPerSecond);
    expect(depot.outboundRate).toBe(DEPOT.maxOutboundUnitsPerSecond);
  });
});

describe('deterministic marginal multi-Depot allocation', () => {
  it('physically supplies an ordinary building from multiple Depots before activating it', () => {
    const state = stateWithCenters();
    clearPlayerStorage(state);
    grant(state, { manpower: 500 });
    const first = connectedDepot(state, { x: 230, y: 60 }).storage;
    const second = connectedDepot(state, { x: 230, y: 140 }).storage;
    for (const storage of [first, second]) {
      storage.inventory.wood = 50;
      storage.dispatchBudget = 0;
    }
    const anchor = addNode(state, 'player', { x: 390, y: 300 });
    addSegment(state, 'player', state.centerNode.player, anchor.id, 'wood');
    recomputeConnectivity(state);
    refreshEconomyStock(state, 'player');
    const buildingId = constructBuilding(state, 'house', { x: 420, y: 320 });
    expect(buildingId).not.toBeNull();
    const building = buildingId ? state.buildings.get(buildingId) : undefined;
    expect(building?.constructionComplete).toBe(false);
    const service = [...state.segments.values()].find((segment) => segment.service && segment.b === building?.nodeId)!;
    updateConstruction(state, WORLD.fixedStep);
    expect(service.frontierCell).toBe(0);
    state.tick += 1;
    updateLogistics(state, 0);
    expect(new Set([...state.supplyReservations.values()].map((reservation) => reservation.storageId)).size).toBeGreaterThanOrEqual(2);
    for (const storage of [first, second]) storage.dispatchBudget = storage.outboundRate;
    expect(advanceUntil(state, () => Boolean(building?.constructionComplete), 2200)).toBe(true);
    expect(service.constructionState).toBe('complete');
    expect(building?.connected).toBe(true);
  });

  it('combines enabled Depots per resource, reserves real stock, and excludes a disabled Depot from automatic supply', () => {
    const state = stateWithCenters();
    clearPlayerStorage(state);
    grant(state, { manpower: 500 });
    const first = connectedDepot(state, { x: 240, y: 60 }).storage;
    const second = connectedDepot(state, { x: 240, y: 140 }).storage;
    first.inventory.wood = 30;
    second.inventory.wood = 30;
    first.dispatchBudget = 0;
    second.dispatchBudget = 0;
    refreshEconomyStock(state, 'player');
    arrowFromCenter(state, 620);
    state.tick += 1;
    updateLogistics(state, 0);
    const contributors = new Set([...state.supplyReservations.values()].map((reservation) => reservation.storageId));
    expect(contributors.size).toBeGreaterThanOrEqual(1);
    const reservedBefore = first.reserved.wood + second.reserved.wood;
    expect(reservedBefore).toBeGreaterThan(0);
    expect(state.economy.player.stock.manpower).toBe(500);
    expect(setDepotAutoSupply(state, first.id, false)).toBe(true);
    state.tick += 1;
    updateLogistics(state, WORLD.fixedStep);
    expect([...state.supplyReservations.values()].some((reservation) => reservation.storageId === first.id)).toBe(false);
    expect(first.reserved.wood).toBe(0);
    first.dispatchBudget = STORAGE.packetUnitSize;
    expect(requestManualTransfer(state, first.id, playerCenterStorage(state).id, 'wood', STORAGE.packetUnitSize)).not.toBeNull();
    state.tick += 1;
    updateLogistics(state, WORLD.fixedStep);
    expect([...state.packets.values()].some((packet) => packet.originStorageId === first.id && packet.purpose === 'transfer')).toBe(true);
  });

  it('uses stocked Depots independently for different resources and supplements the fastest insufficient origin', () => {
    const state = stateWithCenters();
    clearPlayerStorage(state);
    grant(state, { manpower: 500 });
    state.economy.player.discovered = new Set<Resource>(RESOURCE_ORDER);
    const nearIron = connectedDepot(state, { x: 140, y: 70 }).storage;
    const coalDepot = connectedDepot(state, { x: 230, y: 130 }).storage;
    const supplement = connectedDepot(state, { x: 700, y: 100 }, state.centerNode.player, 'iron', 3).storage;
    nearIron.inventory.iron = 1;
    supplement.inventory.iron = 30;
    coalDepot.inventory.coal = 30;
    for (const storage of [nearIron, coalDepot, supplement]) storage.dispatchBudget = 0;
    refreshEconomyStock(state, 'player');
    const ironTarget = addNode(state, 'player', { x: 600, y: 360 });
    addSegment(state, 'player', state.centerNode.player, ironTarget.id, 'iron', { constructionState: 'building', buildProgress: 0 });
    state.tick += 1;
    updateLogistics(state, WORLD.fixedStep);
    const reservations = [...state.supplyReservations.values()];
    expect(reservations.some((reservation) => reservation.resource === 'iron' && reservation.storageId === nearIron.id)).toBe(true);
    expect(reservations.some((reservation) => reservation.resource === 'iron' && reservation.storageId === supplement.id)).toBe(true);
    expect(reservations.filter((reservation) => reservation.resource === 'coal').every((reservation) => reservation.storageId === coalDepot.id)).toBe(true);
    expect(reservations.some((reservation) => (reservation.resource as string) === 'manpower')).toBe(false);
    expect(reservations.reduce((sum, reservation) => sum + reservation.amount, 0)).toBeGreaterThan(0);
  });

  it('can prefer a farther stacked corridor over a nearby congested route without brute-force combinations', () => {
    const state = stateWithCenters();
    clearPlayerStorage(state);
    grant(state, { manpower: 500 });
    const near = connectedDepot(state, { x: 240, y: 100 });
    const far = connectedDepot(state, { x: 480, y: 100 }, state.centerNode.player, 'iron', 3);
    for (const storage of [near.storage, far.storage]) {
      storage.inventory.wood = 30;
      storage.dispatchBudget = 0;
    }
    near.line.trafficAB.load = effectiveDirectionalCapacity(state, near.line) * 3;
    near.line.trafficAB.loadRatio = 3;
    near.line.trafficAB.state = 'heavy';
    near.line.congestion = 3;
    near.line.congested = true;
    const attackTarget = addNode(state, 'player', { x: 700, y: 360 });
    addSegment(state, 'player', state.centerNode.player, attackTarget.id, 'wood', { constructionState: 'building', buildProgress: 0 });
    state.tick += 1;
    updateLogistics(state, WORLD.fixedStep);
    expect([...state.supplyReservations.values()].some((reservation) => reservation.storageId === far.storage.id)).toBe(true);
  });
});

describe('physical redirection, circulation, and packet click-through', () => {
  it('returns redirected construction cargo along its Arrow and releases its supply commitment', () => {
    const state = stateWithCenters();
    clearPlayerStorage(state);
    const arrow = arrowFromCenter(state, 500);
    const cells = cellsOf(state, arrow);
    for (const cell of cells.slice(0, 2)) {
      cell.state = 'intact'; cell.health = cell.maxHealth; cell.constructionProgress = 1; cell.connected = true;
    }
    arrow.frontierCell = 2;
    const target = cells[2]!;
    const packet = createPacket(state, 'player', 'wood', 1, arrow.a, arrow.a, 'construction', arrow.id, 'center', target.id)!;
    target.constructionInTransit.wood = 1;
    expect(advanceUntil(state, () => packet.traversingArrow && packet.arrowCellIndex === 1 && packet.arrowCellProgress > 0.3, 300)).toBe(true);
    const position = { ...packet.position };
    expect(redirectPacket(state, packet.id, state.centerNode.player, 'destination')).toBe(true);
    expect(packet.position).toEqual(position);
    expect(packet.amount).toBe(1);
    expect(advanceUntil(state, () => !state.packets.has(packet.id), 600)).toBe(true);
    expect(target.constructionInTransit.wood).toBeCloseTo(0);
    expect(playerCenterStorage(state).inventory.wood).toBeCloseTo(1);
    expect(target.constructionSupply.wood ?? 0).toBe(0);
  });

  it('preserves both traffic directions when inserting a stockpile into a busy road', () => {
    const state = stateWithCenters();
    const end = addNode(state, 'player', { x: 500, y: 100 });
    const line = addSegment(state, 'player', state.centerNode.player, end.id, 'stone');
    recomputeConnectivity(state);
    const outbound = createPacket(state, 'player', 'wood', 1, line.a, line.b)!;
    const inbound = createPacket(state, 'player', 'wood', 1, line.b, line.a)!;
    outbound.progress = 0.75; outbound.position = { x: 400, y: 100 };
    inbound.progress = 0.25; inbound.position = { x: 400, y: 100 };
    const split = splitSegment(state, line.id, { x: 300, y: 100 })!;
    expect(split).not.toBeNull();
    expect(outbound.position).toEqual({ x: 400, y: 100 });
    expect(inbound.position).toEqual({ x: 400, y: 100 });
    expect(outbound.progress).toBeCloseTo(0.5);
    expect(inbound.progress).toBeCloseTo(0.5);
    expect(outbound.segmentPath[outbound.edgeIndex]).toBe(split.segmentIds[1]);
    expect(inbound.segmentPath[inbound.edgeIndex]).toBe(split.segmentIds[1]);
    expect(createStockpileAtNode(state, 'player', split.nodeId)).not.toBeNull();
  });

  function loopNetwork(state: GameState): { anchor: string; storage: StorageSite } {
    const a = state.centerNode.player;
    const b = addNode(state, 'player', { x: 300, y: 20 });
    const c = addNode(state, 'player', { x: 500, y: 100 });
    const d = addNode(state, 'player', { x: 300, y: 180 });
    addSegment(state, 'player', a, b.id, 'stone');
    addSegment(state, 'player', b.id, c.id, 'stone');
    addSegment(state, 'player', c.id, d.id, 'stone');
    addSegment(state, 'player', d.id, a, 'stone');
    recomputeConnectivity(state);
    return { anchor: a, storage: playerCenterStorage(state) };
  }

  it('redirects a moving packet in place without changing its quantity or teleporting it', () => {
    const state = stateWithCenters();
    const firstNode = addNode(state, 'player', { x: 400, y: 100 });
    const secondNode = addNode(state, 'player', { x: 400, y: 300 });
    addSegment(state, 'player', state.centerNode.player, firstNode.id, 'wood');
    addSegment(state, 'player', firstNode.id, secondNode.id, 'wood');
    recomputeConnectivity(state);
    const first = createStockpileAtNode(state, 'player', firstNode.id)!;
    const second = createStockpileAtNode(state, 'player', secondNode.id)!;
    const packet = createPacket(state, 'player', 'wood', 2, state.centerNode.player, firstNode.id, 'transfer', undefined, 'center', undefined, first.id, playerCenterStorage(state).id)!;
    packet.progress = 0.35;
    const position = { ...packet.position };
    expect(redirectPacket(state, packet.id, secondNode.id, 'destination')).toBe(true);
    expect(packet.position).toEqual(position);
    expect(packet.amount).toBe(2);
    expect(packet.pendingRedirectNodeId).toBe(secondNode.id);
    expect(advanceUntil(state, () => second.inventory.wood >= 1.999, 1200)).toBe(true);
  });

  it('circulates through repeated loop cycles, waits on a cut, and resumes after repair', () => {
    const state = stateWithCenters();
    const { anchor, storage } = loopNetwork(state);
    expect(findCirculationLoop(state, 'player', anchor)).not.toBeNull();
    expect(requestCirculatingTransfer(state, storage.id, anchor, 'wood', 2)).not.toBeNull();
    expect(advanceUntil(state, () => [...state.packets.values()].some((packet) => packet.routingMode === 'circulate'), 120)).toBe(true);
    const packet = [...state.packets.values()].find((candidate) => candidate.routingMode === 'circulate')!;
    expect(advanceUntil(state, () => packet.circulationCycles >= 2, 1800)).toBe(true);
    const quantity = packet.amount;
    const cycleSegment = state.segments.get(packet.circulationSegmentCycle[1]!)!;
    const broken = cellsOf(state, cycleSegment)[0]!;
    applyDamageToCell(state, broken, 10000, 'enemy');
    const cyclesAtCut = packet.circulationCycles;
    advanceTicks(state, 120);
    expect(state.packets.has(packet.id)).toBe(true);
    expect(packet.amount).toBe(quantity);
    expect(packet.circulationCycles).toBe(cyclesAtCut);
    broken.state = 'intact'; broken.health = broken.maxHealth;
    state.topologyVersion += 1;
    recomputeConnectivity(state);
    expect(advanceUntil(state, () => packet.circulationCycles > cyclesAtCut, 1800)).toBe(true);
  });

  it('lets a nearby construction intercept a circulating commodity exactly once', () => {
    const state = stateWithCenters();
    const { anchor, storage } = loopNetwork(state);
    clearPlayerStorage(state);
    grant(state, { manpower: 100, wood: 1 }, storage);
    expect(requestCirculatingTransfer(state, storage.id, anchor, 'wood', 1)).not.toBeNull();
    expect(advanceUntil(state, () => [...state.packets.values()].some((packet) => packet.routingMode === 'circulate'), 120)).toBe(true);
    const packet = [...state.packets.values()].find((candidate) => candidate.routingMode === 'circulate')!;
    const target = addNode(state, 'player', { x: 700, y: 300 });
    const arrow = addSegment(state, 'player', state.centerNode.player, target.id, 'wood', { constructionState: 'building', buildProgress: 0 });
    state.nextSupplyPlanTick = state.tick;
    updateLogistics(state, 0);
    expect(state.packets.get(packet.id)?.purpose).toBe('construction');
    expect(state.packets.get(packet.id)?.routingMode).toBe('destination');
    expect(state.packets.get(packet.id)?.targetSegmentId).toBe(arrow.id);
    expect([...state.packets.values()].filter((candidate) => candidate.id === packet.id).length).toBe(1);
  });

  it('gives a Line selection priority under dense traffic and lets Y bypass packets completely', () => {
    const state = stateWithCenters();
    const end = addNode(state, 'player', { x: 500, y: 100 });
    const line = addSegment(state, 'player', state.centerNode.player, end.id, 'wood');
    recomputeConnectivity(state);
    const packet = createPacket(state, 'player', 'wood', 2, line.a, line.b)!;
    packet.position = { x: 300, y: 100 };
    const index = new SelectionIndex();
    const normal = index.pick(state, packet.position, 1, false);
    expect(normal.kind).toBe('segment');
    expect(normal.id).toBe(line.id);
    const bypassed = index.pick(state, packet.position, 1, true);
    expect(bypassed.kind).toBe('segment');
    expect(bypassed.id).toBe(line.id);
    expect(state.packets.has(packet.id)).toBe(true);
  });

  it('keeps packet inspection available off-road and explicitly over a road', () => {
    const state = stateWithCenters();
    const end = addNode(state, 'player', { x: 500, y: 100 });
    const line = addSegment(state, 'player', state.centerNode.player, end.id, 'wood');
    recomputeConnectivity(state);
    const packet = createPacket(state, 'player', 'wood', 2, line.a, line.b)!;
    const index = new SelectionIndex();
    packet.position = { x: 300, y: 180 };
    expect(index.pick(state, packet.position, 1).kind).toBe('packet');
    packet.position = { x: 300, y: 100 };
    const explicit = index.pick(state, packet.position, 1, false, true);
    expect(explicit.kind).toBe('packet');
    expect(explicit.id).toBe(packet.id);
  });

  it('keeps an exact broken Line cell selectable with screen-space tolerance', () => {
    const state = stateWithCenters();
    const end = addNode(state, 'player', { x: 500, y: 100 });
    const line = addSegment(state, 'player', state.centerNode.player, end.id, 'stone');
    recomputeConnectivity(state);
    const routeCells = cellsOf(state, line);
    const broken = routeCells[Math.floor(routeCells.length / 2)]!;
    applyDamageToCell(state, broken, 10000, 'enemy');
    const midpoint = { x: (broken.start.x + broken.end.x) / 2, y: (broken.start.y + broken.end.y) / 2 };
    const picked = new SelectionIndex().pick(state, { x: midpoint.x, y: midpoint.y + 8 }, 2.25);
    expect(picked.kind).toBe('segment');
    expect(picked.id).toBe(line.id);
  });
});

describe('directional lanes and independent traffic', () => {
  it('provides exact Wood 1, Stone 2, and Iron 3 lane capacity in each direction', () => {
    const state = stateWithCenters();
    for (const [tier, lanes, y] of [['wood', 1, 80], ['stone', 2, 140], ['iron', 3, 200]] as const) {
      const end = addNode(state, 'player', { x: 500, y });
      const line = addSegment(state, 'player', state.centerNode.player, end.id, tier);
      expect(TIER_BALANCE[tier].lanesPerDirection).toBe(lanes);
      expect(effectiveDirectionalCapacity(state, line)).toBe(lanes);
      expect(line.trafficAB.capacity).toBe(lanes);
      expect(line.trafficBA.capacity).toBe(lanes);
    }
  });

  it('keeps ordinary A→B congestion independent from B→A capacity', () => {
    const state = stateWithCenters();
    const end = addNode(state, 'player', { x: 700, y: 100 });
    const line = addSegment(state, 'player', state.centerNode.player, end.id, 'wood');
    recomputeConnectivity(state);
    const outbound = createPacket(state, 'player', 'wood', 4, line.a, line.b)!;
    const inbound = createPacket(state, 'player', 'stone', 1, line.b, line.a)!;
    outbound.progress = 0.2;
    inbound.progress = 0.2;
    updateLogistics(state, WORLD.fixedStep);
    expect(line.trafficAB.state).toBe('congested');
    expect(line.trafficBA.state).toBe('free');
    expect(line.trafficAB.load).toBeGreaterThan(line.trafficBA.load);
  });

  it('multiplies both directional capacities independently with stack level', () => {
    const state = stateWithCenters();
    const end = addNode(state, 'player', { x: 650, y: 100 });
    const line = addSegment(state, 'player', state.centerNode.player, end.id, 'iron', { stackLevel: 3 });
    updateLogistics(state, WORLD.fixedStep);
    expect(line.trafficAB.capacity).toBe(9);
    expect(line.trafficBA.capacity).toBe(9);
  });
});

describe('stack capacity, loop routing, and real congestion', () => {
  it('scales stack capacity linearly so equal traffic may congest x1 but not x3', () => {
    const state = stateWithCenters();
    const oneEnd = addNode(state, 'player', { x: 800, y: 80 });
    const threeEnd = addNode(state, 'player', { x: 800, y: 220 });
    const one = addSegment(state, 'player', state.centerNode.player, oneEnd.id, 'iron', { stackLevel: 1 });
    const three = addSegment(state, 'player', state.centerNode.player, threeEnd.id, 'iron', { stackLevel: 3 });
    recomputeConnectivity(state);
    expect(effectiveDirectionalCapacity(state, three) / effectiveDirectionalCapacity(state, one)).toBeCloseTo(3);
    const traffic = effectiveDirectionalCapacity(state, one) * STORAGE.packetUnitSize * 1.1;
    const packetOne = createPacket(state, 'player', 'wood', traffic, state.centerNode.player, oneEnd.id)!;
    const packetThree = createPacket(state, 'player', 'wood', traffic, state.centerNode.player, threeEnd.id)!;
    packetOne.progress = 0.2;
    packetThree.progress = 0.2;
    updateLogistics(state, WORLD.fixedStep);
    expect(one.congested).toBe(true);
    expect(three.congested).toBe(false);
  });

  it('distributes packets across parallel loops and charges no extra cost merely for turns', () => {
    const state = stateWithCenters();
    const goal = addNode(state, 'player', { x: 500, y: 100 });
    const top = addNode(state, 'player', { x: 300, y: 0 });
    const bottom = addNode(state, 'player', { x: 300, y: 200 });
    const topFirst = addSegment(state, 'player', state.centerNode.player, top.id, 'wood');
    addSegment(state, 'player', top.id, goal.id, 'wood');
    const bottomFirst = addSegment(state, 'player', state.centerNode.player, bottom.id, 'wood');
    addSegment(state, 'player', bottom.id, goal.id, 'wood');
    const straightLength = 2 * Math.hypot(200, 100);
    const straightGoal = addNode(state, 'player', { x: 100 + straightLength, y: 100 });
    addSegment(state, 'player', state.centerNode.player, straightGoal.id, 'wood');
    recomputeConnectivity(state);
    const curvedCost = findRoute(state, 'player', state.centerNode.player, goal.id)?.cost ?? Infinity;
    const straightCost = findRoute(state, 'player', state.centerNode.player, straightGoal.id)?.cost ?? Infinity;
    expect(curvedCost).toBeCloseTo(straightCost, 6);
    const packets = Array.from({ length: 5 }, () => createPacket(state, 'player', 'wood', STORAGE.packetUnitSize, state.centerNode.player, goal.id)!);
    const firstEdges = new Set(packets.map((packet) => packet.segmentPath[0]));
    expect(firstEdges.has(topFirst.id)).toBe(true);
    expect(firstEdges.has(bottomFirst.id)).toBe(true);
  });

  it('uses the centralized FREE, CONGESTED, HEAVY, and opposite-HEAVY speed priority', () => {
    expect(resolveDirectionalSpeedMultiplier(3, 'free', 'free')).toBe(3);
    expect(resolveDirectionalSpeedMultiplier(3, 'congested', 'free')).toBe(CONGESTION.normalEffectiveMultiplier);
    expect(resolveDirectionalSpeedMultiplier(3, 'heavy', 'free')).toBe(CONGESTION.heavyEffectiveMultiplier);
    expect(resolveDirectionalSpeedMultiplier(3, 'free', 'heavy')).toBeCloseTo(1.5);

    const state = stateWithCenters();
    const end = addNode(state, 'player', { x: 1000, y: 100 });
    const line = addSegment(state, 'player', state.centerNode.player, end.id, 'wood');
    recomputeConnectivity(state);
    const packet = createPacket(state, 'player', 'wood', 1, state.centerNode.player, end.id)!;
    packet.cruiseSpeedMultiplier = 3;
    line.trafficAB.state = 'free'; line.trafficBA.state = 'free';
    packetSpeedOnSegment(state, packet, line, line.a);
    expect(packet.effectiveSpeedMultiplier).toBe(3);
    line.trafficAB.state = 'congested';
    packetSpeedOnSegment(state, packet, line, line.a);
    expect(packet.effectiveSpeedMultiplier).toBe(1);
    line.trafficAB.state = 'heavy';
    packetSpeedOnSegment(state, packet, line, line.a);
    expect(packet.effectiveSpeedMultiplier).toBe(0.25);
    line.trafficAB.state = 'free'; line.trafficBA.state = 'heavy';
    packetSpeedOnSegment(state, packet, line, line.a);
    expect(packet.effectiveSpeedMultiplier).toBeCloseTo(1.5);
    line.trafficBA.state = 'free';
    packetSpeedOnSegment(state, packet, line, line.a);
    expect(packet.effectiveSpeedMultiplier).toBe(3);
  });
});
