import { describe, expect, it } from "vitest";
import { buildWriterWizardNavigationState, getWriterModeCapabilities, getWriterStepsForMode, writerInitialDraft } from "./writer-form-state";

describe("getWriterStepsForMode", () => {
  it.each([
    ["normal", ["mode", "topic", "type", "rule", "library", "media", "seo", "structure", "publish", "confirm"]],
    ["free", ["mode", "brief", "library", "media", "seo", "structure", "publish", "confirm"]],
    ["serp", ["mode", "serp", "type", "rule", "library", "media", "seo", "structure", "publish", "confirm"]],
    ["template", ["mode", "type", "variables", "rule", "library", "media", "seo", "structure", "publish", "confirm"]]
  ] as const)("builds the %s creation path", (mode, expectedStepIds) => {
    expect(getWriterStepsForMode(mode).map((step) => step.id)).toEqual(expectedStepIds);
  });

  it.each([
    ["normal", "topic"],
    ["free", "brief"],
    ["serp", "serp"],
    ["template", "type"]
  ] as const)("routes %s to %s after mode selection", (mode, expectedStepId) => {
    const navigation = buildWriterWizardNavigationState(mode, 1);

    expect(navigation.activeStepId).toBe(expectedStepId);
  });
});

describe("getWriterModeCapabilities", () => {
  it.each([
    ["normal", { usesArticleType: true, usesRule: true, usesSerp: false }],
    ["free", { usesArticleType: false, usesRule: false, usesSerp: false }],
    ["serp", { usesArticleType: true, usesRule: true, usesSerp: true }],
    ["template", { usesArticleType: true, usesRule: true, usesSerp: false }]
  ] as const)("describes the %s generation context", (mode, expectedCapabilities) => {
    expect(getWriterModeCapabilities(mode)).toEqual(expectedCapabilities);
  });
});

describe("writerInitialDraft", () => {
  it("defaults to cover plus dynamically allocated body images", () => {
    expect(writerInitialDraft.generateImages).toBe(true);
    expect(writerInitialDraft.imageStrategy).toBe("cover-and-inline");
    expect(writerInitialDraft.maxInlineImages).toBe(5);
  });
});

describe("buildWriterWizardNavigationState", () => {
  it("marks earlier steps completed and future steps pending", () => {
    const navigation = buildWriterWizardNavigationState("serp", 3);

    expect(navigation.steps).toHaveLength(getWriterStepsForMode("serp").length);
    expect(navigation.steps[0]?.status).toBe("completed");
    expect(navigation.steps[2]?.status).toBe("completed");
    expect(navigation.steps[3]?.status).toBe("active");
    expect(navigation.steps[4]?.status).toBe("pending");
  });

  it("allows jumping only to completed or active steps", () => {
    const navigation = buildWriterWizardNavigationState("normal", 5);

    expect(navigation.canJumpToStep(0)).toBe(true);
    expect(navigation.canJumpToStep(5)).toBe(true);
    expect(navigation.canJumpToStep(6)).toBe(false);
  });

  it("switches the primary action label on the last step", () => {
    const lastFreeStep = getWriterStepsForMode("free").length - 1;
    const navigation = buildWriterWizardNavigationState("free", lastFreeStep);

    expect(navigation.primaryActionLabel).toBe("生成文案");
    expect(navigation.secondaryActionLabel).toBe("上一步");
    expect(navigation.progressText).toBe("8/8");
  });
});
