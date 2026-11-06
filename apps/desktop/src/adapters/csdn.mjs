import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ContentPlatformAdapter, contentPlatformConfigs, isConfiguredPlatformLoggedIn, readConfiguredPlatformPageState } from "./content-platform.mjs";
import { buildImagePublicationEvidence, isPersistentPlatformImageUrl } from "../platform-images.mjs";
import { bindContentBlocksToImages, composeRichArticleHtml } from "../rich-content.mjs";
import { platformApiFetch } from "./platform-api.mjs";

// Hot-update compatibility floor. platform-images.mjs is bridged to the copy
// inside the installed MSI, and a device that has not taken an MSI update in a
// while can be running one from before this constant existed. Importing it here
// would make the bundle's smoke import fail on such a device, which silently
// keeps the old adapter instead of installing the fix. The value is only a stage
// label handed to buildImagePublicationEvidence as its publicBlocker argument,
// which older four-argument builds ignore, so defining it locally changes
// nothing about the evidence that gets produced.
const PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED = "PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED";

const CSDN_ORIGIN = "https://mp.csdn.net";
const CSDN_EDITOR_URL = "https://mp.csdn.net/mp_blog/creation/editor";
const CSDN_PUBLIC_SNAPSHOT_API_URL = "https://zhixin.example.com/api/public-snapshots/csdn";
const CSDN_PUBLIC_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CSDN_PUBLIC_MAX_REDIRECTS = 3;
const CSDN_ARTICLE_GATEWAY_CLIENT = {
  get appKey() { return process.env.CSDN_ARTICLE_APP_KEY || ""; },
  get appSecret() { return process.env.CSDN_ARTICLE_APP_SECRET || ""; },
  timestamped: false,
};
// CSDN article status codes. Only 1 means the article is publicly readable;
// 6 means the platform accepted it and queued it for review, which is a
// legitimate success terminal state rather than a publish failure.
const CSDN_ARTICLE_STATUS_PUBLIC = 1;
const CSDN_ARTICLE_STATUS_IN_REVIEW = 6;
// 16 is the transient state CSDN reports right after it accepts a publish
// call and before the article lands in the review queue. A real run (article
// 123456789) sat on 16 for the whole 12s polling window and only reached 6
// afterwards, so an unknown-status failure here turns an accepted, queued
// article into a false negative.
const CSDN_ARTICLE_STATUS_SETTLING = new Set([16]);
const CSDN_UPLOAD_GATEWAY_CLIENT = {
  get appKey() { return process.env.CSDN_UPLOAD_APP_KEY || ""; },
  get appSecret() { return process.env.CSDN_UPLOAD_APP_SECRET || ""; },
  timestamped: true,
};

