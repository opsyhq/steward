---
name: ship-plan
description: Take an implementation plan from ~/.claude/plans/ end-to-end to a watched PR — implement it, run /simplify, review it with parallel subagents (reuse + in-house style + correctness), run /verify, then open a PR and watch it until the user comments or merges. Use when handed a plan to execute ("implement this plan", "ship this plan", "do this plan and open a PR").
---

# Ship a plan

Drive a plan file from `~/.claude/plans/` through five steps: implement, simplify,
review, verify, open-and-watch a PR. Follow `AGENTS.md` throughout (read files in full
before wide edits, answer questions before editing, say agree/disagree when
responding to feedback, no backward-compat unless asked, ask before removing
intentional code).

The arg is the plan name (a file under `~/.claude/plans/`). No arg → pick the
plan from this session, else the most recent one, else ask.

## Step 1 — Implement

1. Read the plan file in full. Treat decisions it marks as "locked / decided with
   the user" as fixed; don't relitigate them.
2. Read every file the plan touches IN FULL (and the files it mirrors) before
   editing — not search snippets. Match the surrounding in-house style: comment
   density and voice, naming, error handling, import conventions.
3. Implement faithfully. If the plan and reality diverge in a way that changes
   behavior, surface it and pick the option that honors the plan's intent.
4. Track multi-step work with the task tools so progress is visible.

## Step 2 — Simplify

Invoke the `simplify` skill for a reuse / simplification / efficiency / altitude
cleanup pass over the diff. It applies its fixes — so review them, and DON'T accept
its suggestions to extract helpers too eagerly: reject moves that hoist single-line
or single-call-site code into a shared helper just for DRY's sake (the reuse review
in Step 3 holds the same bar). Keep the simplifications that genuinely read better;
drop the helper-happy ones. Re-run typecheck + linter after.

## Step 3 — Review with subagents (parallel)

Spawn several subagents at once (one message, multiple Agent calls). Cover these
angles, scaled to the change:
- **Reuse** — does the code reuse existing reusable utilities/abstractions, or
  reinvent something that already exists? DO NOT ask it to extract new shared
  helpers or DRY up single-line / single-call-site helpers — that's not wanted.
  Only flag genuine reinvention of code that already exists.
- **In-house style** — does it match the conventions of the files it mirrors
  (comment voice, naming, structure, error handling)?
- **Correctness** — real bugs, races, edge cases. Adversarial but precise.
- **Plan adherence** (when there's a plan doc) — does the implementation match
  the plan's stated API/decisions; what's missing or added beyond it.

Then triage: apply the clear wins, push back (with reasons) on the ones you
disagree with, and surface genuine judgment calls to the user rather than guessing
— especially anything that would change a plan-locked decision. State agree/
disagree explicitly. For a heavyweight, exhaustive pass the user can opt into a
`Workflow` instead of loose Agent calls.

## Step 4 — Verify

Invoke the `verify` skill. Verification is runtime observation — run the app /
drive the real surface and capture evidence; do NOT substitute the test suite or
typecheck for it. Report PASS/FAIL/BLOCKED/SKIP with the observations.

## Step 5 — Open the PR and watch it

1. If on the default branch, create a feature branch first. Commit (end messages
   with the Co-Authored-By / Claude-Session trailers from the harness rules),
   push, open the PR with `gh pr create` (PR body ends with the Generated-with
   trailer).
2. Confirm green locally before/with the PR: typecheck, full test suite, linter.
3. **Arm the watcher.** It wakes you both when the user comments AND when they
   merge (so you know it's done) — GitHub can't push to you, so a background
   script polls and exits on change; the harness re-invokes you when it exits.

   ```bash
   REPO=<owner/repo>; PR=<n>
   BASE="$SCRATCH/pr$PR-baseline.txt"   # $SCRATCH = the session scratchpad dir
   ic=$(gh pr view $PR --repo $REPO --json comments --jq '.comments | length')
   rc=$(gh api repos/$REPO/pulls/$PR/comments --jq 'length')
   sr=$(gh api repos/$REPO/pulls/$PR/reviews --jq '[.[]|select(.state!="PENDING")]|length')
   echo "$ic $rc $sr" > "$BASE"
   ```
   Then run the bundled watcher in the BACKGROUND (Bash `run_in_background: true`):
   ```bash
   bash <this-skill-dir>/watch-pr.sh <owner/repo> <PR> "$BASE"
   ```
4. **On wake**, read the watcher's output line:
   - `MERGED` → the work is done. Report it and stop (don't re-arm).
   - `CLOSED` → closed without merge; tell the user, stop.
   - `NEW_ACTIVITY` → fetch the new comments/reviews (`gh api .../comments`,
     `.../reviews`), address them in code, reply to each inline comment
     (`gh api -X POST repos/<repo>/pulls/<pr>/comments/<id>/replies -f body=...`)
     saying what changed and where you agree/disagree, push, then RE-SEED the
     baseline and RE-ARM the watcher (your own replies are activity — re-baseline
     so they don't self-trigger).
   - `IDLE` → just re-arm.

## Notes
- The watcher counts only SUBMITTED reviews, so a draft review the user is still
  writing won't wake you early.
- Don't add a polling `ScheduleWakeup` on top — the background script is
  harness-tracked and re-invokes you on exit.
- One daemon/agent per PR; the watcher keys off the PR number, so several can run
  in parallel with separate baseline files.
