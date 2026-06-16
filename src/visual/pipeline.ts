// #578: visual-review queue consumer. Drives the review-target lifecycle and writes an R2 audit log for
// the intake. The actual screenshot work is intentionally NOT implemented here — that is the job of the
// later child issues:
//   #579 visual-change detection + affected-route mapping
//   #580 base/head render harness (reuse `ui:preview`)
//   #581 Playwright before/after capture across viewports
//   #582 visual diff + change quantification
//   #583 R2 image hosting + managed PR comment (flips state -> `posted`)
//   #584 optional LLM visual review + verdict
// So this scaffold transitions `queued` -> `capturing` and parks there with an audited "capture pending"
// note. A genuine processing error (incl. an R2 write failure when the bucket IS bound) transitions the
// target to `failed` and rethrows so the queue retries and ultimately dead-letters (observable) rather
// than silently dropping.
import { recordAuditEvent } from "../db/repositories";
import { errorMessage } from "../utils/json";
import { visualReviewAuditKey } from "./constants";
import { getVisualReviewTarget, transitionVisualReviewTarget } from "./targets";

export async function processVisualReview(
  env: Env,
  args: { deliveryId: string; repoFullName: string; pullNumber: number; headSha: string },
): Promise<void> {
  const target = await getVisualReviewTarget(env, args.repoFullName, args.pullNumber, args.headSha);
  if (!target) {
    // The webhook records the target before enqueueing, so a missing target means it was superseded
    // (e.g. a newer push) or pruned. Nothing to do; ack the message.
    await recordAuditEvent(env, {
      eventType: "visual_review.target_missing",
      targetKey: `${args.repoFullName}#${args.pullNumber}`,
      outcome: "completed",
      detail: `no visual_review_targets row for ${args.repoFullName}#${args.pullNumber} @ ${args.headSha.slice(0, 7)}`,
      metadata: { deliveryId: args.deliveryId, headSha: args.headSha },
    });
    return;
  }

  try {
    await transitionVisualReviewTarget(env, target.id, "capturing", { incrementAttempts: true });

    // R2 audit log for the intake. The binding is optional — when it is absent (tests / pre-provisioning)
    // the write is skipped. When it IS bound, a failed write is a real error that fails the job (-> retry
    // -> DLQ) rather than being silently lost. Image objects land here too in #583.
    await writeIntakeAuditLog(env, target.id, args);

    await recordAuditEvent(env, {
      eventType: "visual_review.capture_pending",
      targetKey: `${args.repoFullName}#${args.pullNumber}`,
      outcome: "completed",
      detail: "visual-review scaffold reached `capturing`; screenshot capture lands in #580/#581",
      metadata: { deliveryId: args.deliveryId, targetId: target.id, headSha: args.headSha, attempts: target.attempts + 1 },
    });
  } catch (error) {
    await transitionVisualReviewTarget(env, target.id, "failed", { error: errorMessage(error) });
    throw error;
  }
}

async function writeIntakeAuditLog(
  env: Env,
  targetId: string,
  args: { deliveryId: string; repoFullName: string; pullNumber: number; headSha: string },
): Promise<void> {
  const bucket = env.VISUAL_REVIEW_BUCKET;
  if (!bucket) return;
  const key = visualReviewAuditKey(args.repoFullName, args.pullNumber, args.headSha);
  const body = JSON.stringify({
    targetId,
    deliveryId: args.deliveryId,
    repoFullName: args.repoFullName,
    pullNumber: args.pullNumber,
    headSha: args.headSha,
    stage: "intake",
  });
  await bucket.put(key, body, { httpMetadata: { contentType: "application/json" } });
}
