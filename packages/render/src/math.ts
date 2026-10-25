// Column-major 4x4 matrices (WebGPU/WGSL convention), clip depth 0..1.
export type Mat4 = Float32Array;
export type V3 = [number, number, number];

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (far * near) / (near - far);
  return m;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const normalize = (a: V3): V3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function lookAt(eye: V3, target: V3, up: V3 = [0, 1, 0]): Mat4 {
  const z = normalize(sub(eye, target));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
    o[c * 4 + r] = s;
  }
  return o;
}

export function invert(m: Mat4): Mat4 {
  // Gauss-Jordan on a 4x8 augmented matrix, in float64.
  const a = Array.from({ length: 4 }, (_, r) => [...Array.from({ length: 4 }, (_, c) => m[c * 4 + r]!), ...[0, 1, 2, 3].map((c) => (c === r ? 1 : 0))]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
    if (Math.abs(a[p]![c]!) < 1e-12) throw new Error('singular matrix');
    [a[c], a[p]] = [a[p]!, a[c]!];
    const d = a[c]![c]!;
    for (let k = 0; k < 8; k++) a[c]![k]! /= d;
    for (let r = 0; r < 4; r++) if (r !== c) {
      const f = a[r]![c]!;
      for (let k = 0; k < 8; k++) a[r]![k]! -= f * a[c]![k]!;
    }
  }
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = a[r]![4 + c]!;
  return o;
}

export function transform(m: Mat4, p: V3, w = 1): [number, number, number, number] {
  return [0, 1, 2, 3].map((r) => m[r]! * p[0] + m[4 + r]! * p[1] + m[8 + r]! * p[2] + m[12 + r]! * w) as [number, number, number, number];
}

export function ortho(l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = 2 / (r - l);
  m[5] = 2 / (t - b);
  m[10] = 1 / (n - f);
  m[12] = -(r + l) / (r - l);
  m[13] = -(t + b) / (t - b);
  m[14] = n / (n - f);
  m[15] = 1;
  return m;
}
