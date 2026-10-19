import { addBuilding, addNode, addResourceNode, addSegment, addTerrain, addWall, createEmptyState } from '../core/state';
import { SeededRandom } from '../core/rng';
import type { GameState, MaterialResource, Tier, Vec2 } from '../core/types';
import { recomputeConnectivity } from '../systems/graph';

interface DepositSpec {
  type: MaterialResource;
  position: Vec2;
  amount: number;
}

function jitter(rng: SeededRandom, point: Vec2, amount: number): Vec2 {
  return { x: point.x + rng.range(-amount, amount), y: point.y + rng.range(-amount, amount) };
}

function addDeposits(state: GameState, rng: SeededRandom): void {
  const guaranteed: DepositSpec[] = [
    { type: 'wood', position: { x: 455, y: 605 }, amount: 820 },
    { type: 'wood', position: { x: 515, y: 790 }, amount: 760 },
    { type: 'wood', position: { x: 640, y: 505 }, amount: 720 },
    { type: 'stone', position: { x: 815, y: 430 }, amount: 690 },
    { type: 'stone', position: { x: 950, y: 905 }, amount: 760 },
    { type: 'stone', position: { x: 1090, y: 555 }, amount: 540 },
    { type: 'coal', position: { x: 780, y: 1040 }, amount: 640 },
    { type: 'coal', position: { x: 1010, y: 330 }, amount: 670 },
    { type: 'coal', position: { x: 1115, y: 845 }, amount: 510 },
    { type: 'iron', position: { x: 1245, y: 690 }, amount: 470 },
    { type: 'iron', position: { x: 1370, y: 500 }, amount: 330 },
    { type: 'wood', position: { x: 1650, y: 1040 }, amount: 610 },
    { type: 'stone', position: { x: 1780, y: 350 }, amount: 520 },
    { type: 'coal', position: { x: 1860, y: 980 }, amount: 500 },
  ];
  for (const deposit of guaranteed) {
    addResourceNode(state, deposit.type, jitter(rng, deposit.position, 24), deposit.amount, rng.range(25, 34));
  }

  const types: MaterialResource[] = ['wood', 'wood', 'stone', 'coal'];
  for (let index = 0; index < 10; index += 1) {
    const side = index < 5 ? 1 : -1;
    const position = {
      x: side === 1 ? rng.range(380, 1080) : rng.range(1450, 2050),
      y: rng.range(170, 1230),
    };
    addResourceNode(state, rng.pick(types), position, rng.range(380, 680), rng.range(23, 31));
  }
}

function addTerrainFeatures(state: GameState, rng: SeededRandom): void {
  addTerrain(state, { kind: 'ridge', position: { x: 1130, y: 175 }, radiusX: 410, radiusY: 120, rotation: 0.04, blocking: true });
  addTerrain(state, { kind: 'ridge', position: { x: 1190, y: 1230 }, radiusX: 430, radiusY: 125, rotation: -0.04, blocking: true });
  addTerrain(state, { kind: 'water', position: { x: 760, y: 690 }, radiusX: 145, radiusY: 92, rotation: -0.35, blocking: true });
  addTerrain(state, { kind: 'water', position: { x: 1520, y: 760 }, radiusX: 150, radiusY: 94, rotation: 0.32, blocking: true });
  addTerrain(state, { kind: 'rough', position: { x: 1250, y: 690 }, radiusX: 270, radiusY: 230, rotation: 0, blocking: false });
  for (let index = 0; index < 16; index += 1) {
    addTerrain(state, {
      kind: 'rough',
      position: { x: rng.range(200, 2200), y: rng.range(120, 1280) },
      radiusX: rng.range(35, 90),
      radiusY: rng.range(25, 65),
      rotation: rng.range(0, Math.PI),
      blocking: false,
    });
  }
}

function connect(state: GameState, owner: 'player' | 'enemy', ids: string[], tier: Tier): void {
  for (let index = 1; index < ids.length; index += 1) {
    const previous = ids[index - 1];
    const current = ids[index];
    if (previous && current) addSegment(state, owner, previous, current, tier);
  }
}

