// Small dense linear algebra for the per-body AVBD update.

/**
 * Solve A x = b for a symmetric positive definite 6x6 A (row-major, 36
 * entries) with an LDL^T factorization (no square roots, as in the AVBD
 * reference). Writes x into out; A and b are not modified.
 */
export function solveSpd6(A: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array): void {
  const L = new Float64Array(36), D = new Float64Array(6);
  for (let j = 0; j < 6; j++) {
    let d = A[6 * j + j]!;
    for (let k = 0; k < j; k++) d -= L[6 * j + k]! * L[6 * j + k]! * D[k]!;
    D[j] = d;
    for (let i = j + 1; i < 6; i++) {
      let s = A[6 * i + j]!;
      for (let k = 0; k < j; k++) s -= L[6 * i + k]! * L[6 * j + k]! * D[k]!;
      L[6 * i + j] = s / d;
    }
  }
  for (let i = 0; i < 6; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= L[6 * i + k]! * out[k]!;
    out[i] = s;
  }
  for (let i = 0; i < 6; i++) out[i] = out[i]! / D[i]!;
  for (let i = 5; i >= 0; i--) {
    let s = out[i]!;
    for (let k = i + 1; k < 6; k++) s -= L[6 * k + i]! * out[k]!;
    out[i] = s;
  }
}
