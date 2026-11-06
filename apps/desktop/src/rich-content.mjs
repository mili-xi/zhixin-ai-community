import { isPersistentPlatformImageUrl } from "./platform-images.mjs";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function bindContentBlocksToImages(blocks = [], images = []) {
  const imageByAsset = new Map(images.filter((image) => image?.assetId).map((image) => [String(image.assetId), image]));
  const imageBySection = new Map(images.filter((image) => image?.sectionId).map((image) => [String(image.sectionId), image]));
  return (Array.isArray(blocks) ? blocks : []).map((block) => {
    if (block?.type !== "image") return { ...block };
    const image = imageByAsset.get(String(block.assetId || "")) || imageBySection.get(String(block.sectionId || ""));
    return image ? { ...block, ...image, type: "image" } : { ...block };
  });
}

// Published article HTML may only point at images the platform itself can
// fetch. The device materializes every inline image as a local data URL before
// an adapter runs; that blob belongs to the upload handoff, never to the
// article body. CSDN rejected a 1.4 MB base64 body on 2026-10-11 with
// "正文字数太多，请分成几篇博文发布", so a data URL is now treated as "no
// usable image" and the block degrades to nothing instead.
function publicImageSource(block = {}) {
  for (const candidate of [block.platformImageUrl, block.url]) {
    if (isPersistentPlatformImageUrl(candidate)) return String(candidate).trim();
  }
  return "";
}

export function composeRichArticleHtml(blocks = [], options = {}) {
  const includeImages = options.includeImages !== false;
  const newline = String.fromCharCode(10);
  return (Array.isArray(blocks) ? blocks : []).map((block) => {
    if (block?.type === "title") return "";
    if (block?.type === "section") {
      const paragraphs = String(block.content || "")
        .split(newline + newline)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
        .map((paragraph) => `<p style="margin: 0 0 12px; line-height: 1.8;">${escapeHtml(paragraph).replace(new RegExp(newline, "g"), "<br>")}</p>`)
        .join("");
      return `<section data-zhixin-section="${escapeHtml(block.sectionId || "")}" style="margin: 0 0 24px;"><h2 style="margin: 0 0 12px; line-height: 1.4;">${escapeHtml(block.title || "")}</h2>${paragraphs}</section>`;
    }
    if (block?.type === "image") {
      if (!includeImages) return "";
      const source = publicImageSource(block);
      if (!source) return "";
      const altText = escapeHtml(block.altText || "Article image");
      return `<figure data-zhixin-section="${escapeHtml(block.sectionId || "")}" style="margin: 20px 0; text-align: center;"><img src="${escapeHtml(source)}" alt="${altText}" style="display: block; max-width: 100%; height: auto; margin: 0 auto 8px;"><figcaption style="margin: 0; font-size: 12px; color: #666; text-align: center;">${altText}</figcaption></figure>`;
    }
    return "";
  }).join("");
}

// Compare textual representations only. Never merge them: blocks retain their
// existing rendering precedence and a warning reports a potentially stale copy.
export function inspectArticleContentConsistency(input = {}) {
  const blocks = Array.isArray(input.contentBlocks) ? input.contentBlocks : [];
  const markdown = String(input.contentMarkdown || "").trim();
  if (!blocks.length || !markdown) return null;
  const normalize = (value) => String(value || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#\s+.*$/gm, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[\p{P}\p{S}\s]/gu, "");
  const blockText = normalize(blocks.filter((block) => block?.type === "section")
    .map((block) => [block.title || "", block.content || ""].join("\n")).join("\n"));
  const markdownText = normalize(markdown);
  if (blockText === markdownText) return null;
  return {
    code: "ARTICLE_CONTENT_REPRESENTATION_MISMATCH",
    blockTextLength: blockText.length,
    markdownTextLength: markdownText.length,
    message: "contentBlocks 与 contentMarkdown 正文不一致；保留现有正文来源优先级，请检查缺段或过期内容。",
  };
}
