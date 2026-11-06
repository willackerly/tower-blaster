// Bullet Time's frozen look (frozen-look.ts, playtest PT8): the grade's easing and what the renderer is given.
// The frame itself is tested in @tb/render (render.test.ts) and on the game page (freeze-e2e.test.ts).
import { describe, expect, it } from 'vitest';
import { easeGrade, FROZEN_HEAT, FROZEN_IN_S, FROZEN_LABEL, FROZEN_OUT_S, freezeFxOf } from '../src/frozen-look.ts';

describe('frozen look', () => {
  it('the grade eases in over FROZEN_IN_S and out over FROZEN_OUT_S, linearly, never past its target', () => {
    expect(easeGrade(0, 1, FROZEN_IN_S / 2)).toBeCloseTo(0.5, 9);
    expect(easeGrade(0.5, 1, FROZEN_IN_S)).toBe(1);
    expect(easeGrade(1, 0, FROZEN_OUT_S / 4)).toBeCloseTo(0.75, 9);
    expect(easeGrade(0.1, 0, 1)).toBe(0);
    expect(easeGrade(1, 1, 0.1)).toBe(1);
    expect(easeGrade(0, 0, 0.1)).toBe(0);
  });

  it('none of it when unfrozen; at full grade no sparks drawn and the heat glow at FROZEN_HEAT', () => {
    expect(freezeFxOf(0)).toEqual({ grade: 0, sparks: 1, heat: 1 });
    const full = freezeFxOf(1);
    expect([full.grade, full.sparks]).toEqual([1, 0]);
    expect(full.heat).toBeCloseTo(FROZEN_HEAT, 12);
    expect(freezeFxOf(0.5).sparks).toBeCloseTo(0.5, 9);
  });

  it('the label says what to do, and how to resume on a keyboard and on a touch screen', () => {
    expect(FROZEN_LABEL).toMatch(/FROZEN<\/b> · aim and fire/);
    expect(FROZEN_LABEL).toMatch(/kg-desk[^>]*> · <kbd>T<\/kbd> resumes/);
    expect(FROZEN_LABEL).toMatch(/kg-tch[^>]*> · Resume to go on/);
  });
});
