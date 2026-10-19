export class UIInteractionGuard {
  private pointerId: number | null = null;

  get blocksRefresh(): boolean {
    return this.pointerId !== null;
  }

  begin(pointerId: number): void {
    if (this.pointerId === null) this.pointerId = pointerId;
  }

  release(pointerId: number): boolean {
    if (this.pointerId !== pointerId) return false;
    this.pointerId = null;
    return true;
  }

  cancel(): void {
    this.pointerId = null;
  }
}

export function claimUIControlPointer(event: { pointerId: number; stopPropagation: () => void }, guard: UIInteractionGuard): void {
  event.stopPropagation();
  guard.begin(event.pointerId);
}
