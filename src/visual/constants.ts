// #578 (epic #577): visual-change PR auto-review scaffold. Shared constants for the visual-review
// pipeline, kept separate from the submission-gate constants so the two owner-led surfaces never collide.

/**
 * Managed-comment marker for the visual-review comment. Mirrors the submission-gate's PR_PANEL marker:
 * a single hidden HTML comment lets the worker find-and-update its own comment (idempotent) instead of
 * posting a new one per push. The managed comment itself ships in #583; the marker is defined here so the
 * scaffold, the capture pipeline, and the comment writer all agree on one constant.
 */
export const REVIEW_MARKER = "<!-- gittensory-visual-review:v1 -->";

/** PR webhook actions that (re)trigger a visual review. A new push (`synchronize`) produces a new head SHA
 *  and therefore a new review target; `reopened` re-reviews a previously closed PR. */
export const VISUAL_REVIEW_PR_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

/** Lifecycle states for a `visual_review_targets` row. `queued` -> `capturing` -> `posted` | `failed`. */
export type VisualReviewStatus = "queued" | "capturing" | "posted" | "failed";

/** R2 object key for the per-target intake audit log (image storage keys are added in #583). */
export function visualReviewAuditKey(repoFullName: string, pullNumber: number, headSha: string): string {
  return `visual-review/${repoFullName}/${pullNumber}/${headSha}/intake.json`;
}
