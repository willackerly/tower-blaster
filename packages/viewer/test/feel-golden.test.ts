// O4's golden test, the viewer's half (docs/design/options.md): the game's feel options through the
// viewer's URL and its scene file, recorded from main at 1d7158e before the options moved to one
// module each. Outputs in golden/feel-golden.json; never regenerate them. A later option is not in
// the record: a scene written for a recorded case may gain nothing, since only a value off its default
// is written (hitstop and slowmo always are), so these compare whole strings and objects.
import { describe, expect, it } from 'vitest';
import { FEEL_SEARCHES, FLIPPED_FEEL_SEARCH, SCENE_BAD } from '../../game/test/golden/options-cases.ts';
import { parseSceneFile, parseViewerConfig, sceneFile, toSearch } from '../src/index.ts';
import golden from './golden/feel-golden.json' with { type: 'json' };

const AT = new Date(Date.UTC(2026, 10, 7));
const base = '?level=L1&rules=keystone';

describe('the feel options in the viewer, as recorded before the registry (O4)', () => {
  it("the URL and the scene file's rules, and the scene file read back", () => {
    const searches = [base, `${base}&${FLIPPED_FEEL_SEARCH}`, ...FEEL_SEARCHES.filter((s) => !s.endsWith('=')).map((s) => `${base}&${s}`)];
    const got = searches.flatMap((search) => {
      let c;
      try { c = parseViewerConfig(search); } catch { return []; }
      const f = sceneFile(c, '', null, AT);
      return [{ search, toSearch: toSearch(c), rules: f.rules, back: toSearch(parseSceneFile(JSON.stringify(f)).config) }];
    });
    expect(got.map((g) => g.search)).toEqual(golden.scenes.map((g) => g.search));
    got.forEach((g, i) => expect(g, g.search).toEqual(golden.scenes[i]));
  });

  it("a scene file's bad rule values are refused with the same words", () => {
    const f = sceneFile(parseViewerConfig(base), '', null, AT);
    expect(SCENE_BAD.length).toBe(golden.bad.length);
    SCENE_BAD.forEach((patch, i) => {
      let error: string | null = null;
      try { parseSceneFile(JSON.stringify({ ...f, rules: { ...f.rules, ...patch } })); } catch (e) { error = (e as Error).message; }
      expect(error, JSON.stringify(patch)).toBe(golden.bad[i]!.error);
    });
  });
});
