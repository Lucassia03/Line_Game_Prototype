import { BUILDING_BALANCE, COLORS, COMMODITY_ORDER, DEPOT, LOGISTICS_ACCELERATION, RESOURCE_ORDER, TIER_BALANCE, UPGRADE_COSTS, WORLD } from '../config/balance';
import { formatNumber } from '../core/geometry';
import type { BuildTool, BuildingType, CommodityResource, GameState, Resource, SettingsData, Tier, Vec2 } from '../core/types';
import { buildingCost, calculateLineCost, formatCost, hasResources, isBuildingUnlocked, isTierUnlocked } from '../systems/economy';
import { isWallUnlocked, stoneWallCostPer100 } from '../systems/walls';
import { cellsOf, constructionSupplyProgress, costAmount, firstArrowGap, hasCost } from '../systems/cells';
import { actualProductionPerSecond, baseProductionPerSecond } from '../systems/extraction';
import { effectiveDirectionalCapacity } from '../systems/graph';
import { availableInventory, reservedAmount, storageAtNode, storedAmount } from '../systems/storage';
import type { Tutorial } from './tutorial';
import { dispatchImmediateUICommand, MIN_CONTROL_TARGET_CSS_PX } from './commands';
import { claimUIControlPointer, UIInteractionGuard } from './interaction';
import { findRecognizedLoop } from '../systems/graph';

interface UIHooks {
  state: () => GameState;
  tool: () => BuildTool;
  setTool: (tool: BuildTool) => void;
  togglePause: () => void;
  setSpeed: (speed: number) => void;
  restart: () => void;
  startGame: (mode: 'new-game' | 'debug') => void;
  toggleMute: () => void;
  updateSettings: (patch: Partial<SettingsData>) => void;
  toggleTutorial: () => void;
  tutorialNext: () => void;
  tutorialPrevious: () => void;
  tutorialSkip: () => void;
  repairSelected: () => void;
  upgradeSelected: () => void;
  focusWorld: (position: Vec2) => void;
  toggleDebug: () => void;
  toggleDebugFlag: (flag: 'connectivity' | 'routes' | 'congestion' | 'spatial') => void;
  toggleLogisticsAcceleration: () => void;
  toggleDepotAutoSupply: (storageId: string) => void;
  setProductionDestination: (buildingId: string, storageId?: string) => boolean;
  setUIInteractionActive: (active: boolean) => void;
}

interface ActionDescriptor {
  id: string;
  group: 'line' | 'building' | 'tool';
  icon: string;
  name: string;
  key: string;
  tip: string;
  tier?: Tier;
  building?: Exclude<BuildingType, 'center'>;
  tool?: 'wall' | 'repair' | 'upgrade' | 'acceleration';
}

const ACTIONS: ActionDescriptor[] = [
  { id: 'line-wood', group: 'line', icon: '➤', name: 'Wood', key: '1', tip: 'Fast persistent Arrow; 35 damage per assault bundle. Wood Lines cannot stack.', tier: 'wood' },
  { id: 'line-stone', group: 'line', icon: '➤', name: 'Stone', key: '2', tip: 'Medium persistent Arrow; 80 damage per bundle. Same-material stacking is limited to x2.', tier: 'stone' },
  { id: 'line-iron', group: 'line', icon: '➤', name: 'Iron', key: '3', tip: 'Slow persistent Arrow; 180 damage per supply, 2× against Walls, and repeatable same-material stacking.', tier: 'iron' },
  { id: 'build-house', group: 'building', icon: '⌂', name: 'House', key: 'H', tip: 'Adds Manpower directly to the workforce pool and raises its connected capacity. Manpower is never shipped.', building: 'house' },
  { id: 'build-wood', group: 'building', icon: '♜', name: 'Camp', key: 'C', tip: 'Placement overlap determines output. Small Wood packets prefer the best reachable Depot.', building: 'woodCamp' },
  { id: 'build-stone', group: 'building', icon: '◆', name: 'Quarry', key: 'Q', tip: 'Place beside Stone. Requires Wood and Manpower.', building: 'quarry' },
  { id: 'build-coal', group: 'building', icon: '●', name: 'Coal', key: 'O', tip: 'Place beside Coal. Requires Wood and Manpower.', building: 'coalMine' },
  { id: 'build-iron', group: 'building', icon: '⬢', name: 'Iron', key: 'I', tip: 'Late-game mine requiring Wood, Stone, Coal, and Manpower.', building: 'ironMine' },
  { id: 'build-depot', group: 'building', icon: '⊞', name: 'Depot', key: 'B', tip: 'Real forward inventory with a fixed outbound dispatch rate.', building: 'depot' },
  { id: 'build-wall', group: 'tool', icon: '▰', name: 'Wall', key: 'F', tip: 'Drag a passive 300 HP Stone Wall anywhere physically valid. Weak to Iron.', tool: 'wall' },
  { id: 'tool-repair', group: 'tool', icon: '⌁', name: 'Repair', key: 'R', tip: 'Request visible repair/rebuild packets for damaged Line cells.', tool: 'repair' },
  { id: 'tool-upgrade', group: 'tool', icon: '⇧', name: 'Upgrade', key: 'U', tip: 'Upgrade the currently selected valid Line or House immediately.', tool: 'upgrade' },
  { id: 'tool-acceleration', group: 'tool', icon: '»', name: 'Boost', key: 'L', tip: `Spend ${LOGISTICS_ACCELERATION.manpowerCostPerPacket} workforce per dispatched packet for persistent ${LOGISTICS_ACCELERATION.speedMultiplier}× cruise speed.`, tool: 'acceleration' },
];

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element #${id}`);
  return element as T;
}

export class UI {
  private hooks: UIHooks;
  private tutorialModel: Tutorial;
  private settings: SettingsData;
  private resourceBar = requiredElement<HTMLDivElement>('resource-bar');
  private timeControls = requiredElement<HTMLDivElement>('time-controls');
  private objectPanel = requiredElement<HTMLElement>('object-panel');
  private objectivesPanel = requiredElement<HTMLElement>('objectives-panel');
  private warnings = requiredElement<HTMLDivElement>('warning-stack');
  private tutorial = requiredElement<HTMLDivElement>('tutorial');
  private actionbar = requiredElement<HTMLDivElement>('actionbar');
  private tooltip = requiredElement<HTMLDivElement>('tooltip');
  private modalRoot = requiredElement<HTMLDivElement>('modal-root');
  private debugPanel = requiredElement<HTMLDivElement>('debug-panel');
  private minimap = requiredElement<HTMLCanvasElement>('minimap');
  private hud = requiredElement<HTMLDivElement>('hud');
  private previousStock = new Map<Resource, number>();
  private modalMode = '';
  private timeSignature = '';
  private panelPointerActive = false;
  private uiInteraction = new UIInteractionGuard();

