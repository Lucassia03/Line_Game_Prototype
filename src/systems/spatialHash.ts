import type { Vec2 } from '../core/types';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class SpatialHash<T extends string> {
  readonly cellSize: number;
  private cells = new Map<string, Set<T>>();

  constructor(cellSize = 160) {
    this.cellSize = cellSize;
  }

  clear(): void {
    this.cells.clear();
  }

  private key(x: number, y: number): string {
    return `${x},${y}`;
  }

  insert(id: T, bounds: Bounds): void {
    const minCellX = Math.floor(bounds.minX / this.cellSize);
    const maxCellX = Math.floor(bounds.maxX / this.cellSize);
    const minCellY = Math.floor(bounds.minY / this.cellSize);
    const maxCellY = Math.floor(bounds.maxY / this.cellSize);
    for (let y = minCellY; y <= maxCellY; y += 1) {
      for (let x = minCellX; x <= maxCellX; x += 1) {
        const key = this.key(x, y);
        let cell = this.cells.get(key);
        if (!cell) {
          cell = new Set();
          this.cells.set(key, cell);
        }
        cell.add(id);
      }
    }
  }

  insertPoint(id: T, point: Vec2, radius = 0): void {
    this.insert(id, { minX: point.x - radius, minY: point.y - radius, maxX: point.x + radius, maxY: point.y + radius });
  }

  query(bounds: Bounds): Set<T> {
    const result = new Set<T>();
    const minCellX = Math.floor(bounds.minX / this.cellSize);
    const maxCellX = Math.floor(bounds.maxX / this.cellSize);
    const minCellY = Math.floor(bounds.minY / this.cellSize);
    const maxCellY = Math.floor(bounds.maxY / this.cellSize);
    for (let y = minCellY; y <= maxCellY; y += 1) {
      for (let x = minCellX; x <= maxCellX; x += 1) {
        for (const id of this.cells.get(this.key(x, y)) ?? []) result.add(id);
      }
    }
    return result;
  }

  queryCircle(center: Vec2, radius: number): Set<T> {
    return this.query({ minX: center.x - radius, minY: center.y - radius, maxX: center.x + radius, maxY: center.y + radius });
  }

  occupiedCellCount(): number {
    return this.cells.size;
  }
}
