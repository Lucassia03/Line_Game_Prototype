import { clamp } from '../core/geometry';
import type { Vec2 } from '../core/types';

export class Camera {
  position: Vec2 = { x: 440, y: 700 };
  zoom = 0.82;
  viewport = { width: window.innerWidth, height: window.innerHeight };
  worldSize: Vec2;
  private keys = new Set<string>();
  private edgePointer: Vec2 = { x: this.viewport.width / 2, y: this.viewport.height / 2 };
  private uiInteractionActive = false;

  constructor(worldSize: Vec2) {
    this.worldSize = { ...worldSize };
  }

  resize(width: number, height: number): void {
    this.viewport.width = width;
    this.viewport.height = height;
    this.clampPosition();
  }

  setPointer(screen: Vec2): void {
    this.edgePointer = screen;
  }

  setUIInteractionActive(active: boolean): void {
    this.uiInteractionActive = active;
  }

  setKey(code: string, down: boolean): void {
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

  screenToWorld(screen: Vec2): Vec2 {
    return {
      x: this.position.x + (screen.x - this.viewport.width / 2) / this.zoom,
      y: this.position.y + (screen.y - this.viewport.height / 2) / this.zoom,
    };
  }

  worldToScreen(world: Vec2): Vec2 {
    return {
      x: (world.x - this.position.x) * this.zoom + this.viewport.width / 2,
      y: (world.y - this.position.y) * this.zoom + this.viewport.height / 2,
    };
  }

  zoomAt(screen: Vec2, delta: number): void {
    const before = this.screenToWorld(screen);
    this.zoom = clamp(this.zoom * Math.exp(-delta * 0.0012), 0.42, 2.25);
    const after = this.screenToWorld(screen);
    this.position.x += before.x - after.x;
    this.position.y += before.y - after.y;
    this.clampPosition();
  }

  panByScreen(delta: Vec2): void {
    this.position.x -= delta.x / this.zoom;
    this.position.y -= delta.y / this.zoom;
    this.clampPosition();
  }

  focus(world: Vec2, zoom?: number): void {
    this.position = { ...world };
    if (zoom !== undefined) this.zoom = clamp(zoom, 0.42, 2.25);
    this.clampPosition();
  }

  update(dt: number, edgeScroll: boolean): void {
    const direction = { x: 0, y: 0 };
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) direction.x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) direction.x += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) direction.y -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) direction.y += 1;

    if (edgeScroll && document.hasFocus() && !this.uiInteractionActive) {
      const edge = 14;
      if (this.edgePointer.x >= 0 && this.edgePointer.x < edge) direction.x -= 1;
      if (this.edgePointer.x <= this.viewport.width && this.edgePointer.x > this.viewport.width - edge) direction.x += 1;
      if (this.edgePointer.y >= 0 && this.edgePointer.y < edge) direction.y -= 1;
      if (this.edgePointer.y <= this.viewport.height && this.edgePointer.y > this.viewport.height - edge) direction.y += 1;
    }
    const magnitude = Math.hypot(direction.x, direction.y) || 1;
    const speed = 620 / Math.sqrt(this.zoom);
    this.position.x += (direction.x / magnitude) * speed * dt;
    this.position.y += (direction.y / magnitude) * speed * dt;
    this.clampPosition();
  }

  visibleBounds(padding = 0): { minX: number; minY: number; maxX: number; maxY: number } {
    const halfWidth = this.viewport.width / (2 * this.zoom);
    const halfHeight = this.viewport.height / (2 * this.zoom);
    return {
      minX: this.position.x - halfWidth - padding,
      minY: this.position.y - halfHeight - padding,
      maxX: this.position.x + halfWidth + padding,
      maxY: this.position.y + halfHeight + padding,
    };
  }

  private clampPosition(): void {
    const halfWidth = Math.min(this.worldSize.x / 2, this.viewport.width / (2 * this.zoom));
    const halfHeight = Math.min(this.worldSize.y / 2, this.viewport.height / (2 * this.zoom));
    this.position.x = clamp(this.position.x, halfWidth, this.worldSize.x - halfWidth);
    this.position.y = clamp(this.position.y, halfHeight, this.worldSize.y - halfHeight);
  }
}
