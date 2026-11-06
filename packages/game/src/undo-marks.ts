// Undo checkpoints by shot (play.ts; docs/game/undo.md): mark k is the world just before shot k went
// in, or null where none was kept. Taken as each shot goes in, within a byte budget (PaceFeel.undoMB):
// the oldest go first, room is made before a new one is taken (so the copy never overshoots), and one
// that alone would not fit is not taken at all.

/** Something held for undo: what it costs, and how to let it go. */
export interface Held { readonly bytes: number; dispose(): void }

export class UndoMarks<T extends Held> {
  private marks: Array<T | null> = [];
  /** Bytes of the last mark taken: what the next is expected to cost (shots on one level cost about the same). */
  private expect = 0;

  /** The marks held now and their bytes. */
  get held(): { marks: number; bytes: number } {
    return { marks: this.marks.filter((m) => m !== null).length, bytes: this.bytes() };
  }

  private bytes(): number {
    return this.marks.reduce((a, m) => a + (m?.bytes ?? 0), 0);
  }

  /** Keep the marks of the first k shots only (dispose the rest). */
  drop(k: number): void {
    for (const m of this.marks.splice(k)) m?.dispose();
  }

  /** Free the oldest marks until `bytes() + extra` fits in `budget`. */
  private fit(budget: number, extra: number): void {
    for (let i = 0; i < this.marks.length && this.bytes() + extra > budget; i++) {
      this.marks[i]?.dispose();
      this.marks[i] = null;
    }
  }

  /**
   * Mark shot k (marks for shots k and later are dropped first): `make()` takes it, unless the budget
   * is 0 or the last mark alone was over it. The oldest go to make room, before and after.
   */
  take(k: number, budget: number, make: () => T | null): T | null {
    this.drop(k);
    while (this.marks.length < k) this.marks.push(null);
    let m: T | null = null;
    if (budget > 0 && this.expect <= budget) {
      this.fit(budget, this.expect);
      m = make();
    }
    if (m) this.expect = m.bytes;
    this.marks.push(m);
    this.fit(budget, 0);
    return this.marks[k] ?? null;
  }

  /** Take mark k out (it is the caller's to dispose), dropping it and every later one; null if none is held. */
  pop(k: number): T | null {
    const m = this.marks[k] ?? null;
    if (m) this.marks[k] = null;
    this.drop(k);
    return m;
  }
}