export function csdnDraftUrlFromArticleId(articleId) {
  const value = String(articleId || "").trim();
  return value ? `${CSDN_EDITOR_URL}/${encodeURIComponent(value)}` : CSDN_EDITOR_URL;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizePublishInput(input = {}) {
  const title = cleanText(input.articleTitle || input.title);
  const content = String(input.contentMarkdown || input.content || input.body || input.markdown || "").trim();
  if (!title) throw new Error("CSDN_TITLE_REQUIRED");
  if (title.length < 5) throw new Error("CSDN_TITLE_TOO_SHORT");
  if (title.length > 100) throw new Error("CSDN_TITLE_TOO_LONG");
  if (!cleanText(content) || cleanText(content).length < 5) throw new Error("CSDN_CONTENT_REQUIRED");
  return {
    title,
    content,
    contentBlocks: Array.isArray(input.contentBlocks) ? input.contentBlocks : [],
    richHtml: String((input.platformImageTasks?.length ? input.contentHtmlWithoutImages : input.contentHtml) || "").trim(),
    platformImageTasks: Array.isArray(input.platformImageTasks) ? input.platformImageTasks : [],
    summary: cleanText(input.summary || input.description || content.slice(0, 200)).slice(0, 256),
    tags: normalizeTags(input),
    category: cleanText(input.category || input.column || input.columnName || input.categoryName),
    articleType: normalizeCsdnArticleType(input.articleType || input.contentType || input.originalType),
    visibility: normalizeCsdnVisibility(input.visibility || input.visibleRange || input.publishVisibility),
    creationStatement: normalizeCsdnCreationStatement(input.creationStatement || input.declaration || input.statement),
    coverImagePath: cleanText(input.coverImagePath || input.coverPath || input.coverFilePath),
    confirmPublish: input.confirmPublish === true || input.publishMode === "publish",
  };
}

function normalizeCsdnArticleType(value = "") {
  const text = cleanText(value).toLowerCase();
  if (["repost", "转载", "zhuanzai"].includes(text)) return "repost";
  if (["translation", "translate", "翻译", "fanyi"].includes(text)) return "translation";
  return "original";
}

function normalizeCsdnVisibility(value = "") {
  const text = cleanText(value).toLowerCase();
  if (["private", "only_me", "only-me", "仅我可见"].includes(text)) return "private";
  if (["fans", "followers", "粉丝可见"].includes(text)) return "fans";
  if (["vip", "vip可见"].includes(text)) return "vip";
  return "public";
}

function normalizeCsdnCreationStatement(value = "") {
  const text = cleanText(value).toLowerCase();
  if (!text || ["none", "no", "无", "无声明"].includes(text)) return "none";
  return text;
}

function normalizeTags(input = {}) {
  const raw = Array.isArray(input.tags)
    ? input.tags
    : Array.isArray(input.keywords)
      ? input.keywords
      : String(input.tags || input.keywords || "").split(/[,，\s]+/);
  const tags = raw.map(cleanText).filter(Boolean);
  return [...new Set(tags)].slice(0, 5);
}

function normalizeCsdnPublishedUrl(url = "") {
  try {
    const parsed = new URL(String(url || "").trim());
    const match = parsed.pathname.match(/^\/([A-Za-z0-9_-]+)\/article\/details\/(\d+)\/?$/);
    if (
      parsed.protocol !== "https:"
      || parsed.hostname !== "blog.csdn.net"
      || parsed.username
      || parsed.password
      || parsed.port
      || parsed.search
      || parsed.hash
      || !match
    ) return "";
    return `https://blog.csdn.net/${match[1]}/article/details/${match[2]}`;
  } catch {
    return "";
  }
  return "";
}

function decodeHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      const value = Number.parseInt(code, 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : _match;
    })
    .replace(/&#(\d+);/g, (_match, code) => {
      const value = Number.parseInt(code, 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : _match;
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function htmlToPlainText(html = "") {
  return cleanText(decodeHtmlEntities(
    String(html || "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ));
}

// CSDN stores the markdown we submit verbatim while it re-renders the html
// copy, and the two forms interleave structural tokens differently around the
// same words: "## " headings sit where the html has <h2> text, and
// "![alt](url)" images sit where the html has a figcaption. Reducing the
// markdown to the same semantic text keeps the readback marker comparable
// across both stored copies; without it an 80-character window that crosses a
// block boundary fails as CSDN_API_DRAFT_CONTENT_MISMATCH (2026-10-13).
function markdownToPlainText(markdown = "") {
  const text = String(markdown || "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, " $1 ")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, " ");
  return cleanText(decodeHtmlEntities(text));
}

function readHtmlTitle(html = "") {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanText(decodeHtmlEntities(match[1])) : "";
}

function readCsdnPublicContentHtml(html = "") {
  const source = String(html || "");
  const opening = source.match(/<[^>]+\bid=["']content_views["'][^>]*>/i);
  if (!opening || opening.index === undefined) return "";
  const start = opening.index;
  const articleEnd = source.indexOf("</article>", start);
  const recommendationEnd = source.search(/<div[^>]+class=["'][^"']*recommend/i);
  const candidates = [articleEnd, recommendationEnd]
    .filter((index) => index > start);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

function readCsdnPublicImageUrls(contentHtml = "") {
  const images = String(contentHtml || "").match(/<img\b[^>]*>/gi) || [];
  const urls = [];
  for (const image of images) {
    const direct = image.match(/\b(?:src|data-src|data-original)=["']([^"']+)["']/i)?.[1] || "";
    if (direct) urls.push(decodeHtmlEntities(direct));
    const srcset = image.match(/\bsrcset=["']([^"']+)["']/i)?.[1] || "";
    for (const candidate of srcset.split(",")) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url) urls.push(decodeHtmlEntities(url));
    }
  }
  return [...new Set(urls.map(normalizeCsdnImageUrl).filter(Boolean))];
}

async function fetchCsdnCloudPublicSnapshot(publishedUrl) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 20000) : null;
  try {
    const response = await fetch(CSDN_PUBLIC_SNAPSHOT_API_URL, {
      method: "POST",
      signal: controller?.signal,
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: publishedUrl }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== "object") {
      const detail = cleanText(payload?.detail || "snapshot unavailable");
      throw new Error(`CSDN_PUBLIC_SNAPSHOT_SERVICE_FAILED:${response.status}:${detail}`);
    }
    return payload;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class CsdnLocalPublicTransportError extends Error {}

function isCsdnLocalTransportError(error) {
  return error instanceof TypeError || error?.name === "AbortError";
}

async function fetchCsdnLocalPublicHtml(publishedUrl, signal) {
  const expectedUrl = normalizeCsdnPublishedUrl(publishedUrl);
  if (!expectedUrl) throw new Error("CSDN_PUBLIC_URL_INVALID");
  let currentUrl = String(publishedUrl).trim();
  for (let redirectCount = 0; redirectCount <= CSDN_PUBLIC_MAX_REDIRECTS; redirectCount += 1) {
    let response;
    try {
      response = await fetch(currentUrl, {
        redirect: "manual",
        signal,
        headers: {
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
          "cache-control": "no-cache",
          "pragma": "no-cache",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
        }
      });
    } catch (error) {
      if (isCsdnLocalTransportError(error)) throw new CsdnLocalPublicTransportError("CSDN_PUBLIC_LOCAL_FETCH_FAILED", { cause: error });
      throw error;
    }

    if (CSDN_PUBLIC_REDIRECT_STATUSES.has(Number(response.status))) {
      const location = response.headers?.get?.("location") || "";
      if (!location || redirectCount >= CSDN_PUBLIC_MAX_REDIRECTS) {
        throw new Error("CSDN_PUBLIC_REDIRECT_INVALID");
      }
      let redirectedUrl = "";
      try {
        redirectedUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new Error("CSDN_PUBLIC_REDIRECT_INVALID");
      }
      if (normalizeCsdnPublishedUrl(redirectedUrl) !== expectedUrl) {
        throw new Error("CSDN_PUBLIC_REDIRECT_INVALID");
      }
      currentUrl = redirectedUrl;
      continue;
    }

    try {
      return { response, html: await response.text(), currentUrl };
    } catch (error) {
      if (isCsdnLocalTransportError(error)) throw new CsdnLocalPublicTransportError("CSDN_PUBLIC_LOCAL_FETCH_FAILED", { cause: error });
      throw error;
    }
  }
  throw new Error("CSDN_PUBLIC_REDIRECT_INVALID");
}

async function fetchCsdnPublicPageSnapshot(publishedUrl) {
  if (typeof fetch !== "function") throw new Error("CSDN_PUBLIC_FETCH_UNAVAILABLE");
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 20000) : null;
  let local;
  try {
    local = await fetchCsdnLocalPublicHtml(publishedUrl, controller?.signal);
  } catch (error) {
    if (!(error instanceof CsdnLocalPublicTransportError)) throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!local) return await fetchCsdnCloudPublicSnapshot(publishedUrl);

  const contentHtml = readCsdnPublicContentHtml(local.html);
  return {
    status: local.response.status,
    url: local.response.url || local.currentUrl,
    title: readHtmlTitle(local.html),
    text: htmlToPlainText(local.html).slice(0, 20000),
    contentText: htmlToPlainText(contentHtml).slice(0, 20000),
    imageUrls: readCsdnPublicImageUrls(contentHtml),
  };
}

function isCsdnSoftUnavailablePage(snapshot = {}) {
  const text = cleanText(`${snapshot.title || ""} ${snapshot.text || ""}`);
  return /^404\b|not found|forbidden/i.test(text)
    || /\u4f60\u60f3\u627e\u7684\u5185\u5bb9\u79bb\u4f60\u800c\u53bb/.test(text)
    || /\u5185\u5bb9\u4e0d\u5b58\u5728/.test(text)
    || /\u5185\u5bb9\u8fd8\u5728\u5ba1\u6838\u4e2d/.test(text)
    || /\u5185\u5bb9\u5730\u5740\u9519\u8bef/.test(text)
    || /\u4f5c\u8005\u5220\u9664/.test(text)
    || /\u8fd4\u56de\u9996\u9875\s+\u5411\u4e13\u5bb6\u63d0\u95ee/.test(text);
}

function normalizeCsdnImageUrl(value = "") {
  try {
    const url = new URL(String(value || ""));
    if (!/(^|\.)csdnimg\.cn$/i.test(url.hostname)) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function extractCsdnImageUrls(value = "") {
  const matches = String(value || "").match(/https?:\/\/[^\s"'<>]+/gi) || [];
  return [...new Set(matches.map(normalizeCsdnImageUrl).filter(Boolean))];
}

function hasAllCsdnImages(actual = [], expected = []) {
  const normalizedActual = new Set(actual.map(normalizeCsdnImageUrl).filter(Boolean));
  return expected.every((url) => normalizedActual.has(normalizeCsdnImageUrl(url)));
}

function assertCsdnPublicSnapshot(snapshot = {}, expectedTitle = "", expectedContentMarker = "", expectedImages = [], expectedUrl = "") {
  const status = Number(snapshot.status || 0);
  const pageText = cleanText(`${snapshot.title || ""} ${snapshot.text || ""}`);
  if (status < 200 || status >= 300) throw new Error("CSDN_PUBLISHED_URL_NOT_PUBLIC");
  if (!pageText || isCsdnSoftUnavailablePage(snapshot)) throw new Error("CSDN_PUBLISHED_URL_NOT_PUBLIC");
  const actualUrl = normalizeCsdnPublishedUrl(snapshot.url);
  const normalizedExpectedUrl = normalizeCsdnPublishedUrl(expectedUrl);
  if (!normalizedExpectedUrl || !actualUrl || actualUrl !== normalizedExpectedUrl) {
    throw new Error("CSDN_PUBLISHED_URL_NOT_PUBLIC");
  }
  const pageTitle = cleanText(snapshot.title || "");
  if (expectedTitle && !pageTitle.includes(expectedTitle)) throw new Error("CSDN_PUBLISHED_URL_NOT_PUBLIC");
  const contentText = cleanText(snapshot.contentText || "");
  if (expectedContentMarker && !contentText.includes(cleanText(expectedContentMarker))) {
    throw new Error("CSDN_PUBLIC_CONTENT_MISMATCH");
  }
  if (expectedImages.length && !hasAllCsdnImages(snapshot.imageUrls || [], expectedImages)) {
    throw new Error("CSDN_PUBLIC_IMAGE_MISMATCH");
  }
  return true;
}

function csdnPublishedUrlFromApiPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  const direct = payload.url || payload.href || payload.link || payload.articleUrl || payload.blogUrl || payload.detailUrl;
  const normalized = normalizeCsdnPublishedUrl(direct);
  if (normalized) return normalized;
  for (const item of Object.values(payload)) {
    if (item && typeof item === "object") {
      const nested = csdnPublishedUrlFromApiPayload(item);
      if (nested) return nested;
    }
  }
  return "";
}

function csdnPayloadHasManualBlocker(payload) {
  if (!payload || typeof payload !== "object") return false;
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  const message = cleanText([
    payload.message,
    payload.msg,
    payload.error,
    payload.errorMessage,
    payload.detail,
    data.message,
    data.msg,
    data.error,
    data.errorMessage,
  ].filter(Boolean).join(" "));
  return /captcha|security verification|risk control|manual verification|verification code|slider|\u5b89\u5168\u9a8c\u8bc1|\u9a8c\u8bc1\u7801|\u6ed1\u5757|\u626b\u7801\u9a8c\u8bc1|\u98ce\u63a7|\u4eba\u5de5\u9a8c\u8bc1/i.test(message);
}

function throwCsdnManualActionRequired(input = {}, stage = "publish") {
  notifyPublishProgress(input, {
    type: "manual_verification_required",
    platform: "csdn",
    stage,
  });
  throw new Error("CSDN_MANUAL_ACTION_REQUIRED");
}

function findArticleId(value) {
  if (!value || typeof value !== "object") return "";
  const direct = value.articleId || value.article_id || value.id || value.blogId || value.blog_id;
  if (direct) return String(direct);
  for (const item of Object.values(value)) {
    if (item && typeof item === "object") {
      const nested = findArticleId(item);
      if (nested) return nested;
    }
  }
  return "";
}

function csdnSlugFromShareUrl(value) {
  const match = cleanText(value).match(/blog\.csdn\.net\/([A-Za-z0-9_-]+)\//i);
  return match ? match[1] : "";
}

function csdnSlugFromApiUrl(value) {
  const match = cleanText(value).match(/\/blog\/([A-Za-z0-9_-]+)\/console\//i);
  return match ? match[1] : "";
}

function csdnPublishedUrlFromSlug(articleId, slug) {
  const id = String(articleId || "").trim();
  const name = cleanText(slug);
  if (!id || !name) return "";
  return `https://blog.csdn.net/${encodeURIComponent(name)}/article/details/${encodeURIComponent(id)}`;
}

// CSDN serves the same public article with or without its traffic attribution
// query, but the address the platform hands a visitor carries
// ?spm=1011.2415.3001.5331. Only the reported backlink wears it: every URL that
// feeds a fetch or a snapshot assertion stays clean, because
// normalizeCsdnPublishedUrl rejects a query string and would otherwise fail a
// page that really is public.
const CSDN_PUBLIC_URL_SPM = "spm=1011.2415.3001.5331";

function csdnPublicBacklinkUrl(verifiedUrl) {
  // Strip any query first: the backlink is built from links this function has
  // already emitted (reviewUrl feeds publishedUrl), and normalizeCsdnPublishedUrl
  // rejects a query string, so re-adding the traffic parameter without dropping
  // the old one would return an empty link.
  const normalized = normalizeCsdnPublishedUrl(csdnStoredPublishedUrl(verifiedUrl));
  return normalized ? `${normalized}?${CSDN_PUBLIC_URL_SPM}` : "";
}

function csdnStoredPublishedUrl(value) {
  // A backlink this adapter reported earlier carries the spm tracking query,
  // which normalizeCsdnPublishedUrl rejects; drop it so a stored backlink still
  // round-trips into the article id and slug candidates.
  return normalizeCsdnPublishedUrl(String(value || "").trim().replace(/[?#].*$/, ""));
}

function csdnPublishedUrlParts(url = "") {
  // normalizeCsdnPublishedUrl hands back a full https URL, so the parts have
  // to be read off its pathname; matching the anchored path pattern against
  // the whole URL never hits and silently drops the stored slug and article id.
  const normalized = normalizeCsdnPublishedUrl(url);
  if (!normalized) return { slug: "", articleId: "" };
  let pathname = "";
  try {
    pathname = new URL(normalized).pathname;
  } catch {
    return { slug: "", articleId: "" };
  }
  const match = pathname.match(/^\/([A-Za-z0-9_-]+)\/article\/details\/(\d+)\/?$/);
  return match ? { slug: match[1], articleId: match[2] } : { slug: "", articleId: "" };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The device materializes every inline image as a local data URL before any
// adapter runs. That blob must never reach CSDN: on 2026-10-11 a 1.4 MB base64
// body was rejected with "正文字数太多，请分成几篇博文发布". Keep only the URL
// the image upload returned, and mirror it onto `url` as well so the composer
// emits it on every rich-content version, hot-updated or install-bundled.
// Exported so tests can pin the hot-update contract: the shipped adapter has to
// keep working with the composer built into an older install, which still reads
// `block.dataUrl || block.url`.
export function csdnPublicImageBlock(block) {
  if (block?.type !== "image") return block;
  const platformImageUrl = cleanText(block.platformImageUrl);
  return {
    ...block,
    url: platformImageUrl,
    platformImageUrl,
    dataUrl: "",
    path: "",
  };
}

// Backstop for the same failure. CSDN answers an oversized body with an opaque
// "正文字数太多", so refuse locally with the real size instead of shipping the
// payload. 200k chars sits far above the largest article CSDN accepted from
// this pipeline (~168k on 2026-10-07) while still catching any base64
// regression: one 150 KB photo already base64-encodes past the limit.
const CSDN_MAX_CONTENT_CHARS = 200000;

function assertCsdnPublishContentSize(content, label) {
  const text = String(content || "");
  if (/<img[^>]+src="data:[^"]*;base64,/i.test(text)) {
    throw new Error("CSDN_API_CONTENT_EMBEDS_LOCAL_IMAGE");
  }
  if (text.length > CSDN_MAX_CONTENT_CHARS) {
    throw new Error(`CSDN_API_CONTENT_TOO_LARGE:${label}:${text.length}`);
  }
  return text;
}

export function csdnBodyHtml(publishInput = {}, uploadedImages = []) {
  if (publishInput.contentBlocks?.length) {
    const blocks = bindContentBlocksToImages(publishInput.contentBlocks, uploadedImages).map(csdnPublicImageBlock);
    return assertCsdnPublishContentSize(composeRichArticleHtml(blocks), "html");
  }
  const base = publishInput.richHtml || String(publishInput.content || "")
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const figures = uploadedImages
    .map((image) => image.platformImageUrl ? `<p><img src="${escapeHtml(image.platformImageUrl)}#pic_center" alt="${escapeHtml(image.altText || "article image")}"></p>` : "")
    .join("");
  return assertCsdnPublishContentSize(`${base || "<p><br></p>"}${figures}`, "html");
}

export function csdnMarkdown(publishInput = {}, uploadedImages = []) {
  if (publishInput.contentBlocks?.length) {
    const markdown = publishInput.contentBlocks.map((block) => {
      if (block?.type === "section") {
        return [`## ${block.title || ""}`, block.content || ""].filter(Boolean).join("\n\n");
      }
      if (block?.type === "image") {
        const image = uploadedImages.find((item) => (
          (block.assetId && item.assetId === block.assetId)
          || (block.sectionId && item.sectionId === block.sectionId)
        ));
        const url = image?.platformImageUrl || "";
        return url ? `![${block.altText || "article image"}](${url}#pic_center)` : "";
      }
      return "";
    }).filter(Boolean).join("\n\n");
    return assertCsdnPublishContentSize(markdown, "markdown");
  }
  const imageMarkdown = uploadedImages
    .map((image) => image.platformImageUrl ? `![${image.altText || "article image"}](${image.platformImageUrl}#pic_center)` : "")
    .filter(Boolean)
    .join("\n\n");
  return assertCsdnPublishContentSize([publishInput.content, imageMarkdown].filter(Boolean).join("\n\n"), "markdown");
}

function csdnApiConfig(input = {}) {
  const config = input.platformConfig && typeof input.platformConfig === "object" ? input.platformConfig : {};
  return {
    publishApiUrl: cleanText(config.publishApiUrl || config.publishUrl || "https://bizapi.csdn.net/blog-console-api/v3/mdeditor/saveArticle"),
    signatureApiUrl: cleanText(config.signatureApiUrl || "https://bizapi.csdn.net/resource-api/v1/image/direct/upload/signature"),
    accountApiUrl: cleanText(config.accountApiUrl || "https://bizapi.csdn.net/blog-console-api/v1/user/info"),
    articleApiUrl: cleanText(config.articleApiUrl || "https://bizapi.csdn.net/blog-console-api/v3/editor/getArticle"),
    articleListApiUrl: cleanText(config.articleListApiUrl || "https://bizapi.csdn.net/blog/phoenix/console/v1/article/list"),
    deleteArticleApiUrl: cleanText(config.deleteArticleApiUrl || "https://bizapi.csdn.net/blog/phoenix/console/v1/article/del"),
  };
}

function csdnApiPayloadAccepted(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.success === false) return false;
  const code = payload.code ?? payload.errno ?? payload.status;
  if (code !== undefined && ![0, "0", 200, "200"].includes(code)) return false;
  return Boolean(payload.success === true || [0, "0", 200, "200"].includes(code) || findArticleId(payload) || csdnPublishedUrlFromApiPayload(payload));
}

function csdnImageMime(fileName = "") {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  if ([".jpg", ".jpeg"].includes(extension)) return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  throw new Error(`CSDN_IMAGE_TYPE_UNSUPPORTED:${extension || "missing"}`);
}

function csdnImageSuffix(fileName = "") {
  const mimeType = csdnImageMime(fileName);
  return mimeType === "image/jpeg" ? "jpeg" : mimeType.replace(/^image\//, "");
}

function csdnGatewayClient(url) {
  const pathname = new URL(String(url || "")).pathname;
  return pathname.startsWith("/resource-api/")
    ? CSDN_UPLOAD_GATEWAY_CLIENT
    : CSDN_ARTICLE_GATEWAY_CLIENT;
}

function csdnCanonicalResource(url) {
  const parsed = new URL(String(url || ""));
  const values = new Map();
  for (const [name, value] of parsed.searchParams) {
    const existing = values.get(name) || [];
    existing.push(value);
    values.set(name, existing);
  }
  const query = [...values.keys()]
    .sort()
    .map((name) => {
      const value = values.get(name).join(",");
      return value === "" ? name : `${name}=${value}`;
    })
    .join("&");
  return `${parsed.pathname}${query ? `?${query}` : ""}`;
}

function buildCsdnGatewayRequest(url, options = {}) {
  const method = String(options.method || (options.data === undefined ? "GET" : "POST")).toUpperCase();
  if (!["GET", "POST"].includes(method)) throw new Error(`CSDN_GATEWAY_METHOD_UNSUPPORTED:${method}`);
  const client = csdnGatewayClient(url);
  if (!client.appKey || !client.appSecret) throw new Error("CSDN_GATEWAY_CONFIG_REQUIRED");
  const accept = String(options.headers?.Accept || options.headers?.accept || "application/json, text/plain, */*");
  const contentType = method === "POST"
    ? String(options.headers?.["Content-Type"] || options.headers?.["content-type"] || "application/json;charset=UTF-8")
    : "";
  const nonce = String(options.nonce || randomUUID());
  const signedHeaders = {
    "x-ca-key": client.appKey,
    "x-ca-nonce": nonce,
    ...(client.timestamped ? { "x-ca-timestamp": String(options.timestamp || Date.now()) } : {}),
  };
  const signatureHeaderNames = Object.keys(signedHeaders).sort().join(",");
  const canonicalHeaders = Object.keys(signedHeaders)
    .sort()
    .map((name) => `${name}:${signedHeaders[name]}\n`)
    .join("");
  const canonical = `${method}\n${accept}\n\n${contentType}\n\n${canonicalHeaders}${csdnCanonicalResource(url)}`;
  const signature = createHmac("sha256", client.appSecret).update(canonical).digest("base64");
  const headers = {
    ...(options.headers || {}),
    Accept: accept,
    ...(contentType ? { "Content-Type": contentType } : {}),
    "X-Ca-Key": client.appKey,
    "X-Ca-Nonce": nonce,
    ...(client.timestamped ? { "X-Ca-Timestamp": signedHeaders["x-ca-timestamp"] } : {}),
    "X-Ca-Signature": signature,
    "X-Ca-Signature-Headers": signatureHeaderNames,
  };
  return {
    url: String(url || ""),
    method,
    data: options.data,
    body: method === "POST" ? JSON.stringify(options.data || {}) : undefined,
    headers,
  };
}

export async function csdnGatewayFetch(page, url, options = {}) {
  if (typeof page?.evaluate !== "function") throw new Error("CSDN_SIGNED_GATEWAY_UNAVAILABLE");
  const result = await page.evaluate(async (request) => {
    try {
      const response = await fetch(request.url, {
        method: request.method,
        credentials: "include",
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      const responseText = await response.text();
      let payload = null;
      try {
        payload = responseText ? JSON.parse(responseText) : null;
      } catch {
        payload = responseText || null;
      }
      const code = payload?.code;
      const accepted = response.ok
        && (code === undefined || code === 0 || code === "0" || code === 200 || code === "200");
      return {
        ok: accepted,
        status: response.status,
        payload,
        error: accepted ? "" : `Request failed with status code ${response.status}`,
      };
    } catch (error) {
      return {
        ok: false,
        status: Number(error?.status || 0),
        payload: null,
        error: String(error?.message || error || "CSDN_GATEWAY_REQUEST_FAILED"),
      };
    }
  }, buildCsdnGatewayRequest(url, options));
  if (!result?.ok && !result?.error) result.error = "CSDN_GATEWAY_REQUEST_REJECTED";
  return result || { ok: false, status: 0, payload: null, error: "CSDN_GATEWAY_REQUEST_FAILED" };
}

function csdnCreationStatementValue(value, articleType = "original") {
  const normalized = cleanText(value).toLowerCase();
  if (/^\d+$/.test(normalized)) return Number(normalized);
  if (normalized && normalized !== "none") return 1;
  return articleType === "original" ? 1 : 0;
}

function buildCsdnArticlePayload(publishInput, options = {}) {
  const articleId = Number(options.articleId || 0);
  const publishing = options.pubStatus === "publish";
  return {
    ...(articleId ? { id: articleId } : {}),
    title: publishInput.title,
    markdowncontent: options.markdown || publishInput.content,
    content: options.html || "",
    description: publishInput.summary,
    readType: publishInput.visibility,
    level: publishInput.visibility === "private" ? 1 : 0,
    tags: publishInput.tags.join(","),
    status: publishing ? 0 : 2,
    categories: publishInput.category || "",
    type: publishInput.articleType,
    original_link: "",
    authorized_status: false,
    not_auto_saved: articleId ? "1" : "0",
    source: "pc_mdeditor",
    cover_images: Array.isArray(options.coverImages) ? options.coverImages : [],
    cover_type: 1,
    is_new: 1,
    vote_id: 0,
    resource_id: "",
    pubStatus: publishing ? "publish" : "draft",
    creation_statement: csdnCreationStatementValue(publishInput.creationStatement, publishInput.articleType),
    creator_activity_id: "",
  };
}

function isSensitiveCsdnErrorKey(key) {
  return /(cookie|token|secret|password|credential|authorization|csrf|xsrf|session|signature|api[_-]?key|access[_-]?(?:key|id))/i.test(String(key || ""));
}

function sanitizeCsdnErrorDetail(value) {
  const detail = cleanText(value)
    .replace(/\b(?:set-cookie|cookie)\s*[:=]\s*[^,]*/gi, "cookie=[REDACTED]")
    .replace(/(["']?)([A-Za-z][A-Za-z0-9_-]{0,63})\1\s*[:=]\s*(["']?)(?:(?:basic|bearer)\s+)?([^"'\s,;}\]]+)\3/gi, (match, quote, key) => (
      isSensitiveCsdnErrorKey(key) ? `${quote}${key}${quote}=[REDACTED]` : match
    ))
    .replace(/\b(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "credential=[REDACTED]");
  return detail.slice(0, 1000);
}

function csdnApiData(result, errorCode) {
  if (!result?.ok || !csdnApiPayloadAccepted(result.payload)) {
    const payloadDetail = result?.payload && typeof result.payload === "object"
      ? result.payload.message || result.payload.msg || result.payload.error || result.payload.detail
      : result?.payload;
    const detail = sanitizeCsdnErrorDetail(payloadDetail || result?.error || result?.status);
    throw new Error(`${errorCode}${detail ? `:${detail}` : ""}`);
  }
  return result.payload?.data ?? result.payload;
}

async function readCsdnAccountViaApi(page, config) {
  const result = await csdnGatewayFetch(page, config.accountApiUrl, { method: "GET" });
  const data = csdnApiData(result, "CSDN_ACCOUNT_API_FAILED");
  const username = cleanText(data?.username);
  if (!username) throw new Error("CSDN_ACCOUNT_USERNAME_MISSING");
  return { username, payload: result.payload };
}

async function readCsdnArticleViaApi(page, config, articleId) {
  const url = `${config.articleApiUrl}?id=${encodeURIComponent(articleId)}&model_type=`;
  const result = await csdnGatewayFetch(page, url, { method: "GET" });
  return { data: csdnApiData(result, "CSDN_ARTICLE_READ_FAILED"), payload: result.payload, url };
}

async function readCsdnArticleListViaApi(page, config) {
  const url = `${config.articleListApiUrl}?page=1&status=all_v3&pageSize=20`;
  const result = await csdnGatewayFetch(page, url, { method: "GET" });
  return { data: csdnApiData(result, "CSDN_ARTICLE_LIST_FAILED"), payload: result.payload, url };
}

function findCsdnArticleInList(data = {}, articleId = "") {
  const expectedId = cleanText(articleId);
  return (Array.isArray(data?.list) ? data.list : [])
    .find((item) => cleanText(item?.article_id || item?.articleId || item?.id) === expectedId) || null;
}

// The console article list carries the author's real blog slug on every entry, which
// makes it the one slug source that is not a guess. The share-data URL and the console
// API path both embed CSDN's template slug (phoenix), which belongs to no author, so
// they can only ever contribute a 404. Measured on the 2026-10-22 capture of
// bizapi.csdn.net/blog/phoenix/console/v1/article/list.
function csdnListUsername(listItem) {
  return cleanText(listItem?.username);
}

// CSDN states the review verdict only in the console article list: status 1 is
// published, 6 is still queued for review. The same capture measured what that means
// for the link - every status=1 article answered 200 on its public URL while the one
// status=6 article answered 404 - so an article the platform still reports as
// in_review has no public page to link, no matter how readable some other page at
// that address looks. "unknown" means the console returned no verdict for this
// article (the list call failed, or the article is not on the page we read); that is
// missing evidence, never approval, so the public page stays the only judge there.
function csdnConsoleApprovalVerdict(listItem) {
  if (!listItem) return "unknown";
  const status = Number(listItem.status);
  if (status === CSDN_ARTICLE_STATUS_PUBLIC) return "published";
  if (status === CSDN_ARTICLE_STATUS_IN_REVIEW) return "in_review";
  return "unknown";
}

async function waitForCsdnCleanupListState(page, config, articleId, expectedStatus, input = {}) {
  const attempts = Math.max(1, Number(input.cleanupVerifyAttempts || 12));
  const pollMs = Math.max(1, Number(input.cleanupVerifyPollMs || 500));
  let lastStatus = "missing";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const listResult = await readCsdnArticleListViaApi(page, config);
    const article = findCsdnArticleInList(listResult.data, articleId);
    lastStatus = article ? cleanText(article.status) : "missing";
    if (expectedStatus === null ? !article : Number(article?.status) === Number(expectedStatus)) {
      return { article, listUrl: listResult.url, attempt };
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`CSDN_TEST_CLEANUP_NOT_VERIFIED:expected=${expectedStatus ?? "missing"}:actual=${lastStatus}`);
}

async function destroyCsdnTestArticleViaApi(page, config, articleId, input = {}) {
  const expectedId = cleanText(articleId);
  if (!/^\d+$/.test(expectedId)) throw new Error("CSDN_TEST_CLEANUP_ARTICLE_ID_INVALID");
  const remove = async (deep, errorCode) => {
    const result = await csdnGatewayFetch(page, config.deleteArticleApiUrl, {
      method: "POST",
      data: { articleId: expectedId, deep },
    });
    const data = csdnApiData(result, errorCode);
    if (data !== true) throw new Error(`${errorCode}:delete_not_confirmed`);
  };

  await remove(false, "CSDN_TEST_SOFT_DELETE_FAILED");
  const recycled = await waitForCsdnCleanupListState(page, config, expectedId, 32, input);
  await remove(true, "CSDN_TEST_PERMANENT_DELETE_FAILED");
  const deleted = await waitForCsdnCleanupListState(page, config, expectedId, null, input);
  return {
    deleted: true,
    articleId: expectedId,
    softDeleted: true,
    permanentlyDeleted: true,
    listVerified: true,
    softDeleteStatus: Number(recycled.article.status),
    endpoint: config.deleteArticleApiUrl,
    listEndpoint: deleted.listUrl,
  };
}

function csdnArticleMatches(article = {}, articleId = "", title = "") {
  const actualId = cleanText(article.article_id || article.articleId || article.id);
  return actualId === cleanText(articleId) && cleanText(article.title) === cleanText(title);
}

// Both readback fingerprints use the same window length: long enough to be
// unique per article, short enough to survive the first block boundary.
const CSDN_CONTENT_MARKER_CHARS = 80;

function csdnContentMarker(content = "") {
  const source = String(content || "");
  const semanticText = /<[^>]+>/.test(source) ? htmlToPlainText(source) : cleanText(source);
  return cleanText(semanticText).slice(0, CSDN_CONTENT_MARKER_CHARS);
}

// The markdown copy is stored verbatim, so its fingerprint is the plain prefix
// of the markdown itself rather than of the html rendering.
function csdnMarkdownContentMarker(markdown = "") {
  return cleanText(markdown).slice(0, CSDN_CONTENT_MARKER_CHARS);
}

async function waitForCsdnDraftReadback(page, config, articleId, publishInput, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 10));
  const pollMs = Math.max(1, Number(options.pollMs || 500));
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const article = (await readCsdnArticleViaApi(page, config, articleId)).data || {};
    const matched = csdnArticleMatches(article, articleId, publishInput.title);
    const actualId = cleanText(article.article_id || article.articleId || article.id);
    const status = Number(article.status);
    if (actualId === cleanText(articleId) && status === 1) {
      throw new Error("CSDN_API_DRAFT_STATUS_MISMATCH:actual=1");
    }
    const htmlContent = htmlToPlainText(article.content || "");
    const markdownContent = cleanText(article.markdowncontent || "");
    const imageUrls = extractCsdnImageUrls(`${article.markdowncontent || ""}\n${article.content || ""}`);
    const coverImages = Array.isArray(article.cover_images) ? article.cover_images : [];
    // CSDN stores the markdown we submit verbatim while re-rendering the html
    // copy, so each stored form is matched against the text we sent in that
    // same form. The markdown copy additionally accepts the syntax-normalized
    // html marker: "## " headings and image links break the shared
    // 80-character window even though both forms carry the same words.
    const htmlMarker = cleanText(options.contentMarker);
    const markdownMarker = cleanText(options.markdownContentMarker);
    const representations = [
      { form: "html", text: htmlContent, semanticText: "", markers: [htmlMarker] },
      {
        form: "markdown",
        text: markdownContent,
        semanticText: markdownToPlainText(article.markdowncontent || ""),
        markers: [markdownMarker, htmlMarker],
      },
    ].filter((entry) => entry.text);
    const representationMatched = (entry) => entry.markers.some((marker) => (
      marker && (entry.text.includes(marker) || entry.semanticText.includes(marker))
    ));
    const contentMatched = !htmlMarker || (
      representations.length > 0 && representations.every(representationMatched)
    );
    const mismatchedForms = representations
      .filter((entry) => !representationMatched(entry))
      .map((entry) => entry.form)
      .join("+");
    const imagesMatched = hasAllCsdnImages(imageUrls, options.expectedImages || []);
    const coverMatched = hasAllCsdnImages(coverImages, options.expectedCoverImages || []);
    last = { article, matched, status, contentMatched, mismatchedForms, imagesMatched, coverMatched, imageUrls, coverImages };
    if (matched && status === 2 && contentMatched && imagesMatched && coverMatched) {
      return last;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (!last?.matched) throw new Error("CSDN_API_DRAFT_READBACK_MISMATCH");
  if (last.status !== 2) throw new Error(`CSDN_API_DRAFT_STATUS_MISMATCH:actual=${last.article.status ?? "missing"}`);
  // The suffix names the stored form that missed the marker; only the desktop
  // log keeps it (sanitizeCommandFailure reduces the code to the first token).
  if (!last.contentMatched) {
    throw new Error(`CSDN_API_DRAFT_CONTENT_MISMATCH${last.mismatchedForms ? `:form=${last.mismatchedForms}` : ""}`);
  }
  if (!last.imagesMatched) throw new Error("DRAFT_IMAGE_MISSING");
  throw new Error("CSDN_DRAFT_COVER_MISSING");
}

async function waitForCsdnApiPublication(page, config, articleId, publishInput, publicUrl, options = {}) {
  // The default window has to outlive CSDN's status 16 settling state, which
  // was still active 12 seconds after the publish call was accepted.
  const attempts = Math.max(1, Number(options.attempts || 20));
  const pollMs = Math.max(1, Number(options.pollMs || 1500));
  const fetchPublicPage = typeof options.publicPageFetcher === "function"
    ? options.publicPageFetcher
    : fetchCsdnPublicPageSnapshot;
  // The article list carries the real blog slug (downloadShareDataUrl); the
  // account endpoint only exposes the internal user id, which is not routable.
  const configSlug = csdnSlugFromApiUrl(config.articleListApiUrl);
  let last = null;
  let review = null;
  let settling = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const articleResult = await readCsdnArticleViaApi(page, config, articleId);
    const listResult = await readCsdnArticleListViaApi(page, config);
    const article = articleResult.data || {};
    const listItem = (Array.isArray(listResult.data?.list) ? listResult.data.list : [])
      .find((item) => csdnArticleMatches(item, articleId, publishInput.title));
    // The list entry's own username is the platform's record of the real blog
    // slug; the account username backs it up. Both phoenix sources (the
    // share-data URL and the console API path) are CSDN template residue that
    // belongs to no author, so they only ever come last.
    const slug = csdnListUsername(listItem)
      || cleanText(options.accountUsername)
      || csdnSlugFromShareUrl(listItem?.downloadShareDataUrl)
      || configSlug;
    const candidateUrl = csdnPublishedUrlFromSlug(articleId, slug) || publicUrl;
    const articleMatched = csdnArticleMatches(article, articleId, publishInput.title);
    const articleStatus = Number(article.status);
    const articlePublished = articleMatched && articleStatus === CSDN_ARTICLE_STATUS_PUBLIC;
    const listPublished = Boolean(listItem && Number(listItem.status) === CSDN_ARTICLE_STATUS_PUBLIC);
    let snapshot = null;
    let publicError = "";
    if (articlePublished && listPublished) {
      try {
        snapshot = await fetchPublicPage(candidateUrl);
        assertCsdnPublicSnapshot(
          snapshot,
          publishInput.title,
          options.contentMarker || csdnContentMarker(publishInput.content),
          options.expectedImages || [],
          candidateUrl,
        );
        return { article, listItem, snapshot, candidateUrl, attempt };
      } catch (error) {
        publicError = error instanceof Error ? error.message : String(error);
      }
    }
    if (articleMatched && articleStatus === CSDN_ARTICLE_STATUS_IN_REVIEW) {
      review = { article, listItem, slug, candidateUrl, attempt };
    }
    if (articleMatched && CSDN_ARTICLE_STATUS_SETTLING.has(articleStatus)) {
      settling = { article, listItem, slug, candidateUrl, attempt };
    }
    last = { article, listItem, snapshot, publicError, attempt };
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  // A settling article is one CSDN already accepted but has not queued yet, so
  // it reports the same thing a review does: no public page to verify.
  const queued = review || settling;
  if (queued) {
    return {
      mode: "review",
      article: queued.article,
      listItem: queued.listItem,
      slug: queued.slug,
      candidateUrl: queued.candidateUrl,
      snapshot: null,
      publicError: "",
      attempt: queued.attempt,
      settledStatus: Number(queued.article.status),
      settling: Boolean(settling) && !review,
    };
  }
  const status = Number(last?.article?.status ?? -1);
  throw new Error(`CSDN_API_PUBLICATION_NOT_VERIFIED:status=${status}:${last?.publicError || "public evidence missing"}`);
}

async function uploadCsdnImageViaApi(page, config, task, appName) {
  const fileName = path.basename(task.path || "") || "article-image.jpg";
  const signature = await csdnGatewayFetch(page, config.signatureApiUrl, {
    method: "POST",
    data: {
      imageTemplate: "",
      appName,
      imageSuffix: csdnImageSuffix(fileName),
    },
  });
  if ([401, 403].includes(signature.status)) throw new Error("CSDN_LOGIN_REQUIRED");
  const data = signature.payload?.data || signature.payload || {};
  const host = cleanText(data.host);
  const key = cleanText(data.filePath || data.key);
  if (!signature.ok || !host || !key) throw new Error("CSDN_API_IMAGE_SIGNATURE_FAILED");
  const buffer = await readFile(task.path);
  const multipart = {
    key,
    policy: data.policy || "",
    signature: data.signature || "",
    callbackBody: data.callbackBody || "",
    callbackBodyType: data.callbackBodyType || "application/json",
    ...(cleanText(data.provider).toLowerCase() === "obs"
      ? { callbackUrl: data.callbackUrl || "", AccessKeyId: data.accessId || "" }
      : { callback: data.callbackUrl || "", OSSAccessKeyId: data.accessId || "" }),
    ...Object.fromEntries(Object.entries(data.customParam || {}).map(([keyName, value]) => [`x:${keyName}`, value])),
    file: {
      name: fileName,
      mimeType: csdnImageMime(fileName),
      buffer,
    },
  };
  const upload = await platformApiFetch(page, host, {
    method: "POST",
    multipart,
    headers: { Referer: CSDN_EDITOR_URL },
  });
  if (![200, 201, 204].includes(upload.status)) throw new Error("CSDN_API_IMAGE_UPLOAD_FAILED");
  const responseImageUrl = typeof upload.payload?.data === "string"
    ? normalizeCsdnImageUrl(upload.payload.data)
    : normalizeCsdnImageUrl(
        upload.payload?.data?.url
        || upload.payload?.url
        || upload.payload?.location,
      );
  const platformImageUrl = responseImageUrl || normalizeCsdnImageUrl(`https://i-blog.csdnimg.cn/${key}`);
  if (!platformImageUrl || !isPersistentPlatformImageUrl(platformImageUrl)) {
    throw new Error("CSDN_API_IMAGE_URL_MISSING");
  }
  return {
    ...task,
    platformImageId: key,
    platformImageUrl,
    loaded: true,
  };
}

async function uploadCsdnImagesViaApi(page, input = {}, publishInput = {}) {
  if (!publishInput.platformImageTasks.length) return [];
  const config = csdnApiConfig(input);
  const uploaded = [];
  for (const task of publishInput.platformImageTasks) {
    uploaded.push(await uploadCsdnImageViaApi(page, config, task, "direct_blog"));
  }
  return uploaded;
}

async function publishCsdnViaApi(page, input = {}, publishInput = {}, options = {}) {
  const config = csdnApiConfig(input);
  let articleId = "";
  let result = null;
  let operationError = null;
  try {
  const account = await readCsdnAccountViaApi(page, config);
  const uploadedImages = await uploadCsdnImagesViaApi(page, input, publishInput);
  const uploadedCover = publishInput.coverImagePath
    ? await uploadCsdnImageViaApi(page, config, {
        assetId: "cover",
        sectionId: "cover",
        position: -1,
        path: publishInput.coverImagePath,
        altText: "cover",
      }, "direct_blog_coverimage")
    : null;
  const coverImages = uploadedCover ? [uploadedCover.platformImageUrl] : [];
  const html = csdnBodyHtml(publishInput, uploadedImages);
  const markdown = csdnMarkdown(publishInput, uploadedImages);
  const contentMarker = csdnContentMarker(html);
  const markdownContentMarker = csdnMarkdownContentMarker(markdown);
  const draftPayload = buildCsdnArticlePayload(publishInput, {
    html,
    markdown,
    pubStatus: "draft",
    coverImages,
  });
  const draftResult = await csdnGatewayFetch(page, config.publishApiUrl, {
    method: "POST",
    data: draftPayload,
  });
  if (csdnPayloadHasManualBlocker(draftResult.payload)) throwCsdnManualActionRequired(input, "draft");
  const draftData = csdnApiData(draftResult, "CSDN_API_DRAFT_NOT_ACCEPTED");
  articleId = cleanText(findArticleId(draftData) || findArticleId(draftResult.payload));
  if (!articleId) throw new Error("CSDN_API_DRAFT_ID_MISSING");
  const draftUrl = csdnDraftUrlFromArticleId(articleId);
  // Report the identity now. A throw during draft readback or public-page
  // verification would otherwise hide an article id that already exists.
  input.evidenceSink?.({
    externalIds: { articleId, username: account.username },
    draftUrl,
    platformStatus: "draft_saved"
  });
  const candidateUrl = csdnPublishedUrlFromApiPayload(draftResult.payload)
    || csdnPublishedUrlFromSlug(
      articleId,
      cleanText(account.username) || csdnSlugFromApiUrl(config.articleListApiUrl),
    );
  const uploadedImageUrls = uploadedImages.map((image) => image.platformImageUrl);
  const draftReadback = await waitForCsdnDraftReadback(page, config, articleId, publishInput, {
    attempts: input.draftVerifyAttempts,
    pollMs: input.draftVerifyPollMs,
    contentMarker,
    markdownContentMarker,
    expectedImages: uploadedImageUrls,
    expectedCoverImages: coverImages,
  });
  const draftArticle = draftReadback.article;
  const draftCoverImages = draftReadback.coverImages;
  const draftImages = uploadedImages.map((image) => ({ ...image, loaded: true }));

  const evidence = {
    source: "api",
    transport: "csdn_signed_gateway",
    accepted: true,
    steps: [
      { stage: "account", endpoint: config.accountApiUrl, username: account.username },
      { stage: "draft", endpoint: config.publishApiUrl, articleId, status: Number(draftArticle.status) },
    ],
  };

  if (!publishInput.confirmPublish) {
    const imagePublicationEvidence = publishInput.platformImageTasks.length
      ? buildImagePublicationEvidence(publishInput.platformImageTasks, uploadedImages, draftImages, [], PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED)
      : undefined;
    result = {
      draftUrl,
      publishedUrl: "",
      platformStatus: "draft_saved",
      title: publishInput.title,
      externalIds: { articleId, username: account.username },
      publicationEvidence: evidence,
      ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
      ...(uploadedCover ? {
        coverImageEvidence: {
          status: "draft_verified",
          platformImageUrl: uploadedCover.platformImageUrl,
          draftImages: draftCoverImages,
        },
      } : {}),
    };
    return result;
  }

  const publishPayload = buildCsdnArticlePayload(publishInput, {
    articleId,
    html,
    markdown,
    pubStatus: "publish",
    coverImages,
  });
  const publishResult = await csdnGatewayFetch(page, config.publishApiUrl, {
    method: "POST",
    data: publishPayload,
  });
  if (csdnPayloadHasManualBlocker(publishResult.payload)) throwCsdnManualActionRequired(input, "publish");
  csdnApiData(publishResult, "CSDN_API_PUBLISH_NOT_ACCEPTED");
  const publishedId = cleanText(findArticleId(publishResult.payload));
  if (publishedId && publishedId !== articleId) {
    throw new Error(`CSDN_API_PUBLISH_ID_MISMATCH:expected=${articleId}:actual=${publishedId}`);
  }
  evidence.steps.push({ stage: "publish", endpoint: config.publishApiUrl, articleId });

  const verified = await waitForCsdnApiPublication(page, config, articleId, publishInput, candidateUrl, {
    accountUsername: account.username,
    publicPageFetcher: options.publicPageFetcher,
    attempts: input.publicVerifyAttempts,
    pollMs: input.publicVerifyPollMs,
    expectedImages: uploadedImageUrls,
    contentMarker,
  });
  // The list entry's username is the platform's own record of the real blog
  // slug, and the account username backs it up; the share-data URL and the
  // console API path both carry CSDN's template slug (phoenix), which belongs
  // to no author, so they only ever come last.
  const resolvedSlug = csdnListUsername(verified.listItem)
    || cleanText(account.username)
    || csdnSlugFromApiUrl(config.articleListApiUrl)
    || csdnSlugFromShareUrl(verified.listItem?.downloadShareDataUrl);
  // Only the reported link wears CSDN's traffic query; the clean URL stays the
  // one that gets fetched and asserted against the public page.
  const reviewUrl = csdnPublicBacklinkUrl(csdnPublishedUrlFromSlug(articleId, resolvedSlug));
  // The publish call was accepted before this line, so a later cover or
  // public-page failure must not relabel the article as never submitted.
  input.evidenceSink?.({
    draftUrl,
    reviewUrl,
    candidateUrl: reviewUrl,
    platformStatus: "submitted_for_review"
  });
  if (verified.mode === "review") {
    const settledStatus = Number(
      verified.settledStatus ?? verified.article?.status ?? CSDN_ARTICLE_STATUS_IN_REVIEW
    );
    // CSDN accepted the article and queued it for review (status 6). The
    // article is not publicly readable yet, so there is no public page to
    // verify: reporting this as a failure would destroy the real article id.
    evidence.steps.push(
      { stage: "article_readback", endpoint: config.articleApiUrl, articleId, status: settledStatus },
      { stage: "article_list", endpoint: config.articleListApiUrl, articleId, status: Number(verified.listItem?.status ?? settledStatus) },
      { stage: "review_queued", endpoint: config.publishApiUrl, articleId, status: settledStatus },
    );
    const draftImageEvidence = publishInput.platformImageTasks.length
      ? buildImagePublicationEvidence(publishInput.platformImageTasks, uploadedImages, draftImages, [], PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED)
      : undefined;
    result = {
      draftUrl,
      publishedUrl: "",
      reviewUrl,
      candidateUrl: reviewUrl,
      platformStatus: "submitted_for_review",
      publiclyVisible: false,
      reviewStatus: "pending_review",
      title: publishInput.title,
      externalIds: { articleId, username: account.username, slug: resolvedSlug },
      publicationEvidence: evidence,
      message: verified.settling === true
        ? `CSDN accepted the article and still reported status ${settledStatus} (settling into the review queue); no public page is readable yet, so the review URL is the only honest link.`
        : "CSDN accepted the article and queued it for review; the public page is not readable until the platform approves it.",
      ...(draftImageEvidence ? { imagePublicationEvidence: draftImageEvidence } : {}),
    };
    return result;
  }
  evidence.steps.push(
    { stage: "article_readback", endpoint: config.articleApiUrl, articleId, status: Number(verified.article.status) },
    { stage: "article_list", endpoint: config.articleListApiUrl, articleId, status: Number(verified.listItem.status) },
    // Name the address that was actually fetched: the draft payload can carry
    // CSDN's template slug, so the initial candidate is not the one the public
    // page was read from.
    { stage: "public_page", endpoint: verified.candidateUrl || candidateUrl, articleId, title: publishInput.title },
  );
  const publicImageUrls = (verified.snapshot?.imageUrls || []).map(normalizeCsdnImageUrl).filter(Boolean);
  const publicImages = uploadedImages.map((image) => ({
    ...image,
    loaded: publicImageUrls.includes(normalizeCsdnImageUrl(image.platformImageUrl)),
  }));
  const imagePublicationEvidence = publishInput.platformImageTasks.length
    ? buildImagePublicationEvidence(publishInput.platformImageTasks, uploadedImages, draftImages, publicImages)
    : undefined;
  const listCoverImages = Array.isArray(verified.listItem?.coverImage) ? verified.listItem.coverImage : [];
  if (uploadedCover && !hasAllCsdnImages(listCoverImages, coverImages)) {
    throw new Error("CSDN_PUBLICATION_COVER_MISMATCH");
  }
  result = {
    draftUrl,
    // csdnPublicBacklinkUrl drops any query before re-adding the traffic one,
    // so both the slug-derived link and the payload fallback come out in the
    // same visitor-facing shape.
    publishedUrl: csdnPublicBacklinkUrl(reviewUrl || candidateUrl),
    platformStatus: "published",
    publiclyVisible: true,
    reviewStatus: "public",
    title: publishInput.title,
    externalIds: { articleId, username: account.username, slug: resolvedSlug },
    publicationEvidence: evidence,
    ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
    ...(uploadedCover ? {
      coverImageEvidence: {
        status: "verified",
        platformImageUrl: uploadedCover.platformImageUrl,
        draftImages: draftCoverImages,
        listImages: listCoverImages,
      },
    } : {}),
  };
  return result;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (input.cleanupTestArticle === true && articleId) {
      try {
        const cleanup = await destroyCsdnTestArticleViaApi(page, config, articleId, input);
        if (result) result.testCleanup = cleanup;
      } catch (cleanupError) {
        if (!operationError) throw cleanupError;
        notifyPublishProgress(input, {
          type: "test_cleanup_failed",
          platform: "csdn",
          articleId,
          errorMessage: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }
  }
}

function notifyPublishProgress(input = {}, event = {}) {
  if (typeof input.onProgress !== "function") return;
  input.onProgress(event);
}

// A recheck has to re-derive the public link from the console instead of trusting
// the stored one: the article list is the only place CSDN exposes the real blog
// slug, while the slug baked into the platformConfig template belongs to a
// different author, so a review URL built from it stays a 404 no matter how the
// platform rules on the article. The public page is attempted even when the
// console still reports a review status, because a stale console is exactly the
// case where the article is already public while the recheck keeps failing.
async function inspectCsdnPublication(page, input = {}, options = {}) {
  const config = csdnApiConfig(input);
  const expectedTitle = cleanText(input.articleTitle || input.title);
  const storedUrl = csdnStoredPublishedUrl(input.publicUrl || input.publishedUrl || input.reviewUrl);
  const stored = csdnPublishedUrlParts(storedUrl);
  const contentMarker = csdnMarkdownContentMarker(input.contentMarkdown) || csdnContentMarker(input.contentHtml || "");
  const fetchPublicPage = typeof options.publicPageFetcher === "function"
    ? options.publicPageFetcher
    : fetchCsdnPublicPageSnapshot;
  const existing = input.imagePublicationEvidence && typeof input.imagePublicationEvidence === "object"
    ? input.imagePublicationEvidence
    : {};
  const expectedTasks = Array.isArray(existing.expected) ? existing.expected : [];

  // Console reads are advisory: one failing endpoint must not abort a recheck the
  // public page alone can still settle.
  let account = null;
  try {
    account = await readCsdnAccountViaApi(page, config);
  } catch {
    account = null;
  }
  let listItem = null;
  try {
    const listResult = await readCsdnArticleListViaApi(page, config);
    const list = Array.isArray(listResult.data?.list) ? listResult.data.list : [];
    // The article id is the stronger key: match it exactly across the whole
    // list first and fall back to the title only when no id matches, so a
    // different article that happens to share the title cannot hijack the
    // recheck.
    listItem = (stored.articleId ? findCsdnArticleInList(listResult.data, stored.articleId) : null)
      || (expectedTitle ? list.find((item) => cleanText(item?.title) === expectedTitle) : null)
      || null;
  } catch {
    listItem = null;
  }

  const articleId = stored.articleId
    || cleanText(listItem?.article_id || listItem?.articleId || listItem?.id);
  // Every slug source is a candidate, never a winner: the share-data URL and
  // the console API path both carry CSDN's template slug (phoenix), which
  // belongs to no author, while the account username is the real blog slug.
  // Only the public page can judge, so probe each distinct candidate instead
  // of stopping at the first non-empty one. The list entry's own username leads
  // because it is the platform's record rather than a derived guess, and the
  // account username backs it up, so a not-found recheck hands the backend the
  // real-slug URL as the corrected review URL.
  const slugCandidates = [];
  for (const candidateSlug of [
    csdnListUsername(listItem),
    cleanText(account?.username),
    csdnSlugFromShareUrl(listItem?.downloadShareDataUrl),
    csdnSlugFromApiUrl(config.articleListApiUrl),
    stored.slug,
  ]) {
    if (candidateSlug && !slugCandidates.includes(candidateSlug)) slugCandidates.push(candidateSlug);
  }
  const slug = slugCandidates[0] || "";
  const candidates = [];
  for (const candidate of [
    ...slugCandidates.map((candidateSlug) => csdnPublishedUrlFromSlug(articleId, candidateSlug)),
    storedUrl,
  ]) {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  }
  const uploadImages = Array.isArray(existing.upload?.images) ? existing.upload.images : [];
  const draftImages = Array.isArray(existing.draft?.images) ? existing.draft.images : [];
  // The public stage is the only one a recheck can still observe, so it reads the
  // images back off the page instead of trusting the stale verdict; upload and
  // draft observations carry over from the order evidence.
  const observedImages = uploadImages.length ? uploadImages : draftImages;
  const steps = [
    { stage: "account", endpoint: config.accountApiUrl, username: cleanText(account?.username) },
    { stage: "article_list", endpoint: config.articleListApiUrl, articleId, slug, status: Number(listItem?.status ?? -1) },
  ];

  let lastPublicError = "";
  for (const candidateUrl of candidates) {
    let snapshot = null;
    try {
      snapshot = await fetchPublicPage(candidateUrl);
      assertCsdnPublicSnapshot(snapshot, expectedTitle, contentMarker, [], candidateUrl);
    } catch (error) {
      lastPublicError = error instanceof Error ? error.message : String(error);
      continue;
    }
    // Approval gate: a readable page is not by itself proof that review finished.
    // When the console did return a verdict for this article and that verdict is
    // still in_review, this address cannot be the approved public link, so the
    // recheck has to stay pending rather than hand the backend a backlink to a
    // page the platform has not let out yet. Only a console that said nothing is
    // allowed to fall back on the public page alone.
    if (csdnConsoleApprovalVerdict(listItem) === "in_review") {
      lastPublicError = "CSDN_PUBLISHED_URL_NOT_APPROVED";
      continue;
    }
    const publicImageUrls = (snapshot.imageUrls || []).map(normalizeCsdnImageUrl).filter(Boolean);
    const publicImages = observedImages.map((image) => ({
      ...image,
      loaded: publicImageUrls.includes(normalizeCsdnImageUrl(image.platformImageUrl)),
    }));
    const imagePublicationEvidence = expectedTasks.length
      ? buildImagePublicationEvidence(expectedTasks, uploadImages, draftImages, publicImages, "")
      : undefined;
    steps.push({ stage: "public_page", endpoint: candidateUrl, articleId, status: CSDN_ARTICLE_STATUS_PUBLIC });
    // The link the visitor gets wears CSDN's traffic query; the fetched and
    // asserted URL above stays clean, because a query string is exactly what
    // normalizeCsdnPublishedUrl rejects.
    const backlinkUrl = csdnPublicBacklinkUrl(candidateUrl);
    return {
      found: true,
      publicUrl: backlinkUrl,
      publishedUrl: backlinkUrl,
      reviewUrl: backlinkUrl,
      pageText: cleanText(`${snapshot.title || ""} ${snapshot.text || ""}`).slice(0, 12000),
      pageTitle: cleanText(snapshot.title || ""),
      verifiedTitle: expectedTitle,
      platformStatus: "published",
      reviewStatus: "public",
      publiclyVisible: true,
      externalIds: { articleId, username: cleanText(account?.username), slug },
      publicationEvidence: { source: "api", transport: "csdn_signed_gateway", accepted: true, steps },
      ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
      message: "CSDN public page is readable and matches this article, so the review URL now points at the real public link.",
    };
  }

  // Returning the corrected candidate as publishedUrl is what lets the backend
  // rewrite the stored review URL, the only way the wrong template slug gets fixed.
  const candidateUrl = candidates[0] || "";
  // The pending link is reported with the traffic query too, so the URL the
  // backend stores is the same shape a visitor would open once the platform
  // approves the article.
  const backlinkUrl = csdnPublicBacklinkUrl(candidateUrl);
  const consoleStatus = cleanText(listItem?.status);
  const statusText = consoleStatus ? `status ${consoleStatus}` : "no article list entry";
  const publicText = lastPublicError || "no public snapshot";
  // The two pending reasons need different wording: a page we could not read is a
  // fetch problem, while a page the platform still holds in review is a gate
  // rejection, and only the second one means the address is not an approved
  // public link yet.
  const awaitingApproval = csdnConsoleApprovalVerdict(listItem) === "in_review";
  const imagePublicationEvidence = expectedTasks.length
    ? buildImagePublicationEvidence(expectedTasks, uploadImages, draftImages, [], PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED)
    : undefined;
  return {
    found: false,
    publicUrl: "",
    publishedUrl: backlinkUrl,
    reviewUrl: backlinkUrl,
    platformStatus: "submitted_for_review",
    reviewStatus: "pending_public_visibility",
    publiclyVisible: false,
    externalIds: { articleId, username: cleanText(account?.username), slug },
    publicationEvidence: { source: "api", transport: "csdn_signed_gateway", accepted: true, steps },
    ...(consoleStatus ? { managementStatus: consoleStatus } : {}),
    ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
    message: awaitingApproval
      ? `CSDN still holds this article in review, so ${publicText} is not an approved public link yet; console reports ${statusText}. Waiting for the platform review to finish.`
      : `CSDN has not published a readable public page yet (${publicText}); console reports ${statusText}. Waiting for the platform review to finish.`,
  };
}

export class CsdnAdapter extends ContentPlatformAdapter {
  constructor(options = {}) {
    super(contentPlatformConfigs.csdn, options);
    this.publicPageFetcher = options.publicPageFetcher || (options.browser ? null : fetchCsdnPublicPageSnapshot);
  }

  async publishArticle(input = {}) {
    const publishInput = normalizePublishInput(input);
    const context = await this.launchAuthEnvironment(input);
    const page = context.pages()[0] || await context.newPage();
    const keepOpen = Boolean(input.keepBrowserOpen);
    try {
      page.setDefaultTimeout?.(15000);
      page.setDefaultNavigationTimeout?.(45000);
      await page.goto(input.editorUrl || CSDN_EDITOR_URL, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);

      const cookies = await context.cookies([CSDN_ORIGIN, "https://passport.csdn.net", "https://www.csdn.net"]);
      const pageState = await readConfiguredPlatformPageState(page);
      if (!isConfiguredPlatformLoggedIn(this.config, cookies, pageState)) throw new Error("CSDN_LOGIN_REQUIRED");

      return await publishCsdnViaApi(page, input, publishInput, {
        publicPageFetcher: this.publicPageFetcher,
      });
    } finally {
      await this.refreshCredentialAfterOperation(input, context, page, CSDN_EDITOR_URL);
      if (!keepOpen) await context.close().catch(() => undefined);
    }
  }

  async discoverPublication(input = {}) {
    const context = await this.launchAuthEnvironment(input);
    const page = context.pages()[0] || await context.newPage();
    const keepOpen = Boolean(input.keepBrowserOpen);
    try {
      page.setDefaultTimeout?.(15000);
      page.setDefaultNavigationTimeout?.(45000);
      await page.goto(input.editorUrl || CSDN_EDITOR_URL, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);

      const cookies = await context.cookies([CSDN_ORIGIN, "https://passport.csdn.net", "https://www.csdn.net"]);
      const pageState = await readConfiguredPlatformPageState(page);
      if (!isConfiguredPlatformLoggedIn(this.config, cookies, pageState)) throw new Error("CSDN_LOGIN_REQUIRED");

      return await inspectCsdnPublication(page, input, {
        publicPageFetcher: this.publicPageFetcher,
      });
    } finally {
      await this.refreshCredentialAfterOperation(input, context, page, CSDN_EDITOR_URL);
      if (!keepOpen) await context.close().catch(() => undefined);
    }
  }
}
