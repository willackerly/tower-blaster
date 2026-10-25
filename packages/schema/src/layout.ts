// Host-shareable struct layout following the WGSL spec's alignment rules
// (https://www.w3.org/TR/WGSL/#alignment-and-size). One definition drives
// both the WGSL declaration and the TypeScript reader/writer, so the CPU and
// GPU views of a buffer cannot drift apart.

export type Scalar = 'f32' | 'u32' | 'i32';
export type FieldType =
  | Scalar
  | 'vec2f' | 'vec3f' | 'vec4f'
  | 'vec2u' | 'vec3u' | 'vec4u'
  | 'vec2i' | 'vec3i' | 'vec4i'
  | 'mat4x4f';

interface TypeInfo { align: number; size: number; scalar: Scalar; components: number }

const TYPES: Record<FieldType, TypeInfo> = {
  f32: { align: 4, size: 4, scalar: 'f32', components: 1 },
  u32: { align: 4, size: 4, scalar: 'u32', components: 1 },
  i32: { align: 4, size: 4, scalar: 'i32', components: 1 },
  vec2f: { align: 8, size: 8, scalar: 'f32', components: 2 },
  vec3f: { align: 16, size: 12, scalar: 'f32', components: 3 },
  vec4f: { align: 16, size: 16, scalar: 'f32', components: 4 },
  vec2u: { align: 8, size: 8, scalar: 'u32', components: 2 },
  vec3u: { align: 16, size: 12, scalar: 'u32', components: 3 },
  vec4u: { align: 16, size: 16, scalar: 'u32', components: 4 },
  vec2i: { align: 8, size: 8, scalar: 'i32', components: 2 },
  vec3i: { align: 16, size: 12, scalar: 'i32', components: 3 },
  vec4i: { align: 16, size: 16, scalar: 'i32', components: 4 },
  mat4x4f: { align: 16, size: 64, scalar: 'f32', components: 16 },
};

export interface Field {
  name: string;
  type: FieldType;
  offset: number;
  size: number;
  scalar: Scalar;
  components: number;
  doc?: string;
}

export interface StructLayout {
  name: string;
  fields: Field[];
  align: number;
  /** Size of one struct, which is also the array stride. */
  size: number;
  doc?: string;
}

export type FieldSpec = [name: string, type: FieldType, doc?: string];

const roundUp = (k: number, n: number) => Math.ceil(n / k) * k;

export function defineStruct(name: string, specs: FieldSpec[], doc?: string): StructLayout {
  if (specs.length === 0) throw new Error(`struct ${name} has no fields`);
  const seen = new Set<string>();
  let offset = 0;
  let align = 0;
  const fields: Field[] = [];
  for (const [fname, type, fdoc] of specs) {
    if (seen.has(fname)) throw new Error(`struct ${name}: duplicate field ${fname}`);
    seen.add(fname);
    const t = TYPES[type];
    offset = roundUp(t.align, offset);
    fields.push({ name: fname, type, offset, size: t.size, scalar: t.scalar, components: t.components, ...(fdoc ? { doc: fdoc } : {}) });
    offset += t.size;
    align = Math.max(align, t.align);
  }
  return { name, fields, align, size: roundUp(align, offset), ...(doc ? { doc } : {}) };
}

export function field(s: StructLayout, name: string): Field {
  const f = s.fields.find((x) => x.name === name);
  if (!f) throw new Error(`struct ${s.name} has no field ${name}`);
  return f;
}

export type StructValue = Record<string, number | ArrayLike<number>>;

/** Write struct element `index` of an array of `s` into `view`. */
export function writeStruct(view: DataView, s: StructLayout, index: number, value: StructValue): void {
  const base = index * s.size;
  for (const f of s.fields) {
    const v = value[f.name];
    if (v === undefined) continue;
    const comps = typeof v === 'number' ? [v] : v;
    if (comps.length !== f.components) {
      throw new Error(`${s.name}.${f.name}: expected ${f.components} components, got ${comps.length}`);
    }
    for (let c = 0; c < f.components; c++) setScalar(view, base + f.offset + 4 * c, f.scalar, comps[c]!);
  }
}

export function readStruct(view: DataView, s: StructLayout, index: number): Record<string, number[]> {
  const base = index * s.size;
  const out: Record<string, number[]> = {};
  for (const f of s.fields) {
    const comps: number[] = [];
    for (let c = 0; c < f.components; c++) comps.push(getScalar(view, base + f.offset + 4 * c, f.scalar));
    out[f.name] = comps;
  }
  return out;
}

function setScalar(view: DataView, at: number, scalar: Scalar, v: number): void {
  if (scalar === 'f32') view.setFloat32(at, v, true);
  else if (scalar === 'u32') view.setUint32(at, v, true);
  else view.setInt32(at, v, true);
}

function getScalar(view: DataView, at: number, scalar: Scalar): number {
  if (scalar === 'f32') return view.getFloat32(at, true);
  if (scalar === 'u32') return view.getUint32(at, true);
  return view.getInt32(at, true);
}
