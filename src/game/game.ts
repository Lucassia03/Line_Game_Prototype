import { ProceduralAudio } from '../audio/audio';
import { WORLD } from '../config/balance';
import { loadSettings, saveSettings } from '../core/settings';
import type { BuildTool, GameState, SettingsData } from '../core/types';
import { InputController } from '../input/controller';
import { Camera } from '../input/camera';
import { generateScenario } from '../map/generator';
import { Renderer } from '../render/renderer';
import {
  repairBuilding,
  repairSegment,
  updateConstruction,
  upgradeHouse,
  upgradeSegment,
} from '../systems/construction';
import { isBuildingUnlocked, isTierUnlocked } from '../systems/economy';
import { updateEffects } from '../systems/effects';
import { ensureConnectivity } from '../systems/graph';
import { updateLogistics, updateProduction } from '../systems/logistics';
import { addWarning, updateNotifications } from '../systems/notifications';
import { isWallUnlocked, repairWall } from '../systems/walls';
import { setDepotAutoSupply } from '../systems/storage';
import { setProductionDestination } from '../systems/logistics';
import { Tutorial } from '../ui/tutorial';
import { UI } from '../ui/ui';
import { runEasyEnemyAI } from '../systems/enemyAI';

const SPEEDS = [0.5, 1, 2, 4];

export class Game {
  private state: GameState;
  private settings: SettingsData;
  private tool: BuildTool = { kind: 'select' };
  private camera: Camera;
  private renderer: Renderer;
  private input: InputController;
  private ui: UI;
  private audio: ProceduralAudio;
  private tutorial: Tutorial;
  private accumulator = 0;
  private lastFrame = performance.now();
  private uiAccumulator = 0;
  private fpsAccumulator = 0;
  private fpsFrames = 0;
  private running = false;
  private enemyAIEnabled = false;
  private enemyNextDecisionTick = 0;

  constructor(canvas: HTMLCanvasElement, minimap: HTMLCanvasElement) {
    this.settings = loadSettings();
    this.state = generateScenario();
    this.state.phase = 'menu';
    this.camera = new Camera(this.state.worldSize);
    this.renderer = new Renderer(canvas, minimap, this.camera);
    this.audio = new ProceduralAudio(this.settings);
    this.tutorial = new Tutorial(this.settings.showTutorial);
    this.input = new InputController(canvas, this.camera, {
      state: () => this.state,
      tool: () => this.tool,
      setTool: (tool) => this.setTool(tool),
      togglePause: () => this.togglePause(),
      changeSpeed: (direction) => this.changeSpeed(direction),
      toggleMute: () => this.toggleMute(),
      toggleDebug: () => this.toggleDebug(),
      toggleDebugFlag: (flag) => this.toggleDebugFlag(flag),
      toggleTutorial: () => this.toggleTutorial(),
      toggleLogisticsAcceleration: () => this.toggleLogisticsAcceleration(),
      upgradeSelected: () => this.upgradeSelected(),
      onAction: (sound) => this.audio.play(sound),
      settings: () => this.settings,
    }, this.audio);
    this.ui = new UI({
      state: () => this.state,
      tool: () => this.tool,
      setTool: (tool) => this.setTool(tool),
      togglePause: () => this.togglePause(),
      setSpeed: (speed) => this.setSpeed(speed),
      restart: () => this.restart(),
      toggleMute: () => this.toggleMute(),
      updateSettings: (patch) => this.updateSettings(patch),
      toggleTutorial: () => this.toggleTutorial(),
      tutorialNext: () => this.tutorial.next(),
      tutorialPrevious: () => this.tutorial.previous(),
      tutorialSkip: () => this.skipTutorial(),
      startGame: (mode) => this.startGame(mode),
      repairSelected: () => this.repairSelected(),
      upgradeSelected: () => this.upgradeSelected(),
      focusWorld: (position) => this.camera.focus(position),
      toggleDebug: () => this.toggleDebug(),
      toggleDebugFlag: (flag) => this.toggleDebugFlag(flag),
      toggleLogisticsAcceleration: () => this.toggleLogisticsAcceleration(),
      toggleDepotAutoSupply: (storageId) => this.toggleDepotAutoSupply(storageId),
      setProductionDestination: (buildingId, storageId) => setProductionDestination(this.state, buildingId, storageId),
      setUIInteractionActive: (active) => {
        this.camera.setUIInteractionActive(active);
        this.input.setUIInteractionActive(active);
      },
    }, this.tutorial, this.settings);
    this.bindWindowEvents();
    this.ui.update();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame((time) => this.frame(time));
  }

