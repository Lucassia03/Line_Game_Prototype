import { WORLD } from '../config/balance';
import { closestPointOnSegment, distance } from '../core/geometry';
import type { GameState, Selection, Vec2 } from '../core/types';
import { cellsOf } from './cells';
import { SpatialHash } from './spatialHash';

export class SelectionIndex {
  pickPacketsInArea(state: GameState, from: Vec2, to: Vec2, ignorePackets = false): string[] {
    if (ignorePackets) return [];
    return [...state.packets.values()].filter((packet) => packet.owner === 'player' &&
      packet.position.x >= Math.min(from.x, to.x) && packet.position.x <= Math.max(from.x, to.x) &&
      packet.position.y >= Math.min(from.y, to.y) && packet.position.y <= Math.max(from.y, to.y))
      .map((packet) => packet.id).sort();
  }
  private hash = new SpatialHash<string>(120);
  private version = -1;
  private spatialVersion = -1;
  private resourceCount = -1;

  rebuild(state: GameState): void {
    if (this.version === state.topologyVersion && this.spatialVersion === state.spatialVersion && this.resourceCount === state.resourceNodes.size) return;
    this.hash.clear();
    for (const segment of state.segments.values()) {
      const a = state.nodes.get(segment.a)?.position;
      const b = state.nodes.get(segment.b)?.position;
      if (!a || !b) continue;
      this.hash.insert(`s:${segment.id}`, {
        minX: Math.min(a.x, b.x) - 18,
        minY: Math.min(a.y, b.y) - 18,
        maxX: Math.max(a.x, b.x) + 18,
        maxY: Math.max(a.y, b.y) + 18,
      });
    }
    for (const building of state.buildings.values()) this.hash.insertPoint(`b:${building.id}`, building.position, building.type === 'center' ? 45 : 29);
    for (const resource of state.resourceNodes.values()) this.hash.insertPoint(`r:${resource.id}`, resource.position, resource.radius + 8);
    for (const wall of state.walls.values()) {
      this.hash.insert(`w:${wall.id}`, {
        minX: Math.min(wall.start.x, wall.end.x) - wall.thickness,
        minY: Math.min(wall.start.y, wall.end.y) - wall.thickness,
        maxX: Math.max(wall.start.x, wall.end.x) + wall.thickness,
        maxY: Math.max(wall.start.y, wall.end.y) + wall.thickness,
      });
    }
    for (const storage of state.storages.values()) {
      if (storage.kind === 'stockpile') this.hash.insertPoint(`p:${storage.id}`, state.nodes.get(storage.nodeId)?.position ?? { x: -9999, y: -9999 }, 12);
    }
    this.version = state.topologyVersion;
    this.spatialVersion = state.spatialVersion;
    this.resourceCount = state.resourceNodes.size;
  }

  pick(state: GameState, position: Vec2, zoom: number, ignorePackets = false, preferPackets = false): Selection {
    this.rebuild(state);
    const radius = WORLD.selectionRadius / Math.max(0.55, zoom);
    const candidates = this.hash.queryCircle(position, radius + 35);
    const ranked: Array<{ selection: Selection; distance: number; priority: number }> = [];
    const consider = (selection: Selection, candidateDistance: number, priority: number): void => {
      ranked.push({ selection, distance: candidateDistance, priority });
    };
    for (const key of candidates) {
      const [kind, id] = key.split(':');
      if (!id) continue;
      if (kind === 'b') {
        const building = state.buildings.get(id);
        if (!building) continue;
        const d = Math.max(0, distance(position, building.position) - (building.type === 'center' ? 38 : 23));
        if (d <= radius + 8) consider({ kind: 'building', id }, d, 30);
      } else if (kind === 's') {
        const segment = state.segments.get(id);
        const a = segment ? state.nodes.get(segment.a)?.position : undefined;
        const b = segment ? state.nodes.get(segment.b)?.position : undefined;
        if (!segment || !a || !b) continue;
        const d = cellsOf(state, segment).reduce(
          (minimum, cell) => Math.min(minimum, closestPointOnSegment(position, cell.start, cell.end).distance),
          Number.POSITIVE_INFINITY,
        );
        // Cell geometry remains selectable even when that exact cell is broken. The
        // rendered stroke stays narrow; only this screen-space tolerance grows.
        if (d <= radius) consider({ kind: 'segment', id }, d, preferPackets ? 20 : 50);
      } else if (kind === 'r') {
        const resource = state.resourceNodes.get(id);
        if (!resource) continue;
        const d = Math.max(0, distance(position, resource.position) - resource.radius);
        if (d <= radius) consider({ kind: 'resource', id }, d, 10);
      } else if (kind === 'w') {
        const wall = state.walls.get(id);
        if (!wall) continue;
        const d = Math.max(0, closestPointOnSegment(position, wall.start, wall.end).distance - wall.thickness / 2);
        if (d <= radius + 5) consider({ kind: 'wall', id }, d, 30);
      } else if (kind === 'p') {
        const storage = state.storages.get(id);
        const node = storage ? state.nodes.get(storage.nodeId) : undefined;
        if (!storage || !node) continue;
        const d = distance(position, node.position);
        if (d <= radius + 8) consider({ kind: 'storage', id }, d, 50);
      }
    }
    if (!ignorePackets) {
      for (const packet of state.packets.values()) {
        const d = distance(position, packet.position);
        if (d <= radius + 6) consider({ kind: 'packet', id: packet.id }, d, preferPackets ? 60 : 20);
      }
    }
    ranked.sort((left, right) => right.priority - left.priority || left.distance - right.distance ||
      `${left.selection.kind}:${left.selection.id ?? ''}`.localeCompare(`${right.selection.kind}:${right.selection.id ?? ''}`));
    return ranked[0]?.selection ?? { kind: 'none' };
  }
}
