import { BUILDING_BALANCE, COLORS, LINE_CELL, STACKING, TIER_BALANCE, WALL_BALANCE, WORLD } from '../config/balance';
import { clamp, distance, lerpVec } from '../core/geometry';
import type { Building, GameState, LineSegment, ResourceNode, Vec2 } from '../core/types';
import type { InputController } from '../input/controller';
import { Camera } from '../input/camera';
import { formatCost } from '../systems/economy';
import { cellPoint, cellsOf, constructionSupplyProgress } from '../systems/cells';
import { extractorResource } from '../systems/extraction';
import { effectiveDirectionalCapacity } from '../systems/graph';
import { storageAtNode } from '../systems/storage';

function rgba(hex: string, alpha: number): string {
  const cleaned = hex.replace('#', '');
  const value = Number.parseInt(cleaned, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function pathLine(ctx: CanvasRenderingContext2D, a: Vec2, b: Vec2): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function polygon(ctx: CanvasRenderingContext2D, center: Vec2, radius: number, sides: number, rotation = 0): void {
  ctx.beginPath();
  for (let index = 0; index < sides; index += 1) {
    const angle = rotation + (index / sides) * Math.PI * 2;
    const point = { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  }
  ctx.closePath();
}

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private minimap: HTMLCanvasElement;
  private minimapCtx: CanvasRenderingContext2D;
  private camera: Camera;
  private dpr = 1;
  private shakeAmount = 0;

  constructor(canvas: HTMLCanvasElement, minimap: HTMLCanvasElement, camera: Camera) {
    const context = canvas.getContext('2d');
    const minimapContext = minimap.getContext('2d');
    if (!context || !minimapContext) throw new Error('Canvas 2D is unavailable');
    this.canvas = canvas;
    this.ctx = context;
    this.minimap = minimap;
    this.minimapCtx = minimapContext;
    this.camera = camera;
    this.resize();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.floor(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * this.dpr));
    this.camera.resize(rect.width, rect.height);
  }

  triggerShake(amount: number): void {
    this.shakeAmount = Math.max(this.shakeAmount, amount);
  }

  render(state: GameState, input: InputController): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b1113';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    if (this.shakeAmount > 0.05) {
      const phase = performance.now() * 0.055;
      ctx.translate(Math.sin(phase * 1.3) * this.shakeAmount, Math.cos(phase * 1.7) * this.shakeAmount);
      this.shakeAmount *= 0.86;
    } else {
      this.shakeAmount = 0;
    }
    ctx.translate(this.camera.viewport.width / 2, this.camera.viewport.height / 2);
    ctx.scale(this.camera.zoom, this.camera.zoom);
    ctx.translate(-this.camera.position.x, -this.camera.position.y);

    this.drawGround(state);
    this.drawTerrain(state);
    this.drawResources(state);
    this.drawTerritory(state);
    this.drawSegments(state);
    this.drawWalls(state);
    this.drawNodes(state);
    this.drawBuildings(state);
    this.drawPacketRoutes(state);
    this.drawPackets(state);
    this.drawImpactEffects(state);
    this.drawParticles(state);
    this.drawSelection(state, input);
    this.drawConstructionPreview(state, input);
    this.drawDebugWorld(state);
    ctx.restore();
    this.drawScreenLabels(state, input);
    this.drawMinimap(state);
  }

  private isVisible(position: Vec2, padding = 80): boolean {
    const bounds = this.camera.visibleBounds(padding);
    return position.x >= bounds.minX && position.x <= bounds.maxX && position.y >= bounds.minY && position.y <= bounds.maxY;
  }

  private drawGround(state: GameState): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#11191a';
    ctx.fillRect(0, 0, state.worldSize.x, state.worldSize.y);
    const bounds = this.camera.visibleBounds(50);
    const grid = WORLD.grid;
    const startX = Math.max(0, Math.floor(bounds.minX / grid) * grid);
    const endX = Math.min(state.worldSize.x, Math.ceil(bounds.maxX / grid) * grid);
    const startY = Math.max(0, Math.floor(bounds.minY / grid) * grid);
    const endY = Math.min(state.worldSize.y, Math.ceil(bounds.maxY / grid) * grid);
    ctx.lineWidth = 1 / this.camera.zoom;
    ctx.strokeStyle = 'rgba(177,207,191,.042)';
    ctx.beginPath();
    for (let x = startX; x <= endX; x += grid) {
      ctx.moveTo(x, startY);
      ctx.lineTo(x, endY);
    }
    for (let y = startY; y <= endY; y += grid) {
      ctx.moveTo(startX, y);
      ctx.lineTo(endX, y);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(121,230,165,.18)';
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, state.worldSize.x - 3, state.worldSize.y - 3);

    ctx.fillStyle = 'rgba(150,180,165,.065)';
    const coarse = 80;
    for (let y = Math.max(coarse, Math.floor(bounds.minY / coarse) * coarse); y < Math.min(state.worldSize.y, bounds.maxY); y += coarse) {
      for (let x = Math.max(coarse, Math.floor(bounds.minX / coarse) * coarse); x < Math.min(state.worldSize.x, bounds.maxX); x += coarse) {
        const hash = ((x * 73856093) ^ (y * 19349663) ^ state.seed) >>> 0;
        if (hash % 5 !== 0) continue;
        const ox = (hash % 31) - 15;
        const oy = ((hash >> 5) % 27) - 13;
        ctx.fillRect(x + ox, y + oy, 1.5, 1.5);
      }
    }
  }

  private drawTerrain(state: GameState): void {
    const ctx = this.ctx;
    for (const terrain of state.terrain) {
      if (!this.isVisible(terrain.position, Math.max(terrain.radiusX, terrain.radiusY))) continue;
      ctx.save();
      ctx.translate(terrain.position.x, terrain.position.y);
      ctx.rotate(terrain.rotation);
      ctx.beginPath();
      ctx.ellipse(0, 0, terrain.radiusX, terrain.radiusY, 0, 0, Math.PI * 2);
      if (terrain.kind === 'water') {
        const gradient = ctx.createRadialGradient(0, 0, 8, 0, 0, terrain.radiusX);
        gradient.addColorStop(0, 'rgba(39,82,90,.55)');
        gradient.addColorStop(1, 'rgba(25,52,58,.35)');
        ctx.fillStyle = gradient;
        ctx.fill();
        ctx.strokeStyle = 'rgba(96,166,175,.32)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(112,191,198,.13)';
        ctx.lineWidth = 1;
        for (let stripe = -2; stripe <= 2; stripe += 1) {
          ctx.beginPath();
          ctx.ellipse(0, stripe * terrain.radiusY * 0.23, terrain.radiusX * (0.75 - Math.abs(stripe) * 0.08), terrain.radiusY * 0.12, 0, 0, Math.PI);
          ctx.stroke();
        }
      } else if (terrain.kind === 'ridge') {
        ctx.fillStyle = 'rgba(62,68,63,.66)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(160,169,154,.22)';
        ctx.lineWidth = 3;
        ctx.stroke();
        for (let ridge = 0; ridge < 4; ridge += 1) {
          ctx.beginPath();
          ctx.ellipse(0, 0, terrain.radiusX * (0.86 - ridge * 0.16), terrain.radiusY * (0.78 - ridge * 0.13), 0, Math.PI * 1.06, Math.PI * 1.94);
          ctx.strokeStyle = `rgba(190,195,177,${0.12 - ridge * 0.015})`;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = 'rgba(93,94,70,.075)';
        ctx.fill();
        ctx.setLineDash([8, 12]);
        ctx.strokeStyle = 'rgba(156,155,109,.1)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawResources(state: GameState): void {
    for (const node of state.resourceNodes.values()) {
      if (!this.isVisible(node.position, 50)) continue;
      this.drawResourceNode(node, state.tick);
    }
  }

  private drawResourceNode(node: ResourceNode, tick: number): void {
    const ctx = this.ctx;
    const ratio = clamp(node.amount / node.maxAmount, 0, 1);
    const color = COLORS[node.type];
    ctx.save();
    ctx.translate(node.position.x, node.position.y);
    ctx.globalAlpha = 0.28 + ratio * 0.72;
    ctx.fillStyle = rgba(color, 0.11);
    ctx.beginPath();
    ctx.arc(0, 0, node.radius + 13 + Math.sin(tick * 0.03 + node.position.x) * 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.35);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    for (let index = 0; index < 7; index += 1) {
      const angle = index * 2.399 + node.position.y * 0.01;
      const radial = node.radius * (0.25 + ((index * 37) % 65) / 100);
      const size = (4 + (index % 3) * 2) * (0.35 + ratio * 0.65);
      ctx.fillStyle = index % 2 ? rgba(color, 0.8) : rgba(color, 0.5);
      if (node.type === 'wood') {
        ctx.fillRect(Math.cos(angle) * radial - size / 2, Math.sin(angle) * radial - size, size, size * 2);
      } else {
        polygon(ctx, { x: Math.cos(angle) * radial, y: Math.sin(angle) * radial }, size, node.type === 'coal' ? 5 : 6, angle);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.font = `600 ${10 / this.camera.zoom}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(node.amount > 0 ? node.type.toUpperCase() : 'DEPLETED', 0, (node.radius + 23) / this.camera.zoom);
    ctx.restore();
  }

  private drawTerritory(state: GameState): void {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const segment of state.segments.values()) {
      if (segment.constructionState !== 'complete') continue;
      for (const cell of cellsOf(state, segment)) {
        if (cell.state !== 'intact' || cell.health <= 0 || !cell.connected ||
          (!this.isVisible(cell.start, 90) && !this.isVisible(cell.end, 90))) continue;
        ctx.strokeStyle = segment.owner === 'player' ? rgba(COLORS.player, 0.08) : rgba(COLORS.enemy, 0.09);
        ctx.lineWidth = WORLD.territoryRadius * 2;
        pathLine(ctx, cell.start, cell.end);
      }
    }
  }

  private drawSegments(state: GameState): void {
    const ctx = this.ctx;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    for (const segment of state.segments.values()) {
      const points = this.segmentPoints(state, segment);
      if (!points) continue;
      const queued = segment.constructionState === 'queued';
      const building = segment.constructionState === 'building';
      const attacking = segment.constructionState === 'attacking';
      const activeArrow = building || attacking;
      const sourceConnected = state.nodes.get(segment.a)?.connected ?? false;
      const ownerColor = segment.owner === 'player' ? COLORS.player : COLORS.enemy;
      const materialColor = COLORS[segment.tier];
      const width = TIER_BALANCE[segment.tier].width;
      const cells = cellsOf(state, segment);
      if (queued) {
        ctx.save(); ctx.strokeStyle = rgba(ownerColor, 0.3); ctx.lineWidth = 2; ctx.setLineDash([5, 10]);
        pathLine(ctx, points[0], points[1]); ctx.restore();
        continue;
      }
      const layerCount = Math.min(segment.stackLevel, STACKING.maxRenderedLayers);
      const dx = points[1].x - points[0].x;
      const dy = points[1].y - points[0].y;
      const magnitude = Math.max(1, Math.hypot(dx, dy));
      const normal = { x: -dy / magnitude, y: dx / magnitude };
      for (const cell of cells) {
        if (!this.isVisible(cellPoint(cell, 0.5), 70)) continue;
        if (cell.state === 'planned' || cell.state === 'broken') {
          if (cell.state === 'broken') {
            ctx.save(); ctx.strokeStyle = rgba(COLORS.enemy, 0.42); ctx.lineWidth = 1.5; ctx.setLineDash([2, 6]);
            pathLine(ctx, cell.start, cell.end); ctx.restore();
          }
          continue;
        }
        const progress = cell.state === 'building' ? cell.constructionProgress : 1;
        const seam = Math.min(0.12, LINE_CELL.seamSize / Math.max(1, cell.length));
        const rawStart = cellPoint(cell, seam);
        const rawEnd = cellPoint(cell, Math.max(seam, progress - seam));
        const healthRatio = clamp(cell.health / Math.max(1, cell.maxHealth), 0, 1);
        for (let layer = 0; layer < layerCount; layer += 1) {
          const offset = (layer - (layerCount - 1) / 2) * STACKING.renderOffset;
          const start = { x: rawStart.x + normal.x * offset, y: rawStart.y + normal.y * offset };
          const end = { x: rawEnd.x + normal.x * offset, y: rawEnd.y + normal.y * offset };
          ctx.save();
          ctx.globalAlpha = activeArrow ? (sourceConnected ? 0.94 : 0.34) : cell.connected ? 1 : 0.4;
          ctx.shadowColor = ownerColor; ctx.shadowBlur = attacking ? 17 : cell.connected ? 6 : 0;
          ctx.strokeStyle = rgba(ownerColor, cell.damageFlash > 0 ? 1 : 0.72); ctx.lineWidth = width + 4; pathLine(ctx, start, end);
          ctx.shadowBlur = 0;
          ctx.strokeStyle = segment.owner === 'enemy' ? rgba(COLORS.enemy, 0.9) : materialColor;
          ctx.lineWidth = Math.max(2, width - layerCount * 0.35); pathLine(ctx, start, end);
          ctx.strokeStyle = 'rgba(235,255,244,.3)'; ctx.lineWidth = Math.max(1, width * 0.18); pathLine(ctx, start, end);
          if (healthRatio < 0.72) {
            ctx.strokeStyle = rgba(COLORS.enemy, (1 - healthRatio) * 0.92); ctx.lineWidth = Math.max(1.5, width * (1 - healthRatio));
            ctx.setLineDash([3, 5]); pathLine(ctx, start, end);
          }
          if (cell.state === 'rebuilding' || cell.repairRequested) {
            ctx.strokeStyle = rgba(COLORS.logistics, 0.9); ctx.lineWidth = width + 7; ctx.setLineDash([3, 7]);
            ctx.lineDashOffset = -state.tick * 0.5; pathLine(ctx, start, end);
          }
          ctx.restore();
        }
      }
      if (segment.congestion > 0.75 && segment.connected) {
        ctx.save(); ctx.strokeStyle = rgba('#ffc864', clamp((segment.congestion - 0.65) * 0.45, 0.16, 0.65));
        ctx.lineWidth = width + 8; ctx.setLineDash([5, 14]); ctx.lineDashOffset = -state.tick * 0.8;
        for (const cell of cells) if (cell.state === 'intact' && cell.health > 0) pathLine(ctx, cell.start, cell.end);
        ctx.restore();
      }
      if (activeArrow) {
        const frontier = cells[Math.min(segment.frontierCell, Math.max(0, cells.length - 1))];
        const tip = frontier ? cellPoint(frontier, segment.frontierCell >= cells.length ? 1 : frontier.constructionProgress) : points[0];
        this.drawArrowhead(tip, points[0], points[1], segment.tier, ownerColor, state.tick, attacking, sourceConnected);
        this.drawConstructionSupplyBar(state, segment, tip);
      }
      if (segment.stackLevel > STACKING.maxRenderedLayers || (state.selection.kind === 'segment' && state.selection.id === segment.id && segment.stackLevel > 1)) {
        const mid = lerpVec(points[0], points[1], 0.5);
        ctx.fillStyle = '#07120c'; ctx.strokeStyle = ownerColor; ctx.lineWidth = 1;
        ctx.fillRect(mid.x - 14, mid.y - 11, 28, 18); ctx.strokeRect(mid.x - 14, mid.y - 11, 28, 18);
        ctx.fillStyle = ownerColor; ctx.font = '700 10px ui-monospace, monospace'; ctx.textAlign = 'center';
        ctx.fillText(`x${segment.stackLevel}`, mid.x, mid.y + 2);
      }
    }
    ctx.lineCap = 'round';
  }

  private drawConstructionSupplyBar(state: GameState, segment: LineSegment, tip: Vec2): void {
    const progress = constructionSupplyProgress(state, segment);
    const width = 88;
    const y = tip.y - 31;
    const shipped = progress.built + progress.delivered + progress.inTransit;
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(4,8,9,.82)'; ctx.fillRect(tip.x - width / 2, y, width, 13);
    ctx.fillStyle = COLORS.logistics; ctx.fillRect(tip.x - width / 2 + 2, y + 2, (width - 4) * progress.ratio, 4);
    ctx.fillStyle = '#dff7e7'; ctx.font = '600 7px ui-monospace, monospace'; ctx.textAlign = 'center';
    ctx.fillText(`${shipped.toFixed(1)} / ${progress.required.toFixed(1)} supplied`, tip.x, y + 11);
  }

  private drawArrowhead(
    tip: Vec2,
    source: Vec2,
    destination: Vec2,
    tier: LineSegment['tier'],
    ownerColor: string,
    tick: number,
    attacking: boolean,
    sourceConnected: boolean,
  ): void {
    const ctx = this.ctx;
    const angle = Math.atan2(destination.y - source.y, destination.x - source.x);
    const size = tier === 'iron' ? 17 : tier === 'stone' ? 14 : 12;
    ctx.save();
    ctx.translate(tip.x, tip.y);
    ctx.rotate(angle);
    ctx.shadowColor = ownerColor;
    ctx.shadowBlur = 13 + Math.sin(tick * 0.18) * 3;
    ctx.fillStyle = COLORS[tier];
    ctx.strokeStyle = ownerColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.7, size * 0.68);
    ctx.lineTo(-size * 0.36, 0);
    ctx.lineTo(-size * 0.7, -size * 0.68);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    if (attacking) {
      ctx.rotate(-angle);
      ctx.strokeStyle = sourceConnected ? '#fff1a8' : COLORS.enemy;
      ctx.lineWidth = 2.2;
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -tick * 0.7;
      ctx.beginPath();
      ctx.arc(0, 0, size * (1.15 + Math.sin(tick * 0.16) * 0.08), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.rotate(angle);
    }
    if (tier === 'iron') {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(-size * 0.35, 0); ctx.lineTo(size * 0.62, 0); ctx.stroke();
    }
    ctx.restore();
  }

  private drawWalls(state: GameState): void {
    const ctx = this.ctx;
    ctx.lineCap = 'butt';
    for (const wall of state.walls.values()) {
      const midpoint = { x: (wall.start.x + wall.end.x) / 2, y: (wall.start.y + wall.end.y) / 2 };
      if (!this.isVisible(midpoint, distance(wall.start, wall.end) / 2 + 50)) continue;
      const ownerColor = wall.owner === 'player' ? COLORS.player : COLORS.enemy;
      const healthRatio = clamp(wall.health / wall.maxHealth, 0, 1);
      ctx.save();
      ctx.shadowColor = wall.damageFlash > 0 ? '#ffffff' : ownerColor;
      ctx.shadowBlur = wall.damageFlash > 0 ? 18 : 7;
      ctx.strokeStyle = rgba(ownerColor, 0.78);
      ctx.lineWidth = wall.thickness + 7;
      pathLine(ctx, wall.start, wall.end);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = wall.damageFlash > 0 ? '#f5f1e7' : '#8f9998';
      ctx.lineWidth = wall.thickness;
      pathLine(ctx, wall.start, wall.end);
      ctx.strokeStyle = 'rgba(225,235,230,.35)';
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 7]);
      pathLine(ctx, wall.start, wall.end);
      if (healthRatio < 0.72) {
        ctx.strokeStyle = rgba(COLORS.enemy, (1 - healthRatio) * 0.8);
        ctx.lineWidth = 2.5;
        ctx.setLineDash([3, 11]);
        pathLine(ctx, wall.start, wall.end);
      }
      ctx.restore();

      if (healthRatio < 0.98 || (state.selection.kind === 'wall' && state.selection.id === wall.id)) {
        const width = Math.min(82, Math.max(44, distance(wall.start, wall.end) * 0.55));
        ctx.fillStyle = 'rgba(0,0,0,.68)';
        ctx.fillRect(midpoint.x - width / 2, midpoint.y - wall.thickness - 12, width, 5);
        ctx.fillStyle = healthRatio > 0.4 ? COLORS.stone : COLORS.enemy;
        ctx.fillRect(midpoint.x - width / 2, midpoint.y - wall.thickness - 12, width * healthRatio, 5);
      }
    }
    ctx.lineCap = 'round';
  }

  private drawNodes(state: GameState): void {
    const ctx = this.ctx;
    for (const node of state.nodes.values()) {
      if (!this.isVisible(node.position, 20) || node.kind === 'center') continue;
      const ownerColor = node.owner === 'player' ? COLORS.player : COLORS.enemy;
      ctx.fillStyle = node.connected ? '#17211e' : '#181b1a';
      ctx.strokeStyle = rgba(ownerColor, node.connected ? 0.85 : 0.32);
      ctx.lineWidth = 2;
      if (node.kind === 'stockpile') polygon(ctx, node.position, 8, 4, Math.PI / 4);
      else { ctx.beginPath(); ctx.arc(node.position.x, node.position.y, node.kind === 'building' ? 6 : 4.2, 0, Math.PI * 2); }
      ctx.fill();
      ctx.stroke();
      if (node.kind === 'stockpile') {
        ctx.fillStyle = COLORS.logistics;
        ctx.beginPath(); ctx.arc(node.position.x, node.position.y, 2.4, 0, Math.PI * 2); ctx.fill();
      }
      if (!node.connected) {
        ctx.strokeStyle = rgba('#ff6577', 0.55);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(node.position.x - 4, node.position.y - 4);
        ctx.lineTo(node.position.x + 4, node.position.y + 4);
        ctx.moveTo(node.position.x + 4, node.position.y - 4);
        ctx.lineTo(node.position.x - 4, node.position.y + 4);
        ctx.stroke();
      }
    }
  }

  private drawBuildings(state: GameState): void {
    for (const building of state.buildings.values()) {
      if (!this.isVisible(building.position, 70)) continue;
      this.drawBuilding(building, state, 1);
    }
  }

  private drawBuilding(building: Building, state: GameState, alpha: number): void {
    const ctx = this.ctx;
    const color = building.owner === 'player' ? COLORS.player : COLORS.enemy;
    const healthRatio = clamp(building.health / building.maxHealth, 0, 1);
    ctx.save();
    ctx.globalAlpha = alpha * (building.constructionComplete ? (building.connected || building.type === 'center' ? 1 : 0.45) : 0.38);
    ctx.translate(building.position.x, building.position.y);
    if (building.damageFlash > 0) ctx.shadowColor = '#ffffff';
    else ctx.shadowColor = color;
    ctx.shadowBlur = building.type === 'center' ? 18 : 7;
    ctx.fillStyle = building.owner === 'player' ? '#18241f' : '#26191c';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    if (!building.constructionComplete) ctx.setLineDash([5, 6]);

    if (building.type === 'center') {
      polygon(ctx, { x: 0, y: 0 }, 37, 8, Math.PI / 8 + state.tick * 0.0008);
      ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = rgba(color, 0.5);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 25, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillRect(-15, -3, 30, 6);
      ctx.fillStyle = '#dff7e7';
      ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
    } else if (building.type === 'house') {
      ctx.beginPath();
      ctx.moveTo(-20, 7); ctx.lineTo(-20, -7); ctx.lineTo(0, -24); ctx.lineTo(20, -7); ctx.lineTo(20, 17); ctx.lineTo(-20, 17); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = rgba(COLORS.manpower, 0.75);
      ctx.fillRect(-5, 3, 10, 14);
      if (building.level > 1) { ctx.fillRect(-15, -4, 7, 7); ctx.fillRect(8, -4, 7, 7); }
    } else if (building.type === 'depot') {
      ctx.fillRect(-23, -20, 46, 40); ctx.strokeRect(-23, -20, 46, 40);
      ctx.strokeStyle = rgba(COLORS.logistics, 0.75); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(14, 0); ctx.moveTo(0, -13); ctx.lineTo(0, 13); ctx.stroke();
      const storage = storageAtNode(state, building.nodeId);
      if (storage) {
        ctx.fillStyle = storage.autoSupplyEnabled ? COLORS.player : COLORS.enemy;
        ctx.beginPath(); ctx.arc(18, -16, 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#07120c'; ctx.font = '700 7px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(storage.autoSupplyEnabled ? 'A' : '×', 18, -16);
      }
    } else {
      polygon(ctx, { x: 0, y: 0 }, 23, 6, Math.PI / 6);
      ctx.fill(); ctx.stroke();
      const resource = BUILDING_BALANCE[building.type].productionResource;
      ctx.fillStyle = resource ? COLORS[resource] : color;
      ctx.font = '700 15px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labels: Record<string, string> = { woodCamp: 'W', quarry: 'S', coalMine: 'C', ironMine: 'I' };
      ctx.fillText(labels[building.type] ?? '?', 0, 1);
    }
    ctx.restore();

    if (!building.constructionComplete) {
      ctx.fillStyle = COLORS.logistics;
      ctx.font = '700 9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('SUPPLYING', building.position.x, building.position.y + 39);
    }

    if (healthRatio < 0.98 || building.type === 'center') {
      const width = building.type === 'center' ? 74 : 48;
      const y = building.position.y - (building.type === 'center' ? 52 : 36);
      ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(building.position.x - width / 2, y, width, 5);
      ctx.fillStyle = healthRatio > 0.45 ? COLORS.player : COLORS.enemy;
      ctx.fillRect(building.position.x - width / 2, y, width * healthRatio, 5);
    }
    if (!building.connected && building.type !== 'center') {
      ctx.strokeStyle = COLORS.enemy; ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(building.position.x - 13, building.position.y - 13); ctx.lineTo(building.position.x + 13, building.position.y + 13);
      ctx.moveTo(building.position.x + 13, building.position.y - 13); ctx.lineTo(building.position.x - 13, building.position.y + 13);
      ctx.stroke();
    }
  }

  private drawPacketRoutes(state: GameState): void {
    if (!state.debug.enabled || !state.debug.routes) return;
    const ctx = this.ctx;
    ctx.lineWidth = 1.2 / this.camera.zoom;
    ctx.setLineDash([4 / this.camera.zoom, 5 / this.camera.zoom]);
    for (const packet of state.packets.values()) {
      ctx.strokeStyle = rgba(COLORS[packet.resource], 0.28);
      ctx.beginPath();
      packet.nodePath.forEach((nodeId, index) => {
        const point = state.nodes.get(nodeId)?.position;
        if (!point) return;
        if (index === 0) ctx.moveTo(point.x, point.y); else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  private drawPackets(state: GameState): void {
    const ctx = this.ctx;
    for (const packet of state.packets.values()) {
      if (!this.isVisible(packet.position, 20)) continue;
      const color = COLORS[packet.resource];
      const radius = packet.purpose === 'assault' ? 5.2 : packet.purpose === 'construction' ? 4.6 : 4.2;
      ctx.save();
      ctx.translate(packet.position.x, packet.position.y);
      ctx.rotate(Math.PI / 4 + state.tick * 0.025);
      ctx.shadowColor = color;
      ctx.shadowBlur = packet.waiting > 0 ? 3 : 10;
      ctx.fillStyle = packet.waiting > 0 ? rgba(color, 0.4) : color;
      ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
      if (packet.purpose !== 'income') {
        ctx.strokeStyle = packet.purpose === 'assault' ? '#fff1a8' : COLORS.player;
        ctx.lineWidth = 1.4;
        ctx.strokeRect(-radius - 2, -radius - 2, radius * 2 + 4, radius * 2 + 4);
      }
      ctx.restore();
    }
  }

  private drawImpactEffects(state: GameState): void {
    const ctx = this.ctx;
    for (const impact of state.impacts) {
      const alpha = clamp(impact.life / impact.maxLife, 0, 1);
      const progress = 1 - alpha;
      const radius = impact.radius * (0.32 + progress * 0.96);
      ctx.save();
      ctx.shadowColor = impact.color;
      ctx.shadowBlur = 10 + impact.power * 8;
      ctx.strokeStyle = rgba(impact.color, alpha * 0.9);
      ctx.lineWidth = 2.5 + impact.power * 2.2;
      ctx.beginPath();
      ctx.arc(impact.position.x, impact.position.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = rgba('#ffffff', alpha * 0.78);
      ctx.lineWidth = 1.2 + impact.power * 0.55;
      ctx.beginPath();
      ctx.arc(impact.position.x, impact.position.y, radius * 0.58, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawParticles(state: GameState): void {
    const ctx = this.ctx;
    for (const particle of state.particles) {
      if (!this.isVisible(particle.position, 20)) continue;
      const alpha = clamp(particle.life / particle.maxLife, 0, 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = particle.color;
      if (particle.kind === 'smoke') {
        ctx.beginPath(); ctx.arc(particle.position.x, particle.position.y, particle.size * (2 - alpha), 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillRect(particle.position.x - particle.size / 2, particle.position.y - particle.size / 2, particle.size, particle.size);
      }
    }
    ctx.globalAlpha = 1;
    ctx.font = `600 ${12 / this.camera.zoom}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    for (const text of state.floatingTexts) {
      ctx.globalAlpha = clamp(text.life, 0, 1);
      ctx.fillStyle = text.color;
      ctx.fillText(text.text, text.position.x, text.position.y);
    }
    ctx.globalAlpha = 1;
  }

  private drawSelection(state: GameState, input: InputController): void {
    const draw = (selection: GameState['selection'], alpha: number): void => {
      if (!selection.id) return;
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
      ctx.lineWidth = 1.5 / this.camera.zoom;
      ctx.setLineDash([5 / this.camera.zoom, 4 / this.camera.zoom]);
      if (selection.kind === 'segment') {
        const segment = state.segments.get(selection.id);
        const points = segment ? this.segmentPoints(state, segment) : null;
        if (points) {
          ctx.lineWidth = TIER_BALANCE[segment?.tier ?? 'wood'].width + 11 / this.camera.zoom;
          pathLine(ctx, points[0], points[1]);
        }
      } else if (selection.kind === 'wall') {
        const wall = state.walls.get(selection.id);
        if (wall) {
          ctx.lineWidth = wall.thickness + 11 / this.camera.zoom;
          pathLine(ctx, wall.start, wall.end);
        }
      } else if (selection.kind === 'building') {
        const building = state.buildings.get(selection.id);
        if (building) {
          ctx.beginPath();
          ctx.arc(building.position.x, building.position.y, 34, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else if (selection.kind === 'resource') {
        const resource = state.resourceNodes.get(selection.id);
        if (resource) {
          ctx.beginPath();
          ctx.arc(resource.position.x, resource.position.y, resource.radius + 8, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else if (selection.kind === 'storage') {
        const storage = state.storages.get(selection.id);
        const node = storage ? state.nodes.get(storage.nodeId) : undefined;
        if (node) {
          ctx.beginPath(); ctx.arc(node.position.x, node.position.y, 15, 0, Math.PI * 2); ctx.stroke();
        }
      } else if (selection.kind === 'packet') {
        const packet = state.packets.get(selection.id);
        if (packet) {
          ctx.beginPath(); ctx.arc(packet.position.x, packet.position.y, 10 / this.camera.zoom, 0, Math.PI * 2); ctx.stroke();
        }
      }
      ctx.restore();
    };
    draw(input.hovered, 0.32);
    draw(state.selection, 0.9);
    if (state.selection.kind === 'packets') {
      for (const id of state.selection.ids ?? []) draw({ kind: 'packet', id }, 0.9);
    }
    if (input.selectionBox) {
      const { from, to } = input.selectionBox;
      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = 'rgba(114,216,232,0.12)';
      ctx.strokeStyle = COLORS.logistics;
      ctx.lineWidth = 1.5 / this.camera.zoom;
      ctx.fillRect(from.x, from.y, to.x - from.x, to.y - from.y);
      ctx.strokeRect(from.x, from.y, to.x - from.x, to.y - from.y);
      ctx.restore();
    }
  }

  private drawConstructionPreview(state: GameState, input: InputController): void {
    const ctx = this.ctx;
    if (input.redirectPreview) {
      const preview = input.redirectPreview;
      const color = preview.valid ? COLORS.logistics : COLORS.enemy;
      const points = preview.nodePath.map((nodeId) => state.nodes.get(nodeId)?.position).filter((point): point is Vec2 => Boolean(point));
      ctx.save();
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3 / this.camera.zoom;
      ctx.setLineDash(preview.routingMode === 'circulate' ? [4, 5] : [10, 6]);
      ctx.lineDashOffset = -state.tick * 0.35;
      ctx.beginPath(); ctx.moveTo(preview.from.x, preview.from.y);
      for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.lineTo(preview.to.x, preview.to.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(preview.to.x, preview.to.y, preview.routingMode === 'circulate' ? 13 : 9, 0, Math.PI * 2); ctx.stroke();
      if (preview.routingMode === 'circulate') {
        ctx.font = `700 ${11 / this.camera.zoom}px ui-monospace, monospace`;
        ctx.textAlign = 'center'; ctx.fillText('LOOP', preview.to.x, preview.to.y - 17 / this.camera.zoom);
      }
      ctx.restore();
    }
    if (input.preview) {
      const preview = input.preview;
      const color = preview.valid ? COLORS.player : COLORS.enemy;
      ctx.save();
      ctx.globalAlpha = 0.78;
      ctx.strokeStyle = color;
      ctx.lineWidth = TIER_BALANCE[input.selectedTier].width + 3;
      ctx.setLineDash([10, 7]);
      pathLine(ctx, preview.from, preview.to);
      ctx.fillStyle = rgba(color, 0.18);
      ctx.beginPath(); ctx.arc(preview.to.x, preview.to.y, WORLD.territoryRadius, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
      if (preview.impact) this.drawImpactTargetHighlight(state, preview.impact.targetKind, preview.impact.targetId);
    }
    if (input.wallPreview) {
      const preview = input.wallPreview;
      const color = preview.valid ? COLORS.player : COLORS.enemy;
      ctx.save();
      ctx.globalAlpha = 0.72;
      ctx.strokeStyle = color;
      ctx.lineWidth = WALL_BALANCE.thickness;
      ctx.setLineDash([12, 5]);
      pathLine(ctx, preview.from, preview.to);
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      for (const point of [preview.from, preview.to]) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    if (input.buildingGhost) {
      const ghost = input.buildingGhost;
      const color = ghost.valid ? COLORS.player : COLORS.enemy;
      ctx.save();
      ctx.globalAlpha = 0.52;
      ctx.fillStyle = rgba(color, 0.16);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 6]);
      ctx.beginPath(); ctx.arc(ghost.position.x, ghost.position.y, 27, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      const resource = extractorResource(ghost.type);
      if (resource) {
        ctx.strokeStyle = rgba(color, 0.35);
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 7]);
        ctx.beginPath(); ctx.arc(ghost.position.x, ghost.position.y, WORLD.resourceBuildRange, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = '700 13px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(BUILDING_BALANCE[ghost.type].label.slice(0, 2).toUpperCase(), ghost.position.x, ghost.position.y);
      ctx.restore();
    }
  }

  private drawImpactTargetHighlight(state: GameState, kind: 'cell' | 'building' | 'wall', id: string): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = '#fff1a8';
    ctx.shadowColor = COLORS.enemy;
    ctx.shadowBlur = 14;
    ctx.lineWidth = 3 / this.camera.zoom;
    ctx.setLineDash([7 / this.camera.zoom, 5 / this.camera.zoom]);
    if (kind === 'cell') {
      const cell = state.cells.get(id);
      const segment = cell ? state.segments.get(cell.segmentId) : undefined;
      if (cell && segment) {
        ctx.lineWidth = TIER_BALANCE[segment.tier].width + 10 / this.camera.zoom;
        pathLine(ctx, cell.start, cell.end);
      }
    } else if (kind === 'wall') {
      const wall = state.walls.get(id);
      if (wall) {
        ctx.lineWidth = wall.thickness + 10 / this.camera.zoom;
        pathLine(ctx, wall.start, wall.end);
      }
    } else {
      const building = state.buildings.get(id);
      if (building) {
        ctx.beginPath();
        ctx.arc(building.position.x, building.position.y, building.type === 'center' ? 49 : 34, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawDebugWorld(state: GameState): void {
    if (!state.debug.enabled) return;
    const ctx = this.ctx;
    if (state.debug.connectivity) {
      for (const node of state.nodes.values()) {
        ctx.strokeStyle = node.connected ? 'rgba(114,216,232,.75)' : 'rgba(255,101,119,.72)';
        ctx.lineWidth = 1 / this.camera.zoom;
        ctx.beginPath(); ctx.arc(node.position.x, node.position.y, 9, 0, Math.PI * 2); ctx.stroke();
      }
    }
    if (state.debug.congestion) {
      ctx.font = `600 ${9 / this.camera.zoom}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      for (const segment of state.segments.values()) {
        if (segment.loadRatio < 0.2 && segment.queuedPackets === 0) continue;
        const points = this.segmentPoints(state, segment);
        if (!points) continue;
        const mid = lerpVec(points[0], points[1], 0.5);
        ctx.fillStyle = '#ffc864';
        const capacity = effectiveDirectionalCapacity(state, segment);
        const crossPenalty = segment.trafficAB.state === 'heavy' || segment.trafficBA.state === 'heavy' ? ' · opposite ×0.5' : '';
        ctx.fillText(`x${segment.stackLevel} · A→B ${TIER_BALANCE[segment.tier].lanesPerDirection}L · ${segment.trafficAB.load.toFixed(1)}/${capacity.toFixed(1)} · ${segment.trafficAB.state.toUpperCase()} · Q${segment.trafficAB.queuedPackets}`, mid.x, mid.y - 17);
        ctx.fillText(`B→A ${TIER_BALANCE[segment.tier].lanesPerDirection}L · ${segment.trafficBA.load.toFixed(1)}/${capacity.toFixed(1)} · ${segment.trafficBA.state.toUpperCase()} · Q${segment.trafficBA.queuedPackets}${crossPenalty}`, mid.x, mid.y - 7);
      }
    }
    if (state.debug.spatial) {
      const bounds = this.camera.visibleBounds();
      const size = 180;
      ctx.strokeStyle = 'rgba(114,216,232,.13)'; ctx.lineWidth = 1;
      for (let x = Math.floor(bounds.minX / size) * size; x <= bounds.maxX; x += size) {
        for (let y = Math.floor(bounds.minY / size) * size; y <= bounds.maxY; y += size) ctx.strokeRect(x, y, size, size);
      }
    }
    if (state.debug.routes) {
      ctx.font = `600 ${8 / this.camera.zoom}px ui-monospace, monospace`;
      ctx.textAlign = 'left';
      for (const packet of state.packets.values()) {
        if (!this.isVisible(packet.position, 30)) continue;
        ctx.fillStyle = COLORS[packet.resource];
        ctx.fillText(`${packet.purpose}/${packet.routingMode}${packet.routingMode === 'circulate' ? ` cycle ${packet.circulationCycles}` : ''} → ${packet.targetStorageId ?? packet.targetCellId ?? packet.targetNode} · cruise x${packet.cruiseSpeedMultiplier.toFixed(2)} · effective x${packet.effectiveSpeedMultiplier.toFixed(2)}`, packet.position.x + 7, packet.position.y - 7);
      }
    }
  }

  private drawScreenLabels(state: GameState, input: InputController): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    const drawTag = (position: Vec2, text: string, color: string): void => {
      const screen = this.camera.worldToScreen(position);
      if (screen.x < -100 || screen.x > this.camera.viewport.width + 100 || screen.y < -50 || screen.y > this.camera.viewport.height + 50) return;
      ctx.font = '600 11px ui-monospace, monospace';
      const width = ctx.measureText(text).width + 14;
      ctx.fillStyle = 'rgba(5,9,10,.72)'; ctx.fillRect(screen.x - width / 2, screen.y + 49, width, 20);
      ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.fillText(text, screen.x, screen.y + 63);
    };
    const playerCenter = state.buildings.get(state.centerBuilding.player);
    const enemyCenter = state.buildings.get(state.centerBuilding.enemy);
    if (playerCenter) drawTag(playerCenter.position, 'LINE CENTER / PLAYER', COLORS.player);
    if (enemyCenter) drawTag(enemyCenter.position, 'PRIMARY TARGET', COLORS.enemy);

    const lines: string[] = [];
    let valid = false;
    if (input.preview) {
      const preview = input.preview;
      valid = preview.valid;
      lines.push(`${input.selectedTier.toUpperCase()} ${preview.stackNextLevel ? `STACK x${preview.stackNextLevel}` : 'ARROW'} · ${formatCost(preview.cost)}`);
      if (preview.stackNextLevel) {
        lines.push(`Layer ${preview.stackNextLevel} is supplied cell by cell · packet acceleration x${preview.stackNextLevel}`);
      } else if (preview.impact) {
        lines.push(`Damage / supply ${preview.impact.baseDamage} × ${preview.impact.multiplier.toFixed(2)} = ${preview.impact.estimatedDamage}`);
        lines.push(`Assault supply · ${formatCost(TIER_BALANCE[input.selectedTier].assaultCost)}`);
        lines.push(`First contact: ${preview.impact.targetLabel} · Holds until destroyed`);
      } else {
        lines.push(`Damage / supply ${TIER_BALANCE[input.selectedTier].damagePerSupply} · Clear route becomes a permanent Line`);
      }
      if (!preview.valid) lines.push(preview.reason);
    } else if (input.wallPreview) {
      const preview = input.wallPreview;
      valid = preview.valid;
      lines.push(`STONE WALL · ${formatCost(preview.cost)} · ${WALL_BALANCE.health} HP`);
      lines.push('Blocks Arrows · weak to Iron (2.00×)');
      if (preview.reason) lines.push(preview.reason);
    } else if (input.buildingGhost) {
      valid = input.buildingGhost.valid;
      const config = BUILDING_BALANCE[input.buildingGhost.type];
      lines.push(config.label.toUpperCase());
      if (config.requiredNode) {
        lines.push(`Efficiency: ${Math.round(input.buildingGhost.extractionEfficiency * 100)}%`);
        lines.push(`Expected production: ${(input.buildingGhost.actualProductionPerSecond * 60).toFixed(1)} ${config.productionResource} / min`);
      }
      lines.push(input.buildingGhost.reason);
    } else if (input.redirectPreview) {
      valid = input.redirectPreview.valid;
      lines.push(input.redirectPreview.routingMode === 'circulate' ? 'REDIRECT · CIRCULATING LOOP' : 'REDIRECT · STORAGE DESTINATION');
      lines.push(input.redirectPreview.reason);
      lines.push('Click to confirm · Right-click or Esc to cancel');
    }
    if (lines.length > 0) {
      ctx.font = '600 12px ui-monospace, monospace';
      const width = Math.min(440, Math.max(...lines.map((line) => ctx.measureText(line).width)) + 18);
      const x = clamp(input.pointerScreen.x + 18, 8, this.camera.viewport.width - width - 8);
      const height = 10 + lines.length * 18;
      const y = clamp(input.pointerScreen.y + 18, 88, this.camera.viewport.height - height - 18);
      ctx.fillStyle = 'rgba(7,11,12,.92)'; ctx.fillRect(x, y, width, height);
      ctx.textAlign = 'left';
      lines.forEach((line, index) => {
        ctx.fillStyle = index === lines.length - 1 && !valid ? COLORS.enemy : index === 0 ? (valid ? COLORS.player : COLORS.enemy) : '#d5e4dc';
        ctx.fillText(line, x + 9, y + 18 + index * 18);
      });
    }
    ctx.restore();
  }

  private drawMinimap(state: GameState): void {
    const ctx = this.minimapCtx;
    const width = this.minimap.width;
    const height = this.minimap.height;
    const sx = width / state.worldSize.x;
    const sy = height / state.worldSize.y;
    ctx.fillStyle = '#0b1213'; ctx.fillRect(0, 0, width, height);
    for (const terrain of state.terrain) {
      ctx.save(); ctx.translate(terrain.position.x * sx, terrain.position.y * sy); ctx.rotate(terrain.rotation);
      ctx.beginPath(); ctx.ellipse(0, 0, terrain.radiusX * sx, terrain.radiusY * sy, 0, 0, Math.PI * 2);
      ctx.fillStyle = terrain.kind === 'water' ? 'rgba(53,108,118,.65)' : terrain.kind === 'ridge' ? 'rgba(87,92,83,.7)' : 'rgba(108,107,77,.18)';
      ctx.fill(); ctx.restore();
    }
    for (const resource of state.resourceNodes.values()) {
      if (resource.amount <= 0) continue;
      ctx.fillStyle = COLORS[resource.type]; ctx.globalAlpha = 0.65;
      ctx.fillRect(resource.position.x * sx - 1, resource.position.y * sy - 1, 2, 2);
    }
    ctx.globalAlpha = 1; ctx.lineCap = 'round';
    for (const segment of state.segments.values()) {
      if (segment.constructionState !== 'complete') continue;
      ctx.strokeStyle = segment.owner === 'player' ? COLORS.player : COLORS.enemy;
      ctx.globalAlpha = segment.connected ? 0.9 : 0.3;
      ctx.lineWidth = segment.tier === 'iron' ? 2.1 : segment.tier === 'stone' ? 1.5 : 1;
      for (const cell of cellsOf(state, segment)) {
        if (cell.state !== 'intact' || cell.health <= 0) continue;
        ctx.beginPath(); ctx.moveTo(cell.start.x * sx, cell.start.y * sy); ctx.lineTo(cell.end.x * sx, cell.end.y * sy); ctx.stroke();
      }
    }
    for (const wall of state.walls.values()) {
      ctx.strokeStyle = wall.owner === 'player' ? COLORS.player : COLORS.enemy;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(wall.start.x * sx, wall.start.y * sy);
      ctx.lineTo(wall.end.x * sx, wall.end.y * sy);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const building of state.buildings.values()) {
      if (building.type !== 'center') continue;
      ctx.fillStyle = building.owner === 'player' ? COLORS.player : COLORS.enemy;
      ctx.beginPath(); ctx.arc(building.position.x * sx, building.position.y * sy, 4, 0, Math.PI * 2); ctx.fill();
    }
    const visible = this.camera.visibleBounds();
    ctx.strokeStyle = 'rgba(255,255,255,.72)'; ctx.lineWidth = 1;
    ctx.strokeRect(visible.minX * sx, visible.minY * sy, (visible.maxX - visible.minX) * sx, (visible.maxY - visible.minY) * sy);
    ctx.strokeStyle = 'rgba(121,230,165,.25)'; ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
  }

  private segmentPoints(state: GameState, segment: LineSegment): [Vec2, Vec2] | null {
    const a = state.nodes.get(segment.a)?.position;
    const b = state.nodes.get(segment.b)?.position;
    return a && b ? [a, b] : null;
  }
}
