export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "canceled" | "retry";
export type ArticleStatus = "draft" | "generating" | "ready" | "review_required" | "published" | "archived";

export type ArticleImagePurpose = "cover" | "inline" | "infographic";

export type ArticleImage = {
  assetId?: string;
  purpose: ArticleImagePurpose;
  sectionId?: string;
  url: string;
  path?: string;
  altText: string;
  source?: "upload" | "website" | "ai";
};

export type ArticleImageBrief = {
  id?: string;
  purpose: ArticleImagePurpose;
  sectionId?: string;
  prompt: string;
  altText: string;
  aspectRatio?: string;
  priority?: number;
};

export type ArticleContentBlock =
  | { type: "title"; text: string }
  | { type: "section"; sectionId: string; title: string; content: string }
  | { type: "image"; sectionId: string; assetId?: string; url: string; path?: string; altText: string };

export type ArticleQuality = {
  status: "ready" | "review_required";
  issues: string[];
  wordCount: number;
  sectionCount: number;
  imageCount: number;
};
export type SiteStatus = "active" | "disabled" | "test_failed";
export type PublishStatus = "pending" | "running" | "succeeded" | "failed" | "canceled" | "retry" | "review_required" | "published_restricted";
export type InclusionStatus = "unchecked" | "checking" | "indexed" | "not_indexed" | "failed";
export type IndexSubmissionStatus = "pending" | "submitting" | "accepted" | "provider_pending" | "rejected" | "failed" | "unverified";
export type InclusionVerificationLevel = "official" | "observed" | "unavailable";
export type IndexWorkflowStatus = "not_submitted" | "pending" | "submitting" | "submitted" | "provider_pending" | "rejected" | "failed" | "unverified";
export type ScoreDimension = "seo" | "geo" | "semantic";

export type WorkspaceNavItem = {
  label: string;
  href: string;
  description: string;
};

export type WorkspaceNavGroup = {
  label: string;
  items: WorkspaceNavItem[];
};

export const workspaceNavGroups: WorkspaceNavGroup[] = [
  {
    label: "运营",
    items: [
      { label: "工作台", href: "/dashboard", description: "待办、运行状态和下一步操作" }
    ]
  },
  {
    label: "内容",
    items: [
      { label: "AI 创作", href: "/ai-writer", description: "创作文章并使用知识、素材和生成规则" },
      { label: "文章管理", href: "/articles", description: "管理文章、创作任务和发布状态" }
    ]
  },
  {
    label: "发布",
    items: [
      { label: "媒体账号", href: "/free-media", description: "免费媒体授权与登录态健康" },
      { label: "自动发布", href: "/auto-publish", description: "批量生成并发布到已授权媒体" },
      { label: "抖音视频", href: "/video-publish", description: "上传成品视频并自动发布到抖音" },
      { label: "发布记录", href: "/published", description: "发布结果、审核状态和公开 URL" }
    ]
  },
  {
    label: "接入",
    items: [
      { label: "自动化接入", href: "/agent-access", description: "远程 MCP 凭据与客户端配置" }
    ]
  }
];

export type IndexerTriggerEvent = "site_publish" | "media_backlink" | "manual_submit";

export type IndexerIntegration = {
  id: string;
  type: "site" | "media";
  name: string;
  status: string;
};

export type IndexerConfigRecord = IndexerConfig & {
  autoSubmit: boolean;
  triggerEvents: IndexerTriggerEvent[];
  connectedIntegrationIds: string[];
  retryLimit: number;
  connectedIntegrations: IndexerIntegration[];
  submittedCount: number;
  includedCount: number;
  retryQueueCount: number;
};

export type IndexerConfigCenter = {
  configs: IndexerConfigRecord[];
  integrations: IndexerIntegration[];
  summary: {
    total: number;
    authorized: number;
    autoSubmitEnabled: number;
    retryQueue: number;
    authorizationErrors: number;
  };
};

export function normalizeIndexerConfig(config: IndexerConfig): IndexerConfig {
  return {
    ...config,
    autoSubmit: config.autoSubmit ?? false,
    triggerEvents: config.triggerEvents ?? ["manual_submit"],
    connectedIntegrationIds: config.connectedIntegrationIds ?? [],
    retryLimit: config.retryLimit ?? 2,
    connectedSites: config.connectedSites ?? []
  };
}

export function createIndexerConfigCenter(input: {
  indexerConfigs: IndexerConfig[];
  sites: Site[];
  mediaAccounts: MediaAccount[];
  indexSubmissions: IndexSubmission[];
}): IndexerConfigCenter {
  const integrations: IndexerIntegration[] = [
    ...input.sites.map((site) => ({ id: `site:${site.id}`, type: "site" as const, name: site.name, status: site.status })),
    ...input.mediaAccounts.map((account) => ({ id: `media:${account.id}`, type: "media" as const, name: account.name, status: account.status }))
  ];
  const integrationById = new Map(integrations.map((integration) => [integration.id, integration]));
  const configs = input.indexerConfigs.map((rawConfig) => {
    const config = normalizeIndexerConfig(rawConfig);
    const submissions = input.indexSubmissions.filter((submission) => submission.provider === config.provider);
    return {
      ...config,
      autoSubmit: config.autoSubmit ?? false,
      triggerEvents: config.triggerEvents ?? ["manual_submit"],
      connectedIntegrationIds: config.connectedIntegrationIds ?? [],
      retryLimit: config.retryLimit ?? 2,
      connectedIntegrations: (config.connectedIntegrationIds ?? [])
        .map((id) => integrationById.get(id))
        .filter((item): item is IndexerIntegration => Boolean(item)),
      submittedCount: submissions.filter((submission) => submission.submitted).length,
      includedCount: submissions.filter((submission) => submission.inclusionStatus === "indexed").length,
      retryQueueCount: submissions.filter((submission) => submission.inclusionStatus === "failed" || submission.inclusionStatus === "not_indexed").length
    };
  });

  return {
    configs,
    integrations,
    summary: {
      total: configs.length,
      authorized: configs.filter((config) => config.authorized).length,
      autoSubmitEnabled: configs.filter((config) => config.autoSubmit).length,
      retryQueue: configs.reduce((sum, config) => sum + config.retryQueueCount, 0),
      authorizationErrors: configs.filter((config) => !config.authorized || config.error).length
    }
  };
}

export const workspaceNavItems: WorkspaceNavItem[] = workspaceNavGroups.flatMap((group) => group.items);

export type Article = {
  id: string;
  title: string;
  status: ArticleStatus;
  siteName: string;
  keyword: string;
  updatedAt: string;
  summary?: string;
  contentMarkdown?: string;
  seoTitle?: string;
  metaDescription?: string;
  keywords?: string[];
  score?: SeoGeoScoreResult;
  ruleName?: string;
  articleType?: string;
  tags?: string[];
  source?: string;
  publishStatus?: PublishStatus | "submitted_for_review" | "account_under_review" | "manual_verification_required";
  publicationStatus?: PublishStatus | "review_required";
  publishedUrl?: string;
  mediaPublishStatus?: PublishStatus | "review_required";
  mediaBacklinkStatus?: "pending" | "published" | "reviewing" | "blocked" | "failed";
  mediaOrderId?: string;
  mediaAccountId?: string;
  mediaPlatform?: string;
  mediaReviewUrl?: string;
  mediaPublishedUrl?: string;
  mediaPublicDiscoveryStatus?: string;
  writerContext?: AiWriterStepContext;
  llmProvider?: string;
  llmModel?: string;
  sections?: Array<{ id: string; title: string; content: string }>;
  contentBlocks?: ArticleContentBlock[];
  imageBriefs?: ArticleImageBrief[];
  coverImage?: ArticleImage | null;
  inlineImages?: ArticleImage[];
  assetIds?: string[];
  imageGenerationStatus?: "disabled" | "pending" | "completed" | "partial" | "failed";
  imageErrors?: Array<{ briefId?: string; purpose?: ArticleImagePurpose; sectionId?: string; code: string; message: string }>;
  quality?: ArticleQuality;
};

export type PublishJob = {
  id: string;
  articleId?: string;
  articleTitle: string;
  siteId?: string;
  siteName: string;
  connectorType: "WordPress" | "Webhook" | "DedeCMS" | "XunRuiCMS" | "PHPCMS";
  status: PublishStatus;
  attempts: number;
  publishedUrl?: string;
  errorMessage?: string;
  updatedAt: string;
};

export type IndexSubmission = {
  id: string;
  articleId?: string;
  articleTitle: string;
  provider: "Google" | "Baidu" | "IndexNow" | "Sitemap";
  status?: IndexSubmissionStatus;
  submitted: boolean;
  queued?: boolean;
  taskId?: string;
  source?: string;
  sourceType?: string;
  sourceId?: string;
  submissionMethod?: string;
  providerMessage?: string;
  providerResponse?: Record<string, unknown>;
  submissionReason?: string;
  submittedAt?: string;
  inclusionStatus: InclusionStatus;
  inspectionStatus?: string;
  verificationLevel?: InclusionVerificationLevel;
  verificationMethod?: string;
  inspectionMessage?: string;
  inspectionResponse?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  availabilityStatus?: "reachable" | "unreachable" | "unknown";
  availabilityHttpStatus?: number | null;
  availabilityError?: string;
  checkedAt: string;
  url?: string;
};

export type IndexablePublishOption = {
  jobId: string;
  articleTitle: string;
  siteName: string;
  url: string;
};

export type ResolvedIndexSubmissionInput = {
  articleTitle: string;
  provider: IndexSubmission["provider"];
  source: "publish_job" | "manual";
  url: string;
};

export type IndexSubmissionTimelineItem = {
  type: "submission_queued" | "submitted" | "inclusion_checked" | "failed";
  title: string;
  description: string;
  at?: string;
  status: InclusionStatus | IndexSubmissionStatus | "submitted";
};

export type IndexSubmissionNextAction = {
  action: "check-inclusion" | "retry-submit" | "copy-url" | "open-source";
  label: string;
  enabled: boolean;
  reason?: string;
};

export type IndexSubmissionDetail = {
  submission: IndexSubmission;
  sourceRecord?: PublishedCenterRecord;
  timeline: IndexSubmissionTimelineItem[];
  nextActions: IndexSubmissionNextAction[];
};

export type PublishedCenterRecord = {
  id: string;
  sourceType: "site" | "media";
  sourceId: string;
  articleId?: string;
  articleTitle: string;
  channelName: string;
  channelType: string;
  mediaAccountId?: string;
  platform?: string;
  status: PublishStatus;
  publishedUrl?: string;
  reviewUrl?: string;
  backlinkStatus?: MediaOrder["backlinkStatus"];
  platformStatus?: string;
  reviewStatus?: string;
  publicDiscoveryStatus?: MediaOrder["publicDiscoveryStatus"];
  indexStatus: IndexWorkflowStatus;
  indexProvider?: IndexSubmission["provider"];
  indexSubmissionId?: string;
  inclusionStatus: InclusionStatus;
  checkedAt?: string;
  errorMessage?: string;
  updatedAt: string;
};

export type PublishedRecordTimelineItem = {
  type: "created" | "published" | "index_submitted" | "inclusion_checked" | "failed";
  title: string;
  description: string;
  at?: string;
  status: PublishStatus | InclusionStatus | "submitted";
};

export type PublishedRecordNextAction = {
  action: "submit-index" | "check-inclusion" | "retry-failed" | "copy-url";
  label: string;
  enabled: boolean;
  reason?: string;
};

export type PublishedRecordDetail = {
  record: PublishedCenterRecord;
  publishJob?: PublishJob;
  mediaOrder?: MediaOrder;
  indexSubmission?: IndexSubmission;
  timeline: PublishedRecordTimelineItem[];
  nextActions: PublishedRecordNextAction[];
};

export type ArticleManagementRecord = {
  articleId: string;
  title: string;
  keyword: string;
  status: ArticleStatus;
  siteName: string;
  ruleName?: string;
  articleType?: string;
  tags: string[];
  source?: string;
  score?: SeoGeoScoreResult;
  updatedAt: string;
  publishJobId?: string;
  publishStatus: PublishStatus | "not_published";
  publishedUrl?: string;
  indexSubmissionId?: string;
  indexStatus: IndexWorkflowStatus;
  indexProvider?: IndexSubmission["provider"];
  inclusionStatus: InclusionStatus;
  checkedAt?: string;
};

export type ArticleManagementSummary = {
  total: number;
  draft: number;
  ready: number;
  published: number;
  generating: number;
  indexedSubmitted: number;
  included: number;
  notSubmitted: number;
};

export type ArticleManagementFacets = {
  articleTypes: string[];
  ruleNames: string[];
  sources: string[];
  tags: string[];
};

export type ArticleManagementFilters = {
  status?: ArticleStatus | "all";
  articleType?: string;
  ruleName?: string;
  source?: string;
  tag?: string;
  publishStatus?: PublishStatus | "not_published" | "all";
  indexStatus?: "submitted" | "not_submitted" | "all";
  inclusionStatus?: InclusionStatus | "all";
  query?: string;
};

export type ArticleManagementCenter = {
  records: ArticleManagementRecord[];
  summary: ArticleManagementSummary;
  facets: ArticleManagementFacets;
};

export type CreationTaskSourceType = "auto_publish" | "serp" | "rule" | "manual_ai";

export type CreationTaskArticle = Pick<
  ArticleManagementRecord,
  "articleId" | "title" | "keyword" | "status" | "publishStatus" | "indexStatus" | "inclusionStatus" | "updatedAt" | "publishedUrl"
