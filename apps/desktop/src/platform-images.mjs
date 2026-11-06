import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";

function clean(value) {
  return String(value ?? "").trim();
}

function imageIdentity(image = {}) {
  return `${clean(image.assetId)}\u0000${clean(image.sectionId)}\u0000${Number(image.position ?? -1)}`;
}

function findBoundImage(block = {}, images = []) {
  const assetId = clean(block.assetId);
  const sectionId = clean(block.sectionId);
  return images.find((image) => assetId && clean(image?.assetId) === assetId)
    || images.find((image) => sectionId && clean(image?.sectionId) === sectionId);
}

export function isPersistentPlatformImageUrl(value) {
  try {
    const url = new URL(clean(value));
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

// Expected result for the public stage of an article that only reached a draft
// or the platform's review queue: there is no public page to look at yet, so
// "not attempted" is the honest answer and must not read as a missing image.
export const PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED = "PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED";

export async function preparePlatformImageTasks(contentBlocks = [], inlineImages = [], onSkip = null) {
  const blocks = Array.isArray(contentBlocks) ? contentBlocks : [];
  const images = Array.isArray(inlineImages) ? inlineImages : [];
  const sectionTitles = new Map(blocks
    .filter((block) => block?.type === "section" && clean(block.sectionId))
    .map((block) => [clean(block.sectionId), clean(block.title)]));
  const tasks = [];
  for (const [position, block] of blocks.entries()) {
    if (block?.type !== "image") continue;
    const image = findBoundImage(block, images);
    const localPath = clean(image?.path || block?.path);
    // An image block whose bytes never reached this machine used to abort the
    // entire publish. Skipping it keeps the article publishable, and the caller
    // records which block was dropped and why.
    const skipReason = !localPath
      ? "INLINE_IMAGE_LOCAL_PATH_MISSING"
      : await access(localPath).then(() => "").catch(() => "INLINE_IMAGE_LOCAL_FILE_MISSING");
    if (skipReason) {
      if (typeof onSkip === "function") {
        onSkip({
          position,
          assetId: clean(block.assetId || image?.assetId),
          sectionId: clean(block.sectionId || image?.sectionId),
          reason: skipReason
        });
      }
      continue;
    }
    const contentHash = createHash("sha256").update(await readFile(localPath)).digest("hex");
    const assetId = clean(block.assetId || image?.assetId);
    const sectionId = clean(block.sectionId || image?.sectionId);
    tasks.push({
      assetId,
      sectionId,
      sectionTitle: sectionTitles.get(sectionId) || "",
      position,
      path: localPath,
      altText: clean(block.altText || image?.altText || "文章插图"),
      contentHash,
      idempotencyKey: `${assetId}:${sectionId}:${contentHash}`,
    });
  }
  return tasks;
}

function sanitizeStage(expectedTasks, images, stage, unverifiableHint = "") {
  const candidates = (Array.isArray(images) ? images : []).map((image) => ({
    assetId: clean(image?.assetId),
    sectionId: clean(image?.sectionId),
    position: Number(image?.position ?? -1),
    platformImageId: clean(image?.platformImageId),
    platformImageUrl: clean(image?.platformImageUrl || image?.url || image?.src),
    loaded: image?.loaded !== false,
  }));
  const byIdentity = new Map(candidates.map((image) => [imageIdentity(image), image]));
  const ordered = expectedTasks.map((expected) => byIdentity.get(imageIdentity(expected))).filter(Boolean);
  const persistent = ordered.filter((image) => isPersistentPlatformImageUrl(image.platformImageUrl) && image.loaded);
  const unverifiableReason = String(unverifiableHint || "").trim();
  const status = unverifiableReason
    ? "unverifiable"
    : persistent.length === expectedTasks.length ? "verified" : "failed";
  return {
    stage,
    expectedCount: expectedTasks.length,
    observedCount: candidates.length,
    verifiedCount: persistent.length,
    status,
    ...(unverifiableReason ? { blocker: unverifiableReason, unverifiableReason } : {}),
    images: persistent,
  };
}

export function buildImagePublicationEvidence(expectedTasks = [], uploadImages = [], draftImages = [], publicImages = [], publicBlocker = "") {
  const expected = (Array.isArray(expectedTasks) ? expectedTasks : []).map((task) => ({
    assetId: clean(task?.assetId),
    sectionId: clean(task?.sectionId),
    position: Number(task?.position ?? -1),
    idempotencyKey: clean(task?.idempotencyKey),
  }));
  const upload = sanitizeStage(expected, uploadImages, "upload");
  const draft = sanitizeStage(expected, draftImages, "draft");
  // The fifth argument is an explicit "we could not look" signal from the caller.
  // It must never be inferred here: a caller that did read a public page and found
  // no images has to keep reporting "failed", not "unverifiable".
  const publicStage = sanitizeStage(expected, publicImages, "public", publicBlocker);
  const issues = [];
  if (upload.status !== "verified") issues.push("UPLOAD_IMAGE_MISSING");
  if (draft.status !== "verified") issues.push("DRAFT_IMAGE_MISSING");
  if (publicStage.status === "failed") issues.push("PUBLIC_IMAGE_MISSING");
  else if (publicStage.status === "unverifiable") issues.push("PUBLIC_IMAGE_UNVERIFIABLE");
  return {
    version: 1,
    status: issues.length ? "review_required" : "verified",
    expectedCount: expected.length,
    expected: expected.map(({ assetId, sectionId, position, idempotencyKey }) => ({ assetId, sectionId, position, idempotencyKey })),
    upload,
    draft,
    public: publicStage,
    issues,
    verifiedAt: issues.length ? "" : new Date().toISOString(),
  };
}

export function requireImagePublicationEvidence(evidence = {}, stage = "public") {
  const normalizedStage = stage === "upload" ? "upload" : stage === "draft" ? "draft" : "public";
  const stageEvidence = evidence?.[normalizedStage];
  if (stageEvidence?.status === "verified") return evidence;
  // "unverifiable" means the platform hid the public page from us (login wall,
  // captcha, risk control). That is a signal problem, not a broken article, so the
  // adapter continues instead of failing the whole publish.
  if (stageEvidence?.status === "unverifiable") return evidence;
  const code = normalizedStage === "upload"
    ? "UPLOAD_IMAGE_MISSING"
    : normalizedStage === "draft"
      ? "DRAFT_IMAGE_MISSING"
      : "PUBLIC_IMAGE_MISSING";
  throw new Error(code);
}
