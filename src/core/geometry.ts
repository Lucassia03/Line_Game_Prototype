import type { Vec2 } from './types';

export const vec = (x = 0, y = 0): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, value: number): Vec2 => ({ x: a.x * value, y: a.y * value });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const lengthSq = (a: Vec2): number => dot(a, a);
export const length = (a: Vec2): number => Math.sqrt(lengthSq(a));
export const distanceSq = (a: Vec2, b: Vec2): number => lengthSq(sub(a, b));
export const distance = (a: Vec2, b: Vec2): number => Math.sqrt(distanceSq(a, b));
export const normalize = (a: Vec2): Vec2 => {
  const len = length(a);
  return len > 0.0001 ? scale(a, 1 / len) : vec();
};
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerpVec = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
export const saturate = (value: number): number => clamp(value, 0, 1);
export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = saturate((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

export function closestPointOnSegment(point: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number; distance: number } {
  const ab = sub(b, a);
  const denominator = lengthSq(ab);
  const t = denominator <= 0.0001 ? 0 : clamp(dot(sub(point, a), ab) / denominator, 0, 1);
  const projected = lerpVec(a, b, t);
  return { point: projected, t, distance: distance(point, projected) };
}

function orientation(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
}

export function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

export function segmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    closestPointOnSegment(a, c, d).distance,
    closestPointOnSegment(b, c, d).distance,
    closestPointOnSegment(c, a, b).distance,
    closestPointOnSegment(d, a, b).distance,
  );
}

export function pointInEllipse(point: Vec2, center: Vec2, radiusX: number, radiusY: number, rotation = 0): boolean {
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const x = dx * cos - dy * sin;
  const y = dx * sin + dy * cos;
  return (x * x) / (radiusX * radiusX) + (y * y) / (radiusY * radiusY) <= 1;
}

export function formatNumber(value: number): string {
  return Math.floor(value).toLocaleString('en-US');
}
