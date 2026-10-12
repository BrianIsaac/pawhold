import { createHash } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import type { AgentDependencies } from "@/agent/jobs";
import {
  draftUpdate,
  type DraftedUpdate,
  MAX_FINDING_LENGTH,
  MAX_PHOTO_BYTES,
} from "@/agent/update";
import type { Executor } from "@/db/client";
import { auditEvent, estimateSource, PHOTO_MEDIA_TYPES } from "@/db/schema";
import { checkEstimateTrigger, type EstimateTriggerCheck } from "@/estimate/trigger";
import {
  caseEstimateVersions,
  type EstimateDelta,
  estimateDelta,
  type EstimateVersionView,
} from "@/estimate/version";
import type { CaseMoney } from "@/money/view";
import { updateIncrease } from "@/money/view";

import { parsePracticeRequest } from "./cases";
import { type VersionPanel, versionPanel } from "./panels";
import { PracticeError } from "./errors";
import { keepSourceOrRefuse, type SourceView } from "./sources";
import { triggerSentence } from "./wording";

/** A photo's media type. */
export type PhotoMediaType = (typeof PHOTO_MEDIA_TYPES)[number];

/**
 * The image type a photo's bytes are, read from their first bytes, so a file
 * is never taken for the type its name or the browser claims.
 *
 * @param bytes - The photo.
 * @returns Its type, or null when it is none of the four an update takes.
 */
export function sniffImage(bytes: Buffer): PhotoMediaType | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("latin1"))) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

const photoInput = z
  .strictObject({
    mediaType: z.string(),
    bytes: z.instanceof(Buffer),
  })
  .nullable();

const updateInput = z
  .strictObject({
    practiceId: z.uuid(),
    caseId: z.uuid(),
    finding: z
      .string()
      .max(MAX_FINDING_LENGTH, `At most ${MAX_FINDING_LENGTH} characters`)
      .refine((text) => text.trim() !== "", "Write what you found first"),
    photo: photoInput,
    sharePhoto: z.boolean(),
  })
  .superRefine((request, context) => {
    const photo = request.photo;
    if (photo) {
      if (photo.bytes.length === 0 || photo.bytes.length > MAX_PHOTO_BYTES) {
        context.addIssue({ code: "custom", path: ["photo"], message: "A photo of at most 5 MB" });
      } else if (sniffImage(photo.bytes) === null || sniffImage(photo.bytes) !== photo.mediaType) {
        context.addIssue({
          code: "custom",
          path: ["photo"],
          message: "A PNG, JPEG, WebP or GIF image",
        });
      }
    }
  });

/**
 * "What did you find, and what do you recommend?" (section 6): U4's update
 * drafted from the vet's finding and an optional photo, then the finding, the
 * photo, whether the owner sees it, and the owner's explanation kept beside
 * the update's version (U4's finding 7). A photo is taken only when its bytes
 * are the image type it claims.
 *
 * @param agent - The estimate agent.
 * @param request - The practice, the case, the finding, the photo and whether the owner sees it.
 * @returns The update as U4 answers it.
 * @throws PracticeError naming each field at fault.
 * @throws EstimateError as `draftUpdate` refuses.
 */
export async function draftUpdateForCase(
  agent: AgentDependencies,
  request: z.input<typeof updateInput>,
): Promise<DraftedUpdate> {
  const { practiceId, caseId, finding, photo, sharePhoto } = parsePracticeRequest(
    updateInput,
    request,
  );
  const versions = await caseEstimateVersions(agent.db, practiceId, caseId);
  const open = versions.find((version) => version.sentAt === null) ?? null;
  // A redraft with no new photo keeps the one already added: a file input
  // cannot be filled again, and dropping the photo silently would lose it.
  const kept = photo === null && open ? await storedPhoto(agent.db, open.id) : null;
  const bytes = photo?.bytes ?? kept?.bytes ?? null;
  const mediaType = bytes ? sniffImage(bytes) : null;
  if (sharePhoto && !bytes) {
    throw new PracticeError("request_invalid", "Check the fields marked below.", {
      sharePhoto: "Add a photo to show the owner",
    });
  }
  const drafted = await draftUpdate(agent, {
    practiceId,
    caseId,
    finding,
    photo: bytes && mediaType ? { mediaType, dataBase64: bytes.toString("base64") } : null,
  });
  await keepSourceOrRefuse(agent.db, {
    versionId: drafted.version.id,
    practiceId,
    caseId,
    kind: "finding",
    text: finding,
    outcome: drafted,
    preservedLines: drafted.failure !== null && open !== null,
    photo:
      bytes && mediaType
        ? {
            mediaType,
            bytes,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            shared: sharePhoto,
          }
        : null,
  });
  return drafted;
}

/**
 * The photo kept beside a version, if any.
 *
 * @param executor - The pool or an open transaction.
 * @param versionId - The version.
 * @returns Its bytes, or null.
 */
async function storedPhoto(
  executor: Executor,
  versionId: string,
): Promise<{ bytes: Buffer } | null> {
  const [row] = await executor
    .select({ photo: estimateSource.photo })
    .from(estimateSource)
    .where(eq(estimateSource.versionId, versionId));
  return row?.photo ? { bytes: row.photo } : null;
}

const photoRequest = z.strictObject({
  practiceId: z.uuid(),
  caseId: z.uuid(),
  versionId: z.uuid(),
});

/**
 * An update's photo, for the practice's own page (U6 serves the owner's,
 * only when shared).
 *
 * @param executor - The pool or an open transaction.
 * @param request - The practice, the case and the version.
 * @returns The photo, or null when there is none.
 */
