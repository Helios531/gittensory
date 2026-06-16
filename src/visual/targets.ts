// #578: D1-backed state management for visual-review targets and per-repo enablement. This is the
// "D1 for review-target state" half of the scaffold; R2 (audit logs + image storage) is handled in
// pipeline.ts and later child issues. All functions mirror the house repository style (drizzle + getDb).
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { visualReviewSettings, visualReviewTargets } from "../db/schema";
import { nowIso } from "../utils/json";
import type { VisualReviewStatus } from "./constants";

export type VisualReviewTargetRecord = {
  id: string;
  repoFullName: string;
  pullNumber: number;
  headSha: string;
  baseSha: string | null;
  installationId: number | null;
  status: VisualReviewStatus;
  attempts: number;
  lastError: string | null;
  deliveryId: string | null;
  createdAt: string;
  updatedAt: string;
};

function toRecord(row: typeof visualReviewTargets.$inferSelect): VisualReviewTargetRecord {
  return {
    id: row.id,
    repoFullName: row.repoFullName,
    pullNumber: row.pullNumber,
    headSha: row.headSha,
    baseSha: row.baseSha,
    installationId: row.installationId,
    status: row.status as VisualReviewStatus,
    attempts: row.attempts,
    lastError: row.lastError,
    deliveryId: row.deliveryId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Whether a repo has opted in to visual review. Absence of a settings row == disabled (opt-in). */
export async function isVisualReviewEnabled(env: Env, repoFullName: string): Promise<boolean> {
  const db = getDb(env.DB);
  const [row] = await db
    .select({ enabled: visualReviewSettings.enabled })
    .from(visualReviewSettings)
    .where(eq(visualReviewSettings.repoFullName, repoFullName))
    .limit(1);
  return (row?.enabled ?? 0) === 1;
}

/** Opt a repo in/out of visual review (owner/operator action). Idempotent upsert. */
export async function setVisualReviewEnabled(env: Env, repoFullName: string, enabled: boolean): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(visualReviewSettings)
    .values({ repoFullName, enabled: enabled ? 1 : 0 })
    .onConflictDoUpdate({
      target: visualReviewSettings.repoFullName,
      set: { enabled: enabled ? 1 : 0, updatedAt: nowIso() },
    });
}

/**
 * Idempotently create (or refresh) the review target for a (repo, PR, head SHA). Webhook redelivery of
 * the same head SHA resets the target back to `queued` (a fresh re-run) instead of inserting a duplicate.
 * A new push (new head SHA) creates a distinct target via the UNIQUE(repo, pr, head) index.
 */
export async function upsertVisualReviewTarget(
  env: Env,
  args: {
    repoFullName: string;
    pullNumber: number;
    headSha: string;
    baseSha?: string | null | undefined;
    installationId?: number | null | undefined;
    deliveryId?: string | null | undefined;
  },
): Promise<VisualReviewTargetRecord> {
  const db = getDb(env.DB);
  const now = nowIso();
  await db
    .insert(visualReviewTargets)
    .values({
      id: crypto.randomUUID(),
      repoFullName: args.repoFullName,
      pullNumber: args.pullNumber,
      headSha: args.headSha,
      baseSha: args.baseSha ?? null,
      installationId: args.installationId ?? null,
      deliveryId: args.deliveryId ?? null,
      status: "queued",
    })
    .onConflictDoUpdate({
      target: [visualReviewTargets.repoFullName, visualReviewTargets.pullNumber, visualReviewTargets.headSha],
      set: {
        status: "queued",
        baseSha: args.baseSha ?? null,
        installationId: args.installationId ?? null,
        deliveryId: args.deliveryId ?? null,
        lastError: null,
        updatedAt: now,
      },
    });
  // The insert/upsert above guarantees the row exists, so the read-back is non-null.
  return (await getVisualReviewTarget(env, args.repoFullName, args.pullNumber, args.headSha))!;
}

export async function getVisualReviewTarget(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  headSha: string,
): Promise<VisualReviewTargetRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db
    .select()
    .from(visualReviewTargets)
    .where(
      and(
        eq(visualReviewTargets.repoFullName, repoFullName),
        eq(visualReviewTargets.pullNumber, pullNumber),
        eq(visualReviewTargets.headSha, headSha),
      ),
    )
    .limit(1);
  return row ? toRecord(row) : null;
}

/** Transition a target to a new lifecycle state. `failed` records the error and increments `attempts`. */
export async function transitionVisualReviewTarget(
  env: Env,
  id: string,
  status: VisualReviewStatus,
  options: { error?: string | null | undefined; incrementAttempts?: boolean | undefined } = {},
): Promise<void> {
  const db = getDb(env.DB);
  const set: Partial<typeof visualReviewTargets.$inferInsert> = {
    status,
    lastError: options.error ?? (status === "failed" ? "unknown error" : null),
    updatedAt: nowIso(),
  };
  if (options.incrementAttempts) {
    const [row] = await db.select({ attempts: visualReviewTargets.attempts }).from(visualReviewTargets).where(eq(visualReviewTargets.id, id)).limit(1);
    set.attempts = (row?.attempts ?? 0) + 1;
  }
  await db.update(visualReviewTargets).set(set).where(eq(visualReviewTargets.id, id));
}