  private frame(time: number): void {
    if (!this.running) return;
    const rawDelta = Math.min(0.1, Math.max(0, (time - this.lastFrame) / 1000));
    this.lastFrame = time;
    this.input.update(rawDelta);

    if (this.state.phase === 'playing' || this.state.phase === 'tutorial') {
      this.accumulator += rawDelta * this.state.speed;
      let steps = 0;
      while (this.accumulator >= WORLD.fixedStep && steps < 12) {
        this.simulate(WORLD.fixedStep);
        this.accumulator -= WORLD.fixedStep;
        steps += 1;
      }
      if (steps === 12) this.accumulator = 0;
    }

    this.renderer.render(this.state, this.input);
    this.uiAccumulator += rawDelta;
    this.fpsAccumulator += rawDelta;
    this.fpsFrames += 1;
    if (this.fpsAccumulator >= 0.45) {
      this.state.debug.fps = this.fpsFrames / this.fpsAccumulator;
      this.state.debug.frameMs = (this.fpsAccumulator / this.fpsFrames) * 1000;
      this.fpsAccumulator = 0;
      this.fpsFrames = 0;
    }
    if (this.uiAccumulator >= 0.1) {
      this.ui.update();
      this.uiAccumulator = 0;
    }
    requestAnimationFrame((nextTime) => this.frame(nextTime));
  }

  private simulate(dt: number): void {
    const previousPacketDeliveries = this.state.stats.packetsDelivered;
    const previousPhase = this.state.phase;
    this.state.tick += 1;
    this.state.stats.elapsed += dt;

    const construction = updateConstruction(this.state, dt);
    if (construction.completed.length > 0) this.audio.play('complete');
    ensureConnectivity(this.state);
    updateProduction(this.state, dt);
    updateLogistics(this.state, dt);
    if (this.enemyAIEnabled && this.state.tick >= this.enemyNextDecisionTick) {
      const launched = runEasyEnemyAI(this.state);
      this.enemyNextDecisionTick = this.state.tick + (launched ? 1800 : 180);
    }
    updateEffects(this.state, dt);
    updateNotifications(this.state, dt);
    this.tutorial.update(this.state);

    if (this.state.stats.packetsDelivered > previousPacketDeliveries) this.audio.play('delivery');
    for (const impact of construction.impacts) {
      this.audio.play(impact.tier === 'iron' ? 'impactIron' : impact.tier === 'stone' ? 'impactStone' : 'impactWood');
      if (this.settings.screenShake) this.renderer.triggerShake(impact.tier === 'iron' ? 8 : impact.tier === 'stone' ? 5 : 2.5);
      if (impact.targetDestroyed) this.audio.play('destroy');
    }
    if (previousPhase !== this.state.phase) {
      if (this.state.phase === 'victory') this.audio.play('victory');
      if (this.state.phase === 'defeat') this.audio.play('defeat');
      this.ui.update();
    }
  }

  private setTool(tool: BuildTool): void {
    if (tool.kind === 'line' && !isTierUnlocked(this.state, 'player', tool.tier)) {
      addWarning(this.state, `${tool.tier.toUpperCase()} Line requires delivered ${tool.tier === 'stone' ? 'Stone' : 'Coal and Iron'}`, 'danger');
      this.audio.play('error');
      return;
    }
    if (tool.kind === 'building' && !isBuildingUnlocked(this.state, 'player', tool.building)) {
      addWarning(this.state, 'Resource hierarchy requirement not met', 'danger');
      this.audio.play('error');
      return;
    }
    if (tool.kind === 'wall' && !isWallUnlocked(this.state, 'player')) {
      addWarning(this.state, 'Deliver Stone to unlock Stone Walls', 'danger');
      this.audio.play('error');
      return;
    }
    this.tool = tool;
    if (tool.kind === 'line') this.input.selectedTier = tool.tier;
  }

  private togglePause(): void {
    if (this.state.phase === 'victory' || this.state.phase === 'defeat') return;
    if (this.state.phase === 'paused') {
      this.state.phase = this.state.previousPhase === 'paused' ? 'playing' : this.state.previousPhase;
    } else {
      this.state.previousPhase = this.state.phase;
      this.state.phase = 'paused';
    }
    this.ui.update();
  }

  private setSpeed(speed: number): void {
    if (!SPEEDS.includes(speed)) return;
    this.state.speed = speed;
    if (this.state.phase === 'paused') this.togglePause();
  }

