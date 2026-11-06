import { describe, expect, it } from "vitest";
import {
  isMediaAccountPublishable,
  type MediaAccount,
  type MediaOrder,
  type PlatformCapabilities,
  type PlatformConfigSnapshot,
  type PublicationEvidence,
  type PublicationStageCheckpoint
} from "./index";

const activeAccount: MediaAccount = {
  id: "media-account-active",
  platform: "zhihu",
  name: "Active account",
  cookies: "",
  status: "active",
  credentialStatus: "active",
  fields: [],
  isCanonical: true,
  createdAt: "2026-07-11"
};

describe("isMediaAccountPublishable", () => {
  it("requires a canonical account with active account and credential state", () => {
    expect(isMediaAccountPublishable(activeAccount)).toBe(true);
    expect(isMediaAccountPublishable({ ...activeAccount, credentialStatus: "stale" })).toBe(false);
    expect(isMediaAccountPublishable({ ...activeAccount, status: "needs_reauth" })).toBe(false);
    expect(isMediaAccountPublishable({ ...activeAccount, isCanonical: false })).toBe(false);
  });
});

describe("media platform evidence contracts", () => {
  it("allows accounts to carry sanitized platform config and capability snapshots", () => {
    const platformConfig: PlatformConfigSnapshot = {
      schemaVersion: 1,
      fetchedAt: "2026-07-27T10:00:00.000Z",
      sourceEvidence: {
        endpoint: "https://mp.sohu.com/account/task/getAccountTaskList",
        httpStatus: 200,
        businessStatus: "success"
      },
      accountId: "122929277",
      channelId: 47,
      categoryId: -1,
      declaration: "not_original"
    };
    const capabilities: PlatformCapabilities = {
      schemaVersion: 1,
      fetchedAt: "2026-07-27T10:00:00.000Z",
      canPublishArticle: true,
      canUploadImages: true,
      requiresCover: true,
      requiresManualVerification: false,
      requiredFields: ["title", "content", "cover"]
    };

    const account: MediaAccount = {
      ...activeAccount,
      platform: "sohu",
      platformConfig,
      capabilities
    };

    expect(account.platformConfig?.accountId).toBe("122929277");
    expect(account.capabilities?.requiredFields).toContain("cover");
  });

  it("allows media orders to keep publication checkpoints and evidence without a public backlink", () => {
    const checkpoint: PublicationStageCheckpoint = {
      stage: "platform_accepted",
      status: "succeeded",
      at: "2026-07-27T10:01:00.000Z",
      evidence: {
        endpoint: "https://mp.sohu.com/mpbp/bp/news/v4/news/publish/v2",
        httpStatus: 200,
        businessStatus: "2000000",
        externalIds: { newsId: "1055223497" }
      }
    };
    const evidence: PublicationEvidence = {
      source: "desktop-adapter",
      platform: "sohu",
      accepted: true,
      externalIds: { newsId: "1055223497" },
      checkpoints: [checkpoint]
    };
    const order: MediaOrder = {
      id: "media-order-evidence",
      articleTitle: "Evidence based publish",
      resourceId: "account:sohu",
      resourceName: "搜狐号",
      status: "review_required",
      backlinkStatus: "reviewing",
      reviewUrl: "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?newsId=1055223497",
      platformStatus: "submitted_for_review",
      reviewStatus: "pending_public_visibility",
      publicationEvidence: evidence,
      publicationCheckpoints: [checkpoint],
      externalIds: { newsId: "1055223497" },
      failureCategory: "public_not_visible",
      createdAt: "2026-07-27 10:00",
      updatedAt: "2026-07-27 10:01"
    };

    expect(order.backlinkUrl).toBeUndefined();
    expect(order.publicationEvidence?.accepted).toBe(true);
    expect(order.publicationCheckpoints?.[0]?.stage).toBe("platform_accepted");
  });
});
