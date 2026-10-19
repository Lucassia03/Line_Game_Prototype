import { nextId } from '../core/state';
import type { GameState, Vec2 } from '../core/types';

export function spawnParticles(
  state: GameState,
  position: Vec2,
  color: string,
  count: number,
  kind: 'spark' | 'smoke' | 'delivery' | 'destruction' | 'impact' = 'spark',
  power = 1,
): void {
  for (let index = 0; index < count; index += 1) {
    const angle = ((index * 2.399) + state.tick * 0.17) % (Math.PI * 2);
    const speed = (18 + ((index * 17) % 52)) * power;
    const life = 0.35 + ((index * 13) % 40) / 100;
    state.particles.push({
      id: nextId(state, 'fx'),
      kind,
      position: { ...position },
      velocity: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
      color,
      life,
      maxLife: life,
      size: (1.5 + (index % 4)) * Math.sqrt(power),
    });
  }
}

export function spawnImpactEffect(state: GameState, position: Vec2, color: string, power: number): void {
  const life = 0.34 + power * 0.08;
  state.impacts.push({
    id: nextId(state, 'impact'),
    position: { ...position },
    color,
    life,
    maxLife: life,
    radius: 13 + power * 10,
    power,
  });
  spawnParticles(state, position, color, Math.round(8 + power * 8), 'impact', power);
}

export function updateEffects(state: GameState, dt: number): void {
  for (const segment of state.segments.values()) segment.damageFlash = Math.max(0, segment.damageFlash - dt);
  for (const cell of state.cells.values()) cell.damageFlash = Math.max(0, cell.damageFlash - dt);
  for (const building of state.buildings.values()) building.damageFlash = Math.max(0, building.damageFlash - dt);
  for (const wall of state.walls.values()) wall.damageFlash = Math.max(0, wall.damageFlash - dt);
  for (const particle of state.particles) {
    particle.life -= dt;
    particle.position.x += particle.velocity.x * dt;
    particle.position.y += particle.velocity.y * dt;
    particle.velocity.x *= Math.pow(0.12, dt);
    particle.velocity.y *= Math.pow(0.12, dt);
    if (particle.kind === 'smoke') particle.velocity.y -= 5 * dt;
  }
  state.particles = state.particles.filter((particle) => particle.life > 0).slice(-900);
  for (const impact of state.impacts) impact.life -= dt;
  state.impacts = state.impacts.filter((impact) => impact.life > 0).slice(-80);
  for (const text of state.floatingTexts) {
    text.life -= dt;
    text.position.y -= 15 * dt;
  }
  state.floatingTexts = state.floatingTexts.filter((text) => text.life > 0).slice(-80);
}
