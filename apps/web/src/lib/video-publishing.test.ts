import { describe, expect, it } from "vitest";
import { canDiscoverVideo, canRetryVideo, limitVideoTitle, defaultVideoSchedule, scheduledVideoPayload, validateVideoSchedule, formatVideoSchedule, videoCoverPayload, verifiedVideoPreparationLabels, captionCodePointCount, limitVideoCaption, publicVideoUrl, validateVideoFile, videoPublicationLabel, videoPublicationState } from "./video-publishing";

describe("video publishing UI boundaries", () => {
  it("accepts MP4 at the product limit, rejects oversized or renamed images", () => {
    expect(validateVideoFile({ name: "film.mp4", size: 500 * 1024 * 1024, type: "video/mp4" })).toBe("");
    expect(validateVideoFile({ name: "film.mp4", size: 500 * 1024 * 1024 + 1, type: "video/mp4" })).toContain("500");
    expect(validateVideoFile({ name: "film.mp4", size: 1024, type: "image/png" })).toContain("MP4");
    expect(validateVideoFile({ name: "film.mp4", size: 0, type: "video/mp4" })).toContain("空");
  });
  it("does not call accepted execution published or turn uncertainty into a failure", () => {
    expect(videoPublicationState({status: "succeeded", platformStatus: "submitted_for_review"})).toBe("submitted_for_review");
    expect(videoPublicationLabel({status: "succeeded"})).toBe("待确认");
    expect(videoPublicationLabel({status: "failed", platformStatus: "submission_unknown"})).toBe("提交结果待确认");
    expect(canDiscoverVideo({status: "submission_unknown"})).toBe(true);
    expect(canDiscoverVideo({status: "running"})).toBe(false);
  });
  it("links only verified published HTTPS Douyin works", () => {
    expect(publicVideoUrl({status: "submitted_for_review", publicUrl: "https://www.douyin.com/video/123"})).toBe("");
    expect(publicVideoUrl({status: "published", publicUrl: "javascript:alert(1)"})).toBe("");
    expect(publicVideoUrl({status: "published", publicUrl: "https://www.douyin.com.evil.test/video/123"})).toBe("");
    expect(publicVideoUrl({status: "published", publicUrl: "https://www.douyin.com/video/123"})).toBe("https://www.douyin.com/video/123");
  });
});

describe("safe video retries", () => {
  it("only exposes retry for proven pre-submit failure", () => {
    expect(canRetryVideo({status: "failed"})).toBe(true);
    expect(canRetryVideo({status: "failed", submittedAt: "2026-10-26"})).toBe(false);
    expect(canRetryVideo({status: "failed", itemId: "123"})).toBe(false);
    expect(canRetryVideo({status: "submission_unknown"})).toBe(false);
    expect(canRetryVideo({status: "submitted_for_review"})).toBe(false);
  });
});
describe("Douyin real editor limits and progress", () => {
  it.each(["中", "😀"])("accepts 1000 %s code points and limits 1001 without splitting emoji", (character) => {
    const atLimit=character.repeat(1000);
    expect(captionCodePointCount(atLimit)).toBe(1000);
    expect(limitVideoCaption(atLimit)).toBe(atLimit);
    expect(limitVideoCaption(character.repeat(1001))).toBe(atLimit);
  });
  it("shows running transfer stages without overriding terminal or uncertain states", () => {
    expect(videoPublicationLabel({status:"running",stage:"downloading"})).toBe("下载视频中");
    expect(videoPublicationLabel({status:"running",stage:"uploading"})).toBe("上传抖音中");
    expect(videoPublicationLabel({status:"published",stage:"uploading"})).toBe("已公开");
    expect(videoPublicationLabel({status:"running",platformStatus:"submission_unknown",stage:"uploading"})).toBe("提交结果待确认");
  });
});
describe("native Douyin preparation progress", () => {
  it.each([
    ["topics", "正在关联抖音话题"],
    ["chapters", "正在生成视频章节"],
    ["chapters_confirming", "正在确认视频章节"],
  ])("renders %s only while running", (stage, label) => {
    expect(videoPublicationLabel({status:"running",stage})).toBe(label);
    expect(videoPublicationLabel({status:"published",stage})).toBe("已公开");
    expect(videoPublicationLabel({status:"running",platformStatus:"submission_unknown",stage})).toBe("提交结果待确认");
  });
});