  constructor(hooks: UIHooks, tutorial: Tutorial, settings: SettingsData) {
    this.hooks = hooks;
    this.tutorialModel = tutorial;
    this.settings = settings;
    this.hud.style.setProperty('--control-target', `${MIN_CONTROL_TARGET_CSS_PX}px`);
    this.buildResources();
    this.buildActions();
    this.bind();
  }

  setSettings(settings: SettingsData): void {
    this.settings = settings;
  }

  update(): void {
    const state = this.hooks.state();
    this.updateResources(state);
    // Never replace a pressed control between pointer-down and the browser's
    // subsequent click. Simulation-driven text can wait for pointer-up.
    if (!this.uiInteraction.blocksRefresh) {
      this.updateTimeControls(state);
      this.updateActions(state);
      this.updateSelection(state);
      this.updateTutorial();
      this.updateModal(state);
    }
    this.updateObjectives(state);
    this.updateWarnings(state);
    this.updateDebug(state);
  }

  private buildResources(): void {
    this.resourceBar.innerHTML = RESOURCE_ORDER.map((resource) => (
      `<div class="resource-chip" data-resource="${resource}" style="--resource-color:${COLORS[resource]}">` +
      `<span class="label">${resource === 'manpower' ? 'Manpower' : resource}</span><span class="value">0</span></div>`
    )).join('');
  }

  private buildActions(): void {
    const groups = ['line', 'building', 'tool'] as const;
    this.actionbar.innerHTML = groups.map((group) => (
      `<div class="action-group" data-group="${group}">${ACTIONS.filter((action) => action.group === group).map((action) => {
        const cost = action.tier ? calculateLineCost(action.tier, 100) : action.building ? buildingCost(action.building) : action.tool === 'wall' ? stoneWallCostPer100() : action.tool === 'repair' ? { manpower: 2 } : {};
        const costLabel = `${formatCost(cost)}${action.tool === 'wall' || action.tier ? ' / 100 units' : ''}`;
        return `<button class="action-button" data-action="${action.id}" data-tip="${action.tip}" data-cost="${costLabel}">` +
          `<span class="key">${action.key}</span><span class="icon">${action.icon}</span><span class="name">${action.name}</span></button>`;
      }).join('')}</div>`
    )).join('');
  }

