// Pinned bodies (roadmap C8): a body bolted to the world, as solid as the
// ground. Bins, walls, anchors and fixed scenery for the placement modes (M8
// Mason's Trial, M10 Rube Lab) are pinned boxes. Every engine applies it as
// this file says, and the shared case in @tb/testkit's pinned.ts checks it.
//
// A pinned body (BodyDesc.pinned) never moves: its pose stays exactly as it
// was given (bit for bit, as the engine holds it), its velocities are 0 (the
// description's are ignored), and it feels no gravity, no blast, no field
// kick (field.ts), no force (force.ts) and no contact. It is never the
// child of a relative spawn (spawn.ts): it is placed in world coordinates. To every body that touches it, it is an
// infinite mass: they solve against its fixed pose, as against the ground.
// Contacts between two pinned bodies, or a pinned body and the ground, do
// nothing (both ends are fixed). A snapshot reports it with awake 0, as a
// sleeper: it is not solved. It never wakes, and it wakes nothing by being
// there: a group of sleepers on one pin is not joined through it, as the
// ground joins nothing.
//
// It may be removed (remove.ts) like any body: from that step on it is a
// tombstone, and whatever rested on it falls.
//
// Engines that cannot hold one refuse it, at init() or push(), before
// anything changes (the tiered engine; the AVBD engines with
// AvbdParams.restitution on, where the bounce pass does not know anchors
// yet: docs/design/gravity-and-pins.md).
import type { BodyDesc, SceneDesc } from './index.ts';

/** Whether a body is pinned (BodyDesc.pinned). */
export const isPinned = (b: BodyDesc): boolean => b.pinned === true;

/** Whether a scene holds a pinned body at init or spawns one in its inputs. */
export const scenePins = (scene: Pick<SceneDesc, 'bodies' | 'inputs'>): boolean => scene.bodies.some(isPinned) || scene.inputs.some((e) => e.kind === 'spawn' && isPinned(e.body));
