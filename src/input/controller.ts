import type { ProceduralAudio, SoundName } from '../audio/audio';
import { BUILDING_BALANCE, WORLD } from '../config/balance';
import { closestPointOnSegment, distance } from '../core/geometry';
import type {
  BuildTool,
  BuildingType,
  ConstructionPreview,
  GameState,
  LineSegment,
  RedirectPreview,
  SettingsData,
  Tier,
  Vec2,
  WallConstructionPreview,
} from '../core/types';
import {
  type AnchorResult,
  constructBuilding,
  constructLine,
  findFriendlyAnchor,
  repairBuilding,
  repairSegment,
  upgradeHouse,
  upgradeSegment,
  validateBuildingPlacement,
  validateLineConstruction,
} from '../systems/construction';
import { isTierUnlocked } from '../systems/economy';
import { addWarning } from '../systems/notifications';
import {
  redirectPacket,
  redirectStorageContents,
  requestManualTransfer,
  setProductionCirculation,
  setProductionDestination,
} from '../systems/logistics';
import { findRecognizedLoop, findRoute, splitSegment } from '../systems/graph';
import { createStockpileAtNode, storageAtNode } from '../systems/storage';
import { SelectionIndex } from '../systems/selection';
import { constructWall, repairWall, snapWallPoint, validateWallPlacement } from '../systems/walls';
import { Camera } from './camera';

export interface InputHooks {
  state: () => GameState;
  tool: () => BuildTool;
  setTool: (tool: BuildTool) => void;
  togglePause: () => void;
  changeSpeed: (direction: number) => void;
  toggleMute: () => void;
  toggleDebug: () => void;
  toggleDebugFlag: (flag: 'connectivity' | 'routes' | 'congestion' | 'spatial') => void;
  toggleTutorial: () => void;
  toggleLogisticsAcceleration: () => void;
  upgradeSelected: () => void;
  onAction: (sound: SoundName) => void;
  settings: () => SettingsData;
}

export interface BuildingGhost {
  type: Exclude<BuildingType, 'center'>;
  position: Vec2;
  valid: boolean;
  reason: string;
  extractionEfficiency: number;
  baseProductionPerSecond: number;
  actualProductionPerSecond: number;
}

export class InputController {
  pointerScreen: Vec2 = { x: 0, y: 0 };
  pointerWorld: Vec2 = { x: 0, y: 0 };
  preview: ConstructionPreview | null = null;
  wallPreview: WallConstructionPreview | null = null;
  buildingGhost: BuildingGhost | null = null;
  redirectPreview: RedirectPreview | null = null;
  hovered = { kind: 'none' } as GameState['selection'];
  bypassPackets = false;
  selectedTier: Tier = 'wood';
  selectionBox: { from: Vec2; to: Vec2 } | null = null;
  private canvas: HTMLCanvasElement;
  private camera: Camera;
  private hooks: InputHooks;
  private audio: ProceduralAudio;
  private selectionIndex = new SelectionIndex();
  private pointerDownScreen: Vec2 | null = null;
  private dragAnchor: AnchorResult | null = null;
  private queuedAnchor: AnchorResult | null = null;
  private wallStartWorld: Vec2 | null = null;
  private panning = false;
  private activePointerId: number | null = null;
  private uiInteractionActive = false;
  private queueOrder = 0;

  constructor(canvas: HTMLCanvasElement, camera: Camera, hooks: InputHooks, audio: ProceduralAudio) {
    this.canvas = canvas;
    this.camera = camera;
    this.hooks = hooks;
    this.audio = audio;
    this.bind();
  }

  reset(): void {
    this.cancelDrag();
    this.preview = null;
    this.buildingGhost = null;
    this.wallPreview = null;
    this.redirectPreview = null;
    this.hovered = { kind: 'none' };
    this.pointerDownScreen = null;
    this.dragAnchor = null;
    this.queuedAnchor = null;
    this.wallStartWorld = null;
    this.queueOrder = 0;
    this.selectedTier = 'wood';
    this.bypassPackets = false;
  }

