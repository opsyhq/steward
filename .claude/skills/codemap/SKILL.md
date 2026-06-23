---
name: codemap
description: Produce a deep, accurate, readable annotated codemap (a code skeleton — real class/function/method signatures with bodies elided and the important ones // annotated) of a subsystem by driving a multi-agent dynamic Workflow — parallel readers map the source, one agent synthesizes, then reliability + readability critics adversarially refine in a loop and the BEST-scoring draft wins. Use for subsystems too big for one context, or when signature-level accuracy matters (onboarding, audits, "map how X works" deep-dives). Spawns many agents — token-heavy; use when thoroughness is wanted, not for a quick lookup.
---

# Codemap via dynamic workflow

Generate a code skeleton that is BOTH accurate (every signature verified against
source) and readable (clear to someone new). Driven by a `Workflow` so coverage
fans out across files and quality is enforced by adversarial critics, not hope.

## When to use
- A subsystem is too large to hold in one context, or spans many files.
- Signature-level accuracy matters: onboarding, audits, "how does X work".
- You want a durable artifact, not a one-off answer.
Skip it for a single file or a quick fact — just read the file.

## Procedure
1. **Scout inline FIRST (don't skip).** Use Bash/Read/Grep to list the real files
   and group them into 3–6 coherent subsystems. The work-list must come from the
   actual tree, not a guess. THEN orchestrate.
2. **Run `codemap.workflow.js`**, passing the file groups + guiding questions as
   `args`. Phases:
   - **Map** — one reader per group, in PARALLEL, reads its files IN FULL, returns
     a STRUCTURED symbol list (real signatures only; no inventions).
   - **Draft** — one agent synthesizes a single annotated markdown skeleton.
   - **Critique** — each round in parallel: 2 reliability critics (open the real
     files, verify every signature, cite `file:line`, default-skeptical) + 2
     readability critics (clarity only). Structured verdict: score + issues.
   - **Revise** — apply only the findings; re-read source for reliability fixes.
   - Loop until no high-severity issues and both scores clear the bar, or N rounds.
   - **Finalize** — pick the best draft (see lessons), verify, polish.
3. **Render the returned codemap in chat**, stripping any leaked agent preamble.

## Critical lessons (why the workflow beats one big prompt)
- **Keep the BEST draft, not the LAST.** A revise can REGRESS. Capture every
  critiqued draft with its scores; return the one with the fewest high-severity
  issues (tie-break: highest worst-dimension score), then ONE conservative
  finalize pass. (Observed: round 2 = 8.5/7.5, 0 high; round 3 regressed to
  8/6.5, 4 high — the naive "return last" loop ships the worse draft.)
- **Split reliability from readability.** One critic per concern; never let a
  clarity pass invent signatures, or a verify pass muddy the prose.
- **Force verification against source.** Reliability critics must open files and
  give `file:line` evidence; "looks right" is disallowed.
- **Structured output drives the loop.** Schemas (score + high-severity list) make
  pass/fail deterministic instead of vibes.
- **Resume to finalize cheaply.** Edit the script to keep-best + finalize, then
  re-run with `resumeFromRunId`: Map/Draft/Critique replay from cache; only the
  new finalize agents run live.
- **Orient, don't reproduce.** Elide bodies (`{ ... }`), annotate only
  load-bearing symbols, keep `// path/to/file.ts` headers so symbols are locatable.

## Cost
~15–25 agents over several rounds (reference run: 22 agents, ~1.6M tokens). Scale
reader/critic counts to how thorough the ask is.

## Template
The runnable workflow lives next to this file: `codemap.workflow.js`. Invoke with:

```
Workflow({ scriptPath: "<this-skill-dir>/codemap.workflow.js", args: {
  workdir: "/abs/repo",
  questions: "Q1 ... Q2 ...",
  groups: [{ id, title, files: ["rel/path.ts"], focus: "what to extract" }] } })
```
