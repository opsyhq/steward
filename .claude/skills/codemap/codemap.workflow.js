// codemap.workflow.js — annotated codemap of a subsystem, refined by reliability+readability critics.
//
// Invoke:
//   Workflow({ scriptPath: "<skill-dir>/codemap.workflow.js", args: {
//     workdir: "/abs/repo",
//     questions: "Q1 ... Q2 ...",
//     groups: [{ id, title, files: ["rel/path.ts"], focus: "what to extract" }] } })
//
// Returns { codemap, history, chosenRound }. Render `codemap` in chat (strip any leaked preamble).
export const meta = {
  name: 'codemap',
  description: 'Annotated codemap of a subsystem, refined by reliability+readability critics',
  phases: [{ title: 'Map' }, { title: 'Draft' }, { title: 'Critique' }, { title: 'Revise' }, { title: 'Finalize' }],
}

const _args = typeof args === 'string' ? JSON.parse(args) : args
const { workdir: WD, questions: Q, groups } = _args

const SYM = {
  file: { type: 'string' }, kind: { type: 'string' }, name: { type: 'string' },
  signature: { type: 'string' }, annotation: { type: 'string' },
  importance: { type: 'string', enum: ['high', 'medium'] },
}
const MAP_SCHEMA = {
  type: 'object', required: ['summary', 'symbols'], properties: {
    summary: { type: 'string' }, dataFlow: { type: 'string' },
    symbols: { type: 'array', items: { type: 'object', required: Object.keys(SYM), properties: SYM } },
  },
}
const ISSUE = (extra) => ({ type: 'object', properties: { severity: { type: 'string', enum: ['high', 'medium', 'low'] }, ...extra } })
const REL_SCHEMA = {
  type: 'object', required: ['score', 'issues'], properties: {
    score: { type: 'number' },
    issues: { type: 'array', items: ISSUE({ claim: { type: 'string' }, problem: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } }) },
    missing: { type: 'array', items: { type: 'string' } },
  },
}
const READ_SCHEMA = {
  type: 'object', required: ['score', 'issues'], properties: {
    score: { type: 'number' },
    issues: { type: 'array', items: ISSUE({ location: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } }) },
  },
}

phase('Map')
const maps = (await parallel(groups.map((g) => () => agent(
  `Read these files IN FULL from ${WD} and map them: ${g.files.join(', ')}.
${Q}
Subsystem: ${g.title}. Focus: ${g.focus}.
Return REAL signatures only — copy them from source, never invent. Mark central ones importance=high.`,
  { label: `map:${g.id}`, phase: 'Map', schema: MAP_SCHEMA, effort: 'medium' },
)))).filter(Boolean)

const mapsBlock = maps.map((m) => `## ${m.summary}\n${m.dataFlow || ''}\n` +
  m.symbols.map((s) => `- [${s.importance}] ${s.kind} ${s.name} @ ${s.file}\n  ${s.signature}\n  // ${s.annotation}`).join('\n')).join('\n\n')

phase('Draft')
let draft = await agent(`Write a CODEMAP (markdown) from these maps. ${Q}
Shape: short mental-model intro; a small real flow diagram; then \`\`\`ts code blocks with REAL signatures,
bodies elided (\`{ ... }\`), important symbols // annotated, and // file-path headers. Use ONLY real signatures
(re-read ${WD}/<path> to confirm if unsure). Output ONLY the markdown.

${mapsBlock}`, { label: 'draft:v1', phase: 'Draft', effort: 'high' })

const relP = (d) => `RELIABILITY critic. Verify every signature/claim in the codemap below against REAL source at ${WD}. Open files; cite file:line; be adversarial; severity=high for any invented/wrong signature or false claim.\n\n${d}`
const readP = (d) => `READABILITY critic. Judge ONLY clarity/structure/pedagogy for a newcomer (not accuracy). severity=high blocks comprehension.\n\n${d}`

const rounds = []
for (let r = 1; r <= 3; r++) {
  const critiqued = draft
  const [a, b, c, e] = await parallel([
    () => agent(relP(draft), { label: `rel:a:r${r}`, phase: 'Critique', schema: REL_SCHEMA, effort: 'high' }),
    () => agent(relP(draft), { label: `rel:b:r${r}`, phase: 'Critique', schema: REL_SCHEMA, effort: 'high' }),
    () => agent(readP(draft), { label: `read:a:r${r}`, phase: 'Critique', schema: READ_SCHEMA, effort: 'high' }),
    () => agent(readP(draft), { label: `read:b:r${r}`, phase: 'Critique', schema: READ_SCHEMA, effort: 'high' }),
  ])
  const rels = [a, b].filter(Boolean), reads = [c, e].filter(Boolean)
  const hi = (x) => x.flatMap((o) => o.issues || []).filter((i) => i.severity === 'high')
  const relS = rels.length ? Math.min(...rels.map((o) => o.score ?? 0)) : 0
  const readS = reads.length ? Math.min(...reads.map((o) => o.score ?? 0)) : 0
  rounds.push({ r, draft: critiqued, relS, readS, high: hi(rels).length + hi(reads).length })
  log(`round ${r}: reliability ${relS} (${hi(rels).length} high) | readability ${readS} (${hi(reads).length} high)`)
  if (rounds.at(-1).high === 0 && relS >= 8.5 && readS >= 8.5) break
  if (r === 3) break
  const fixes = [
    ...rels.flatMap((o) => o.issues || []).map((i) => `[${i.severity}] ${i.claim}: ${i.problem} | ${i.evidence} | fix:${i.fix}`),
    ...reads.flatMap((o) => o.issues || []).map((i) => `[${i.severity}] @${i.location}: ${i.problem} | fix:${i.fix}`),
  ].join('\n')
  draft = await agent(`Revise the codemap to resolve these findings; re-read ${WD}/<path> for reliability fixes; keep what works; output ONLY markdown.
FINDINGS:
${fixes}

CODEMAP:
${draft}`, { label: `revise:r${r}`, phase: 'Revise', effort: 'high' })
}

// KEEP BEST, NOT LAST — a revise can regress. Fewest high-severity issues, then highest worst-dimension score.
phase('Finalize')
const best = rounds.slice().sort((x, y) => (x.high - y.high) || (Math.min(y.relS, y.readS) - Math.min(x.relS, x.readS)))[0]
log(`best = round ${best.r} (high=${best.high}, rel=${best.relS}, read=${best.readS})`)
const finalDraft = await agent(`Best-scoring codemap below. (1) Strip any leaked agent preamble + outer code fence so output starts at "# CODEMAP". (2) Apply ONLY high/medium fixes; re-verify each reliability fix against ${WD}/<path>; add no new claims. Output ONLY clean markdown.

${best.draft}`, { label: 'finalize', phase: 'Finalize', effort: 'high' })

return { codemap: finalDraft, history: rounds.map(({ draft, ...m }) => m), chosenRound: best.r }