  private bind(): void {
    const interactiveSelector = 'button, select, input, [role="button"], [data-control]';
    this.hud.addEventListener('pointerdown', (event) => {
      const control = (event.target as HTMLElement).closest<HTMLElement>(interactiveSelector);
      if (!control) return;
      claimUIControlPointer(event, this.uiInteraction);
      this.hooks.setUIInteractionActive(true);
      control.classList.add('is-pressed');
      if (control.matches('button, [role="button"]')) control.setPointerCapture?.(event.pointerId);
      if (this.objectPanel.contains(control)) this.panelPointerActive = true;
    });
    const releaseUIInteraction = (pointerId?: number): void => {
      if (pointerId !== undefined && !this.uiInteraction.release(pointerId)) return;
      if (pointerId === undefined) this.uiInteraction.cancel();
      this.panelPointerActive = false;
      this.hooks.setUIInteractionActive(false);
      for (const control of this.hud.querySelectorAll('.is-pressed')) control.classList.remove('is-pressed');
    };
    window.addEventListener('pointerup', (event) => releaseUIInteraction(event.pointerId));
    window.addEventListener('pointercancel', (event) => releaseUIInteraction(event.pointerId));
    window.addEventListener('blur', () => releaseUIInteraction());
    this.hud.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest(interactiveSelector)) event.stopPropagation();
    });
    this.actionbar.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
      const action = ACTIONS.find((candidate) => candidate.id === button?.dataset.action);
      if (!action) return;
      if (action.tier) this.hooks.setTool({ kind: 'line', tier: action.tier });
      else if (action.building) this.hooks.setTool({ kind: 'building', building: action.building });
      else if (action.tool === 'wall') this.hooks.setTool({ kind: 'wall' });
      else if (action.tool === 'repair') this.hooks.setTool({ kind: 'repair' });
      else if (action.tool === 'upgrade') dispatchImmediateUICommand({ kind: 'upgrade' }, this.hooks);
      else if (action.tool === 'acceleration') dispatchImmediateUICommand({ kind: 'acceleration' }, this.hooks);
    });

    this.actionbar.addEventListener('pointerover', (event) => this.showTooltip(event));
    this.actionbar.addEventListener('pointermove', (event) => this.moveTooltip(event));
    this.actionbar.addEventListener('pointerout', (event) => {
      if (!(event.relatedTarget instanceof Node) || !this.actionbar.contains(event.relatedTarget)) this.tooltip.classList.remove('show');
    });

    this.timeControls.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-time]');
      const command = button?.dataset.time;
      if (command === 'pause') this.hooks.togglePause();
      else if (command) this.hooks.setSpeed(Number(command));
    });

    this.objectPanel.addEventListener('click', (event) => {
      const actionButton = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-panel-action]');
      const action = actionButton?.dataset.panelAction;
      if (action === 'redirect-group') {
        const state = this.hooks.state();
        const ids = (state.selection.ids ?? []).filter((id) => state.packets.has(id));
        if (ids.length) this.hooks.setTool({ kind: 'redirect', sourceKind: 'packet', sourceId: ids[0]!, sourceIds: ids });
      }
      if (action === 'repair') this.hooks.repairSelected();
      if (action === 'upgrade') dispatchImmediateUICommand({ kind: 'upgrade' }, this.hooks);
      if (action === 'transfer') {
        const state = this.hooks.state();
        const selection = state.selection;
        const building = selection.kind === 'building' && selection.id ? state.buildings.get(selection.id) : undefined;
        const storage = selection.kind === 'storage' && selection.id ? state.storages.get(selection.id) : building ? storageAtNode(state, building.nodeId) : undefined;
        const resource = this.objectPanel.querySelector<HTMLSelectElement>('[data-transfer-resource]')?.value as CommodityResource | undefined;
        const amount = Number(this.objectPanel.querySelector<HTMLInputElement>('[data-transfer-amount]')?.value ?? 0);
        if (storage && resource && amount > 0) dispatchImmediateUICommand({
          kind: 'transfer', sourceStorageId: storage.id, resource, amount,
        }, this.hooks);
      }
      if (action === 'toggle-auto') {
        const state = this.hooks.state();
        const selection = state.selection;
        const building = selection.kind === 'building' && selection.id ? state.buildings.get(selection.id) : undefined;
        const storage = selection.kind === 'storage' && selection.id ? state.storages.get(selection.id) : building ? storageAtNode(state, building.nodeId) : undefined;
        if (storage?.kind === 'depot') dispatchImmediateUICommand({ kind: 'toggle-auto', storageId: storage.id }, this.hooks);
      }
      if (action === 'production-target') {
        const state = this.hooks.state();
        const building = state.selection.kind === 'building' && state.selection.id ? state.buildings.get(state.selection.id) : undefined;
        const value = this.objectPanel.querySelector<HTMLSelectElement>('[data-production-target]')?.value;
        if (building) this.hooks.setProductionDestination(building.id, value && value !== 'auto' ? value : undefined);
      }
      if (action === 'focus') {
        const state = this.hooks.state();
        const selection = state.selection;
        const position = selection.kind === 'building' && selection.id ? state.buildings.get(selection.id)?.position :
          selection.kind === 'resource' && selection.id ? state.resourceNodes.get(selection.id)?.position : undefined;
        if (position) this.hooks.focusWorld(position);
      }
      if (actionButton) {
        actionButton.blur();
        queueMicrotask(() => this.update());
      }
    });

    this.tutorial.addEventListener('click', (event) => {
      const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tutorial]')?.dataset.tutorial;
      if (action === 'next') this.hooks.tutorialNext();
      if (action === 'previous') this.hooks.tutorialPrevious();
      if (action === 'skip') this.hooks.tutorialSkip();
    });

    this.modalRoot.addEventListener('click', (event) => {
      const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-modal-action]')?.dataset.modalAction;
      if (action === 'new-game') this.hooks.startGame('new-game');
      if (action === 'debug-mode') this.hooks.startGame('debug');
      if (action === 'resume') this.hooks.togglePause();
      if (action === 'restart') this.hooks.restart();
      if (action === 'mute') this.hooks.toggleMute();
      if (action === 'tutorial') this.hooks.toggleTutorial();
      if (action === 'debug') this.hooks.toggleDebug();
      if (action?.startsWith('debug-')) this.hooks.toggleDebugFlag(action.slice(6) as 'connectivity' | 'routes' | 'congestion' | 'spatial');
    });
    this.modalRoot.addEventListener('input', (event) => {
      const input = event.target as HTMLInputElement;
      if (input.dataset.setting === 'volume') this.hooks.updateSettings({ masterVolume: Number(input.value) });
      if (input.dataset.setting === 'edgeScroll') this.hooks.updateSettings({ edgeScroll: input.checked });
      if (input.dataset.setting === 'screenShake') this.hooks.updateSettings({ screenShake: input.checked });
    });

    this.minimap.addEventListener('pointerdown', (event) => {
      const rect = this.minimap.getBoundingClientRect();
      const state = this.hooks.state();
      this.hooks.focusWorld({
        x: ((event.clientX - rect.left) / rect.width) * state.worldSize.x,
        y: ((event.clientY - rect.top) / rect.height) * state.worldSize.y,
      });
    });
  }

  private updateResources(state: GameState): void {
    const economy = state.economy.player;
    for (const resource of RESOURCE_ORDER) {
      const chip = this.resourceBar.querySelector<HTMLElement>(`[data-resource="${resource}"]`);
      const value = chip?.querySelector<HTMLElement>('.value');
      if (!chip || !value) continue;
      value.textContent = resource === 'manpower'
        ? `${formatNumber(economy.stock.manpower)} / ${formatNumber(economy.maxManpower)}`
        : formatNumber(economy.stock[resource]);
      const previous = this.previousStock.get(resource) ?? economy.stock[resource];
      if (economy.stock[resource] > previous + 0.1) {
        chip.classList.remove('bump');
        void chip.offsetWidth;
        chip.classList.add('bump');
      }
      this.previousStock.set(resource, economy.stock[resource]);
    }
  }

  private updateTimeControls(state: GameState): void {
    const signature = `${state.phase}:${state.speed}:${this.settings.muted}`;
    if (signature === this.timeSignature) return;
    this.timeSignature = signature;
    this.timeControls.innerHTML = `<button class="time-button ${state.phase === 'paused' ? 'active' : ''}" data-time="pause" title="Pause [Space]">${state.phase === 'paused' ? '▶' : 'Ⅱ'}</button>` +
      [0.5, 1, 2, 4].map((speed) => `<button class="time-button ${state.speed === speed && state.phase !== 'paused' ? 'active' : ''}" data-time="${speed}">${speed}×</button>`).join('') +
      `<button class="time-button" data-time="mute" title="Mute [M]">${this.settings.muted ? '×' : '♪'}</button>`;
    const mute = this.timeControls.querySelector<HTMLButtonElement>('[data-time="mute"]');
    mute?.addEventListener('click', () => this.hooks.toggleMute(), { once: true });
  }

  private updateActions(state: GameState): void {
    const activeTool = this.hooks.tool();
    for (const descriptor of ACTIONS) {
      const button = this.actionbar.querySelector<HTMLButtonElement>(`[data-action="${descriptor.id}"]`);
      if (!button) continue;
      const unlocked = descriptor.tier ? isTierUnlocked(state, 'player', descriptor.tier) :
        descriptor.building ? isBuildingUnlocked(state, 'player', descriptor.building) : descriptor.tool === 'wall' ? isWallUnlocked(state, 'player') : true;
      const cost = descriptor.tier ? calculateLineCost(descriptor.tier, 100) : descriptor.building ? buildingCost(descriptor.building) : descriptor.tool === 'wall' ? stoneWallCostPer100() : {};
      const affordable = descriptor.tier ? true : hasResources(state, 'player', cost);
      const active = descriptor.tier ? activeTool.kind === 'line' && activeTool.tier === descriptor.tier :
        descriptor.building ? activeTool.kind === 'building' && activeTool.building === descriptor.building :
          descriptor.tool === 'acceleration' ? state.logisticsAcceleration.player : descriptor.tool ? activeTool.kind === descriptor.tool : false;
      button.classList.toggle('locked', !unlocked);
      button.classList.toggle('afford-false', !affordable);
      button.classList.toggle('active', active);
      button.ariaDisabled = String(!unlocked);
      button.disabled = !unlocked;
      button.title = !unlocked ? `${descriptor.name} is locked by the resource hierarchy` : descriptor.tip;
      button.setAttribute('aria-pressed', String(active));
    }
  }

  private updateSelection(state: GameState): void {
    if (this.panelPointerActive || this.objectPanel.contains(document.activeElement)) return;
    const selection = state.selection;
    if (selection.kind === 'packets') {
      const packets = (selection.ids ?? []).map((id) => state.packets.get(id)).filter((packet) => packet !== undefined);
      this.objectPanel.innerHTML = `<div class="panel-kicker">COMMODITY GROUP</div><div class="panel-title">${packets.length} PACKETS</div>` +
        COMMODITY_ORDER.map((resource) => `<div class="stat-row"><span>${resource}</span><b>${packets.filter((p) => p.resource === resource).reduce((sum, p) => sum + p.amount, 0).toFixed(1)}</b></div>`).join('') +
        `<button class="ui-button" data-panel-action="redirect-group" ${packets.length ? '' : 'disabled'}>Redirect group [G]</button><div class="empty-selection">Choose a connected storage, junction, or completed Line point. Packets travel there from their current positions.</div>`;
      return;
    }
    if (!selection.id || selection.kind === 'none') {
      this.objectPanel.innerHTML = `<div class="panel-kicker">Selection</div><div class="panel-title">No object selected</div>` +
        `<div class="empty-selection">Drag from a friendly Line to launch a construction Arrow. Completed Lines provide territory and logistics, never passive fire.</div>`;
      return;
    }
    if (selection.kind === 'segment') {
      const segment = state.segments.get(selection.id);
      if (!segment) return;
      const health = clampPercent(segment.health / segment.maxHealth);
      const nextTier = segment.tier === 'wood' ? 'stone' : segment.tier === 'stone' ? 'iron' : null;
      const isArrow = segment.constructionState !== 'complete';
      const title = isArrow ? `${segment.tier.toUpperCase()} ARROW` : `${segment.tier.toUpperCase()} LINE`;
      const sourceConnected = state.nodes.get(segment.a)?.connected ?? false;
      const cells = cellsOf(state, segment);
      const intact = cells.filter((cell) => cell.state === 'intact' && cell.health > 0).length;
      const broken = cells.filter((cell) => cell.state === 'broken' || cell.health <= 0).length;
      const rebuilding = cells.filter((cell) => cell.repairRequested).length;
      const arrowGap = isArrow ? firstArrowGap(state, segment) : undefined;
      const supplyProgress = constructionSupplyProgress(state, segment);
      const shipped = supplyProgress.built + supplyProgress.delivered + supplyProgress.inTransit;
      const reservedConstruction = COMMODITY_ORDER.reduce((sum, resource) => sum + costAmount(segment.waitingConstruction, resource), 0);
      const reservedAssault = COMMODITY_ORDER.reduce((sum, resource) => sum + costAmount(segment.waitingAssault, resource), 0);
      const reservedRepair = COMMODITY_ORDER.reduce((sum, resource) => sum + costAmount(segment.waitingRepair, resource), 0);
      const contributors = segment.contributingStorageIds.map((id) => {
        const storage = state.storages.get(id);
        return storage ? `${storage.kind.toUpperCase()} ${id}` : id;
      }).join(' · ') || 'NONE YET';
      const repairInTransit = cells.reduce((total, cell) => total + COMMODITY_ORDER.reduce(
        (sum, resource) => sum + costAmount(cell.repairInTransit, resource), 0,
      ), 0);
      const assaultReady = hasCost(segment.assaultSupply, TIER_BALANCE[segment.tier].assaultCost);
      const status = segment.constructionState === 'queued'
        ? 'QUEUED · NOT CHARGED'
        : isArrow && !sourceConnected
          ? 'SUPPLY LINE CUT · PAUSED'
          : arrowGap
            ? `CELL ${arrowGap.index + 1} BROKEN · AWAITING REBUILD`
          : segment.constructionState === 'building'
            ? `CELL ${Math.min(segment.frontierCell + 1, cells.length)} / ${cells.length} · RESOURCE PACED`
            : segment.constructionState === 'attacking'
              ? assaultReady ? 'ATTACKING · SUPPLIED' : 'ATTACKING · AWAITING SUPPLY'
              : segment.connected ? 'CONNECTED' : 'DISCONNECTED';
      const originNode = segment.supplyOriginNodeId ? state.nodes.get(segment.supplyOriginNodeId) : undefined;
      const originStorage = originNode ? storageAtNode(state, originNode.id) : undefined;
      const supplyOrigin = originStorage ? `${originStorage.kind.toUpperCase()} · ${originStorage.id}` : 'LOCATING STOCKED STORAGE';
      this.objectPanel.innerHTML = `<div class="panel-kicker">${segment.owner} ${isArrow ? 'construction' : 'network'}</div><div class="panel-title">${title}</div>` +
        `<div class="stat-row"><span>Aggregate cell HP</span><b>${Math.max(0, Math.ceil(segment.health))} / ${Math.ceil(segment.maxHealth)}</b></div><div class="health-track"><div class="health-fill" style="width:${health}%"></div></div>` +
        `<div class="stat-row"><span>Status</span><b>${status}</b></div>` +
        `<div class="stat-row"><span>Material / stack</span><b>${segment.tier.toUpperCase()} · x${segment.stackLevel}${segment.stackTargetLevel > segment.stackLevel ? ` → x${segment.stackTargetLevel}` : ''}</b></div>` +
        `<div class="stat-row"><span>Cells</span><b>${intact} intact · ${broken} broken · ${cells.length} total</b></div>` +
        `<div class="stat-row"><span>Repair state</span><b>${rebuilding > 0 ? `${rebuilding} REQUESTED` : 'IDLE'}</b></div>` +
        (isArrow ? `<div class="stat-row"><span>Damage / supply</span><b>${TIER_BALANCE[segment.tier].damagePerSupply}</b></div>` +
          `<div class="stat-row"><span>Assault bundle</span><b>${formatCost(TIER_BALANCE[segment.tier].assaultCost)}</b></div>` +
          `<div class="stat-row"><span>Frontier</span><b>CELL ${Math.min(segment.frontierCell + 1, cells.length)} / ${cells.length}</b></div>` +
          `<div class="stat-row"><span>Construction shipped</span><b>${shipped.toFixed(1)} / ${supplyProgress.required.toFixed(1)}</b></div>` +
          `<div class="capacity-track"><div class="capacity-fill" style="width:${Math.floor(supplyProgress.ratio * 100)}%"></div></div>` +
          `<div class="stat-row"><span>Route requirement</span><b>${supplyProgress.required.toFixed(1)} UNITS</b></div>` +
          `<div class="stat-row"><span>Delivered / in transit</span><b>${supplyProgress.delivered.toFixed(1)} / ${supplyProgress.inTransit.toFixed(1)}</b></div>` +
          `<div class="stat-row"><span>Committed, not sent</span><b>${reservedConstruction.toFixed(1)} RESERVED</b></div>` +
          `<div class="stat-row"><span>Supply origin</span><b>${supplyOrigin}</b></div>` +
          `<div class="stat-row"><span>Contributors</span><b>${contributors}</b></div>` +
          `<div class="stat-row"><span>Waiting construction</span><b>${supplyProgress.inTransit.toFixed(1)} TRANSIT · ${reservedConstruction.toFixed(1)} RESERVED</b></div>` +
          `<div class="stat-row"><span>Waiting assault</span><b>${COMMODITY_ORDER.reduce((sum, resource) => sum + costAmount(segment.assaultInTransit, resource), 0).toFixed(1)} TRANSIT · ${reservedAssault.toFixed(1)} RESERVED</b></div>` +
          `<div class="stat-row"><span>Waiting repair</span><b>${repairInTransit.toFixed(1)} TRANSIT · ${reservedRepair.toFixed(1)} RESERVED</b></div>` +
          `<div class="empty-selection">Built Arrow cells carry only construction, assault, and rebuild packets. The first rear gap blocks every packet and damage pulse until physically rebuilt.</div>` :
          `<div class="stat-row"><span>Function</span><b>TERRITORY + TWO-WAY LOGISTICS</b></div>` +
        `<div class="stat-row"><span>A → B lanes</span><b>${TIER_BALANCE[segment.tier].lanesPerDirection} × stack ${segment.stackLevel} = ${effectiveDirectionalCapacity(state, segment).toFixed(0)}</b></div>` +
        `<div class="stat-row"><span>A → B load</span><b>${segment.trafficAB.load.toFixed(1)} / ${segment.trafficAB.capacity.toFixed(1)} · ${segment.trafficAB.state.toUpperCase()} · Q${segment.trafficAB.queuedPackets}</b></div>` +
        `<div class="capacity-track"><div class="capacity-fill" style="width:${Math.min(100, segment.trafficAB.loadRatio * 100)}%"></div></div>` +
        `<div class="stat-row"><span>B → A lanes</span><b>${TIER_BALANCE[segment.tier].lanesPerDirection} × stack ${segment.stackLevel} = ${effectiveDirectionalCapacity(state, segment).toFixed(0)}</b></div>` +
        `<div class="stat-row"><span>B → A load</span><b>${segment.trafficBA.load.toFixed(1)} / ${segment.trafficBA.capacity.toFixed(1)} · ${segment.trafficBA.state.toUpperCase()} · Q${segment.trafficBA.queuedPackets}</b></div>` +
        `<div class="capacity-track"><div class="capacity-fill" style="width:${Math.min(100, segment.trafficBA.loadRatio * 100)}%"></div></div>` +
        `<div class="stat-row"><span>Cross-direction effect</span><b>${segment.trafficAB.state === 'heavy' || segment.trafficBA.state === 'heavy' ? 'OPPOSITE CLEAR LANE ×0.5' : 'INDEPENDENT'}</b></div>` +
        `<div class="stat-row"><span>Armor</span><b>${segment.armor}</b></div>`) +
        (segment.owner === 'player' && !isArrow ? `<div class="panel-actions"><button class="ui-button" data-panel-action="repair">Repair</button><button class="ui-button" data-panel-action="upgrade" ${!nextTier ? 'disabled' : ''}>${nextTier ? `Upgrade · ${formatCost(UPGRADE_COSTS.segment[nextTier])}` : 'Max tier'}</button></div>` : '');
      return;
    }
    if (selection.kind === 'building') {
      const building = state.buildings.get(selection.id);
      if (!building) return;
      const config = BUILDING_BALANCE[building.type];
      const health = clampPercent(building.health / building.maxHealth);
      const storage = storageAtNode(state, building.nodeId);
      const service = !building.constructionComplete ? [...state.segments.values()].find((segment) => segment.service && segment.b === building.nodeId) : undefined;
      const projectProgress = service ? constructionSupplyProgress(state, service) : undefined;
      const basePerMinute = baseProductionPerSecond(building) * 60;
      const actualPerMinute = actualProductionPerSecond(building) * 60;
      const production = !building.constructionComplete ? 'AWAITING PHYSICAL CONSTRUCTION SUPPLY' : config.productionResource ? `${actualPerMinute.toFixed(1)} ${config.productionResource} / min` : building.type === 'depot' ? `Local storage · ${DEPOT.maxOutboundUnitsPerSecond}/s outbound cap` : 'Command nexus';
      const capacity = storage ? (Number.isFinite(storage.maxStorage) ? `${storedAmount(storage).toFixed(1)} / ${storage.maxStorage.toFixed(0)}` : `${storedAmount(storage).toFixed(1)} / ∞`) : '';
      const autoControl = storage?.kind === 'depot' && building.owner === 'player'
        ? `<button class="ui-button icon-control ${storage.autoSupplyEnabled ? 'active' : ''}" data-panel-action="toggle-auto" aria-pressed="${storage.autoSupplyEnabled}" ${building.constructionComplete ? '' : 'disabled'} title="Toggle automatic construction, repair, and assault contribution"><span aria-hidden="true">⇄</span><span>${storage.autoSupplyEnabled ? 'Auto contribution ON' : 'Auto contribution OFF'}</span></button>`
        : '';
      const targetControl = config.productionResource && config.productionResource !== 'manpower' && building.owner === 'player' && building.constructionComplete
        ? `<div class="transfer-controls"><select data-production-target aria-label="Production storage destination"><option value="auto" ${!building.productionTargetStorageId ? 'selected' : ''}>Automatic best Depot</option>${[...state.storages.values()].filter((candidate) => candidate.owner === building.owner).map((candidate) => `<option value="${candidate.id}" ${building.productionTargetStorageId === candidate.id ? 'selected' : ''}>${candidate.kind} · ${candidate.id}</option>`).join('')}</select><button class="ui-button" data-panel-action="production-target">Set destination</button></div>`
        : '';
      this.objectPanel.innerHTML = `<div class="panel-kicker">${building.owner} structure</div><div class="panel-title">${config.label.toUpperCase()}${building.level > 1 ? ` MK ${building.level}` : ''}</div>` +
        `<div class="stat-row"><span>Health</span><b>${Math.max(0, Math.ceil(building.health))} / ${building.maxHealth}</b></div><div class="health-track"><div class="health-fill" style="width:${health}%"></div></div>` +
        `<div class="stat-row"><span>Connection</span><b>${!building.constructionComplete ? 'UNDER CONSTRUCTION' : building.connected ? 'ONLINE' : 'OFFLINE'}</b></div>` +
        `<div class="stat-row"><span>Operation</span><b>${production}</b></div>` +
        (service && projectProgress ? `<div class="stat-row"><span>Construction supply</span><b>${(projectProgress.built + projectProgress.delivered + projectProgress.inTransit).toFixed(1)} / ${projectProgress.required.toFixed(1)}</b></div>` +
          `<div class="capacity-track"><div class="capacity-fill" style="width:${Math.floor(projectProgress.ratio * 100)}%"></div></div>` +
          `<div class="stat-row"><span>Delivered / transit / reserved</span><b>${projectProgress.delivered.toFixed(1)} / ${projectProgress.inTransit.toFixed(1)} / ${COMMODITY_ORDER.reduce((sum, resource) => sum + costAmount(service.waitingConstruction, resource), 0).toFixed(1)}</b></div>` +
          `<div class="stat-row"><span>Contributing storage</span><b>${service.contributingStorageIds.join(' · ') || 'LOCATING STOCK'}</b></div>` : '') +
        (config.requiredNode ? `<div class="stat-row"><span>Extraction efficiency</span><b>${(building.extractionEfficiency * 100).toFixed(0)}%</b></div>` +
          `<div class="stat-row"><span>Base production</span><b>${basePerMinute.toFixed(1)} / min</b></div>` +
          `<div class="stat-row"><span>Actual production</span><b>${actualPerMinute.toFixed(1)} / min</b></div>` : '') + targetControl +
        (storage ? `<div class="panel-kicker">LOCAL INVENTORY</div><div class="stat-row"><span>Stored / maximum</span><b>${capacity}</b></div>` +
          `<div class="stat-row"><span>Incoming storage</span><b>${storage.incomingReservedCapacity.toFixed(1)} RESERVED</b></div>` +
          COMMODITY_ORDER.map((resource) => `<div class="stat-row"><span>${resource}</span><b>${formatNumber(storage.inventory[resource])} · ${storage.reserved[resource].toFixed(1)} reserved · ${availableInventory(storage, resource).toFixed(1)} free</b></div>`).join('') +
          `<div class="stat-row"><span>Inbound load</span><b>${Number.isFinite(storage.inboundRate) ? `${storage.receivedThisSecond.toFixed(1)} / ${storage.inboundRate.toFixed(1)} per s · Q${storage.inboundQueuedPackets}` : 'UNLIMITED'}</b></div>` +
          `<div class="stat-row"><span>Outbound load</span><b>${storage.dispatchedThisSecond.toFixed(1)} / ${storage.outboundRate.toFixed(1)} per s</b></div>` +
          `<div class="stat-row"><span>Dispatch budget</span><b>${storage.dispatchBudget.toFixed(1)}</b></div>` +
          `<div class="stat-row"><span>Queued transfers</span><b>${storage.queuedTransfers}</b></div>` +
          autoControl +
          (building.owner === 'player' ? `<div class="transfer-controls"><select data-transfer-resource>${COMMODITY_ORDER.map((resource) => `<option value="${resource}">${resource}</option>`).join('')}</select><input data-transfer-amount type="number" min="1" step="1" value="10"><button class="ui-button" data-panel-action="transfer">Send, then click destination [T]</button></div><div class="empty-selection">Press G to redirect all available commodities to storage or a closed loop.</div>` : '') : '') +
        (building.owner === 'player' ? `<div class="panel-actions"><button class="ui-button" data-panel-action="repair">Repair</button>${building.type === 'house' && building.level < 2 ? `<button class="ui-button" data-panel-action="upgrade">Upgrade · ${formatCost(UPGRADE_COSTS.house)}</button>` : ''}</div>` : '');
      return;
    }
    if (selection.kind === 'storage') {
      const storage = state.storages.get(selection.id);
      const node = storage ? state.nodes.get(storage.nodeId) : undefined;
      if (!storage || !node) return;
      const capacity = Number.isFinite(storage.maxStorage) ? `${storedAmount(storage).toFixed(1)} / ${storage.maxStorage.toFixed(0)}` : `${storedAmount(storage).toFixed(1)} / ∞`;
      const autoControl = storage.kind === 'depot'
        ? `<button class="ui-button icon-control ${storage.autoSupplyEnabled ? 'active' : ''}" data-panel-action="toggle-auto" aria-pressed="${storage.autoSupplyEnabled}" title="Toggle automatic construction, repair, and assault contribution"><span aria-hidden="true">⇄</span><span>${storage.autoSupplyEnabled ? 'Auto contribution ON' : 'Auto contribution OFF'}</span></button>`
        : '';
      this.objectPanel.innerHTML = `<div class="panel-kicker">FORWARD STORAGE</div><div class="panel-title">${storage.kind.toUpperCase()}</div>` +
        (findRecognizedLoop(state, storage.owner, node.id) ? `<div class="loop-badge">RECOGNIZED LOOP · 3+ roads · 1 network exit</div><div class="empty-selection">Circulating stock stays in the logistics loop and cannot supply structure construction.</div>` : '') +
        `<div class="stat-row"><span>Connection</span><b>${node.connected ? 'ONLINE' : 'OFFLINE'}</b></div>` +
        `<div class="stat-row"><span>Stored / maximum</span><b>${capacity}</b></div>` +
        `<div class="stat-row"><span>Incoming storage</span><b>${storage.incomingReservedCapacity.toFixed(1)} RESERVED</b></div>` +
        `<div class="stat-row"><span>Total committed</span><b>${reservedAmount(storage).toFixed(1)}</b></div>` +
        COMMODITY_ORDER.map((resource) => `<div class="stat-row"><span>${resource}</span><b>${formatNumber(storage.inventory[resource])} · ${storage.reserved[resource].toFixed(1)} reserved · ${availableInventory(storage, resource).toFixed(1)} free</b></div>`).join('') +
        `<div class="stat-row"><span>Inbound load</span><b>${Number.isFinite(storage.inboundRate) ? `${storage.receivedThisSecond.toFixed(1)} / ${storage.inboundRate.toFixed(1)} per s · Q${storage.inboundQueuedPackets}` : 'UNLIMITED'}</b></div>` +
        `<div class="stat-row"><span>Outbound load</span><b>${storage.dispatchedThisSecond.toFixed(1)} / ${storage.outboundRate.toFixed(1)} per s</b></div>` +
        `<div class="stat-row"><span>Dispatch budget</span><b>${storage.dispatchBudget.toFixed(1)}</b></div>` +
        `<div class="stat-row"><span>Queued transfers</span><b>${storage.queuedTransfers}</b></div>` +
        autoControl +
        `<div class="transfer-controls"><select data-transfer-resource>${COMMODITY_ORDER.map((resource) => `<option value="${resource}">${resource}</option>`).join('')}</select><input data-transfer-amount type="number" min="1" step="1" value="10"><button class="ui-button" data-panel-action="transfer">Send, then click destination [T]</button></div>` +
        `<div class="empty-selection">Press G to redirect all available commodities to storage or a closed loop.</div>`;
      return;
    }
    if (selection.kind === 'wall') {
      const wall = state.walls.get(selection.id);
      if (!wall) return;
      const health = clampPercent(wall.health / wall.maxHealth);
      this.objectPanel.innerHTML = `<div class="panel-kicker">${wall.owner} defense</div><div class="panel-title">STONE WALL</div>` +
        `<div class="stat-row"><span>Health</span><b>${Math.max(0, Math.ceil(wall.health))} / ${wall.maxHealth}</b></div><div class="health-track"><div class="health-fill" style="width:${health}%"></div></div>` +
        `<div class="stat-row"><span>Purpose</span><b>BLOCKS ARROWS</b></div>` +
        `<div class="stat-row"><span>Arrow damage</span><b>Wood 0.40× · Stone 1.00× · Iron 2.00×</b></div>` +
        `<div class="empty-selection">Never attacks, transports, claims territory, launches Lines, or joins the network. Weak to Iron Arrows.</div>` +
        (wall.owner === 'player' ? `<div class="panel-actions"><button class="ui-button" data-panel-action="repair">Repair</button></div>` : '');
      return;
    }
    if (selection.kind === 'packet') {
      const packet = state.packets.get(selection.id);
      if (!packet) return;
      this.objectPanel.innerHTML = `<div class="panel-kicker">PHYSICAL RESOURCE PACKET</div><div class="panel-title" style="color:${COLORS[packet.resource]}">${packet.resource.toUpperCase()} · ${packet.amount.toFixed(1)}</div>` +
        `<div class="stat-row"><span>Purpose</span><b>${packet.purpose.toUpperCase()}</b></div>` +
        `<div class="stat-row"><span>Routing</span><b>${packet.routingMode.toUpperCase()}${packet.routingMode === 'circulate' ? ` · ${packet.circulationCycles} CYCLES` : ''}</b></div>` +
        `<div class="stat-row"><span>Destination</span><b>${packet.targetStorageId ?? packet.targetCellId ?? packet.targetNode}</b></div>` +
        `<div class="stat-row"><span>Cruise multiplier</span><b>x${packet.cruiseSpeedMultiplier.toFixed(2)}</b></div>` +
        `<div class="stat-row"><span>Effective multiplier</span><b>x${packet.effectiveSpeedMultiplier.toFixed(2)}${packet.effectiveSpeedMultiplier < packet.cruiseSpeedMultiplier ? ' · CONGESTION SUPPRESSED' : ''}</b></div>` +
        `<div class="stat-row"><span>Cruise / effective</span><b>${packet.cruiseSpeed.toFixed(0)} / ${(packet.baseCruiseSpeed * packet.effectiveSpeedMultiplier).toFixed(0)} u/s</b></div>` +
        `<div class="stat-row"><span>Reroutes / wait</span><b>${packet.reroutes} · ${packet.waiting > 0 ? 'QUEUED' : 'MOVING'}</b></div>`;
      return;
    }
    const resource = state.resourceNodes.get(selection.id);
    if (!resource) return;
    this.objectPanel.innerHTML = `<div class="panel-kicker">Resource deposit</div><div class="panel-title" style="color:${COLORS[resource.type]}">${resource.type.toUpperCase()}</div>` +
      `<div class="stat-row"><span>Remaining</span><b>${formatNumber(resource.amount)} / ${formatNumber(resource.maxAmount)}</b></div>` +
      `<div class="capacity-track"><div class="capacity-fill" style="background:${COLORS[resource.type]};width:${clampPercent(resource.amount / resource.maxAmount)}%"></div></div>` +
      `<div class="empty-selection">Build a ${BUILDING_BALANCE[resource.type === 'wood' ? 'woodCamp' : resource.type === 'stone' ? 'quarry' : resource.type === 'coal' ? 'coalMine' : 'ironMine'].label} within the ${WORLD.resourceBuildRange}-unit extraction preview and optimize deposit overlap.</div>`;
  }

  private updateObjectives(state: GameState): void {
    const economy = state.economy.player;
    const objectives = [
      { text: 'Extend the starting Line', done: state.stats.segmentsBuilt > 0 },
      { text: 'Establish Wood production', done: [...state.buildings.values()].some((building) => building.owner === 'player' && building.type === 'woodCamp') },
      { text: 'Deliver Stone and Coal', done: economy.discovered.has('stone') && economy.discovered.has('coal') },
      { text: 'Deliver the first Iron packet', done: economy.discovered.has('iron') },
      { text: 'Breach the hostile network', done: state.stats.enemySegmentsDestroyed > 0 },
      { text: 'Destroy the enemy Line Center', done: state.phase === 'victory' },
    ];
    this.objectivesPanel.innerHTML = `<div class="panel-kicker">Assault directive</div><div class="panel-title">OBJECTIVES</div>` +
      objectives.map((objective) => `<div class="objective ${objective.done ? 'done' : ''}"><span class="diamond"></span><span>${objective.text}</span></div>`).join('');
  }

  private updateWarnings(state: GameState): void {
    this.warnings.innerHTML = state.warnings.map((warning) => `<div class="warning" data-kind="${warning.kind}">${warning.text}</div>`).join('');
  }

  private updateTutorial(): void {
    const step = this.tutorialModel.current;
    this.tutorial.style.display = step ? 'block' : 'none';
    if (!step) return;
    this.tutorial.innerHTML = `<div class="tutorial-head"><span>${step.title}</span><button class="ui-button" data-tutorial="skip">SKIP [F1]</button></div>` +
      `<p>${step.text}</p><div class="panel-actions"><button class="ui-button" data-tutorial="previous">Back</button><button class="ui-button" data-tutorial="next">Next</button></div>`;
  }

  private updateModal(state: GameState): void {
    const mode = state.phase;
    if (mode !== 'menu' && mode !== 'paused' && mode !== 'victory' && mode !== 'defeat') {
      if (this.modalMode) this.modalRoot.innerHTML = '';
      this.modalMode = '';
      return;
    }
    const signature = `${mode}-${this.settings.muted}-${this.settings.edgeScroll}-${this.settings.screenShake}-${Math.round(this.settings.masterVolume * 100)}-${state.debug.enabled}`;
    if (this.modalMode === signature) return;
    this.modalMode = signature;
    if (mode === 'menu') {
      this.modalRoot.innerHTML = `<div class="modal-backdrop menu-backdrop"><section class="main-menu glass" aria-label="Main menu">` +
        `<div class="menu-brand"><span class="brand-mark"></span><span>LINE</span></div>` +
        `<div class="panel-kicker">DIRECTIONAL LOGISTICS RTS</div>` +
        `<button class="ui-button menu-primary" data-modal-action="new-game">New Game</button>` +
        `<div class="campaign-card"><div><div class="panel-kicker">CAMPAIGN</div><h2>Campaign</h2><p>Still empty</p></div><button class="ui-button" disabled title="Campaign is not available yet">Coming soon</button></div>` +
        `<button class="ui-button menu-debug" data-modal-action="debug-mode">Debug Mode <span>Open the familiar map without AI</span></button>` +
        `<div class="menu-footnote">New Game includes an easy, slow attacking opponent.</div></section></div>`;
    } else if (mode === 'paused') {
      this.modalRoot.innerHTML = `<div class="modal-backdrop"><div class="modal glass"><div class="panel-kicker">Simulation suspended</div><h1>PAUSED</h1>` +
        `<p>Plan the next route, inspect controls, or adjust local settings.</p>` +
        `<div class="settings-grid"><label>Volume <input data-setting="volume" type="range" min="0" max="1" step="0.05" value="${this.settings.masterVolume}"></label>` +
        `<label><input data-setting="edgeScroll" type="checkbox" ${this.settings.edgeScroll ? 'checked' : ''}> Edge scrolling</label>` +
        `<label><input data-setting="screenShake" type="checkbox" ${this.settings.screenShake ? 'checked' : ''}> Screen shake</label></div>` +
        `<div class="modal-actions"><button class="ui-button" data-modal-action="resume">Resume</button><button class="ui-button" data-modal-action="mute">${this.settings.muted ? 'Unmute' : 'Mute'}</button><button class="ui-button" data-modal-action="tutorial">Tutorial</button><button class="ui-button" data-modal-action="restart">Restart</button></div>` +
        `<div class="controls-compact">WASD / edges pan · Wheel zoom · 1–3 Arrow tier · F Wall · H/C/Q/O/I/B buildings · R repair · T transfer · G redirect/loop · U selected upgrade · hold Y to click through commodities · L packet boost · F3 debug</div></div></div>`;
    } else {
      const victory = mode === 'victory';
      this.modalRoot.innerHTML = `<div class="modal-backdrop"><div class="modal ${victory ? 'result-victory' : 'result-defeat'}"><div class="panel-kicker">Operation complete</div><h1>${victory ? 'VICTORY' : 'DEFEAT'}</h1>` +
        `<p>${victory ? 'The hostile Line Center has collapsed. Its network is silent.' : 'Your Line Center was destroyed. The network has gone dark.'}</p>` +
        `<div class="result-stats"><span>Time <b>${formatTime(state.stats.elapsed)}</b></span><span>Lines built <b>${state.stats.segmentsBuilt}</b></span><span>Damage pulses <b>${state.stats.arrowsImpacted}</b></span><span>Walls broken <b>${state.stats.wallsDestroyed}</b></span></div>` +
        `<div class="modal-actions"><button class="ui-button" data-modal-action="restart">Restart scenario</button></div></div></div>`;
    }
  }

  private updateDebug(state: GameState): void {
    this.debugPanel.classList.toggle('show', state.debug.enabled);
    if (!state.debug.enabled) return;
    const connected = [...state.segments.values()].filter((segment) => segment.connected).length;
    const congestedDirections = [...state.segments.values()].reduce((sum, segment) =>
      sum + (segment.trafficAB.state !== 'free' ? 1 : 0) + (segment.trafficBA.state !== 'free' ? 1 : 0), 0);
    const heavyDirections = [...state.segments.values()].reduce((sum, segment) =>
      sum + (segment.trafficAB.state === 'heavy' ? 1 : 0) + (segment.trafficBA.state === 'heavy' ? 1 : 0), 0);
    const broken = [...state.cells.values()].filter((cell) => cell.state === 'broken').length;
    this.debugPanel.textContent = `F3 DEBUG\n${state.debug.fps.toFixed(0)} FPS · ${state.debug.frameMs.toFixed(1)} ms\nTick ${state.tick} · Topology v${state.topologyVersion}\nLines ${state.segments.size} · Cells ${state.cells.size} (${broken} broken) · Connected ${connected}\nStorages ${state.storages.size} · Transfers ${state.transfers.size} · Walls ${state.walls.size}\nPackets ${state.packets.size} · Direction congestion ${congestedDirections} (${heavyDirections} heavy) · MP boost ${state.logisticsAcceleration.player ? 'ON' : 'OFF'}\nG redirect · U upgrade · hold Y bypass packets\n[Shift+C] connectivity ${state.debug.connectivity ? 'ON' : 'OFF'}\n[Shift+V] routes ${state.debug.routes ? 'ON' : 'OFF'}\n[Shift+G] congestion ${state.debug.congestion ? 'ON' : 'OFF'}\n[Shift+X] spatial ${state.debug.spatial ? 'ON' : 'OFF'}`;
  }

  private showTooltip(event: PointerEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-tip]');
    if (!button) return;
    this.tooltip.innerHTML = `<div>${button.dataset.tip ?? ''}</div><div class="tip-cost">${button.dataset.cost || 'No upfront cost'}</div>`;
    this.tooltip.classList.add('show');
    this.moveTooltip(event);
  }

  private moveTooltip(event: PointerEvent): void {
    if (!this.tooltip.classList.contains('show')) return;
    const width = 270;
    this.tooltip.style.left = `${Math.min(window.innerWidth - width - 8, event.clientX + 14)}px`;
    this.tooltip.style.top = `${Math.max(8, event.clientY - 80)}px`;
  }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value * 100));
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}
