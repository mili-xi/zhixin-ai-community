import type { AiWriterMode } from "@zengxing/core";

export type WriterStepId =
  | "mode"
  | "topic"
  | "brief"
  | "serp"
  | "type"
  | "variables"
  | "rule"
  | "library"
  | "media"
  | "seo"
  | "structure"
  | "publish"
  | "confirm";

export type WriterStepStatus = "completed" | "active" | "pending";

export type WriterStep = {
  id: WriterStepId;
  label: string;
  description: string;
};

export type WriterWizardNavigationStep = WriterStep & {
  index: number;
  status: WriterStepStatus;
  accessible: boolean;
};

export type WriterWizardNavigationState = {
  activeStep: number;
  activeStepId: WriterStepId;
  steps: WriterWizardNavigationStep[];
  canJumpToStep: (stepIndex: number) => boolean;
  canGoBack: boolean;
  canGoNext: boolean;
  primaryActionLabel: string;
  secondaryActionLabel: string;
  progressText: string;
};

export type ImageStrategy = "none" | "cover" | "inline" | "cover-and-inline" | "thumbnail";

export type WriterDraft = {
  mode: AiWriterMode;
  question: string;
  keyword: string;
  serpAnalysisId: string;
  articleTypeId: string;
  ruleId: string;
  knowledgeIds: string[];
  brandIds: string[];
  competitorIds: string[];
  assetIds: string[];
  watermarkIds: string[];
  title: string;
  seoTitle: string;
  metaDescription: string;
  secondaryKeywords: string;
  outline: string;
  extras: string[];
  publishTargetIds: string[];
  generateImages: boolean;
  imageStrategy: ImageStrategy;
  maxInlineImages: number;
};

const writerStepCatalog: Record<WriterStepId, WriterStep> = {
  mode: { id: "mode", label: "创作模式", description: "选择本次创作所需的工作流" },
  topic: { id: "topic", label: "基础主题", description: "填写主关键词和核心创作问题" },
  brief: { id: "brief", label: "自由 Brief", description: "用自然语言描述主题、目的和写作要求" },
  serp: { id: "serp", label: "SERP 数据源", description: "选择搜索结果并提炼内容差距" },
  type: { id: "type", label: "文章类型", description: "选择文章类型库模板" },
  variables: { id: "variables", label: "模板变量", description: "填写模板本次生成所需的主题和变量" },
  rule: { id: "rule", label: "生成规则", description: "套用文章/图文生成规则" },
  library: { id: "library", label: "知识与品牌", description: "知识库、品牌库、竞品库" },
  media: { id: "media", label: "素材与水印", description: "素材、配图和水印策略" },
  seo: { id: "seo", label: "标题与 SEO", description: "标题、SEO 标题、Meta" },
  structure: { id: "structure", label: "结构与增强", description: "大纲、FAQ、外链和加粗" },
  publish: { id: "publish", label: "发布设置", description: "媒体账号与发布目标" },
  confirm: { id: "confirm", label: "确认生成", description: "预览上下文并进入编辑器" }
};

export const writerModeStepIds: Record<AiWriterMode, WriterStepId[]> = {
  normal: ["mode", "topic", "type", "rule", "library", "media", "seo", "structure", "publish", "confirm"],
  free: ["mode", "brief", "library", "media", "seo", "structure", "publish", "confirm"],
  serp: ["mode", "serp", "type", "rule", "library", "media", "seo", "structure", "publish", "confirm"],
  template: ["mode", "type", "variables", "rule", "library", "media", "seo", "structure", "publish", "confirm"]
};

export function getWriterStepsForMode(mode: AiWriterMode): WriterStep[] {
  return writerModeStepIds[mode].map((stepId) => writerStepCatalog[stepId]);
}

const writerModeCapabilities: Record<
  AiWriterMode,
  { usesArticleType: boolean; usesRule: boolean; usesSerp: boolean }
