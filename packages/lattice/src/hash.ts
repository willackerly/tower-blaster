// A uniform grid over bounding boxes, for neighbour queries among bodies
// that are not on a lattice (rubble, and the active set each step).
import type { Vec3 } from '@tb/engine-api';

export class BoxHash {
  private cells = new Map<string, number[]>();
  private boxes = new Map<number, [number, number, number, number, number, number]>();

  constructor(readonly size: number) {}

  get count(): number { return this.boxes.size; }

  insert(id: number, center: Vec3, r: number): void {
    const s = this.size;
    const b: [number, number, number, number, number, number] = [
      Math.floor((center[0] - r) / s), Math.floor((center[1] - r) / s), Math.floor((center[2] - r) / s),
      Math.floor((center[0] + r) / s), Math.floor((center[1] + r) / s), Math.floor((center[2] + r) / s),
    ];
    this.boxes.set(id, b);
    for (let x = b[0]; x <= b[3]; x++) for (let y = b[1]; y <= b[4]; y++) for (let z = b[2]; z <= b[5]; z++) {
      const key = `${x},${y},${z}`;
      const list = this.cells.get(key);
      if (list) list.push(id); else this.cells.set(key, [id]);
    }
  }

  remove(id: number): void {
    const b = this.boxes.get(id);
    if (!b) return;
    this.boxes.delete(id);
    for (let x = b[0]; x <= b[3]; x++) for (let y = b[1]; y <= b[4]; y++) for (let z = b[2]; z <= b[5]; z++) {
      const key = `${x},${y},${z}`;
      const list = this.cells.get(key)!;
      list.splice(list.indexOf(id), 1);
      if (!list.length) this.cells.delete(key);
    }
  }

  /** Ids whose boxes may overlap the box [lo, hi], ascending. */
  query(lo: Vec3, hi: Vec3): number[] {
    const s = this.size, out = new Set<number>();
    const x0 = Math.floor(lo[0] / s), y0 = Math.floor(lo[1] / s), z0 = Math.floor(lo[2] / s);
    const x1 = Math.floor(hi[0] / s), y1 = Math.floor(hi[1] / s), z1 = Math.floor(hi[2] / s);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      for (const id of this.cells.get(`${x},${y},${z}`) ?? []) out.add(id);
    }
    return [...out].sort((a, b) => a - b);
  }
}