  private changeSpeed(direction: number): void {
    const index = SPEEDS.indexOf(this.state.speed);
    this.setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, index + direction))] ?? 1);
  }

  private toggleMute(): void {
    this.updateSettings({ muted: !this.settings.muted });
  }

  private updateSettings(patch: Partial<SettingsData>): void {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.settings);
    this.audio.setSettings(this.settings);
    this.ui.setSettings(this.settings);
    this.ui.update();
  }

  private toggleTutorial(): void {
    if (this.tutorial.visible) this.skipTutorial();
    else {
      this.tutorial.restart();
      this.updateSettings({ showTutorial: true });
      if (this.state.phase === 'paused') this.togglePause();
    }
  }

  private skipTutorial(): void {
    this.tutorial.skip();
    this.updateSettings({ showTutorial: false });
  }

  private toggleDebug(): void {
    this.state.debug.enabled = !this.state.debug.enabled;
    this.ui.update();
  }

  private toggleDebugFlag(flag: 'connectivity' | 'routes' | 'congestion' | 'spatial'): void {
    this.state.debug[flag] = !this.state.debug[flag];
  }

  private toggleLogisticsAcceleration(): void {
    this.state.logisticsAcceleration.player = !this.state.logisticsAcceleration.player;
    addWarning(this.state, `Commodity packet boost ${this.state.logisticsAcceleration.player ? 'enabled' : 'disabled'}`, 'info');
    this.audio.play('select');
    this.ui.update();
  }

  private toggleDepotAutoSupply(storageId: string): void {
    const storage = this.state.storages.get(storageId);
    if (!storage || !setDepotAutoSupply(this.state, storageId, !storage.autoSupplyEnabled)) return;
    addWarning(this.state, `Depot automatic contribution ${storage.autoSupplyEnabled ? 'enabled' : 'disabled'}`, 'info');
    this.audio.play('select');
    this.ui.update();
  }

  private repairSelected(): void {
    const selection = this.state.selection;
    const success = selection.kind === 'segment' && selection.id ? repairSegment(this.state, selection.id) :
      selection.kind === 'building' && selection.id ? repairBuilding(this.state, selection.id) :
        selection.kind === 'wall' && selection.id ? repairWall(this.state, selection.id) : false;
    if (success) this.audio.play('complete');
    else {
      addWarning(this.state, 'Repair unavailable or insufficient resources', 'danger');
      this.audio.play('error');
    }
  }

  private upgradeSelected(): void {
    const selection = this.state.selection;
    const success = selection.kind === 'segment' && selection.id ? upgradeSegment(this.state, selection.id) :
      selection.kind === 'building' && selection.id ? upgradeHouse(this.state, selection.id) : false;
    if (success) this.audio.play('complete');
    else {
      addWarning(this.state, 'Upgrade locked, unavailable, or unaffordable', 'danger');
      this.audio.play('error');
    }
  }

  private restart(): void {
    const seed = this.state.seed;
    this.state = generateScenario(seed);
    this.state.speed = 1;
    this.tool = { kind: 'select' };
    this.input.reset();
    this.tutorial.step = 0;
    this.tutorial.visible = this.settings.showTutorial;
    this.camera.worldSize = { ...this.state.worldSize };
    this.camera.focus({ x: 440, y: 700 }, 0.82);
    this.accumulator = 0;
    this.state.phase = this.settings.showTutorial ? 'tutorial' : 'playing';
    this.state.previousPhase = 'playing';
    this.enemyNextDecisionTick = this.state.tick + 1800;
    this.ui.update();
  }

  private startGame(mode: 'new-game' | 'debug'): void {
    this.state = generateScenario(this.state.seed);
    this.enemyAIEnabled = mode === 'new-game';
    this.enemyNextDecisionTick = this.state.tick + 1800;
    this.state.phase = mode === 'new-game' && this.settings.showTutorial ? 'tutorial' : 'playing';
    this.state.previousPhase = 'playing';
    this.state.speed = 1;
    this.tool = { kind: 'select' };
    this.input.reset();
    this.tutorial.restart();
    if (mode === 'debug') this.tutorial.skip();
    this.camera.worldSize = { ...this.state.worldSize };
    this.camera.focus({ x: 440, y: 700 }, 0.82);
    this.accumulator = 0;
    this.ui.update();
  }

  private bindWindowEvents(): void {
    window.addEventListener('resize', () => this.renderer.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && (this.state.phase === 'playing' || this.state.phase === 'tutorial')) this.togglePause();
    });
  }
}
