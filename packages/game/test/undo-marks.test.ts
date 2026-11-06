// UndoMarks (play.ts's undo checkpoints by shot, docs/game/undo.md): one per shot, within a byte budget,
// the oldest first to go; room is made before a mark is taken, and a mark that alone would not fit is
// not taken. Every mark let go is disposed exactly once.
import { describe, expect, it } from 'vitest';
import { UndoMarks } from '../src/undo-marks.ts';

class Mark {
  disposed = 0;
  constructor(readonly shot: number, readonly bytes: number) {}
  dispose() { this.disposed++; }
}

function setup() {
  const made: Mark[] = [];
  const m = new UndoMarks<Mark>();
  const take = (k: number, budget: number, bytes = 10) => m.take(k, budget, () => { const x = new Mark(k, bytes); made.push(x); return x; });
  return { m, made, take };
}

describe('UndoMarks', () => {
  it('keeps one mark per shot; pop takes the last back and drops later ones', () => {
    const { m, made, take } = setup();
    for (let k = 0; k < 3; k++) expect(take(k, 100)!.shot).toBe(k);
    expect(m.held).toEqual({ marks: 3, bytes: 30 });
    const two = m.pop(2)!;
    expect(two.shot).toBe(2);
    expect(two.disposed).toBe(0); // the caller's now
    expect(m.held).toEqual({ marks: 2, bytes: 20 });
    // A new shot 2 replaces nothing left over; shot 1 again drops shot 2's mark.
    take(2, 100);
    take(1, 100);
    expect(made.map((x) => [x.shot, x.disposed])).toEqual([[0, 0], [1, 1], [2, 0], [2, 1], [1, 0]]);
    expect(m.held).toEqual({ marks: 2, bytes: 20 });
  });

  it('within the budget: the oldest go first, room is made before the next is taken', () => {
    const { m, made, take } = setup();
    for (let k = 0; k < 5; k++) take(k, 35);
    // 35 bytes hold three marks of 10; the first two went, each disposed once, before the new ones were taken.
    expect(m.held).toEqual({ marks: 3, bytes: 30 });
    expect(made.map((x) => x.disposed)).toEqual([1, 1, 0, 0, 0]);
    expect(m.pop(1)).toBeNull();
    expect(m.held).toEqual({ marks: 0, bytes: 0 });
    expect(made.map((x) => x.disposed)).toEqual([1, 1, 1, 1, 1]);
  });

  it('budget 0 takes nothing; a mark over the budget alone is let go, and then none is taken while they cost that much', () => {
    const { m, made, take } = setup();
    expect(take(0, 0)).toBeNull();
    expect(made).toEqual([]);
    expect(take(1, 5, 10)).toBeNull();
    expect(made.map((x) => x.disposed)).toEqual([1]);
    expect(take(2, 5, 10)).toBeNull();
    expect(made.length).toBe(1); // not even made
    // More memory: taken again.
    expect(take(3, 50, 10)!.shot).toBe(3);
    expect(m.held).toEqual({ marks: 1, bytes: 10 });
  });

  it('a make() that gives nothing (an engine without checkpoints) leaves a gap; pop of a gap is null', () => {
    const { m, take } = setup();
    take(0, 100);
    m.take(1, 100, () => null);
    take(2, 100);
    expect(m.held.marks).toBe(2);
    expect(m.pop(2)!.shot).toBe(2);
    expect(m.pop(1)).toBeNull();
    expect(m.pop(0)!.shot).toBe(0);
  });
});
