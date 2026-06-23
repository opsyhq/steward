---
name: plan-change-map
description: Render the current implementation plan as an annotated code skeleton (a "code map") — real class/function signatures pulled from the codebase, bodies elided, each line tagged KEEP / CHANGE / ADD / REMOVE. Use right after producing or reading a plan to see exactly where every change lands in the real code before implementing.
---

When invoked, turn the active plan into a structural code map — not prose.

1. Identify the plan in scope: the plan file under ~/.claude/plans/ from this session,
   or the plan described in the conversation. If ambiguous, ask which.
2. For every change the plan describes, locate the REAL symbol it touches. Use
   Grep/Glob/Read to find the actual file, class, and function and capture the TRUE
   signature and surrounding structure. Never invent names or shapes.
3. Emit annotated skeletons, grouped by file:
   - Real signatures (class / method / function / type / import) with bodies elided
     to `{ ... }`.
   - Tag each relevant line with one marker + a short note:
       KEEP      unchanged, shown for context
       ✎ CHANGE  modified; say what changes
       + ADD     new; if it mirrors an existing symbol, name what it mirrors
       ✗ REMOVE  deleted; say why it's dead/safe
   - Bodies stay out. This is a map, not an implementation.
4. End with one sentence per file describing the delta shape.

Rules: ground every symbol in a real file path; if the plan references something that
doesn't exist in the code, flag it. Do not write or edit code.