>;

export type CreationTaskRecord = {
  id: string;
  sourceType: CreationTaskSourceType;
  title: string;
  description: string;
  ruleId?: string;
  ruleName?: string;
  ruleVersion?: string;
  serpId?: string;
  keywordSource?: string;
  targetPlatforms: string[];
  articleCount: number;
  readyCount: number;
  publishedCount: number;
  indexSubmittedCount: number;
  includedCount: number;
  failedCount: number;
  failureReasons: string[];
  createdAt: string;
  updatedAt: string;
  articles: CreationTaskArticle[];
};

export type CreationTaskSummary = {
  totalTasks: number;
  autoPublish: number;
  serp: number;
  rule: number;
  manualAi: number;
  totalArticles: number;
  publishedArticles: number;
  indexedArticles: number;
  includedArticles: number;
  failedTasks: number;
};

export type CreationTaskFacets = {
  sourceTypes: CreationTaskSourceType[];
  ruleNames: string[];
  targetPlatforms: string[];
};

export type CreationTaskFilters = {
  sourceType?: CreationTaskSourceType | "all";
  ruleName?: string;
  query?: string;
};

export type CreationTaskCenter = {
  tasks: CreationTaskRecord[];
  summary: CreationTaskSummary;
  facets: CreationTaskFacets;
};

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right, "zh-CN"));
}

