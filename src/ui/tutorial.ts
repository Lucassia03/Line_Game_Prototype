import type { GameState } from '../core/types';

interface TutorialStep {
  title: string;
  text: string;
  complete?: (state: GameState) => boolean;
}

const STEPS: TutorialStep[] = [
  {
    title: '01 / THE NETWORK',
    text: 'Your completed Line is territory, transport, and construction access. Pan with WASD or the screen edge; zoom with the wheel.',
  },
  {
    title: '02 / EXTEND',
    text: 'Drag from any glowing friendly Line to any valid world point. Depots stream supplies for upcoming cells while the Arrow builds one cell at a time. Empty stock pauses construction until more arrives.',
    complete: (state) => state.stats.segmentsBuilt > 0,
  },
  {
    title: '03 / MANPOWER',
    text: 'Build a House near your connected Line. Once constructed, it adds workforce directly to the Manpower pool. Manpower never becomes a packet and never occupies Depot storage.',
    complete: (state) => [...state.buildings.values()].some((building) => building.owner === 'player' && building.type === 'house'),
  },
  {
    title: '04 / HARVEST',
    text: 'Preview a Wood Camp over a brown deposit and optimize its extraction percentage. Its frequent small packets prefer the best reachable Depot with capacity.',
    complete: (state) => [...state.buildings.values()].some((building) => building.owner === 'player' && building.type === 'woodCamp'),
  },
  {
    title: '05 / LOGISTICS',
    text: 'Centers, Depots, and stockpiles store only Wood, Stone, Coal, and Iron. Projects combine enabled Depots by projected dispatch plus route time; Depot inbound and outbound limits are independent.',
    complete: (state) => state.stats.packetsDelivered >= 2,
  },
  {
    title: '06 / ASSAULT',
    text: 'An Arrow holds at the first living cell or structure and repeatedly consumes delivered assault bundles. It survives contact and continues through a destroyed cell gap toward its original destination.',
  },
  {
    title: '07 / STONE WALLS',
    text: 'Press F and drag anywhere physically valid. Passive Walls hold Arrows and never join the network. Enemy Walls resist Wood, but take 2× damage from Iron.',
  },
  {
    title: '08 / FORWARD SUPPLY',
    text: 'Wood has one lane each way, Stone two, and Iron three; stacking multiplies both directions. Normal congestion affects only its own direction, while HEAVY traffic slows itself to x0.25 and the opposite clear lane by 50%.',
  },
  {
    title: '09 / NETWORK CONTROL',
    text: 'Drag from empty ground to box-select commodities; Alt-drag also works over roads. Press G or Redirect group, then click connected storage, a junction, or a Line point. Alt-click inspects one packet; Y ignores all packets. Press U to upgrade.',
  },
];

export class Tutorial {
  step = 0;
  visible: boolean;
  private completedAt = -1;

  constructor(visible: boolean) {
    this.visible = visible;
  }

  get current(): TutorialStep | null {
    return this.visible ? (STEPS[this.step] ?? null) : null;
  }

  update(state: GameState): void {
    const current = this.current;
    if (!current?.complete || !current.complete(state)) return;
    if (this.completedAt < 0) this.completedAt = state.stats.elapsed;
    if (state.stats.elapsed - this.completedAt > 0.75) this.next();
  }

  next(): void {
    this.step += 1;
    this.completedAt = -1;
    if (this.step >= STEPS.length) this.visible = false;
  }

  previous(): void {
    this.step = Math.max(0, this.step - 1);
    this.completedAt = -1;
  }

  skip(): void {
    this.visible = false;
  }

  restart(): void {
    this.step = 0;
    this.visible = true;
    this.completedAt = -1;
  }
}