describe("explicit video cover source", () => {
  it("AI source omits even a previously uploaded custom cover", () => {
    expect(videoCoverPayload("ai", "old-cover")).toEqual({});
    expect(videoCoverPayload("ai")).toEqual({});
  });
  it("custom source requires an uploaded cover", () => {
    expect(videoCoverPayload("custom", "cover-1")).toEqual({coverAssetId:"cover-1"});
    expect(() => videoCoverPayload("custom")).toThrow("VIDEO_COVER_ASSET_REQUIRED");
  });
  it("shows AI cover progress without reclassifying a public work", () => {
    expect(videoPublicationLabel({status:"running",stage:"ai_cover"})).toBe("正在生成并应用AI封面");
    expect(videoPublicationLabel({status:"published",stage:"ai_cover"})).toBe("已公开");
  });
});
describe("verified preparation evidence", () => {
  it("does not imply preparation for an old published record or unverified payload", () => {
    expect(verifiedVideoPreparationLabels()).toEqual([]);
    expect(verifiedVideoPreparationLabels({topics:{verified:false,resolved:[{name:"测试",id:"123"}]},cover:{source:"platform_ai",verified:false},chapters:{source:"platform_smart",count:4,verified:false}})).toEqual([]);
  });
  it("shows only successfully verified native preparation", () => {
    expect(verifiedVideoPreparationLabels({topics:{verified:true,resolved:[{name:"测试",id:"123"}]},chapters:{source:"platform_smart",count:4,verified:true},cover:{source:"platform_ai",verified:true}})).toEqual(["原生话题 1 个","智能章节 4 条","AI封面已应用"]);
  });
});
describe("title and native scheduling contract", () => {
  const now=Date.parse("2026-10-26T10:00:00+08:00");
  it("limits title to 30 Unicode code points and allows an empty title", () => {
    expect(limitVideoTitle("")).toBe("");
    expect(limitVideoTitle("😀".repeat(31))).toBe("😀".repeat(30));
    expect(limitVideoTitle("中".repeat(30))).toBe("中".repeat(30));
  });
  it("serializes a Beijing datetime independently of host/browser timezone", () => {
    expect(defaultVideoSchedule(now)).toBe("2026-10-26T13:00");
    expect(scheduledVideoPayload("scheduled","2026-10-26T13:00",now)).toEqual({publishMode:"scheduled",scheduledAt:"2026-10-26T13:00:00+08:00"});
    expect(scheduledVideoPayload("immediate","2026-10-26T13:00",now)).toEqual({publishMode:"immediate"});
    expect(formatVideoSchedule("2026-10-26T05:00:00Z")).toBe("2026-10-26 13:00 北京时间");
  });
  it("enforces minute precision and the inclusive two-hour to fourteen-day window", () => {
    expect(validateVideoSchedule("2026-10-26T12:00",now)).toBe("");
    expect(validateVideoSchedule("2026-11-09T10:00",now)).toBe("");
    expect(validateVideoSchedule("2026-10-26T11:59",now)).toContain("2 小时");
    expect(validateVideoSchedule("2026-11-09T10:01",now)).toContain("14 天");
    expect(validateVideoSchedule("2026-10-26T12:00:01",now)).toContain("分钟");
    expect(validateVideoSchedule("2026-02-30T12:00",now)).toContain("有效");
  });
  it("scheduled is not public even when a URL exists", () => {
    expect(videoPublicationLabel({status:"scheduled"})).toBe("已定时，等待计划时间");
    expect(publicVideoUrl({status:"scheduled",publicUrl:"https://www.douyin.com/video/123"})).toBe("");
    expect(canRetryVideo({status:"scheduled"})).toBe(false);
  });
});