export async function loadSourcePhoto(
  executor: Executor,
  request: z.input<typeof photoRequest>,
): Promise<{ mediaType: PhotoMediaType; bytes: Buffer; shared: boolean } | null> {
  const { practiceId, caseId, versionId } = parsePracticeRequest(photoRequest, request);
  const [row] = await executor
    .select({
      photo: estimateSource.photo,
      mediaType: estimateSource.photoMediaType,
      shared: estimateSource.photoShared,
    })
    .from(estimateSource)
    .where(
      and(
        eq(estimateSource.versionId, versionId),
        eq(estimateSource.caseId, caseId),
        eq(estimateSource.practiceId, practiceId),
      ),
    );
  if (!row?.photo || !row.mediaType) {
    return null;
  }
  return {
    mediaType: z.enum(PHOTO_MEDIA_TYPES).parse(row.mediaType),
    bytes: row.photo,
    shared: row.shared,
  };
}

/** An update being drafted: what it changes, what it asks for, and the Order's check. */
export interface UpdateDraftView {
  readonly panel: VersionPanel;
  /** The version it changes: the last the owner approved. */
  readonly basedOn: EstimateVersionView;
  readonly delta: EstimateDelta;
  /** What it asks for over what is held: the "{delta}" the owner approves. */
  readonly increasePence: number;
  readonly trigger: EstimateTriggerCheck | null;
  readonly triggerSentence: string;
}

/**
 * Whether the update half of the case page has anything to show: an update
 * approved, declined, with the owner or drafted, or the form to add one. A
 * discharged case with no update has none, and shows no "Update" heading.
 *
 * @param update - The update half.
 * @returns Whether it shows.
 */
export function updateShows(update: UpdateView): boolean {
  return (
    update.approved.length > 0 ||
    update.declined !== null ||
    update.awaiting !== null ||
    update.draft !== null ||
    update.canDraft
  );
}

/** The update half of the case page. */
export interface UpdateView {
  /** Whether an update may be drafted now: the case held, its bill not signed off. */
  readonly canDraft: boolean;
  readonly draft: UpdateDraftView | null;
  /** The update with the owner. */
  readonly awaiting: { readonly panel: VersionPanel; readonly increasePence: number } | null;
  /** The update the owner declined, while the case is in that state. */
  readonly declined: { readonly panel: VersionPanel; readonly declinedAt: Date } | null;
  /** The updates the owner approved, in order. */
  readonly approved: readonly VersionPanel[];
}

/** What {@link loadUpdateView} reads from the case view being built. */
export interface UpdateContext {
  readonly practiceId: string;
  readonly caseId: string;
  readonly ownerFirstName: string;
  readonly money: CaseMoney;
  readonly versions: readonly EstimateVersionView[];
  readonly sources: ReadonlyMap<string, SourceView>;
  readonly approved: readonly EstimateVersionView[];
  readonly canUpdate: boolean;
}

/**
 * The update half: the update being drafted with its delta and the Order's
 * sentence, the update with the owner, the one they declined, and those they
 * approved. Each update's panel finds only its own lines' spans, in its finding.
 *
 * @param executor - The pool or an open transaction.
 * @param context - The case as the case view read it.
 * @returns The update half.
 */
export async function loadUpdateView(
  executor: Executor,
  context: UpdateContext,
): Promise<UpdateView> {
  const { practiceId, money, versions, sources, approved } = context;
  const basedOn = approved.at(-1) ?? null;
  const panel = (version: EstimateVersionView): VersionPanel =>
    versionPanel(version, sources.get(version.id) ?? null, basedOn?.lines.length ?? 0);
  const inUpdatePhase = basedOn !== null;
  const open = versions.find((version) => version.sentAt === null) ?? null;
  const lastSent = versions.filter((version) => version.sentAt !== null).at(-1) ?? null;

  let draft: UpdateDraftView | null = null;
  if (inUpdatePhase && open) {
    const [increase, trigger] = await Promise.all([
      updateIncrease(executor, practiceId, open.id),
      checkEstimateTrigger(executor, { practiceId, versionId: open.id }),
    ]);
    draft = {
      panel: panel(open),
      basedOn,
      delta: estimateDelta(basedOn, open),
      increasePence: increase.increasePence,
      trigger,
      triggerSentence: triggerSentence({
        increasePence: increase.increasePence,
        heldPence: increase.heldPence,
        check: trigger,
        currency: money.currency,
        ownerFirstName: context.ownerFirstName,
      }),
    };
  }

  let declined: UpdateView["declined"] = null;
  if (money.state === "update_declined" && lastSent && lastSent.id !== basedOn?.id) {
    const [event] = await executor
      .select({ at: auditEvent.occurredAt })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.caseId, context.caseId),
          eq(auditEvent.action, "estimate.update_declined"),
        ),
      )
      .orderBy(desc(auditEvent.id))
      .limit(1);
    declined = { panel: panel(lastSent), declinedAt: event?.at ?? lastSent.sentAt! };
  }

  return {
    canDraft: context.canUpdate,
    draft,
    awaiting:
      money.state === "update_awaiting_owner" && lastSent
        ? {
            panel: panel(lastSent),
            increasePence: lastSent.totals.highPence - money.heldPence,
          }
        : null,
    declined,
    approved: approved
      .slice(1)
      .map((version, at) =>
        versionPanel(version, sources.get(version.id) ?? null, approved[at]!.lines.length),
      ),
  };
}