  update(dt: number): void {
    if (this.queuedAnchor?.nodeId && !this.hooks.state().nodes.has(this.queuedAnchor.nodeId)) {
      this.queuedAnchor = null;
      this.queueOrder = 0;
    }
    this.camera.update(dt, this.hooks.settings().edgeScroll);
  }

  setUIInteractionActive(active: boolean): void {
    this.uiInteractionActive = active;
    if (active) this.cancelDrag();
  }

  cancel(): void {
    this.cancelDrag();
    this.preview = null;
    this.buildingGhost = null;
    this.wallPreview = null;
    this.redirectPreview = null;
    this.queuedAnchor = null;
    this.queueOrder = 0;
    this.hooks.setTool({ kind: 'select' });
  }

  private bind(): void {
    this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.canvas.addEventListener('pointercancel', () => this.cancelDrag());
    this.canvas.addEventListener('lostpointercapture', () => {
      if (this.activePointerId !== null) this.cancelDrag();
    });
    this.canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.cancel();
    });
    this.canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.updatePointer(event);
      this.camera.zoomAt(this.pointerScreen, event.deltaY);
    }, { passive: false });
    window.addEventListener('keydown', (event) => this.onKeyDown(event));
    window.addEventListener('keyup', (event) => {
      this.camera.setKey(event.code, false);
      if (event.code === 'KeyY') this.bypassPackets = false;
    });
    window.addEventListener('blur', () => {
      this.cancelDrag();
      this.bypassPackets = false;
      for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) this.camera.setKey(code, false);
    });
  }

  private updatePointer(event: MouseEvent | PointerEvent | WheelEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointerScreen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    this.pointerWorld = this.camera.screenToWorld(this.pointerScreen);
    this.camera.setPointer(this.pointerScreen);
  }

  private redirectSourceNode(state: GameState): { nodeId: string; position: Vec2 } | null {
    const tool = this.hooks.tool();
    if (tool.kind !== 'redirect') return null;
    if (tool.sourceKind === 'packet') {
      const packet = (tool.sourceIds ?? [tool.sourceId]).map((id) => state.packets.get(id)).find(Boolean);
      if (!packet) return null;
      const nextIndex = packet.progress > 0.0001 ? packet.edgeIndex + 1 : packet.edgeIndex;
      const nodeId = packet.traversingArrow ? packet.targetNode : packet.nodePath[nextIndex] ?? packet.nodePath[packet.edgeIndex] ?? packet.sourceNode;
      return state.nodes.has(nodeId) ? { nodeId, position: { ...packet.position } } : null;
    }
    if (tool.sourceKind === 'storage') {
      const storage = state.storages.get(tool.sourceId);
      const node = storage ? state.nodes.get(storage.nodeId) : undefined;
      return node ? { nodeId: node.id, position: { ...node.position } } : null;
    }
    const building = state.buildings.get(tool.sourceId);
    return building ? { nodeId: building.nodeId, position: { ...building.position } } : null;
  }

  private redirectDestination(
    state: GameState,
    position: Vec2,
    splitLine: boolean,
  ): { nodeId: string; routingMode: 'destination' | 'circulate' } | null {
    const picked = this.selectionIndex.pick(state, position, this.camera.zoom, true);
    let nodeId: string | undefined;
    if (picked.kind === 'storage' && picked.id) nodeId = state.storages.get(picked.id)?.nodeId;
    if (picked.kind === 'building' && picked.id) nodeId = state.buildings.get(picked.id)?.nodeId;
    const nearbyNode = [...state.nodes.values()]
      .filter((node) => node.owner === 'player' && node.connected && distance(node.position, position) <= WORLD.selectionRadius + 10)
      .sort((left, right) => distance(left.position, position) - distance(right.position, position))[0];
    if (!nodeId && nearbyNode) nodeId = nearbyNode.id;
    if (!nodeId && picked.kind === 'segment' && picked.id) {
      const segment = state.segments.get(picked.id);
      const a = segment ? state.nodes.get(segment.a) : undefined;
      const b = segment ? state.nodes.get(segment.b) : undefined;
      if (segment && a && b && segment.owner === 'player' && segment.connected && segment.constructionState === 'complete') {
        if (splitLine) nodeId = splitSegment(state, segment.id, closestPointOnSegment(position, a.position, b.position).point)?.nodeId;
        else nodeId = distance(position, a.position) <= distance(position, b.position) ? a.id : b.id;
      }
    }
    if (!nodeId) return null;
    if (storageAtNode(state, nodeId)) return { nodeId, routingMode: 'destination' };
    const tool = this.hooks.tool();
    if (tool.kind === 'redirect' && tool.sourceIds) {
      if (splitLine && !createStockpileAtNode(state, 'player', nodeId)) return null;
      return { nodeId, routingMode: 'destination' };
    }
    return findRecognizedLoop(state, 'player', nodeId) ? { nodeId, routingMode: 'circulate' } : null;
  }

  private refreshRedirectPreview(): void {
    const state = this.hooks.state();
    const source = this.redirectSourceNode(state);
    const destination = this.redirectDestination(state, this.pointerWorld, false);
    if (!source || !destination) {
      this.redirectPreview = source ? {
        valid: false, reason: 'Choose a connected storage, junction, or completed Line point',
        from: source.position, to: { ...this.pointerWorld }, nodePath: [], routingMode: 'destination',
      } : null;
      return;
    }
    const route = findRoute(state, 'player', source.nodeId, destination.nodeId);
    this.redirectPreview = {
      valid: Boolean(route),
      reason: route ? (destination.routingMode === 'circulate' ? 'Circulate continuously on this loop' : 'Click to redirect; a Line point becomes a stockpile for a group') : 'No valid logistics route',
      from: source.position,
      to: { ...(state.nodes.get(destination.nodeId)?.position ?? this.pointerWorld) },
      nodePath: route?.nodes ?? [],
      routingMode: destination.routingMode,
    };
  }

  private executeRedirect(state: GameState): boolean {
    const tool = this.hooks.tool();
    if (tool.kind !== 'redirect') return false;
    const destination = this.redirectDestination(state, this.pointerWorld, true);
    if (!destination) return false;
    if (tool.sourceKind === 'packet') {
      const ids = tool.sourceIds ?? [tool.sourceId];
      const redirected = ids.filter((id) => redirectPacket(state, id, destination.nodeId, destination.routingMode));
      if (tool.sourceIds) addWarning(state, `${redirected.length} / ${ids.length} packets redirected; unavailable packets keep their orders`, 'info');
      return redirected.length > 0;
    }
    if (tool.sourceKind === 'storage') {
      return redirectStorageContents(state, tool.sourceId, destination.nodeId, destination.routingMode) > 0;
    }
    const building = state.buildings.get(tool.sourceId);
    if (!building) return false;
    const storage = storageAtNode(state, building.nodeId);
    if (storage) return redirectStorageContents(state, storage.id, destination.nodeId, destination.routingMode) > 0;
    return destination.routingMode === 'destination'
      ? Boolean(storageAtNode(state, destination.nodeId) && setProductionDestination(state, building.id, storageAtNode(state, destination.nodeId)?.id))
      : setProductionCirculation(state, building.id, destination.nodeId);
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.uiInteractionActive) return;
    this.updatePointer(event);
    this.audio.unlock();
    if (event.button === 1) {
      event.preventDefault();
      this.panning = true;
      this.activePointerId = event.pointerId;
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    const state = this.hooks.state();
    if (state.phase === 'menu' || state.phase === 'victory' || state.phase === 'defeat' || state.phase === 'paused') return;
    const tool = this.hooks.tool();

    if (tool.kind === 'redirect') {
      if (this.executeRedirect(state)) {
        this.hooks.onAction('build');
        if (!event.shiftKey) this.hooks.setTool({ kind: 'select' });
      } else this.reject('Choose a reachable storage or a junction belonging to a closed loop');
      this.redirectPreview = null;
      return;
    }

    if (tool.kind === 'building') {
      const building = constructBuilding(state, tool.building, this.pointerWorld);
      if (building) {
        state.selection = { kind: 'building', id: building };
        this.hooks.onAction('build');
        if (!event.shiftKey) this.hooks.setTool({ kind: 'select' });
      } else {
        const validation = validateBuildingPlacement(state, tool.building, this.pointerWorld);
        this.reject(validation.reason);
      }
      this.refreshGhost();
      return;
    }

    if (tool.kind === 'wall') {
      this.pointerDownScreen = { ...this.pointerScreen };
      this.wallStartWorld = snapWallPoint(state, 'player', this.pointerWorld).point;
      this.wallPreview = validateWallPlacement(state, this.wallStartWorld, this.pointerWorld);
      this.canvas.setPointerCapture(event.pointerId);
      this.activePointerId = event.pointerId;
      return;
    }

    if (tool.kind === 'transfer') {
      const selection = this.selectionIndex.pick(state, this.pointerWorld, this.camera.zoom, this.bypassPackets);
      const nearbyNode = [...state.nodes.values()]
        .filter((node) => node.owner === 'player' && node.connected && distance(node.position, this.pointerWorld) <= WORLD.selectionRadius + 8)
        .sort((left, right) => distance(left.position, this.pointerWorld) - distance(right.position, this.pointerWorld))[0];
      let targetStorage = nearbyNode ? storageAtNode(state, nearbyNode.id) : undefined;
      if (!targetStorage && nearbyNode && (nearbyNode.kind === 'junction' || nearbyNode.kind === 'stockpile')) {
        targetStorage = createStockpileAtNode(state, 'player', nearbyNode.id) ?? undefined;
      }
      if (!targetStorage && selection.kind === 'storage' && selection.id) targetStorage = state.storages.get(selection.id);
      if (!targetStorage && selection.kind === 'building' && selection.id) {
        const building = state.buildings.get(selection.id);
        if (building) targetStorage = storageAtNode(state, building.nodeId);
      } else if (!targetStorage && selection.kind === 'segment' && selection.id) {
        const segment = state.segments.get(selection.id);
        const a = segment ? state.nodes.get(segment.a)?.position : undefined;
        const b = segment ? state.nodes.get(segment.b)?.position : undefined;
        if (segment && a && b && segment.owner === 'player' && segment.connected && segment.constructionState === 'complete') {
          const split = splitSegment(state, segment.id, closestPointOnSegment(this.pointerWorld, a, b).point);
          if (split) targetStorage = createStockpileAtNode(state, 'player', split.nodeId) ?? undefined;
        }
      }
      const order = targetStorage && targetStorage.id !== tool.sourceStorageId
        ? requestManualTransfer(state, tool.sourceStorageId, targetStorage.id, tool.resource, tool.amount)
        : null;
      if (order && targetStorage) {
        state.selection = { kind: 'storage', id: targetStorage.id };
        this.hooks.onAction('build');
        if (!event.shiftKey) this.hooks.setTool({ kind: 'select' });
      } else this.reject('Choose a different connected Center, Depot, junction, or completed Line point');
      return;
    }

    if (tool.kind === 'repair' || tool.kind === 'upgrade') {
      const selection = this.selectionIndex.pick(state, this.pointerWorld, this.camera.zoom, this.bypassPackets);
      state.selection = selection;
      let success = false;
      if (tool.kind === 'repair') {
        success = selection.kind === 'segment' && selection.id ? repairSegment(state, selection.id) :
          selection.kind === 'building' && selection.id ? repairBuilding(state, selection.id) :
            selection.kind === 'wall' && selection.id ? repairWall(state, selection.id) : false;
      } else {
        success = selection.kind === 'segment' && selection.id ? upgradeSegment(state, selection.id) :
          selection.kind === 'building' && selection.id ? upgradeHouse(state, selection.id) : false;
      }
      if (success) this.hooks.onAction('complete');
      else this.reject(tool.kind === 'repair' ? 'Select a damaged friendly Line, building, or Wall' : 'Upgrade locked, unaffordable, or unavailable');
      if (!event.shiftKey) this.hooks.setTool({ kind: 'select' });
      return;
    }

    if (tool.kind === 'line') this.selectedTier = tool.tier;
    this.pointerDownScreen = { ...this.pointerScreen };
    const screenSpaceAnchorRadius = (WORLD.selectionRadius + 8) / Math.max(0.55, this.camera.zoom);
    this.dragAnchor = this.queuedAnchor ?? findFriendlyAnchor(state, this.pointerWorld, screenSpaceAnchorRadius);
    if (event.altKey || !this.dragAnchor) {
      this.dragAnchor = null;
      this.selectionBox = { from: { ...this.pointerWorld }, to: { ...this.pointerWorld } };
    }
    this.canvas.setPointerCapture(event.pointerId);
    this.activePointerId = event.pointerId;
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.uiInteractionActive) return;
    if (this.activePointerId !== null && event.pointerId !== this.activePointerId) return;
    const previous = { ...this.pointerScreen };
    this.updatePointer(event);
    if (this.panning) {
      this.camera.panByScreen({ x: this.pointerScreen.x - previous.x, y: this.pointerScreen.y - previous.y });
      return;
    }

    if (this.selectionBox) {
      this.selectionBox.to = { ...this.pointerWorld };
      return;
    }

    if (this.pointerDownScreen && this.wallStartWorld && this.hooks.tool().kind === 'wall') {
      this.wallPreview = validateWallPlacement(this.hooks.state(), this.wallStartWorld, this.pointerWorld);
      return;
    }

    if (this.pointerDownScreen && this.dragAnchor) {
      const dragDistance = distance(this.pointerScreen, this.pointerDownScreen);
      if (dragDistance > 5) this.preview = validateLineConstruction(this.hooks.state(), this.dragAnchor, this.pointerWorld, this.selectedTier);
    } else {
      this.refreshGhost();
      if (this.hooks.tool().kind === 'redirect') this.refreshRedirectPreview();
      this.hovered = this.selectionIndex.pick(this.hooks.state(), this.pointerWorld, this.camera.zoom, this.bypassPackets);
    }
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.uiInteractionActive) return;
    if (this.activePointerId === null) return;
    if (this.activePointerId !== null && event.pointerId !== this.activePointerId) return;
    this.updatePointer(event);
    if (event.button === 1) {
      this.panning = false;
      this.activePointerId = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    this.activePointerId = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    const state = this.hooks.state();
    if (this.selectionBox && this.pointerDownScreen && distance(this.pointerScreen, this.pointerDownScreen) > 5) {
      const ids = this.selectionIndex.pickPacketsInArea(state, this.selectionBox.from, this.pointerWorld, this.bypassPackets);
      state.selection = ids.length ? { kind: 'packets', ids } : { kind: 'none' };
      if (ids.length) this.hooks.onAction('select');
      this.cancelDrag();
      return;
    }
    this.selectionBox = null;
    if (this.wallStartWorld && this.hooks.tool().kind === 'wall') {
      const preview = validateWallPlacement(state, this.wallStartWorld, this.pointerWorld);
      const wall = constructWall(state, this.wallStartWorld, this.pointerWorld);
      if (wall) {
        state.selection = { kind: 'wall', id: wall.id };
        this.hooks.onAction('build');
        if (!event.shiftKey) this.hooks.setTool({ kind: 'select' });
      } else {
        this.reject(preview.reason);
      }
      this.pointerDownScreen = null;
      this.wallStartWorld = null;
      this.wallPreview = null;
      return;
    }
    const wasDrag = Boolean(this.pointerDownScreen && distance(this.pointerScreen, this.pointerDownScreen) > 5 && this.dragAnchor);
    if (wasDrag && this.dragAnchor) {
      const order = event.shiftKey ? ++this.queueOrder : 0;
      const segment = constructLine(state, this.dragAnchor, this.pointerWorld, this.selectedTier, order);
      if (segment) {
        state.selection = { kind: 'segment', id: segment.id };
        this.hooks.onAction('build');
        this.setQueuedAnchor(state, segment, event.shiftKey);
      } else {
        this.reject(this.preview?.reason ?? 'Invalid construction');
        if (!event.shiftKey) this.queuedAnchor = null;
      }
    } else if (!wasDrag) {
      state.selection = this.selectionIndex.pick(state, this.pointerWorld, this.camera.zoom, this.bypassPackets, event.altKey);
      if (state.selection.kind !== 'none') this.hooks.onAction('select');
      this.queuedAnchor = null;
    }
    this.pointerDownScreen = null;
    this.dragAnchor = null;
    this.preview = null;
    this.wallPreview = null;
    this.activePointerId = null;
    this.refreshGhost();
  }

  private setQueuedAnchor(state: GameState, segment: LineSegment, queued: boolean): void {
    if (!queued) {
      this.queuedAnchor = null;
      this.queueOrder = 0;
      return;
    }
    const node = state.nodes.get(segment.b);
    this.queuedAnchor = node ? { nodeId: node.id, point: { ...node.position }, distance: 0 } : null;
    this.hooks.setTool({ kind: 'line', tier: this.selectedTier });
  }

  private refreshGhost(): void {
    const tool = this.hooks.tool();
    if (tool.kind !== 'building') {
      this.buildingGhost = null;
      return;
    }
    const validation = validateBuildingPlacement(this.hooks.state(), tool.building, this.pointerWorld);
    this.buildingGhost = {
      type: tool.building, position: { ...this.pointerWorld }, valid: validation.valid, reason: validation.reason,
      extractionEfficiency: validation.extractionEfficiency,
      baseProductionPerSecond: validation.baseProductionPerSecond,
      actualProductionPerSecond: validation.actualProductionPerSecond,
    };
  }

  private reject(reason: string): void {
    addWarning(this.hooks.state(), reason || 'Invalid construction', 'danger');
    this.hooks.onAction('error');
  }

  private cancelDrag(): void {
    this.selectionBox = null;
    const pointerId = this.activePointerId;
    this.activePointerId = null;
    if (pointerId !== null && this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
    this.panning = false;
    this.pointerDownScreen = null;
    this.dragAnchor = null;
    this.preview = null;
    this.wallPreview = null;
    this.wallStartWorld = null;
  }

  private selectTier(tier: Tier): void {
    const state = this.hooks.state();
    if (!isTierUnlocked(state, 'player', tier)) {
      this.reject(`${tier.toUpperCase()} Line is not unlocked`);
      return;
    }
    this.selectedTier = tier;
    this.hooks.setTool({ kind: 'line', tier });
  }

  private selectBuilding(type: Exclude<BuildingType, 'center'>): void {
    this.hooks.setTool({ kind: 'building', building: type });
    this.buildingGhost = {
      type,
      position: { ...this.pointerWorld },
      valid: false,
      reason: `Place ${BUILDING_BALANCE[type].label}`,
      extractionEfficiency: 0,
      baseProductionPerSecond: 0,
      actualProductionPerSecond: 0,
    };
  }

  private startRedirectSelected(): void {
    const state = this.hooks.state();
    const selection = state.selection;
    if (selection.kind === 'packets') {
      const ids = (selection.ids ?? []).filter((id) => state.packets.has(id));
      if (ids.length) this.hooks.setTool({ kind: 'redirect', sourceKind: 'packet', sourceId: ids[0]!, sourceIds: ids });
      else this.reject('Selected packets have already arrived; select another group');
    } else if (selection.kind === 'packet' && selection.id && state.packets.has(selection.id)) {
      this.hooks.setTool({ kind: 'redirect', sourceKind: 'packet', sourceId: selection.id });
    } else if (selection.kind === 'storage' && selection.id && state.storages.has(selection.id)) {
      this.hooks.setTool({ kind: 'redirect', sourceKind: 'storage', sourceId: selection.id });
    } else if (selection.kind === 'building' && selection.id) {
      const building = state.buildings.get(selection.id);
      const production = building ? BUILDING_BALANCE[building.type].productionResource : undefined;
      if (building && (storageAtNode(state, building.nodeId) || (production && production !== 'manpower'))) {
        this.hooks.setTool({ kind: 'redirect', sourceKind: 'building', sourceId: building.id });
      } else this.reject('Select a commodity producer, Center, Depot, stockpile, or movable commodity packet');
    } else this.reject('Select a commodity producer, Center, Depot, stockpile, or movable commodity packet');
    this.refreshRedirectPreview();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.hooks.state().phase === 'menu') return;
    if (event.repeat && !['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) return;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) {
      this.camera.setKey(event.code, true);
    }
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.code === 'KeyY') {
      this.bypassPackets = true;
      return;
    }
    if (event.shiftKey && this.hooks.state().debug.enabled) {
      const debugKey: Partial<Record<string, 'connectivity' | 'routes' | 'congestion' | 'spatial'>> = {
        KeyC: 'connectivity', KeyV: 'routes', KeyG: 'congestion', KeyX: 'spatial',
      };
      const flag = debugKey[event.code];
      if (flag) {
        event.preventDefault();
        this.hooks.toggleDebugFlag(flag);
        return;
      }
    }
    switch (event.code) {
      case 'Digit1': this.selectTier('wood'); break;
      case 'Digit2': this.selectTier('stone'); break;
      case 'Digit3': this.selectTier('iron'); break;
      case 'KeyH': this.selectBuilding('house'); break;
      case 'KeyC': this.selectBuilding('woodCamp'); break;
      case 'KeyQ': this.selectBuilding('quarry'); break;
      case 'KeyO': this.selectBuilding('coalMine'); break;
      case 'KeyI': this.selectBuilding('ironMine'); break;
      case 'KeyB': this.selectBuilding('depot'); break;
      case 'KeyF': this.hooks.setTool({ kind: 'wall' }); break;
      case 'KeyR': this.hooks.setTool({ kind: 'repair' }); break;
      case 'KeyU': this.hooks.upgradeSelected(); break;
      case 'KeyT': {
        const state = this.hooks.state();
        const selection = state.selection;
        const building = selection.kind === 'building' && selection.id ? state.buildings.get(selection.id) : undefined;
        const storage = selection.kind === 'storage' && selection.id ? state.storages.get(selection.id) : building ? storageAtNode(state, building.nodeId) : undefined;
        if (storage) {
          const resource = (['wood', 'stone', 'coal', 'iron'] as const).find((candidate) => storage.inventory[candidate] > 0) ?? 'wood';
          this.hooks.setTool({ kind: 'transfer', sourceStorageId: storage.id, resource, amount: 10 });
        } else this.reject('Select a Center, Depot, or stockpile before starting a transfer');
        break;
      }
      case 'KeyG': this.startRedirectSelected(); break;
      case 'KeyL': this.hooks.toggleLogisticsAcceleration(); break;
      case 'Space': event.preventDefault(); this.hooks.togglePause(); break;
      case 'Equal': case 'NumpadAdd': this.hooks.changeSpeed(1); break;
      case 'Minus': case 'NumpadSubtract': this.hooks.changeSpeed(-1); break;
      case 'KeyM': this.hooks.toggleMute(); break;
      case 'F1': event.preventDefault(); this.hooks.toggleTutorial(); break;
      case 'F3': event.preventDefault(); this.hooks.toggleDebug(); break;
      case 'Escape':
        if (this.hooks.state().phase === 'menu') return;
        if (this.hooks.tool().kind !== 'select' || this.pointerDownScreen || this.preview || this.wallPreview || this.queuedAnchor) this.cancel();
        else this.hooks.togglePause();
        break;
      default: break;
    }
  }
}
