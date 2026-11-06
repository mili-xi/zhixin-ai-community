// Leaf module on purpose: both the hot-updatable adapters and the MSI-only image
// verification helpers need it, and neither import chain may become circular.

function clean(value) {
  return String(value ?? "").trim();
}

function matchesAny(patterns = [], value = "") {
  const text = String(value || "");
  return patterns.some((pattern) => pattern.test(text));
}

// A public page that lands on one of these surfaces cannot tell us anything about
// the article's images: the platform never served the article at all. Image
// verification must then report "unverifiable" instead of "missing", so a login
// wall, captcha or risk-control screen is never mistaken for a broken upload.
const PUBLIC_PAGE_BLOCKER_URL_PATTERNS = [
  /wappass/i,
  /captcha/i,
  /userAuth/i,
  /ptlogin\d?\.(?:qzone|qq)/i,
  /passport\.baidu\.com/i,
  /sso\.toutiao\.com/i,
  /reg\.163\.com/i,
  /\/sign_in/i
];

const PUBLIC_PAGE_BLOCKER_TEXT_PATTERNS = [
  /\u9a8c\u8bc1\u7801|\u5b89\u5168\u9a8c\u8bc1|\u62d9\u52a8\u6ed1\u5757|\u626b\u7801\u9a8c\u8bc1|\u98ce\u63a7\u9a8c\u8bc1|\u4eba\u5de5\u9a8c\u8bc1|\u7edf\u4e00\u8eab\u4efd\u9a8c\u8bc1/,
  /\u8bf7\u767b\u5f55|\u767b\u5f55\u540e\u67e5\u770b|\u767b\u5f55\u540e\u518d\u8bd5|\u8bf7\u5148\u767b\u5f55/,
  /\blog ?in required\b/i,
  /\bplease (?:log ?in|sign in)\b/i,
  /\bsign in to (?:view|continue|read)\b/i
];

export const PUBLIC_PAGE_BLOCKED = "PUBLIC_PAGE_BLOCKED";

export function readPublicPageBlocker(pageState = {}) {
  const url = clean(pageState.url);
  const head = `${clean(pageState.title)} ${clean(pageState.text)}`;
  if (matchesAny(PUBLIC_PAGE_BLOCKER_URL_PATTERNS, url)) return PUBLIC_PAGE_BLOCKED;
  return matchesAny(PUBLIC_PAGE_BLOCKER_TEXT_PATTERNS, head) ? PUBLIC_PAGE_BLOCKED : "";
}

// Playwright page wrapper: a missing or failed read is itself inconclusive, so the
// caller falls back to the generic blocked signal instead of claiming "missing".
export async function readPublicPageBlockerFromPage(page) {
  if (!page || typeof page.url !== "function") return "";
  try {
    const url = String(page.url() || "");
    const title = typeof page.title === "function" ? String(await page.title().catch(() => "") || "") : "";
    const text = typeof page.evaluate === "function"
      ? String(await page.evaluate(() => document.body?.innerText?.slice(0, 8000) || "").catch(() => "") || "")
      : "";
    return readPublicPageBlocker({ url, title, text });
  } catch {
    return "";
  }
}