> = {
  normal: { usesArticleType: true, usesRule: true, usesSerp: false },
  free: { usesArticleType: false, usesRule: false, usesSerp: false },
  serp: { usesArticleType: true, usesRule: true, usesSerp: true },
  template: { usesArticleType: true, usesRule: true, usesSerp: false }
};

export function getWriterModeCapabilities(mode: AiWriterMode) {
  return writerModeCapabilities[mode];
}

export const writerModeCards: { id: AiWriterMode; title: string; description: string }[] = [
  { id: "normal", title: "普通创作", description: "按关键词、类型和规则生成完整 SEO/GEO 长文。" },
  { id: "free", title: "自由创作", description: "以问题和人工 brief 为主，规则只作为辅助约束。" },
  { id: "serp", title: "SERP 创作", description: "从 SERP 结果提炼标题、结构、问题和内容差距。" },
  { id: "template", title: "模板创作", description: "复用文章类型库和生成规则，适合稳定批量产出。" }
];

export const writerExtraOptions = [
  "FAQ",
  "internal links",
  "external links",
  "cover image",
  "inline images",
  "citation summary",
  "bold keywords",
  "YouTube section",
  "online search"
];

export const writerInitialDraft: WriterDraft = {
  mode: "serp",
  question: "企业如何用 AI Writer 生成能发布、能被目标用户阅读的 SEO 长文？",
  keyword: "AI Writer SEO workflow",
  serpAnalysisId: "",
  articleTypeId: "",
  ruleId: "",
  knowledgeIds: [],
  brandIds: [],
  competitorIds: [],
  assetIds: [],
  watermarkIds: [],
  title: "AI Writer 10 步创作流程：从 SERP Brief 到媒体发布闭环",
  seoTitle: "AI Writer 10 步创作流程",
  metaDescription: "用 10 步式 AI Writer 串联关键词、SERP、生成规则、素材、发布渠道与公开可见性观察。",
  secondaryKeywords: "SERP brief\n发布渠道\n公开可见性\n媒体发布",
  outline: "",
  extras: ["FAQ", "internal links", "cover image", "citation summary"],
  publishTargetIds: [],
  generateImages: true,
  imageStrategy: "cover-and-inline",
  maxInlineImages: 5
};

function clampStepIndex(stepIndex: number, stepCount: number) {
  if (Number.isNaN(stepIndex)) return 0;
  return Math.max(0, Math.min(stepCount - 1, stepIndex));
}

export function buildWriterWizardNavigationState(mode: AiWriterMode, activeStep: number): WriterWizardNavigationState {
  const writerSteps = getWriterStepsForMode(mode);
  const stepIndex = clampStepIndex(activeStep, writerSteps.length);
  const steps = writerSteps.map((step, index) => {
    const status: WriterStepStatus = index < stepIndex ? "completed" : index === stepIndex ? "active" : "pending";
    return {
      ...step,
      index,
      status,
      accessible: index <= stepIndex
    };
  });

  return {
    activeStep: stepIndex,
    activeStepId: writerSteps[stepIndex].id,
    steps,
    canJumpToStep: (stepIndexToCheck: number) => stepIndexToCheck >= 0 && stepIndexToCheck <= stepIndex,
    canGoBack: stepIndex > 0,
    canGoNext: stepIndex < writerSteps.length - 1,
    primaryActionLabel: stepIndex === writerSteps.length - 1 ? "生成文案" : "下一步",
    secondaryActionLabel: "上一步",
    progressText: `${stepIndex + 1}/${writerSteps.length}`
  };
}

export function splitWriterLines(value: string) {
  return value
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function joinSelectionNames(items: { name: string }[]) {
  return items.map((item) => item.name).join("、") || "未选择";
}

export function toggleWriterSelection(id: string, values: string[]) {
  return values.includes(id) ? values.filter((item) => item !== id) : [...values, id];
}
