// The weapon editor's pure parts (weapon-editor.ts) and its URL keys (params.ts weapon.tier,
// weapon.edit, weapon.preview; tierRefusal): the side view draws the preview's tracks, splits and
// blasts; the budget's bars are the tier's caps; a weapon over the tier is refused on fire.
import { describe, expect, it } from 'vitest';
import { encodeWeaponParam } from '../src/projectile.ts';
import { CLUSTER, DEFAULT_GRENADE, FIREWORK, GRENADE_XL, type WeaponSpec } from '@tb/weapons';
import { parseViewerConfig, tierRefusal, toSearch, weaponTierOf } from '../src/params.ts';
import { arcSvg, budgetHtml, previewSummary, sidePreview } from '../src/weapon-editor.ts';

describe('weapon editor: side view and budget', () => {
  it('the side view has a track per munition, a dot per split and a sphere per blast', () => {
    const p = sidePreview(FIREWORK, 60, 35);
    const svg = arcSvg(p);
    expect(svg.match(/class="track"/g)).toHaveLength(13);
    expect(svg.match(/class="split"/g)).toHaveLength(1);
    expect(svg.match(/class="blast"/g)).toHaveLength(12);
    expect(svg).not.toMatch(/NaN|Infinity/);
    expect(previewSummary(p)).toMatch(/^splits at [\d.]+ s; 12 blasts from [\d.]+ to [\d.]+ s$/);
  });

  it('the cluster fired flat splits near the ground (its near 3 sees it) and blows six times', () => {
    const p = sidePreview(CLUSTER, 10, 30);
    expect(p.tracks[0]!.end).toBe('split');
    expect(p.blasts).toHaveLength(6);
  });

  it('the budget: three bars against the tier, over in red', () => {
    const low = budgetHtml(GRENADE_XL, 'low');
    expect(low).toMatch(/data-k="grenades"/);
    expect(low).toMatch(/class="bud over" data-k="grenades"/);
    expect(low).toMatch(/fits high only/);
    const high = budgetHtml(GRENADE_XL, 'high');
    expect(high).not.toMatch(/over/);
    expect(budgetHtml(FIREWORK, 'low')).toMatch(/<span>13 \/ 32<\/span>/);
  });
});

describe('weapon.tier, weapon.edit, weapon.preview', () => {
  it('round trip through the URL; absent by default', () => {
    const c = parseViewerConfig('?scenario=S1&weapon.tier=low&weapon.edit=1&weapon.preview=1');
    expect(c.weapons).toEqual({ tier: 'low', edit: true, preview: true });
    expect(parseViewerConfig(toSearch(c)).weapons).toEqual(c.weapons);
    expect(toSearch(parseViewerConfig('?scenario=S1'))).not.toMatch(/weapon\./);
    expect(() => parseViewerConfig('?weapon.tier=huge')).toThrow(/weapon.tier must be one of low, mid, high/);
    expect(() => parseViewerConfig('?weapon.edit=yes')).toThrow(/weapon.edit must be 0 or 1/);
  });

  it('the tier: as set, else high on a GPU engine and mid on CPU physics', () => {
    expect(weaponTierOf({ engine: 'avbd-gpu', weapons: { tier: null, edit: false, preview: false } })).toBe('high');
    expect(weaponTierOf({ engine: 'rapier', weapons: { tier: null, edit: false, preview: false } })).toBe('mid');
    expect(weaponTierOf({ engine: 'rapier', weapons: { tier: 'low', edit: false, preview: false } })).toBe('low');
  });

  it('a weapon over the tier is refused on fire, naming the tier that fires it', () => {
    const xl = parseViewerConfig('?scenario=S1&engine=rapier&proj.weapon=grenadexl');
    expect(tierRefusal(xl)).toMatch(/^grenadexl not fired: 16\.00 grenades a shot is over the mid tier's cap of 8 .*weapon\.tier=high fires it anyway/);
    expect(tierRefusal({ ...xl, weapons: { ...xl.weapons, tier: 'high' } })).toBeNull();
    expect(tierRefusal(parseViewerConfig('?scenario=S1&engine=rapier&proj.weapon=firework&weapon.tier=low'))).toBeNull();
    expect(tierRefusal(parseViewerConfig('?scenario=S1'))).toBeNull();
  });

  it('a shared weapon (weapon.def) over every tier is refused on every tier', () => {
    const swarm: WeaponSpec = {
      version: 1, name: 'swarm', shell: { shape: { kind: 'sphere', radius: 0.5 }, density: 4, speed: [10, 20] },
      rules: [{ when: { after: 1 }, do: [{ split: { into: 14, child: 'mid', at: 8 } }] }],
      children: { mid: { shell: { shape: { kind: 'sphere', radius: 0.1 }, density: 4 }, rules: [{ when: { after: 1 }, do: [{ split: { into: 14, child: 'bit', at: 2 } }] }],
        children: { bit: { shell: { shape: { kind: 'sphere', radius: 0.05 }, density: 4 }, rules: [{ when: { after: 1 }, do: [{ blast: { radius: 1, impulse: 1 } }, { remove: true }] }] } } } },
    };
    const c = parseViewerConfig(`?scenario=S1&proj.weapon=swarm&weapon.def=${encodeWeaponParam(swarm)}&weapon.tier=high`);
    const why = tierRefusal(c)!;
    expect(why).toMatch(/196 blasts a shot is over the high tier's cap of 128 \(over every tier\)/);
    expect(why).not.toMatch(/fires it anyway/);
  });

  it('the grenade\'s knobs count as the grenade they run as', () => {
    expect(tierRefusal(parseViewerConfig('?scenario=S1&proj.weapon=grenade&weapon.tier=low'))).toBeNull();
    const big = parseViewerConfig(`?scenario=S1&proj.weapon=grenade&grenade.radius=${DEFAULT_GRENADE.blast.radius * 3}&weapon.tier=low`);
    expect(tierRefusal(big)).toMatch(/grenades a shot is over the low tier's cap of 4/);
  });
});
