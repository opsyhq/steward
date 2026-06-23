#!/usr/bin/env bash
# Watch a PR and exit (so the harness re-invokes Claude) the moment something
# actionable happens: new review/comment activity, OR the PR is merged/closed.
#
# Usage: watch-pr.sh <owner/repo> <pr-number> <baseline-file> [interval-secs] [max-iters]
#
# The baseline file holds three counts: "<issue_comments> <review_comments> <submitted_reviews>".
# Seed it before launching (see SKILL.md). Only SUBMITTED reviews count, so a draft/pending
# review the author is still writing does not trigger a false wake. On a comment hit the script
# rewrites the baseline so the next arming starts fresh. PENDING reviews are ignored.
set -u

REPO=$1
PR=$2
BASE=$3
INTERVAL=${4:-30}
MAX_ITERS=${5:-360} # ~3h at 30s, then exits idle so the caller can re-arm

read -r B_IC B_RC B_SR < "$BASE"

for ((i = 0; i < MAX_ITERS; i++)); do
	sleep "$INTERVAL"

	# Terminal states first — these mean "done", not "respond".
	state=$(gh pr view "$PR" --repo "$REPO" --json state --jq '.state' 2>/dev/null) || continue
	if [[ "$state" == "MERGED" ]]; then
		echo "MERGED: PR #$PR merged — the work is done."
		exit 0
	fi
	if [[ "$state" == "CLOSED" ]]; then
		echo "CLOSED: PR #$PR closed without merge."
		exit 0
	fi

	# New activity past the baseline?
	ic=$(gh pr view "$PR" --repo "$REPO" --json comments --jq '.comments | length' 2>/dev/null) || continue
	rc=$(gh api "repos/$REPO/pulls/$PR/comments" --jq 'length' 2>/dev/null) || continue
	sr=$(gh api "repos/$REPO/pulls/$PR/reviews" --jq '[.[] | select(.state != "PENDING")] | length' 2>/dev/null) || continue
	if [[ "$ic" -gt "$B_IC" || "$rc" -gt "$B_RC" || "$sr" -gt "$B_SR" ]]; then
		echo "NEW_ACTIVITY on PR #$PR: issue_comments ${B_IC}->${ic}, review_comments ${B_RC}->${rc}, submitted_reviews ${B_SR}->${sr}"
		echo "$ic $rc $sr" >"$BASE"
		exit 0
	fi
done

echo "IDLE: no change on PR #$PR after ~$((INTERVAL * MAX_ITERS / 60))m; re-arm to keep watching."
exit 0