export function createArticleManagementRecords(input: {
  articles: Article[];
  publishJobs: PublishJob[];
  indexSubmissions: IndexSubmission[];
}): ArticleManagementRecord[] {
  return input.articles.map((article) => {
    const publishJob = input.publishJobs
      .filter((job) => job.articleId === article.id || job.articleTitle === article.title)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const submission = findPublishedIndexSubmission(input.indexSubmissions, article.title, publishJob?.publishedUrl);
    const record: ArticleManagementRecord = {
      articleId: article.id,
      title: article.title,
      keyword: article.keyword,
      status: article.status,
      siteName: article.siteName,
      ruleName: article.ruleName,
      articleType: article.articleType,
      tags: article.tags ?? [],
      source: article.source,
      score: article.score,
      updatedAt: article.updatedAt,
      publishJobId: publishJob?.id,
      publishStatus: publishJob?.status ?? "not_published",
      publishedUrl: publishJob?.publishedUrl,
      indexSubmissionId: submission?.id,
      indexStatus: resolveIndexWorkflowStatus(submission),
      indexProvider: submission?.provider,
      inclusionStatus: submission?.inclusionStatus ?? "unchecked",
      checkedAt: submission?.checkedAt
    };
    return record;
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function filterArticleManagementRecords(records: ArticleManagementRecord[], filters: ArticleManagementFilters = {}) {
  const query = filters.query?.trim().toLowerCase();
  return records.filter((record) => {
    if (filters.status && filters.status !== "all" && record.status !== filters.status) return false;
    if (filters.articleType && record.articleType !== filters.articleType) return false;
    if (filters.ruleName && record.ruleName !== filters.ruleName) return false;
    if (filters.source && record.source !== filters.source) return false;
    if (filters.tag && !record.tags.includes(filters.tag)) return false;
    if (filters.publishStatus && filters.publishStatus !== "all" && record.publishStatus !== filters.publishStatus) return false;
    if (filters.indexStatus && filters.indexStatus !== "all" && record.indexStatus !== filters.indexStatus) return false;
    if (filters.inclusionStatus && filters.inclusionStatus !== "all" && record.inclusionStatus !== filters.inclusionStatus) return false;
    if (query) {
      const haystack = [record.title, record.keyword, record.ruleName, record.articleType, record.source, ...record.tags].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

export function summarizeArticleManagement(records: ArticleManagementRecord[]): ArticleManagementSummary {
  return {
    total: records.length,
    draft: records.filter((record) => record.status === "draft").length,
    ready: records.filter((record) => record.status === "ready").length,
    published: records.filter((record) => record.status === "published").length,
    generating: records.filter((record) => record.status === "generating").length,
    indexedSubmitted: records.filter((record) => record.indexStatus === "submitted").length,
    included: records.filter((record) => record.inclusionStatus === "indexed").length,
    notSubmitted: records.filter((record) => record.indexStatus === "not_submitted").length
  };
}

export function createArticleManagementFacets(records: ArticleManagementRecord[]): ArticleManagementFacets {
  return {
    articleTypes: uniqueSorted(records.map((record) => record.articleType ?? "")),
    ruleNames: uniqueSorted(records.map((record) => record.ruleName ?? "")),
    sources: uniqueSorted(records.map((record) => record.source ?? "")),
    tags: uniqueSorted(records.flatMap((record) => record.tags))
  };
}

export function createArticleManagementCenter(input: {
  articles: Article[];
  publishJobs: PublishJob[];
  indexSubmissions: IndexSubmission[];
  filters?: ArticleManagementFilters;
}): ArticleManagementCenter {
  const allRecords = createArticleManagementRecords(input);
  const records = filterArticleManagementRecords(allRecords, input.filters);
  return {
    records,
    summary: summarizeArticleManagement(allRecords),
    facets: createArticleManagementFacets(allRecords)
  };
}

function toCreationTaskArticle(record: ArticleManagementRecord): CreationTaskArticle {
  return {
    articleId: record.articleId,
    title: record.title,
    keyword: record.keyword,
    status: record.status,
    publishStatus: record.publishStatus,
    indexStatus: record.indexStatus,
    inclusionStatus: record.inclusionStatus,
    updatedAt: record.updatedAt,
    publishedUrl: record.publishedUrl
  };
}

function createTaskFromArticles(input: {
  id: string;
  sourceType: CreationTaskSourceType;
  title: string;
  description: string;
  ruleId?: string;
  ruleName?: string;
  ruleVersion?: string;
  serpId?: string;
  keywordSource?: string;
  targetPlatforms?: string[];
  createdAt: string;
  failureReasons?: string[];
  records: ArticleManagementRecord[];
}): CreationTaskRecord {
  const articles = input.records.map(toCreationTaskArticle);
  const failureReasons = Array.from(new Set((input.failureReasons ?? []).filter(Boolean)));
  return {
    id: input.id,
    sourceType: input.sourceType,
    title: input.title,
    description: input.description,
    ruleId: input.ruleId,
    ruleName: input.ruleName,
    ruleVersion: input.ruleVersion,
    serpId: input.serpId,
    keywordSource: input.keywordSource,
    targetPlatforms: input.targetPlatforms ?? [],
    articleCount: articles.length,
    readyCount: articles.filter((article) => article.status === "ready").length,
    publishedCount: articles.filter((article) => article.status === "published" || article.publishStatus === "succeeded").length,
    indexSubmittedCount: articles.filter((article) => article.indexStatus === "submitted").length,
    includedCount: articles.filter((article) => article.inclusionStatus === "indexed").length,
    failedCount: articles.filter((article) => article.publishStatus === "failed" || article.inclusionStatus === "failed").length + failureReasons.length,
    failureReasons,
    createdAt: input.createdAt,
    updatedAt: articles[0]?.updatedAt ?? input.createdAt,
    articles
  };
}

export function createCreationTaskCenter(input: {
  articles: Article[];
  publishJobs: PublishJob[];
  indexSubmissions: IndexSubmission[];
  autoPublishTasks: AutoPublishTask[];
  serpAnalyses: SerpAnalysisResult[];
  generationRules: GenerationRule[];
  filters?: CreationTaskFilters;
}): CreationTaskCenter {
  const articleRecords = createArticleManagementRecords(input);
  const recordsById = new Map(articleRecords.map((record) => [record.articleId, record]));
  const usedArticleIds = new Set<string>();
  const ruleById = new Map(input.generationRules.map((rule) => [rule.id, rule]));
  const tasks: CreationTaskRecord[] = [];

  for (const task of input.autoPublishTasks) {
    const records = (task.generatedArticleIds ?? [])
      .map((id) => recordsById.get(id))
      .filter((record): record is ArticleManagementRecord => Boolean(record));
    records.forEach((record) => usedArticleIds.add(record.articleId));
    const rule = task.ruleId ? ruleById.get(task.ruleId) : undefined;
    tasks.push(createTaskFromArticles({
      id: `auto:${task.id}`,
      sourceType: "auto_publish",
      title: task.name,
      description: `${task.keywordSource} / ${task.selectedKeywords?.join("、") || "未记录关键词"}`,
      ruleId: task.ruleId,
      ruleName: task.ruleName ?? rule?.name,
      ruleVersion: rule?.updatedAt ?? rule?.createdAt ?? task.createdAt,
      keywordSource: task.keywordSource,
      targetPlatforms: task.targetPlatforms,
      createdAt: task.createdAt,
      failureReasons: [task.lastError ?? "", task.failedCount > 0 ? `任务记录失败 ${task.failedCount} 条` : ""],
      records
    }));
  }

  for (const analysis of input.serpAnalyses) {
    const records = articleRecords.filter((record) => {
      if (usedArticleIds.has(record.articleId)) return false;
      const source = record.source ?? "";
      return record.keyword === analysis.keyword || source.includes("SERP") || record.title.includes(analysis.keyword);
    });
    if (!records.length) continue;
    records.forEach((record) => usedArticleIds.add(record.articleId));
    tasks.push(createTaskFromArticles({
      id: `serp:${analysis.id}`,
      sourceType: "serp",
      title: `${analysis.keyword} SERP 创作`,
      description: analysis.contentBrief,
      serpId: analysis.id,
      keywordSource: `${analysis.searchEngine} / ${analysis.region} / ${analysis.device}`,
      targetPlatforms: [],
      createdAt: analysis.analyzedAt,
      records
    }));
  }

  const remaining = articleRecords.filter((record) => !usedArticleIds.has(record.articleId));
  const byRule = new Map<string, ArticleManagementRecord[]>();
  for (const record of remaining) {
    const key = record.ruleName || (record.source?.includes("AI") || record.source?.includes("创作") ? "manual-ai" : "");
    if (!key) continue;
    byRule.set(key, [...(byRule.get(key) ?? []), record]);
  }
  for (const [ruleName, records] of byRule) {
    const rule = input.generationRules.find((item) => item.name === ruleName);
    tasks.push(createTaskFromArticles({
      id: rule ? `rule:${rule.id}` : "manual-ai",
      sourceType: rule ? "rule" : "manual_ai",
      title: rule ? `${rule.name} 规则创作` : "手动 AI 创作",
      description: rule?.content ?? "来自 AI 创作页的手动生成记录",
      ruleId: rule?.id,
      ruleName: rule?.name ?? (ruleName === "manual-ai" ? undefined : ruleName),
      ruleVersion: rule?.updatedAt ?? rule?.createdAt,
      targetPlatforms: [],
      createdAt: records[records.length - 1]?.updatedAt ?? records[0]?.updatedAt ?? "",
      records
    }));
  }

  const query = input.filters?.query?.trim().toLowerCase();
  const filtered = tasks.filter((task) => {
    if (input.filters?.sourceType && input.filters.sourceType !== "all" && task.sourceType !== input.filters.sourceType) return false;
    if (input.filters?.ruleName && task.ruleName !== input.filters.ruleName) return false;
    if (query) {
      const haystack = [
        task.title,
        task.description,
        task.ruleName,
        task.keywordSource,
        ...task.targetPlatforms,
        ...task.articles.flatMap((article) => [article.title, article.keyword])
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return {
    tasks: filtered,
    summary: {
      totalTasks: tasks.length,
      autoPublish: tasks.filter((task) => task.sourceType === "auto_publish").length,
      serp: tasks.filter((task) => task.sourceType === "serp").length,
      rule: tasks.filter((task) => task.sourceType === "rule").length,
      manualAi: tasks.filter((task) => task.sourceType === "manual_ai").length,
      totalArticles: tasks.reduce((sum, task) => sum + task.articleCount, 0),
      publishedArticles: tasks.reduce((sum, task) => sum + task.publishedCount, 0),
      indexedArticles: tasks.reduce((sum, task) => sum + task.indexSubmittedCount, 0),
      includedArticles: tasks.reduce((sum, task) => sum + task.includedCount, 0),
      failedTasks: tasks.filter((task) => task.failedCount > 0).length
    },
    facets: {
      sourceTypes: Array.from(new Set(tasks.map((task) => task.sourceType))),
      ruleNames: uniqueSorted(tasks.map((task) => task.ruleName ?? "")),
      targetPlatforms: uniqueSorted(tasks.flatMap((task) => task.targetPlatforms))
    }
  };
}

export function getIndexablePublishOptions(publishJobs: PublishJob[]): IndexablePublishOption[] {
  return publishJobs
    .filter((job) => job.status === "succeeded" && Boolean(job.publishedUrl?.trim()))
    .map((job) => ({
      jobId: job.id,
      articleTitle: job.articleTitle,
      siteName: job.siteName,
      url: job.publishedUrl!.trim()
    }));
}

export function resolveIndexSubmissionInput(input: {
  publishJobs: PublishJob[];
  selectedJobId: string;
  manualTitle: string;
  manualUrl: string;
  provider: IndexSubmission["provider"];
}): ResolvedIndexSubmissionInput | null {
  const selected = getIndexablePublishOptions(input.publishJobs).find((job) => job.jobId === input.selectedJobId);
  if (selected) {
    return {
      articleTitle: selected.articleTitle,
      provider: input.provider,
      source: "publish_job",
      url: selected.url
    };
  }

  const articleTitle = input.manualTitle.trim();
  const url = input.manualUrl.trim();
  if (!articleTitle || !url) {
    return null;
  }

  return {
    articleTitle,
    provider: input.provider,
    source: "manual",
    url
  };
}

function findPublishedIndexSubmission(submissions: IndexSubmission[], articleTitle: string, url?: string) {
  const normalizedUrl = url?.trim();
  if (normalizedUrl) {
    const byUrl = submissions.find((submission) => submission.url?.trim() === normalizedUrl);
    if (byUrl) return byUrl;
  }
  return submissions.find((submission) => submission.articleTitle === articleTitle);
}

export function resolveIndexWorkflowStatus(submission?: IndexSubmission): IndexWorkflowStatus {
  if (!submission) return "not_submitted";
  if (submission.submitted) return "submitted";
  const status = submission.status ?? "pending";
  if (status === "accepted") return "pending";
  return status;
}

export function createPublishedRecords(input: {
  publishJobs: PublishJob[];
  mediaOrders: MediaOrder[];
  indexSubmissions: IndexSubmission[];
}): PublishedCenterRecord[] {
  const siteRecords = input.publishJobs.map((job): PublishedCenterRecord => {
    const submission = findPublishedIndexSubmission(input.indexSubmissions, job.articleTitle, job.publishedUrl);
    return {
      id: `site:${job.id}`,
      sourceType: "site",
      sourceId: job.id,
      articleTitle: job.articleTitle,
      channelName: job.siteName,
      channelType: job.connectorType,
      status: job.status,
      publishedUrl: job.publishedUrl,
      indexStatus: resolveIndexWorkflowStatus(submission),
      indexProvider: submission?.provider,
      indexSubmissionId: submission?.id,
      inclusionStatus: submission?.inclusionStatus ?? "unchecked",
      checkedAt: submission?.checkedAt,
      errorMessage: job.errorMessage,
      updatedAt: job.updatedAt
    };
  });

  const mediaRecords = input.mediaOrders.map((order): PublishedCenterRecord => {
    const submission = findPublishedIndexSubmission(input.indexSubmissions, order.articleTitle, order.backlinkUrl);
    return {
      id: `media:${order.id}`,
      sourceType: "media",
      sourceId: order.id,
      articleTitle: order.articleTitle,
      channelName: order.resourceName,
      channelType: order.resourceId.startsWith("account:") ? "免费媒体" : "软文媒体",
      status: order.status,
      backlinkStatus: order.backlinkStatus,
      platformStatus: order.platformStatus,
      publishedUrl: order.backlinkUrl,
      indexStatus: resolveIndexWorkflowStatus(submission),
      indexProvider: submission?.provider,
      indexSubmissionId: submission?.id,
      inclusionStatus: submission?.inclusionStatus ?? "unchecked",
      checkedAt: submission?.checkedAt,
      errorMessage: order.errorMessage,
      updatedAt: order.updatedAt
    };
  });

  return [...siteRecords, ...mediaRecords].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function createPublishedRecordDetail(input: {
  record: PublishedCenterRecord;
  publishJob?: PublishJob;
  mediaOrder?: MediaOrder;
  indexSubmission?: IndexSubmission;
}): PublishedRecordDetail {
  const timeline: PublishedRecordTimelineItem[] = [];

  if (input.publishJob) {
    timeline.push({
      type: input.publishJob.status === "failed" ? "failed" : "created",
      title: "站点发布任务",
      description: `${input.publishJob.siteName} / ${input.publishJob.connectorType}`,
      at: input.publishJob.updatedAt,
      status: input.publishJob.status
    });
  }

  if (input.mediaOrder) {
    timeline.push({
      type: input.mediaOrder.status === "failed" ? "failed" : "created",
      title: "媒体发稿订单",
      description: `${input.mediaOrder.resourceName} / ${input.mediaOrder.resourceId}`,
      at: input.mediaOrder.updatedAt,
      status: input.mediaOrder.status
    });
  }

  if (input.record.publishedUrl) {
    timeline.push({
      type: "published",
      title: input.record.sourceType === "site" ? "发布 URL 已生成" : "媒体 backlink 已生成",
      description: input.record.publishedUrl,
      at: input.record.updatedAt,
      status: input.record.status
    });
  }

  if (input.indexSubmission) {
    timeline.push({
      type: "index_submitted",
      title: "可见性记录已创建",
      description: input.indexSubmission.url ?? input.indexSubmission.articleTitle,
      at: input.indexSubmission.checkedAt,
      status: "submitted"
    });

    timeline.push({
      type: "inclusion_checked",
      title: "公开可见性检测已记录",
      description: input.indexSubmission.url ?? input.indexSubmission.articleTitle,
      at: input.indexSubmission.checkedAt,
      status: input.indexSubmission.inclusionStatus
    });
  }

  if (input.record.errorMessage) {
    timeline.push({
      type: "failed",
      title: "发布异常",
      description: input.record.errorMessage,
      at: input.record.updatedAt,
      status: input.record.status
    });
  }

  const nextActions: PublishedRecordNextAction[] = [
    {
      action: "copy-url",
      label: "复制 URL",
      enabled: Boolean(input.record.publishedUrl),
      reason: input.record.publishedUrl ? undefined : "发布成功后才有 URL"
    },
    {
      action: "check-inclusion",
      label: "检测可见性",
      enabled: Boolean(input.record.publishedUrl),
      reason: input.record.publishedUrl ? undefined : "缺少发布 URL"
    },
    {
      action: "retry-failed",
      label: "重试失败",
      enabled: input.record.status === "failed",
      reason: input.record.status === "failed" ? undefined : "仅失败记录可重试"
    }
  ];

  return {
    record: input.record,
    publishJob: input.publishJob,
    mediaOrder: input.mediaOrder,
    indexSubmission: input.indexSubmission,
    timeline,
    nextActions
  };
}

export function createIndexSubmissionDetail(input: {
  submission: IndexSubmission;
  publishedRecords: PublishedCenterRecord[];
}): IndexSubmissionDetail {
  const sourceRecord = input.publishedRecords.find((record) => {
    if (input.submission.url && record.publishedUrl === input.submission.url) return true;
    return record.articleTitle === input.submission.articleTitle;
  });

  const timeline: IndexSubmissionTimelineItem[] = [
    {
      type: input.submission.submitted ? "submitted" : "submission_queued",
      title: input.submission.submitted ? `${input.submission.provider} 已受理` : `${input.submission.provider} 等待提交`,
      description: input.submission.providerMessage ?? input.submission.url ?? input.submission.articleTitle,
      at: input.submission.submittedAt,
      status: input.submission.submitted ? "submitted" : input.submission.status ?? "pending"
    }
  ];

  if (input.submission.inclusionStatus !== "unchecked" && input.submission.inclusionStatus !== "checking") {
    timeline.push({
      type: input.submission.inclusionStatus === "failed" ? "failed" : "inclusion_checked",
      title: "公开可见性验证",
      description: input.submission.inspectionMessage ?? input.submission.verificationMethod ?? input.submission.url ?? input.submission.articleTitle,
      at: input.submission.checkedAt,
      status: input.submission.inclusionStatus
    });
  }

  const nextActions: IndexSubmissionNextAction[] = [
    {
      action: "copy-url",
      label: "复制 URL",
      enabled: Boolean(input.submission.url),
      reason: input.submission.url ? undefined : "缺少 URL"
    },
    {
      action: "check-inclusion",
      label: "验证可见性",
      enabled: Boolean(input.submission.url) && !["pending", "submitting"].includes(input.submission.status ?? "") && input.submission.inclusionStatus !== "checking",
      reason: !input.submission.url
        ? "缺少 URL"
        : ["pending", "submitting"].includes(input.submission.status ?? "")
          ? "请等待 Provider 提交完成"
          : undefined
    },
    {
      action: "retry-submit",
      label: "重新提交",
      enabled: Boolean(input.submission.url) && (["provider_pending", "rejected", "failed", "unverified"].includes(input.submission.status ?? "") || (input.submission.status === "pending" && input.submission.queued === false)),
      reason: ["provider_pending", "rejected", "failed", "unverified"].includes(input.submission.status ?? "") || (input.submission.status === "pending" && input.submission.queued === false) ? undefined : "仅入队失败、待配置、被拒绝、失败或未验证记录需要重提"
    },
    {
      action: "open-source",
      label: "查看来源发布",
      enabled: Boolean(sourceRecord),
      reason: sourceRecord ? undefined : "未匹配发布来源"
    }
  ];

  return {
    submission: input.submission,
    sourceRecord,
    timeline,
    nextActions
  };
}

export type InclusionWorkflowSummary = {
  totalSubmitted: number;
  unchecked: number;
  checking: number;
  indexed: number;
  notIndexed: number;
  failed: number;
  checked: number;
  checkable: number;
  inclusionRate: number;
};

export function getInclusionCheckQueue(submissions: IndexSubmission[]): IndexSubmission[] {
  const priority: Record<InclusionStatus, number> = {
    unchecked: 0,
    failed: 1,
    not_indexed: 2,
    indexed: 3,
    checking: 4
  };

  return submissions
    .filter((submission) => (
      Boolean(submission.url?.trim())
      && submission.inclusionStatus !== "checking"
      && submission.status !== "pending"
      && submission.status !== "submitting"
    ))
    .slice()
    .sort((left, right) => priority[left.inclusionStatus] - priority[right.inclusionStatus]);
}

export function calculateInclusionWorkflowSummary(submissions: IndexSubmission[]): InclusionWorkflowSummary {
  const totalSubmitted = submissions.filter((submission) => submission.submitted).length;
  const unchecked = submissions.filter((submission) => submission.inclusionStatus === "unchecked").length;
  const checking = submissions.filter((submission) => submission.inclusionStatus === "checking").length;
  const indexed = submissions.filter((submission) => submission.inclusionStatus === "indexed").length;
  const notIndexed = submissions.filter((submission) => submission.inclusionStatus === "not_indexed").length;
  const failed = submissions.filter((submission) => submission.inclusionStatus === "failed").length;
  const checked = indexed + notIndexed + failed;
  const checkable = getInclusionCheckQueue(submissions).length;

  return {
    totalSubmitted,
    unchecked,
    checking,
    indexed,
    notIndexed,
    failed,
    checked,
    checkable,
    inclusionRate: checked === 0 ? 0 : Math.round((indexed / checked) * 100)
  };
}

export type TaskItem = {
  id: string;
  title: string;
  type: "AI 生成" | "发布" | "可见性观察";
  status: TaskStatus;
  progress: number;
  errorMessage?: string;
};

export type Site = {
  id: string;
  name: string;
  type: "WordPress" | "Webhook" | "DedeCMS" | "XunRuiCMS" | "PHPCMS";
  siteType: "cms" | "webhook" | "custom";
  baseUrl: string;
  status: SiteStatus;
  defaultCategory: string;
  defaultTags: string[];
  lastPublishedAt: string;
  lastError?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  strategyCount?: number;
  members?: string[];
};

export type Asset = {
  id: string;
  filename: string;
  type: "cover" | "inline" | "brand";
  altText: string;
  relatedArticle: string;
  color: string;
  tags: string[];
  source: "upload" | "website" | "ai";
  size: string;
  updatedAt: string;
  url?: string;
  path?: string;
  contentType?: string;
  sizeBytes?: number;
  provider?: string;
  model?: string;
  prompt?: string;
  purpose?: ArticleImagePurpose;
  sectionId?: string;
  articleId?: string;
  taskId?: string;
};

export type AssetTag = {
  id: string;
  name: string;
  usageCount: number;
};

export type AssetTagGroup = {
  id: string;
  name: string;
  description: string;
  tags: AssetTag[];
  updatedAt: string;
};

export type KnowledgeItem = {
  id: string;
  title: string;
  source: "local_file" | "asset" | "text" | "url";
  status: "parsing" | "learning" | "completed" | "failed";
  content: string;
  url?: string;
  tags: string[];
  refreshMode: "manual" | "daily" | "weekly";
  lastRefreshedAt?: string;
  updatedAt: string;
  errorMessage?: string;
};

export type BrandProfile = {
  id: string;
  name: string;
  website: string;
  description: string;
  contacts: string[];
  products: string[];
  tags: string[];
  updatedAt: string;
};

export type CompetitorProfile = {
  id: string;
  name: string;
  website: string;
  relation: "primary" | "functional" | "content" | "media";
  description: string;
  products: string[];
  strengths: string[];
  weakPoints: string[];
  tags: string[];
  updatedAt: string;
};

export type SupportLibrarySummary = {
  knowledge: {
    total: number;
    completed: number;
    learning: number;
    failed: number;
  };
  brands: {
    total: number;
    products: number;
  };
  competitors: {
    total: number;
    primary: number;
    products: number;
  };
};

export type Watermark = {
  id: string;
  name: string;
  type: "image" | "text";
  imageUrl?: string;
  text?: string;
  opacity: number;
  position: string;
  channels: string[];
  createdAt: string;
};

// Demo-only seed records for core tests, UI examples, and desktop prototypes.
// Production runtime data lives in FastAPI + PostgreSQL; do not treat these mock*
// exports as the application's active data source.
export const mockWatermarks: Watermark[] = [
  { id: "wm-1", name: "右下角品牌水印", type: "image", imageUrl: "https://via.placeholder.com/120x40.png?text=智心AI", opacity: 72, position: "右下", channels: ["封面", "插图", "媒体发布"], createdAt: "2026-06-28 09:20" },
  { id: "wm-2", name: "居中浅色水印", type: "image", imageUrl: "https://via.placeholder.com/120x40.png?text=智心AI", opacity: 18, position: "居中", channels: ["软文媒体配图"], createdAt: "2026-06-27 16:40" },
  { id: "wm-3", name: "无水印原图", type: "image", imageUrl: "", opacity: 0, position: "不应用", channels: ["站内文章", "SEO 图片"], createdAt: "2026-06-26 14:22" },
  { id: "wm-4", name: "公众号横版水印", type: "text", text: "智心AI", opacity: 46, position: "底部居中", channels: ["公众号", "百家号"], createdAt: "2026-06-25 11:10" }
];

export type ScoreItem = {
  key: string;
  label: string;
  dimension: ScoreDimension;
  score: number;
  severity: "good" | "warning" | "critical";
  reason: string;
  suggestion: string;
  canAutoFix: boolean;
};

export type SeoGeoScoreResult = {
  totalScore: number;
  seoScore: number;
  geoScore: number;
  items: ScoreItem[];
};

export type PlatformEvidenceSummary = {
  endpoint?: string;
  httpStatus?: number;
  businessStatus?: string;
  message?: string;
  externalIds?: Record<string, string | number | boolean>;
  checkedAt?: string;
};

export type PlatformConfigSnapshot = {
  schemaVersion: number;
  fetchedAt: string;
  sourceEvidence?: PlatformEvidenceSummary;
  accountId?: string;
  userId?: string;
  wemediaId?: string;
  notebookId?: string;
  channelId?: string | number;
  categoryId?: string | number;
  readType?: string | number;
  city?: string;
  cityCode?: string;
  declaration?: string;
  sourceUrl?: string;
  attrIds?: Array<string | number>;
  metadata?: Record<string, string | number | boolean | Array<string | number>>;
};

export type PlatformCapabilities = {
  schemaVersion: number;
  fetchedAt: string;
  canPublishArticle: boolean;
  canUploadImages: boolean;
  requiresCover?: boolean;
  requiresCategory?: boolean;
  requiresTags?: boolean;
  requiresDeclaration?: boolean;
  requiresManualVerification?: boolean;
  phoneBindingRequired?: boolean;
  requiredFields?: string[];
  limits?: Record<string, string | number | boolean>;
  sourceEvidence?: PlatformEvidenceSummary;
};

export type PublicationStage =
  | "auth_validated"
  | "preflight_passed"
  | "assets_uploaded"
  | "draft_saved"
  | "submit_requested"
  | "platform_accepted"
  | "review_pending"
  | "public_verified";

export type PublicationFailureCategory =
  | "auth_expired"
  | "required_field_missing"
  | "image_upload_failed"
  | "captcha_required"
  | "rate_limited"
  | "platform_rejected"
  | "public_not_visible"
  | "public_mismatch"
  | "unknown";

export type PublicationStageCheckpoint = {
  stage: PublicationStage;
  status: "pending" | "running" | "succeeded" | "failed";
  at: string;
  evidence?: PlatformEvidenceSummary;
  message?: string;
};

export type PublicationEvidence = {
  source: "desktop-adapter" | "api" | "public-discovery" | "manual";
  platform: MediaAccount["platform"];
  accepted?: boolean;
  publicVerified?: boolean;
  externalIds?: Record<string, string | number | boolean>;
  checkpoints?: PublicationStageCheckpoint[];
  sourceEvidence?: PlatformEvidenceSummary;
};

export type MediaAccount = {
  id: string;
  platform: "baijiahao" | "wechat" | "zhihu" | "sohu" | "csdn" | "netease" | "penguin" | "toutiao" | "jianshu" | "douyin" | "other";
  name: string;
  accountName?: string;
  avatar?: string;
  cookies: string;
  status: "active" | "disabled" | "error" | "pending" | "needs_reauth" | "superseded";
  fields: string[];
  limit?: string;
  lastCheckedAt?: string;
  lastError?: string;
  authArtifactId?: string;
  profileKey?: string;
  credentialFingerprint?: string;
  credentialStatus?: "active" | "stale" | "needs_reauth" | "expired" | "invalid" | "revoked";
  credentialExpiresAt?: string;
  lastVerifiedAt?: string;
  nextCredentialCheckAt?: string;
  consecutiveAuthFailures?: number;
  isCanonical?: boolean;
  supersededByAccountId?: string;
  supersededAt?: string;
  platformConfig?: PlatformConfigSnapshot;
  capabilities?: PlatformCapabilities;
  createdAt: string;
};

export function isMediaAccountPublishable(account: Pick<MediaAccount, "status" | "credentialStatus" | "isCanonical">) {
  return account.isCanonical !== false
    && account.status === "active"
    && account.credentialStatus === "active";
}

export const mockMediaAccounts: MediaAccount[] = [
  { id: "media-1", platform: "baijiahao", name: "百家号 AI 增长号", accountName: "智心AI官方", status: "active", credentialStatus: "active", fields: ["标题", "封面", "正文", "原创声明"], limit: "每日发布 3 篇", cookies: "mock-cookies-for-media-1", createdAt: "2026-06-28 09:20" },
  { id: "media-2", platform: "wechat", name: "公众号内容中心", accountName: "智心AI公众号", status: "error", fields: ["标题", "封面", "正文", "摘要"], limit: "登录态已失效", lastError: "Cookie 已过期，请重新授权", cookies: "mock-cookies-for-media-2", createdAt: "2026-06-27 16:40" },
  { id: "media-3", platform: "zhihu", name: "SEO 实战专栏", status: "active", credentialStatus: "active", fields: ["标题", "正文", "话题"], limit: "每日发布 2 篇", cookies: "mock-cookies-for-media-3", createdAt: "2026-06-26 14:22" },
  { id: "media-4", platform: "sohu", name: "搜狐号增长实验室", status: "disabled", fields: ["标题", "正文", "分类"], limit: "审核中", cookies: "mock-cookies-for-media-4", createdAt: "2026-06-25 11:10" },
  { id: "media-6", platform: "csdn", name: "CSDN增长号", status: "pending", fields: ["标题", "正文", "分类", "标签", "封面"], limit: "待授权", cookies: "", createdAt: "2026-07-04 20:10" },
  { id: "media-7", platform: "netease", name: "网易号增长号", status: "pending", fields: ["标题", "正文", "分类", "封面"], limit: "待授权", cookies: "", createdAt: "2026-07-04 20:11" },
  { id: "media-8", platform: "penguin", name: "企鹅号增长号", status: "pending", fields: ["标题", "正文", "分类", "封面", "原创声明"], limit: "待授权", cookies: "", createdAt: "2026-07-04 20:12" },
  { id: "media-9", platform: "toutiao", name: "头条号增长号", status: "pending", fields: ["标题", "正文", "分类", "封面", "原创声明"], limit: "待授权", cookies: "", createdAt: "2026-07-04 20:13" },
  { id: "media-10", platform: "jianshu", name: "简书增长号", status: "pending", fields: ["标题", "正文", "文集", "标签"], limit: "待授权", cookies: "", createdAt: "2026-07-04 20:14" }
];
export type GenerationRule = {
  id: string;
  name: string;
  type: "article" | "image-text";
  content: string;
  sourceMode?: "keyword-library" | "manual-keywords" | "serp" | "template";
  keywordLibraryName?: string;
  keywordPickMode?: "top10" | "manual" | "random";
  keywordCount?: number;
  forcedTitleKeywords?: string[];
  contentRequirements?: string;
  humanizationRules?: string;
  replacementRules?: string;
  knowledgeBaseRefs?: string[];
  assetTagGroupRefs?: string[];
  brandProfileRefs?: string[];
  competitorProfileRefs?: string[];
  watermarkRefs?: string[];
  imageStrategy?: "none" | "cover" | "inline" | "cover-and-inline" | "thumbnail";
  geoStrategy?: {
    includeFaq: boolean;
    includeCitationSummary: boolean;
    trackBrandMention: boolean;
    trackCompetitorMention: boolean;
  };
  formatRules?: string;
  structureRules?: string;
  internalLinkRules?: string;
  externalLinkRules?: string;
  fixedIntro?: string;
  fixedOutro?: string;
  modelProvider?: "OpenAI" | "文心一言" | "DeepSeek";
  status?: "active" | "draft";
  createdAt: string;
  updatedAt?: string;
};

export type ArticleTypeTemplate = {
  id: string;
  name: string;
  category: string;
  sourceType: "system" | "custom";
  visible: boolean;
  prompt: string;
  matchingRules?: string;
  readingRules?: string;
  outlineRules?: string;
  titleRules?: string;
  descriptionRules?: string;
  writingRules?: string;
  rewriteRules?: string;
  notes?: string;
  useCount: number;
  createdAt: string;
  updatedAt: string;
};

export const mockArticleTypes: ArticleTypeTemplate[] = [
  {
    id: "article-type-guide",
    name: "操作指南",
    category: "系统预设",
    sourceType: "system",
    visible: true,
    prompt: "面向搜索用户解释步骤、注意事项和执行清单，输出 H2/H3 层级、FAQ 和可引用结论。",
    matchingRules: "适合怎么做、如何配置、流程教程、排查清单类关键词。",
    readingRules: "先读取 SERP 中的步骤型内容和常见问题，再判断用户最需要的执行路径。",
    outlineRules: "按背景、准备、步骤、检查、FAQ、后续动作组织。",
    titleRules: "标题包含主关键词和明确收益，避免空泛营销词。",
    descriptionRules: "描述需要说明适用对象、核心步骤和结果。",
    writingRules: "每个步骤要给出动作、判断标准和常见错误。",
    rewriteRules: "保留关键实体和工具名，压缩重复段落。",
    notes: "默认用于 AI 创作和 SERP 创作。",
    useCount: 48,
    createdAt: "2026-06-29 10:20",
    updatedAt: "2026-06-29 10:20"
  },
  {
    id: "article-type-list",
    name: "列表文章",
    category: "系统预设",
    sourceType: "system",
    visible: true,
    prompt: "将解决方案拆成可扫描的清单，适合关键词覆盖、媒体分发和对比型内容。",
    matchingRules: "适合工具推荐、方法合集、平台对比、最佳实践类关键词。",
    readingRules: "读取竞品列表项、筛选维度和缺口，避免只堆名称。",
    outlineRules: "先给选择标准，再列清单项，最后给决策建议。",
    titleRules: "标题包含数量、场景和主关键词。",
    descriptionRules: "描述突出清单覆盖范围和选择标准。",
    writingRules: "每个列表项包含适用场景、优势、限制和下一步。",
    rewriteRules: "合并相似项，保持排序逻辑清楚。",
    useCount: 32,
    createdAt: "2026-06-29 10:20",
    updatedAt: "2026-06-29 10:20"
  },
  {
    id: "article-type-faq",
    name: "GEO 引用友好 FAQ",
    category: "GEO",
    sourceType: "custom",
    visible: true,
    prompt: "围绕 AI 问答场景生成问题、短答案和引用来源，强调品牌实体和可摘录句。",
    matchingRules: "适合为什么、是什么、区别、是否值得、怎么判断类问题。",
    readingRules: "优先读取相关问题、AI 引用源和品牌/竞品实体。",
    outlineRules: "每个 H3 是一个真实问题，答案第一句先给结论。",
    titleRules: "标题用问句或问题集合表达。",
    descriptionRules: "描述要覆盖核心问题和答案边界。",
    writingRules: "先短答，再解释依据，最后给可执行建议。",
    rewriteRules: "保持答案直接，减少长铺垫。",
    notes: "用于自动 GEO 和 AI 引用优化。",
    useCount: 9,
    createdAt: "2026-06-29 10:20",
    updatedAt: "2026-06-29 10:20"
  }
];

export const mockGenerationRules: GenerationRule[] = [
  {
    id: "rule-1",
    name: "SEO/GEO 长文规则",
    type: "article",
    content: "H2/H3 结构、FAQ、实体、可引用结论",
    sourceMode: "keyword-library",
    keywordLibraryName: "AI SEO 核心词库",
    keywordPickMode: "top10",
    keywordCount: 10,
    forcedTitleKeywords: ["AI SEO", "GEO 优化"],
    contentRequirements: "每个 H2 后必须给出一句可被 AI 引用的结论，正文覆盖定义、流程、案例和 FAQ。",
    humanizationRules: "少用夸张营销词，用运营负责人能看懂的短句解释。",
    replacementRules: "将“下一代、颠覆式、赋能”等词替换为可验证的业务描述。",
    knowledgeBaseRefs: ["产品资料", "行业 FAQ"],
    assetTagGroupRefs: ["asset-tag-group-1"],
    brandProfileRefs: ["brand-1"],
    competitorProfileRefs: ["competitor-profile-1"],
    watermarkRefs: ["wm-1"],
    imageStrategy: "cover-and-inline",
    geoStrategy: {
      includeFaq: true,
      includeCitationSummary: true,
      trackBrandMention: true,
      trackCompetitorMention: true
    },
    formatRules: "包含摘要、H2/H3、FAQ、内链建议和 Meta 描述。",
    structureRules: "先讲问题，再讲方法，最后给执行清单。",
    internalLinkRules: "至少链接到发布记录、媒体账号和自动发布页面。",
    externalLinkRules: "外链只用于权威资料，软文媒体稿默认不放外链。",
    fixedIntro: "先用一句话说明这篇文章解决什么 SEO/GEO 问题。",
    fixedOutro: "结尾给出发布、公开 URL 回写和可见性观察的下一步。",
    modelProvider: "DeepSeek",
    status: "active",
    createdAt: "2026-06-28 10:20",
    updatedAt: "2026-06-28 10:20"
  },
  {
    id: "rule-2",
    name: "品牌语气规则",
    type: "article",
    content: "专业可信、少夸张表达、不使用空泛营销词",
    sourceMode: "template",
    keywordPickMode: "manual",
    keywordCount: 5,
    forcedTitleKeywords: ["智心AI", "内容增长"],
    contentRequirements: "保持产品语义清楚，避免泛泛谈 AI，必须落到创作、发布、公开 URL 回写和可见性观察闭环。",
    humanizationRules: "语气像懂 SEO 的运营顾问，不像广告文案。",
    replacementRules: "删除感叹号和过度承诺。",
    knowledgeBaseRefs: ["品牌资料", "产品资料"],
    formatRules: "适合官网文章和公众号同步。",
    structureRules: "结论先行，随后展开原因和操作步骤。",
    modelProvider: "OpenAI",
    status: "active",
    createdAt: "2026-06-28 09:15",
    updatedAt: "2026-06-28 09:15"
  },
  {
    id: "rule-3",
    name: "媒体发布规则",
    type: "image-text",
    content: "标题长度、禁用词、图片水印和外链限制",
    sourceMode: "manual-keywords",
    keywordPickMode: "manual",
    keywordCount: 3,
    forcedTitleKeywords: ["行业观察"],
    contentRequirements: "标题不超过 28 个汉字，正文配图必须使用媒体发布水印。",
    humanizationRules: "用资讯稿口吻，减少第一人称。",
    replacementRules: "避免绝对化词汇和不可证实的数据。",
    knowledgeBaseRefs: ["媒体发稿规范"],
    formatRules: "图文稿需要封面图、摘要、正文和分类。",
    structureRules: "新闻背景、问题、解决方案、行业影响。",
    internalLinkRules: "站外媒体稿不使用站内跳转。",
    externalLinkRules: "按媒体要求决定是否保留 dofollow 外链。",
    modelProvider: "文心一言",
    status: "active",
    createdAt: "2026-06-27 16:40",
    updatedAt: "2026-06-27 16:40"
  },
  {
    id: "rule-4",
    name: "可见性友好规则",
    type: "article",
    content: "Meta 描述、内链、公开 URL 和可见性观察建议",
    sourceMode: "serp",
    keywordPickMode: "top10",
    keywordCount: 8,
    forcedTitleKeywords: ["公开可见性", "媒体发布"],
    contentRequirements: "正文必须解释公开 URL 回写和搜索结果可见性观察的区别。",
    humanizationRules: "用排查清单方式写，方便运营复盘。",
    replacementRules: "把抽象指标替换为 URL、provider、检测时间和状态。",
    knowledgeBaseRefs: ["公开 URL 观察规范"],
    formatRules: "包含检查表和异常处理建议。",
    structureRules: "现象、原因、处理、复查。",
    internalLinkRules: "链接到发布记录、媒体账号和自动发布页面。",
    externalLinkRules: "可引用平台公开页面或媒体发布规范。",
    modelProvider: "DeepSeek",
    status: "draft",
    createdAt: "2026-06-27 14:22",
    updatedAt: "2026-06-27 14:22"
  }
];

export type AiWriterMode = "normal" | "free" | "serp" | "template";

export type AiWriterStepContext = {
  mode?: AiWriterMode;
  question?: string;
  title?: string;
  seoTitle?: string;
  metaDescription?: string;
  secondaryKeywords?: string[];
  outline?: string[];
  serpAnalysisId?: string;
  knowledgeItemIds?: string[];
  brandProfileIds?: string[];
  competitorProfileIds?: string[];
  assetIds?: string[];
  watermarkIds?: string[];
  publishTargetIds?: string[];
  publishRules?: {
    category?: string;
    articleType?: "original" | "repost" | "translation" | string;
    visibility?: "public" | "private" | "fans" | "vip" | string;
    creationStatement?: string;
    backupToGitCode?: boolean;
    coverImagePath?: string;
    coverMode?: "auto" | "single" | "three" | "large" | string;
  };
  indexProvider?: IndexSubmission["provider"];
  extras?: string[];
  stepsCompleted?: number;
};

export type AiArticleInput = {
  generationRuleId?: string;
  articleTypeId?: string;
  keyword: string;
  productDescription: string;
  targetAudience: string;
  brandProfile: string;
  intent: string;
  tone: string;
  wordCount: number;
  includeFaq: boolean;
  includeInternalLinks: boolean;
  writerContext?: AiWriterStepContext;
};

export type GeneratedArticle = {
  title: string;
  summary: string;
  contentMarkdown: string;
  seoTitle: string;
  metaDescription: string;
  keywords: string[];
};

export const mockArticles: Article[] = [
  ...Array.from({ length: 5 }, (_, index) => ({
    id: `draft-${index + 1}`,
    title: `GEO 内容策略草稿 ${index + 1}`,
    status: "draft" as const,
    siteName: "智心AI 官网",
    keyword: "AI 搜索优化",
    updatedAt: "今天 09:20",
    ruleName: "SEO/GEO 长文规则",
    articleType: "操作指南",
    tags: ["SEO", "GEO"],
    source: "AI创作"
  })),
  ...Array.from({ length: 11 }, (_, index) => ({
    id: `published-${index + 1}`,
    title: `企业如何用 AI 长文提升搜索可见度 ${index + 1}`,
    status: "published" as const,
    siteName: index % 2 === 0 ? "智心AI 官网" : "增长实验室",
    keyword: index % 2 === 0 ? "SEO 长文" : "GEO 优化",
    updatedAt: "昨天 18:10",
    ruleName: "品牌语气规则",
    articleType: "列表文章",
    tags: ["AI写作", "搜索可见度"],
    source: "自动创作历史"
  })),
  {
    id: "generating-1",
    title: "WordPress 内容自动发布指南",
    status: "generating" as const,
    siteName: "增长实验室",
    keyword: "WordPress 自动发布",
    updatedAt: "刚刚",
    ruleName: "SEO/GEO 长文规则",
    articleType: "操作指南",
    tags: ["WordPress", "自动化"],
    source: "SERP分析及创作"
  },
  {
    id: "ready-1",
    title: "AI 引用友好型 FAQ 写法",
    status: "ready" as const,
    siteName: "智心AI 官网",
    keyword: "FAQ SEO",
    updatedAt: "今天 11:02",
    ruleName: "可见性友好规则",
    articleType: "FAQ",
    tags: ["FAQ", "GEO"],
    source: "AI创作"
  }
];

export const mockPublishJobs: PublishJob[] = [
  ...Array.from({ length: 12 }, (_, index) => ({
    id: `pub-ok-${index + 1}`,
    articleId: `published-${Math.min(index + 1, 11)}`,
    articleTitle: `企业如何用 AI 长文提升搜索可见度 ${index + 1}`,
    siteId: index % 2 === 0 ? "site-1" : "site-2",
    siteName: index % 2 === 0 ? "智心AI 官网" : "增长实验室",
    connectorType: index % 3 === 0 ? ("Webhook" as const) : ("WordPress" as const),
    status: "succeeded" as const,
    attempts: 1,
    publishedUrl: `https://example.com/articles/ai-seo-${index + 1}`,
    updatedAt: "今天 08:40"
  })),
  {
    id: "pub-failed-1",
    articleId: "generating-1",
    articleTitle: "WordPress 内容自动发布指南",
    siteId: "site-2",
    siteName: "增长实验室",
    connectorType: "WordPress",
    status: "failed",
    attempts: 2,
    errorMessage: "WordPress 应用密码已失效，需要重新测试连接。",
    updatedAt: "今天 10:12"
  },
  {
    id: "pub-failed-2",
    articleId: "draft-1",
    articleTitle: "公开可见性失败原因排查清单",
    siteId: "site-1",
    siteName: "智心AI 官网",
    connectorType: "Webhook",
    status: "failed",
    attempts: 1,
    errorMessage: "Webhook 字段映射缺少 contentHtml。",
    updatedAt: "今天 09:55"
  },
  {
    id: "pub-running-1",
    articleId: "ready-1",
    articleTitle: "AI 引用友好型 FAQ 写法",
    siteId: "site-1",
    siteName: "智心AI 官网",
    connectorType: "Webhook",
    status: "running",
    attempts: 1,
    updatedAt: "刚刚"
  }
];

export const mockIndexSubmissions: IndexSubmission[] = [
  ...Array.from({ length: 9 }, (_, index) => ({
    id: `indexed-${index + 1}`,
    articleTitle: `企业如何用 AI 长文提升搜索可见度 ${index + 1}`,
    provider: index % 2 === 0 ? ("Baidu" as const) : ("Sitemap" as const),
    submitted: true,
    inclusionStatus: "indexed" as const,
    checkedAt: "今天 07:30",
    url: `https://example.com/articles/ai-seo-${index + 1}`
  })),
  ...Array.from({ length: 5 }, (_, index) => ({
    id: `not-indexed-${index + 1}`,
    articleTitle: `GEO 内容策略草稿 ${index + 1}`,
    provider: "Sitemap" as const,
    submitted: true,
    inclusionStatus: index === 0 ? ("failed" as const) : ("not_indexed" as const),
    checkedAt: "昨天 22:10",
    url: `https://growth.example.com/articles/geo-draft-${index + 1}`
  }))
];

export const mockTasks: TaskItem[] = [
  { id: "task-ai-1", title: "生成《WordPress 内容自动发布指南》正文", type: "AI 生成", status: "running", progress: 62 },
  { id: "task-pub-1", title: "发布《AI 引用友好型 FAQ 写法》到 Webhook", type: "发布", status: "running", progress: 45 },
  { id: "task-visibility-1", title: "复验 5 个新公开 URL", type: "可见性观察", status: "succeeded", progress: 100 },
  { id: "task-check-1", title: "检测增长实验室最近发布 URL", type: "可见性观察", status: "failed", progress: 20, errorMessage: "观测 provider 限流，建议 30 分钟后重试。" }
];

export const mockSites: Site[] = [
  {
    id: "site-1",
    name: "智心AI 官网",
    type: "WordPress",
    siteType: "cms",
    baseUrl: "https://zhixin.example.com",
    status: "active",
    defaultCategory: "SEO/GEO",
    defaultTags: ["AI 内容", "搜索优化"],
    lastPublishedAt: "今天 08:40",
    strategyCount: 3,
    members: ["chen boss"]
  },
  {
    id: "site-2",
    name: "增长实验室",
    type: "Webhook",
    siteType: "webhook",
    baseUrl: "https://growth.example.com/api/publish",
    status: "test_failed",
    defaultCategory: "增长",
    defaultTags: ["内容营销", "自动化"],
    lastPublishedAt: "昨天 17:20",
    lastError: "Webhook 返回 401，secret 可能已过期。",
    strategyCount: 1,
    members: ["chen boss"]
  }
];

export const mockAssets: Asset[] = [
  { id: "asset-1", filename: "geo-cover-dashboard.png", type: "cover", altText: "智心AI 数据看板封面", relatedArticle: "企业如何用 AI 长文提升搜索可见度", color: "#ede9fe", tags: ["封面", "官网"], source: "upload", size: "124 KB", updatedAt: "2026-06-28 09:20" },
  { id: "asset-2", filename: "wordpress-flow.png", type: "inline", altText: "WordPress 发布流程图", relatedArticle: "WordPress 内容自动发布指南", color: "#dbeafe", tags: ["插图", "流程图"], source: "upload", size: "256 KB", updatedAt: "2026-06-27 16:40" },
  { id: "asset-3", filename: "brand-logo-dark.png", type: "brand", altText: "智心AI 深色品牌标识", relatedArticle: "品牌素材", color: "#fef3c7", tags: ["品牌", "Logo"], source: "website", size: "48 KB", updatedAt: "2026-06-26 14:22" },
  { id: "asset-4", filename: "faq-structure.png", type: "inline", altText: "FAQ 结构化问答示意", relatedArticle: "AI 引用友好型 FAQ 写法", color: "#dcfce7", tags: ["插图", "FAQ"], source: "ai", size: "180 KB", updatedAt: "2026-06-25 11:10" }
];

export const mockAssetTagGroups: AssetTagGroup[] = [
  {
    id: "asset-tag-group-1",
    name: "素材类型",
    description: "按封面、插图、品牌素材划分素材用途。",
    tags: [
      { id: "asset-tag-1", name: "封面", usageCount: 1 },
      { id: "asset-tag-2", name: "插图", usageCount: 2 },
      { id: "asset-tag-3", name: "品牌", usageCount: 1 }
    ],
    updatedAt: "2026-06-29 10:20"
  },
  {
    id: "asset-tag-group-2",
    name: "发布状态",
    description: "用于批量标记精选、待发布和已使用素材。",
    tags: [
      { id: "asset-tag-4", name: "精选", usageCount: 0 },
      { id: "asset-tag-5", name: "待发布", usageCount: 0 },
      { id: "asset-tag-6", name: "已使用", usageCount: 0 }
    ],
    updatedAt: "2026-06-29 10:20"
  },
  {
    id: "asset-tag-group-3",
    name: "来源场景",
    description: "区分官网导入、本地上传和 AI 生成素材。",
    tags: [
      { id: "asset-tag-7", name: "官网导入", usageCount: 1 },
      { id: "asset-tag-8", name: "本地上传", usageCount: 2 },
      { id: "asset-tag-9", name: "AI生成", usageCount: 1 }
    ],
    updatedAt: "2026-06-29 10:20"
  }
];

export const mockKnowledgeItems: KnowledgeItem[] = [
  {
    id: "kb-1",
    title: "智心AI 产品资料",
    source: "text",
    status: "completed",
    content: "智心AI 面向 SEO/GEO 内容运营，覆盖 AI 创作、编辑、发布渠道、公开 URL 回写和可见性观察。",
    tags: ["产品资料", "AI创作", "发布闭环"],
    refreshMode: "manual",
    lastRefreshedAt: "2026-06-28 10:30",
    updatedAt: "2026-06-28 10:30"
  },
  {
    id: "kb-2",
    title: "快鲸SEO 竞品功能结构",
    source: "url",
    status: "completed",
    content: "快鲸SEO 包含 AI创作、SERP分析、知识库、素材库、水印库、自动创作发布、集成网站、已发布、自动GEO。",
    url: "https://seo.kuaijing.cn/seoai/dashboard",
    tags: ["竞品分析", "快鲸", "功能结构"],
    refreshMode: "weekly",
    lastRefreshedAt: "2026-06-29 10:20",
    updatedAt: "2026-06-29 10:20"
  },
  {
    id: "kb-3",
    title: "SEO/GEO 常见 FAQ",
    source: "local_file",
    status: "learning",
    content: "用于生成 FAQ、AI 引用友好段落、公开可见性说明和发布结果排查清单。",
    tags: ["FAQ", "GEO", "可见性观察"],
    refreshMode: "manual",
    updatedAt: "2026-06-27 16:40"
  },
  {
    id: "kb-4",
    title: "媒体发布规范",
    source: "asset",
    status: "completed",
    content: "软文媒体稿件需控制标题长度、配图水印、外链位置和新闻源要求。",
    tags: ["软文媒体", "发布规范"],
    refreshMode: "manual",
    lastRefreshedAt: "2026-06-26 11:10",
    updatedAt: "2026-06-26 11:10"
  }
];

export const mockBrandProfiles: BrandProfile[] = [
  {
    id: "brand-1",
    name: "智心AI",
    website: "https://zhixin.example.com",
    description: "面向 SEO/GEO 内容运营的 AI 创作、发布和公开可见性观察系统。",
    contacts: ["support@zhixin.example.com", "chen boss"],
    products: ["AI创作", "SERP分析及创作", "媒体发布", "自动GEO"],
    tags: ["主品牌", "SEO", "GEO"],
    updatedAt: "2026-06-29 10:20"
  },
  {
    id: "brand-2",
    name: "增长实验室",
    website: "https://growth.example.com",
    description: "承接测试文章、媒体回链和自动发布策略的内容站点。",
    contacts: ["ops@growth.example.com"],
    products: ["站点发布", "媒体分发"],
    tags: ["测试站点", "发布渠道"],
    updatedAt: "2026-06-28 17:20"
  }
];

export const mockCompetitorProfiles: CompetitorProfile[] = [
  {
    id: "competitor-profile-1",
    name: "快鲸SEO",
    website: "https://seo.kuaijing.cn",
    relation: "primary",
    description: "SEO/GEO 内容生产、发布和自动 GEO 闭环竞品。",
    products: ["AI创作", "自动创作发布", "自动GEO", "软文媒体平台", "发布记录"],
    strengths: ["功能链路完整", "侧栏结构清晰", "发布渠道覆盖多"],
    weakPoints: ["商业化与账号功能较重", "部分功能依赖授权配置"],
    tags: ["快鲸", "主竞品", "1:1参考"],
    updatedAt: "2026-06-29 10:20"
  },
  {
    id: "competitor-profile-2",
    name: "内容增长平台 A",
    website: "https://competitor-a.example.com",
    relation: "functional",
    description: "偏内容生产和多渠道发布，GEO 能力较弱。",
    products: ["AI写作", "媒体发布", "关键词库"],
    strengths: ["内容生成流程轻", "媒体发布入口明显"],
    weakPoints: ["自动GEO不足", "发布后公开可见性观察弱"],
    tags: ["功能竞品"],
    updatedAt: "2026-06-27 14:20"
  }
];

export function calculateSupportLibrarySummary(input: {
  knowledgeItems: KnowledgeItem[];
  brandProfiles: BrandProfile[];
  competitorProfiles: CompetitorProfile[];
}): SupportLibrarySummary {
  return {
    knowledge: {
      total: input.knowledgeItems.length,
      completed: input.knowledgeItems.filter((item) => item.status === "completed").length,
      learning: input.knowledgeItems.filter((item) => item.status === "learning" || item.status === "parsing").length,
      failed: input.knowledgeItems.filter((item) => item.status === "failed").length
    },
    brands: {
      total: input.brandProfiles.length,
      products: input.brandProfiles.reduce((sum, item) => sum + item.products.length, 0)
    },
    competitors: {
      total: input.competitorProfiles.length,
      primary: input.competitorProfiles.filter((item) => item.relation === "primary").length,
      products: input.competitorProfiles.reduce((sum, item) => sum + item.products.length, 0)
    }
  };
}

export const scoreItems: ScoreItem[] = [
  {
    key: "title_length",
    label: "标题长度",
    dimension: "seo",
    score: 88,
    severity: "good",
    reason: "标题长度适合搜索结果展示，核心主题明确。",
    suggestion: "保留主关键词，同时补充具体使用场景。",
    canAutoFix: true
  },
  {
    key: "heading_structure",
    label: "H2/H3 结构",
    dimension: "seo",
    score: 76,
    severity: "warning",
    reason: "章节层级清晰，但部分 H3 缺少问题式表达。",
    suggestion: "把关键章节改成用户会搜索的问题。",
    canAutoFix: true
  },
  {
    key: "entity_clarity",
    label: "品牌/产品实体清晰度",
    dimension: "semantic",
    score: 82,
    severity: "good",
    reason: "文章能识别智心AI、WordPress、媒体平台等实体。",
    suggestion: "补充智心AI的适用行业和核心差异。",
    canAutoFix: false
  },
  {
    key: "topic_coverage",
    label: "主题覆盖",
    dimension: "semantic",
    score: 71,
    severity: "warning",
    reason: "覆盖了内容生成和发布，但对公开可见性观察解释不足。",
    suggestion: "增加一节解释公开 URL 回写和可见性观察的区别。",
    canAutoFix: true
  },
  {
    key: "citation_value",
    label: "AI 引用友好度",
    dimension: "geo",
    score: 68,
    severity: "warning",
    reason: "已有 FAQ，但缺少可直接引用的定义句和结论摘要。",
    suggestion: "在每个 H2 后加入一句清晰结论，便于 AI 摘取引用。",
    canAutoFix: true
  }
];

export function generateArticleDraft(input: AiArticleInput): GeneratedArticle {
  const keyword = input.keyword.trim() || "AI 内容营销";
  const brand = input.brandProfile.trim() || "智心AI";
  const audience = input.targetAudience.trim() || "内容运营和 SEO 团队";
  const product = input.productDescription.trim() || "帮助企业完成 AI 长文生产、媒体发布、公开 URL 回写和可见性观察闭环";
  const title = `企业如何使用 ${keyword} 提升搜索与 AI 引用曝光`;
  const faq = input.includeFaq
    ? `\n\n## FAQ\n\n### ${keyword} 和传统 SEO 有什么区别？\n${keyword} 更强调主题覆盖、实体清晰度、问答结构和可引用结论，传统 SEO 更关注页面基础结构和关键词匹配。\n\n### 为什么要记录公开 URL 和可见性观察？\n公开 URL 回写确认文章已经在目标平台出现，可见性观察用于后续判断搜索结果或公开页面是否能找到这篇内容，两者不能互相替代。`
    : "";
  const internalLinks = input.includeInternalLinks
    ? "\n\n## 内链建议\n\n- 链接到媒体账号页，说明授权账号与平台状态。\n- 链接到发布记录页，说明公开 URL、审核状态和可见性观察结果。"
    : "";

  return {
    title,
    summary: `${brand} 面向 ${audience}，通过 ${product}，帮助企业把 ${keyword} 做成可执行的内容增长流程。`,
    seoTitle: `${keyword}实战指南 - ${brand}`,
    metaDescription: `面向${audience}的${keyword}实战流程，覆盖 AI 创作、SEO/GEO 评分、媒体发布、公开 URL 回写和可见性观察。`,
    keywords: Array.from(new Set([keyword, "SEO", "GEO", "AI 写作", "媒体发布"])),
    contentMarkdown: `# ${title}\n\n## 一句话结论\n${keyword} 的核心不是堆关键词，而是让内容同时适合搜索引擎理解、用户阅读和 AI 系统引用。\n\n## 适用对象\n这套流程适合 ${audience}。他们通常需要稳定生产长文、发布到企业站点或媒体平台，并持续跟踪公开 URL 和可见性状态。\n\n## 产品与业务资料\n${product}。\n\n## 推荐工作流\n1. 输入关键词、产品资料、目标用户和品牌资料。\n2. 生成标题候选和文章大纲。\n3. 生成正文后进入编辑器人工确认。\n4. 使用 SEO/GEO 评分检查标题、结构、实体和引用价值。\n5. 发布到 WordPress、Webhook、免费媒体或软文媒体渠道。\n6. 保存公开 URL，记录平台审核结果和可见性观察证据。\n\n## GEO 友好写法\n- 每个 H2 后提供清晰结论。\n- 用 FAQ 回答用户真实问题。\n- 明确品牌、产品、场景和适用人群。\n- 把事实表达写成可直接摘取的短句。${faq}${internalLinks}\n`
  };
}

export function scoreArticleContent(article: Pick<Article, "title" | "summary" | "contentMarkdown" | "keywords">): SeoGeoScoreResult {
  const content = `${article.title}\n${article.summary ?? ""}\n${article.contentMarkdown ?? ""}`;
  const hasFaq = /FAQ|问答|###/.test(content);
  const hasHeadings = /^##\s+/m.test(content);
  const hasEntity = /智心AI|WordPress|媒体平台|百度|GEO|SEO/.test(content);
  const hasCitationSentence = /一句话结论|核心不是|适合搜索引擎|AI 系统引用/.test(content);

  const items: ScoreItem[] = [
    { ...scoreItems[0], score: article.title.length >= 16 && article.title.length <= 48 ? 90 : 62, severity: article.title.length >= 16 && article.title.length <= 48 ? "good" : "warning" },
    { ...scoreItems[1], score: hasHeadings ? 84 : 45, severity: hasHeadings ? "good" : "critical" },
    { ...scoreItems[2], score: hasEntity ? 86 : 50, severity: hasEntity ? "good" : "warning" },
    { ...scoreItems[3], score: (article.keywords?.length ?? 0) >= 3 ? 78 : 58, severity: (article.keywords?.length ?? 0) >= 3 ? "warning" : "critical" },
    { ...scoreItems[4], score: hasFaq && hasCitationSentence ? 82 : 55, severity: hasFaq && hasCitationSentence ? "good" : "warning" }
  ];
  const seoScore = Math.round((items[0].score + items[1].score + items[3].score) / 3);
  const geoScore = Math.round((items[2].score + items[4].score) / 2);

  return {
    seoScore,
    geoScore,
    totalScore: Math.round((seoScore + geoScore) / 2),
    items
  };
}

export function calculateDashboardMetrics(input: {
  articles: Article[];
  publishJobs: PublishJob[];
  indexSubmissions: IndexSubmission[];
}) {
  const successfulPublishes = input.publishJobs.filter((job) => job.status === "succeeded").length;
  const completedPublishes = input.publishJobs.filter((job) => job.status === "succeeded" || job.status === "failed").length;

  return {
    totalArticles: input.articles.length,
    drafts: input.articles.filter((article) => article.status === "draft").length,
    published: input.articles.filter((article) => article.status === "published").length,
    publishSuccessRate: completedPublishes === 0 ? 0 : Math.round((successfulPublishes / completedPublishes) * 100),
    submittedIndexes: input.indexSubmissions.filter((submission) => submission.submitted).length,
    includedUrls: input.indexSubmissions.filter((submission) => submission.inclusionStatus === "indexed").length
  };
}

export type DashboardWorkItemType =
  | "publish_failed"
  | "authorization_exception"
  | "manual_review"
  | "inclusion_failed"
  | "index_pending"
  | "task_failed";

export type DashboardWorkItem = {
  id: string;
  type: DashboardWorkItemType;
  category?: "creation" | "knowledge" | "publishing" | "authorization" | "task";
  title: string;
  description: string;
  href: string;
  severity: "critical" | "warning" | "info";
  status: string;
  updatedAt?: string;
  occurrenceCount?: number;
};

export type DashboardShortcut = {
  label: string;
  href: string;
  description: string;
  metric: number;
};

export type DashboardOperationCenter = {
  today: {
    generatedArticles: number;
    publishedUrls: number;
    indexSubmitted: number;
    includedUrls: number;
  };
  summary: {
    failedTasks: number;
    authorizationExceptions: number;
    manualReview: number;
    pendingIndex: number;
    inclusionProblems: number;
  };
  workItems: DashboardWorkItem[];
  shortcuts: DashboardShortcut[];
};

function currentDateTokens() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const year = String(now.getFullYear());
  return [`${year}-${month}-${day}`, `${month}-${day}`, `${month}/${day}`, `${month}月${day}日`];
}

function isTodayText(value?: string) {
  const text = value ?? "";
  if (!text) return false;
  if (text.includes("今天") || text.includes("今日")) return true;
  return currentDateTokens().some((token) => text.includes(token));
}

function sortWorkItems(items: DashboardWorkItem[]) {
  const severityRank: Record<DashboardWorkItem["severity"], number> = { critical: 0, warning: 1, info: 2 };
  return items.sort((left, right) => {
    const rankDiff = severityRank[left.severity] - severityRank[right.severity];
    if (rankDiff !== 0) return rankDiff;
    return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
  });
}

export function createDashboardOperationCenter(input: {
  articles: Article[];
  publishJobs: PublishJob[];
  indexSubmissions: IndexSubmission[];
  tasks: TaskItem[];
  sites: Site[];
  mediaAccounts: MediaAccount[];
  mediaOrders: MediaOrder[];
  indexerConfigs: IndexerConfig[];
}): DashboardOperationCenter {
  const failedPublishes = input.publishJobs.filter((job) => job.status === "failed");
  const failedTasks = input.tasks.filter((task) => task.status === "failed");
  const failedInclusion = input.indexSubmissions.filter((submission) => submission.inclusionStatus === "failed" || submission.inclusionStatus === "not_indexed");
  const authAccounts = input.mediaAccounts.filter((account) => account.status === "error" || account.status === "disabled");
  const brokenSites = input.sites.filter((site) => site.status === "test_failed" || site.status === "disabled");
  const manualOrders = input.mediaOrders.filter((order) => order.status === "review_required" || order.backlinkStatus === "reviewing");
  const failedOrders = input.mediaOrders.filter((order) => order.status === "failed" || order.backlinkStatus === "failed");

  const workItems: DashboardWorkItem[] = [
    ...failedPublishes.map((job) => ({
      id: `publish:${job.id}`,
      type: "publish_failed" as const,
      title: `发布失败：${job.articleTitle}`,
      description: `${job.siteName} / ${job.errorMessage ?? "等待重试或检查发布配置"}`,
      href: "/published",
      severity: "critical" as const,
      status: job.status,
      updatedAt: job.updatedAt
    })),
    ...failedOrders.map((order) => ({
      id: `media-failed:${order.id}`,
      type: "publish_failed" as const,
      title: `媒体发稿失败：${order.articleTitle}`,
      description: `${order.resourceName} / 回链状态 ${order.backlinkStatus}`,
      href: "/published",
      severity: "critical" as const,
      status: order.status,
      updatedAt: order.updatedAt
    })),
    ...authAccounts.map((account) => ({
      id: `account:${account.id}`,
      type: "authorization_exception" as const,
      title: `媒体授权异常：${account.name}`,
      description: account.lastError ?? account.limit ?? "需要重新检查账号授权",
      href: "/free-media",
      severity: "warning" as const,
      status: account.status,
      updatedAt: account.lastCheckedAt ?? account.createdAt
    })),
    ...manualOrders.map((order) => ({
      id: `media-review:${order.id}`,
      type: "manual_review" as const,
      title: `待人工处理：${order.articleTitle}`,
      description: `${order.resourceName} / ${order.status === "review_required" ? "媒体审核中" : "回链审核中"}`,
      href: "/published",
      severity: "warning" as const,
      status: order.status,
      updatedAt: order.updatedAt
    })),
    ...failedInclusion.map((submission) => ({
      id: `inclusion:${submission.id}`,
      type: "inclusion_failed" as const,
      title: `公开可见性异常：${submission.articleTitle}`,
      description: submission.url ?? "未记录 URL",
      href: "/published",
      severity: submission.inclusionStatus === "failed" ? "critical" as const : "info" as const,
      status: submission.inclusionStatus,
      updatedAt: submission.checkedAt
    })),
    ...failedTasks.map((task) => ({
      id: `task:${task.id}`,
      type: "task_failed" as const,
      title: `任务失败：${task.title}`,
      description: task.errorMessage ?? `${task.type} / 进度 ${task.progress}%`,
      href: "/articles/history",
      severity: "critical" as const,
      status: task.status,
      updatedAt: undefined
    }))
  ];

  return {
    today: {
      generatedArticles: input.articles.filter((article) => isTodayText(article.updatedAt)).length,
      publishedUrls: input.publishJobs.filter((job) => job.status === "succeeded" && job.publishedUrl && isTodayText(job.updatedAt)).length
        + input.mediaOrders.filter((order) => order.status === "succeeded" && order.backlinkUrl && isTodayText(order.updatedAt)).length,
      indexSubmitted: input.indexSubmissions.filter((submission) => submission.submitted && isTodayText(submission.checkedAt)).length,
      includedUrls: input.indexSubmissions.filter((submission) => submission.inclusionStatus === "indexed" && isTodayText(submission.checkedAt)).length
    },
    summary: {
      failedTasks: failedPublishes.length + failedOrders.length + failedTasks.length,
      authorizationExceptions: authAccounts.length,
      manualReview: manualOrders.length,
      pendingIndex: 0,
      inclusionProblems: failedInclusion.length
    },
    workItems: sortWorkItems(workItems).slice(0, 12),
    shortcuts: [
      { label: "AI创作", href: "/ai-writer", description: "普通创作、自由创作和 SERP 创作入口", metric: input.articles.filter((article) => article.status === "draft" || article.status === "ready").length },
      { label: "自动创作发布", href: "/auto-publish", description: "按生成规则和关键词批量创建文章", metric: input.tasks.filter((task) => task.type === "AI 生成" && task.status === "running").length },
      { label: "已发布中心", href: "/published", description: "统一查看网站发布、媒体回链和公开 URL", metric: input.publishJobs.length + input.mediaOrders.length },
      { label: "可见性观察", href: "/published", description: "查看公开 URL 的可见性检测结果", metric: failedInclusion.length + input.indexSubmissions.filter((submission) => submission.inclusionStatus === "unchecked").length }
    ]
  };
}

export const dashboardMetrics = calculateDashboardMetrics({
  articles: mockArticles,
  publishJobs: mockPublishJobs,
  indexSubmissions: mockIndexSubmissions
});

export type Keyword = {
  id: string;
  word: string;
  searchVolume: number;
  difficulty: number;
  trend: "up" | "down" | "stable";
  relatedWords: string[];
  status: "tracking" | "suggested" | "archived";
  createdAt: string;
};

export type SerpAnalysisResult = {
  id: string;
  keyword: string;
  searchEngine: "Baidu" | "Google" | "Bing";
  region: string;
  device: "desktop" | "mobile";
  analyzedAt: string;
  topResults: {
    position: number;
    title: string;
    url: string;
    domain: string;
    snippet: string;
  }[];
  relatedQuestions: string[];
  relatedKeywords: string[];
  contentBrief: string;
};

export type Competitor = {
  id: string;
  domain: string;
  keyword: string;
  topPosition: number;
  titlePattern: string;
  contentCoverage: number;
  backlinkCount: number;
  lastAnalyzed: string;
};

export type RankingEntry = {
  id: string;
  keyword: string;
  url: string;
  engine: "Baidu" | "Google" | "Bing";
  region: string;
  position: number;
  previousPosition?: number;
  change: number;
  checkedAt: string;
  status: "indexed" | "not_indexed" | "not_found" | "error";
};

export const mockKeywords: Keyword[] = [
  { id: "kw-1", word: "AI SEO 优化", searchVolume: 1200, difficulty: 72, trend: "up", relatedWords: ["AI 搜索优化", "GEO 优化", "AI 写作"], status: "tracking", createdAt: "2026-06-20" },
  { id: "kw-2", word: "WordPress 自动发布", searchVolume: 880, difficulty: 65, trend: "stable", relatedWords: ["CMS 自动发布", "WordPress 插件"], status: "tracking", createdAt: "2026-06-21" },
  { id: "kw-3", word: "SEO 长文生成", searchVolume: 640, difficulty: 58, trend: "up", relatedWords: ["长文 SEO", "AI 生成文章"], status: "suggested", createdAt: "2026-06-22" },
  { id: "kw-4", word: "百度可见性观察", searchVolume: 1500, difficulty: 80, trend: "up", relatedWords: ["公开 URL", "可见性"], status: "tracking", createdAt: "2026-06-19" },
  { id: "kw-5", word: "GEO 内容营销", searchVolume: 320, difficulty: 45, trend: "down", relatedWords: ["AI 引用", "搜索可见度"], status: "archived", createdAt: "2026-06-18" }
];

export const mockSerpAnalyses: SerpAnalysisResult[] = [
  {
    id: "serp-1",
    keyword: "AI SEO 优化",
    searchEngine: "Baidu",
    region: "中国",
    device: "desktop",
    analyzedAt: "今天 10:20",
    topResults: [
      { position: 1, title: "AI SEO 优化实战指南", url: "https://example.com/ai-seo-guide", domain: "example.com", snippet: "覆盖 AI 搜索优化、GEO 和结构化数据。" },
      { position: 2, title: "2026 年 AI 搜索优化趋势", url: "https://example.com/ai-seo-trends", domain: "example.com", snippet: "了解 AI 搜索和 GEO 的最新变化。" },
      { position: 3, title: "企业如何用 AI 提升搜索可见度", url: "https://growth.example.com/ai-visibility", domain: "growth.example.com", snippet: "从关键词到发布的完整流程。" }
    ],
    relatedQuestions: ["AI SEO 和传统 SEO 有什么区别？", "如何提升 GEO 引用率？", "AI 搜索优化需要哪些工具？"],
    relatedKeywords: ["GEO 优化", "AI 写作", "搜索可见度"],
    contentBrief: "文章应覆盖 AI SEO 定义、与 GEO 的关系、可执行工作流、工具选型和效果衡量指标。"
  }
];

export const mockCompetitors: Competitor[] = [
  { id: "comp-1", domain: "example.com", keyword: "AI SEO 优化", topPosition: 1, titlePattern: "实战指南 / 趋势 / 企业方案", contentCoverage: 92, backlinkCount: 1200, lastAnalyzed: "今天 09:15" },
  { id: "comp-2", domain: "competitor-a.cn", keyword: "AI SEO 优化", topPosition: 4, titlePattern: "工具推荐 / 案例", contentCoverage: 78, backlinkCount: 540, lastAnalyzed: "昨天 18:40" },
  { id: "comp-3", domain: "competitor-b.com", keyword: "WordPress 自动发布", topPosition: 2, titlePattern: "插件对比 / 配置教程", contentCoverage: 85, backlinkCount: 890, lastAnalyzed: "今天 08:30" }
];

export const mockRankingEntries: RankingEntry[] = [
  { id: "rank-1", keyword: "AI SEO 优化", url: "https://example.com/ai-seo-guide", engine: "Baidu", region: "中国", position: 3, previousPosition: 5, change: 2, checkedAt: "今天 07:30", status: "indexed" },
  { id: "rank-2", keyword: "WordPress 自动发布", url: "https://example.com/wordpress-auto-publish", engine: "Baidu", region: "中国", position: 8, previousPosition: 8, change: 0, checkedAt: "今天 07:30", status: "indexed" },
  { id: "rank-3", keyword: "SEO 长文生成", url: "https://example.com/seo-long-article", engine: "Google", region: "全球", position: 12, previousPosition: 15, change: 3, checkedAt: "昨天 22:10", status: "indexed" },
  { id: "rank-4", keyword: "百度可见性观察", url: "https://example.com/baidu-visibility-check", engine: "Baidu", region: "中国", position: 0, previousPosition: 22, change: -22, checkedAt: "今天 07:30", status: "not_found" }
];

export function calculateKeywordMetrics(input: { keywords: Keyword[]; rankingEntries: RankingEntry[] }) {
  const trackingKeywords = input.keywords.filter((kw) => kw.status === "tracking").length;
  const avgDifficulty = input.keywords.length ? Math.round(input.keywords.reduce((sum, kw) => sum + kw.difficulty, 0) / input.keywords.length) : 0;
  const indexedKeywords = input.rankingEntries.filter((entry) => entry.status === "indexed").length;
  const avgPosition = input.rankingEntries.length ? Math.round(input.rankingEntries.reduce((sum, entry) => sum + entry.position, 0) / input.rankingEntries.length) : 0;

  return {
    totalKeywords: input.keywords.length,
    trackingKeywords,
    avgDifficulty,
    indexedKeywords,
    avgPosition
  };
}

export const keywordMetrics = calculateKeywordMetrics({
  keywords: mockKeywords,
  rankingEntries: mockRankingEntries
});

export type GeoQuestion = {
  id: string;
  keyword: string;
  question: string;
  platform: string;
  sourceUrl: string;
  sourceMedia: string;
  answerExcerpt: string;
  brandMention: boolean;
  competitorMention: boolean;
  queryTime: string;
};

export type GeoStats = {
  totalQuestions: number;
  totalIncluded: number;
  platformDistribution: Record<string, number>;
  hotKeywords: { keyword: string; count: number }[];
};

export type AutoGeoRuleRecord = {
  id: string;
  name: string;
  ruleName?: string;
  keywords: string[];
  aiModels: string[];
  brandName?: string;
  status: AutoPublishTask["scheduleMode"] | "running" | "pending";
  totalQuestions: number;
  hitCount: number;
  missCount: number;
  exposureCount: number;
  rewriteCandidateCount: number;
  targetPlatforms: string[];
  lastError?: string;
  updatedAt: string;
};

export type AutoGeoCenter = {
  summary: {
    rules: number;
    totalQuestions: number;
    brandHits: number;
    competitorHits: number;
    missedQuestions: number;
    rewriteCandidates: number;
    platforms: number;
  };
  rules: AutoGeoRuleRecord[];
  questions: GeoQuestion[];
  rewriteCandidates: GeoQuestion[];
  platforms: { platform: string; total: number; brandHits: number; competitorHits: number }[];
};

export type AutoPublishTask = {
  id: string;
  name: string;
  ruleId?: string;
  ruleName?: string;
  keywordSource: string;
  selectedKeywords?: string[];
  targetPlatforms: string[];
  articleIds?: string[];
  generatedArticleIds?: string[];
  mediaAccountIds?: string[];
  desktopCommandIds?: string[];
  queuedPublishCount?: number;
  publishPendingCount?: number;
  publishSucceededCount?: number;
  publishFailedCount?: number;
  publishManualActionCount?: number;
  status?: "queued" | "pending" | "running" | "publishing" | "succeeded" | "failed" | "partial_failed" | "manual_action_required" | string;
  scheduleMode?: "manual" | "once" | "daily";
  publishCount: number;
  successCount: number;
  failedCount: number;
  lastError?: string;
  createdAt: string;
};

export const mockGeoQuestions: GeoQuestion[] = [
  { id: "geo-q-1", keyword: "AI SEO 优化", question: "AI SEO 和传统 SEO 有什么区别？", platform: "DeepSeek", sourceUrl: "https://example.com/ai-seo-guide", sourceMedia: "example.com", answerExcerpt: "AI SEO 更强调主题覆盖、实体清晰度和问答结构...", brandMention: true, competitorMention: false, queryTime: "今天 10:20" },
  { id: "geo-q-2", keyword: "WordPress 自动发布", question: "如何实现 WordPress 自动发布？", platform: "豆包", sourceUrl: "https://growth.example.com/wordpress-auto-publish", sourceMedia: "growth.example.com", answerExcerpt: "可以通过 Webhook 或 REST API 实现自动发布...", brandMention: false, competitorMention: true, queryTime: "今天 09:15" }
];

export const mockGeoStats: GeoStats = {
  totalQuestions: 128,
  totalIncluded: 86,
  platformDistribution: { DeepSeek: 45, 豆包: 32, 通义: 28, 元宝: 15, Kimi: 8 },
  hotKeywords: [
    { keyword: "AI SEO 优化", count: 56 },
    { keyword: "WordPress 自动发布", count: 42 },
    { keyword: "GEO 内容营销", count: 31 }
  ]
};

export const mockAutoPublishTasks: AutoPublishTask[] = [
  { id: "auto-1", name: "每日 AI 长文自动发布", ruleId: "rule-1", ruleName: "SEO/GEO 长文规则", keywordSource: "关键词库 Top 10", targetPlatforms: ["智心AI 官网", "增长实验室"], publishCount: 10, successCount: 8, failedCount: 2, lastError: "增长实验室 Webhook 返回 401", createdAt: "2026-06-28 08:00" },
  { id: "auto-2", name: "百家号同步发布", ruleId: "rule-2", ruleName: "品牌语气规则", keywordSource: "创作历史", targetPlatforms: ["百家号"], publishCount: 5, successCount: 5, failedCount: 0, createdAt: "2026-06-27 16:00" }
];

export function createAutoGeoCenter(input: {
  geoQuestions: GeoQuestion[];
  autoPublishTasks: AutoPublishTask[];
  generationRules: GenerationRule[];
  brandProfiles: BrandProfile[];
  competitorProfiles: CompetitorProfile[];
}): AutoGeoCenter {
  const questions = input.geoQuestions ?? [];
  const rewriteCandidates = questions.filter((question) => !question.brandMention);
  const platformMap = new Map<string, { platform: string; total: number; brandHits: number; competitorHits: number }>();
  questions.forEach((question) => {
    const item = platformMap.get(question.platform) ?? { platform: question.platform, total: 0, brandHits: 0, competitorHits: 0 };
    item.total += 1;
    if (question.brandMention) item.brandHits += 1;
    if (question.competitorMention) item.competitorHits += 1;
    platformMap.set(question.platform, item);
  });

  const fallbackKeywords = Array.from(new Set(questions.map((question) => question.keyword))).filter(Boolean);
  const rules: AutoGeoRuleRecord[] = input.autoPublishTasks.map((task, index) => {
    const matchedQuestions = questions.filter((question) => {
      const keywords = task.selectedKeywords?.length ? task.selectedKeywords : fallbackKeywords;
      return keywords.some((keyword) => question.keyword.includes(keyword) || keyword.includes(question.keyword));
    });
    const scoped = matchedQuestions.length ? matchedQuestions : questions;
    const rule = task.ruleId ? input.generationRules.find((item) => item.id === task.ruleId) : undefined;
    return {
      id: task.id,
      name: task.name,
      ruleName: task.ruleName ?? rule?.name,
      keywords: task.selectedKeywords?.length ? task.selectedKeywords : fallbackKeywords.slice(index, index + 3),
      aiModels: Array.from(new Set(scoped.map((question) => question.platform))).slice(0, 4),
      brandName: input.brandProfiles[0]?.name,
      status: task.failedCount > 0 ? "running" : task.scheduleMode ?? "pending",
      totalQuestions: scoped.length,
      hitCount: scoped.filter((question) => question.brandMention).length,
      missCount: scoped.filter((question) => !question.brandMention).length,
      exposureCount: scoped.filter((question) => question.brandMention).length + task.successCount,
      rewriteCandidateCount: scoped.filter((question) => !question.brandMention).length,
      targetPlatforms: task.targetPlatforms,
      lastError: task.lastError,
      updatedAt: task.createdAt
    };
  });

  return {
    summary: {
      rules: rules.length,
      totalQuestions: questions.length,
      brandHits: questions.filter((question) => question.brandMention).length,
      competitorHits: questions.filter((question) => question.competitorMention).length,
      missedQuestions: questions.filter((question) => !question.brandMention).length,
      rewriteCandidates: rewriteCandidates.length,
      platforms: platformMap.size
    },
    rules,
    questions,
    rewriteCandidates,
    platforms: Array.from(platformMap.values()).sort((left, right) => right.total - left.total)
  };
}

export type MediaResource = {
  id: string;
  name: string;
  industry: string;
  channelType: string;
  comprehensivePortal: string;
  price: number;
  inclusionRate: number;
  avgDeliveryHours: number;
  deliveryRate: number;
  pcWeight: number;
  mobileWeight: number;
  newsSource: boolean;
  linkStatus: string;
  status: "ready" | "review_required" | "disabled";
  createdAt: string;
};

export type MediaOrder = {
  id: string;
  articleId?: string;
  articleTitle: string;
  resourceId: string;
  resourceName: string;
  mediaAccountId?: string;
  platform?: string;
  status: "pending" | "running" | "succeeded" | "failed" | "review_required";
  backlinkStatus: "pending" | "published" | "generated" | "reviewing" | "blocked" | "failed";
  backlinkUrl?: string;
  reviewUrl?: string;
  platformStatus?: string;
  reviewStatus?: string;
  publicVerifiedAt?: string;
  publicCheckCount?: number;
  publicDiscoveryStatus?: "" | "pending" | "queued" | "candidate_found" | "found" | "not_found" | "failed" | "restricted";
  publicDiscoveryCount?: number;
  lastPublicDiscoveryAt?: string;
  externalIds?: Record<string, string | number | boolean>;
  publicationEvidence?: PublicationEvidence;
  publicationCheckpoints?: PublicationStageCheckpoint[];
  failureCategory?: PublicationFailureCategory;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export const mockMediaResources: MediaResource[] = [
  { id: "media-res-1", name: "人民资讯行业稿", industry: "新闻资讯", channelType: "综合门户", comprehensivePortal: "人民网", price: 680, inclusionRate: 92, avgDeliveryHours: 24, deliveryRate: 96, pcWeight: 5, mobileWeight: 5, newsSource: true, linkStatus: "do_follow", status: "ready", createdAt: "2026-06-28 09:20" },
  { id: "media-res-2", name: "科技商业观察", industry: "科技 / SaaS", channelType: "科技", comprehensivePortal: "新浪网", price: 420, inclusionRate: 88, avgDeliveryHours: 12, deliveryRate: 94, pcWeight: 3, mobileWeight: 4, newsSource: true, linkStatus: "do_follow", status: "ready", createdAt: "2026-06-28 10:05" },
  { id: "media-res-3", name: "区域财经快讯", industry: "财经 / 区域", channelType: "财经", comprehensivePortal: "网易", price: 360, inclusionRate: 78, avgDeliveryHours: 18, deliveryRate: 85, pcWeight: 2, mobileWeight: 3, newsSource: false, linkStatus: "no_follow", status: "review_required", createdAt: "2026-06-27 16:40" },
  { id: "media-res-4", name: "品牌营销周刊", industry: "营销 / 品牌", channelType: "营销", comprehensivePortal: "腾讯网", price: 520, inclusionRate: 85, avgDeliveryHours: 15, deliveryRate: 90, pcWeight: 4, mobileWeight: 4, newsSource: true, linkStatus: "do_follow", status: "ready", createdAt: "2026-06-27 14:22" },
  { id: "media-res-5", name: "健康医疗前沿", industry: "健康医疗", channelType: "健康", comprehensivePortal: "凤凰网", price: 580, inclusionRate: 80, avgDeliveryHours: 20, deliveryRate: 87, pcWeight: 3, mobileWeight: 3, newsSource: true, linkStatus: "do_follow", status: "ready", createdAt: "2026-06-26 11:10" },
  { id: "media-res-6", name: "汽车生活周刊", industry: "汽车网站", channelType: "汽车", comprehensivePortal: "搜狐网", price: 450, inclusionRate: 82, avgDeliveryHours: 16, deliveryRate: 88, pcWeight: 3, mobileWeight: 4, newsSource: false, linkStatus: "do_follow", status: "ready", createdAt: "2026-06-25 09:30" }
];

export const mockMediaOrders: MediaOrder[] = [
  { id: "media-order-1", articleTitle: "AI 长文提升搜索可见度", resourceId: "media-res-1", resourceName: "人民资讯行业稿", status: "succeeded", backlinkStatus: "published", backlinkUrl: "https://example.com/backlink/ai-seo-1", createdAt: "2026-06-28 08:10", updatedAt: "2026-06-28 10:20" },
  { id: "media-order-2", articleTitle: "WordPress 自动发布指南", resourceId: "media-res-2", resourceName: "科技商业观察", status: "running", backlinkStatus: "pending", createdAt: "2026-06-28 09:15", updatedAt: "2026-06-28 09:15" },
  { id: "media-order-3", articleTitle: "GEO 内容策略清单", resourceId: "media-res-3", resourceName: "区域财经快讯", status: "review_required", backlinkStatus: "reviewing", createdAt: "2026-06-27 16:40", updatedAt: "2026-06-27 16:40" },
  { id: "media-order-4", articleTitle: "SEO 长文生成最佳实践", resourceId: "media-res-4", resourceName: "品牌营销周刊", status: "succeeded", backlinkStatus: "published", backlinkUrl: "https://example.com/backlink/seo-best-1", createdAt: "2026-06-27 14:22", updatedAt: "2026-06-27 16:10" }
];

export type IndexerConfig = {
  id: string;
  name: string;
  provider: IndexSubmission["provider"];
  authorized: boolean;
  configured?: boolean;
  status?: "active" | "provider_pending";
  missingFields?: string[];
  configurationErrors?: string[];
  submissionMethod?: string;
  submissionCapability?: "owned_site_only" | "owned_host_only";
  inspectionCapability?: "official_owned_site" | "observed" | "unavailable";
  inspectionConfigured?: boolean;
  observationConfigured?: boolean;
  missingObservationFields?: string[];
  setupHint?: string;
  autoSubmit?: boolean;
  triggerEvents?: ("site_publish" | "media_backlink" | "manual_submit")[];
  connectedIntegrationIds?: string[];
  retryLimit?: number;
  lastAuthorizedAt?: string;
  error?: string;
  connectedSites: string[];
};

export const mockIndexerConfigs: IndexerConfig[] = [];

export type VideoAsset = {
  id: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  kind: "video" | "cover";
  createdAt?: string;
};

export type VideoPreparationEvidence = {
  topics?: {requested?: string[]; resolved?: {name: string; id: string}[]; verified?: boolean};
  chapters?: {source?: "platform_smart"; count?: number; verified?: boolean};
  cover?: {
    source?: "platform_ai" | "custom";
    verified?: boolean;
    horizontal?: {width?: number; height?: number; verified?: boolean};
    vertical?: {width?: number; height?: number; verified?: boolean};
  };
};

export type VideoPublication = {
  preparationEvidence?: VideoPreparationEvidence;
  title?: string;
  publishMode?: "immediate" | "scheduled";
  scheduledAt?: string;
  id: string;
  assetId: string;
  mediaAccountId: string;
  caption: string;
  filename?: string;
  accountName?: string;
  status: string;
  platformStatus?: string;
  stage?: string;
  submittedAt?: string;
  itemId?: string;
  publicUrl?: string;
  message?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt?: string;
};

export type VideoPublishCapabilities = {
  maxVideoBytes: number;
  maxCoverBytes: number;
  accounts: { mediaAccountId: string; deviceId?: string; ready: boolean; supportsScheduled?: boolean; error?: string }[];
};