function addPlayerStart(state: GameState): void {
  const centerNode = addNode(state, 'player', { x: 205, y: 700 }, 'center');
  addBuilding(state, 'player', 'center', centerNode.position, centerNode.id);
  const trunk = [
    centerNode.id,
    addNode(state, 'player', { x: 305, y: 700 }).id,
    addNode(state, 'player', { x: 395, y: 650 }).id,
  ];
  connect(state, 'player', trunk, 'wood');
  const branch = addNode(state, 'player', { x: 390, y: 775 });
  const anchor = trunk[1];
  if (anchor) addSegment(state, 'player', anchor, branch.id, 'wood');
}

function addEnemyNetwork(state: GameState): void {
  const center = addNode(state, 'enemy', { x: 2190, y: 700 }, 'center');
  addBuilding(state, 'enemy', 'center', center.position, center.id);

  const main = [
    center.id,
    addNode(state, 'enemy', { x: 2070, y: 700 }).id,
    addNode(state, 'enemy', { x: 1950, y: 700 }).id,
    addNode(state, 'enemy', { x: 1835, y: 700 }).id,
  ];
  connect(state, 'enemy', main.slice(0, 3), 'iron');
  const main2 = main.slice(2);
  connect(state, 'enemy', main2, 'stone');

  const upperIron = addNode(state, 'enemy', { x: 1960, y: 515 });
  const lowerIron = addNode(state, 'enemy', { x: 1960, y: 885 });
  const mid = main[2];
  if (mid) {
    addSegment(state, 'enemy', mid, upperIron.id, 'iron');
    addSegment(state, 'enemy', mid, lowerIron.id, 'iron');
  }

  const upperStoneA = addNode(state, 'enemy', { x: 1810, y: 535 });
  const lowerStoneA = addNode(state, 'enemy', { x: 1810, y: 865 });
  addSegment(state, 'enemy', upperIron.id, upperStoneA.id, 'stone');
  addSegment(state, 'enemy', lowerIron.id, lowerStoneA.id, 'stone');
  const mainEnd = main[3];
  if (mainEnd) {
    addSegment(state, 'enemy', upperStoneA.id, mainEnd, 'stone');
    addSegment(state, 'enemy', lowerStoneA.id, mainEnd, 'stone');
  }

  const forwardUpper = addNode(state, 'enemy', { x: 1660, y: 545 });
  const forwardLower = addNode(state, 'enemy', { x: 1660, y: 855 });
  const forwardMid = addNode(state, 'enemy', { x: 1575, y: 700 });
  addSegment(state, 'enemy', upperStoneA.id, forwardUpper.id, 'stone');
  addSegment(state, 'enemy', lowerStoneA.id, forwardLower.id, 'stone');
  if (mainEnd) addSegment(state, 'enemy', mainEnd, forwardMid.id, 'stone');
  addSegment(state, 'enemy', forwardUpper.id, forwardMid.id, 'wood');
  addSegment(state, 'enemy', forwardLower.id, forwardMid.id, 'wood');

  const picketUpper = addNode(state, 'enemy', { x: 1460, y: 585 });
  const picketLower = addNode(state, 'enemy', { x: 1460, y: 815 });
  addSegment(state, 'enemy', forwardMid.id, picketUpper.id, 'wood');
  addSegment(state, 'enemy', forwardMid.id, picketLower.id, 'wood');
  addSegment(state, 'enemy', picketUpper.id, picketLower.id, 'wood');

  const depotNode = addNode(state, 'enemy', { x: 1840, y: 700 }, 'building');
  addBuilding(state, 'enemy', 'depot', depotNode.position, depotNode.id);
  if (mainEnd) addSegment(state, 'enemy', mainEnd, depotNode.id, 'stone', { service: true });

  addWall(state, 'enemy', { x: 2030, y: 585 }, { x: 2140, y: 585 });
  addWall(state, 'enemy', { x: 2140, y: 585 }, { x: 2140, y: 645 });
  addWall(state, 'enemy', { x: 2030, y: 815 }, { x: 2140, y: 815 });
  addWall(state, 'enemy', { x: 2140, y: 755 }, { x: 2140, y: 815 });
  addWall(state, 'enemy', { x: 1835, y: 410 }, { x: 1950, y: 445 });
  addWall(state, 'enemy', { x: 1835, y: 1060 }, { x: 1950, y: 1025 });
}

export function generateScenario(seed = 2405): GameState {
  const state = createEmptyState(seed);
  const rng = new SeededRandom(seed);
  addTerrainFeatures(state, rng);
  addDeposits(state, rng);
  addPlayerStart(state);
  addEnemyNetwork(state);
  recomputeConnectivity(state);
  return state;
}
