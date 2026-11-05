// A probe run as Markdown, for results/ and docs/game/mode-probes.md.
import type { Probe, Size, Verdict } from './probe.ts';

export interface RunInfo { commit: string; stamp: string; adapter: string; software: boolean; host: string; size: Size; wallS: number; runs: number }

export function probeMarkdown(p: Probe, v: Verdict, info: RunInfo): string {
  const verdict = v.pass === null ? 'not decided at this size' : v.pass ? 'PASS' : 'FAIL';
  return [
    `### ${p.id} ${p.title}: ${verdict}`,
    '',
    `${p.question}`,
    '',
    `Rule: ${p.rule}`,
    '',
    `Commit \`${info.commit}\`, ${info.stamp}, ${info.host}, ${info.adapter}${info.software ? ' (software adapter: physics valid, timings are not performance results)' : ''}; size ${info.size}, ${info.runs} runs, ${info.wallS.toFixed(0)} s.`,
    '',
    ...v.checks.map((c) => `- ${c.pass ? 'pass' : '**FAIL**'}: ${c.name} (${c.detail})`),
    '',
    ...v.table,
  ].join('\n');
}
