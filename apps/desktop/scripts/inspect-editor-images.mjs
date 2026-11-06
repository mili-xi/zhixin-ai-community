import { getAdapter } from "../src/adapters/index.mjs";

const apiBaseUrl = process.env.ZHIXIN_API_BASE_URL || "http://127.0.0.1:8000";
const profileRoot = process.env.ZHIXIN_PROFILE_ROOT || `${process.env.USERPROFILE}\\.zhixin-ai\\profiles`;
const platform = process.argv[2];
const editorUrls = {
  zhihu: "https://zhuanlan.zhihu.com/write",
  baijiahao: "https://baijiahao.baidu.com/builder/rc/edit?type=news",
  sohu: "https://mp.sohu.com/mpfe/v4/main#/contentManagement/news/addarticle",
  csdn: "https://mp.csdn.net/mp_blog/creation/editor",
  netease: "https://mp.163.com/#/article-publish",
  penguin: "https://om.qq.com/main/creation/article",
  toutiao: "https://mp.toutiao.com/profile_v4/graphic/publish",
  jianshu: "https://www.jianshu.com/writer",
};

if (!editorUrls[platform]) throw new Error(`Unsupported platform: ${platform}`);
const accounts = await fetch(`${apiBaseUrl}/api/media-accounts`).then((response) => response.json());
const account = accounts.find((item) => item.platform === platform);
if (!account) throw new Error(`No account for ${platform}`);
const adapter = getAdapter(platform);
const context = await adapter.launchAuthEnvironment({
  profileRoot,
  profileKey: account.profileKey || account.id,
  mediaAccountId: account.id,
  headless: true,
});
const page = context.pages()[0] || await context.newPage();
try {
  await page.goto(editorUrls[platform], { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
  await page.waitForTimeout(3000);
  const revealSelectors = {
    zhihu: "button[aria-label='图片']",
    baijiahao: ".edui-for-insertimage",
    csdn: "a.cke_button__image",
    penguin: ".exeditor-menu-basic-file",
    toutiao: ".syl-toolbar-tool.image button",
    jianshu: "a[data-action='openImageModal']",
  };
  if (revealSelectors[platform]) {
    await page.locator(revealSelectors[platform]).first().click().catch(() => undefined);
    await page.waitForTimeout(1500);
  }
  const inspect = () => page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 180);
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    return {
      url: location.href,
      title: document.title,
      fileInputs: [...document.querySelectorAll("input[type=file]")].map((input) => ({
        accept: input.accept,
        name: input.name,
        className: clean(input.className),
        visible: visible(input),
        outerHTML: clean(input.outerHTML),
      })),
      imageActions: [...document.querySelectorAll("button,[role=button],label,a")]
        .map((element) => ({ text: clean(element.innerText || element.getAttribute("aria-label") || element.title), outerHTML: clean(element.outerHTML) }))
        .filter((item) => /图片|插图|上传|image|photo|封面/i.test(`${item.text} ${item.outerHTML}`))
        .slice(0, 30),
      imageElements: [...document.querySelectorAll("[class*='image' i],[class*='picture' i],[data-action*='image' i],[aria-label*='图片'],[title*='图像']")]
        .map((element) => ({ tag: element.tagName, text: clean(element.innerText), outerHTML: clean(element.outerHTML) }))
        .slice(0, 50),
      editorControls: [...document.querySelectorAll("button,[role=button],a")]
        .map((element) => ({
          text: clean(element.innerText),
          title: clean(element.title || element.getAttribute("aria-label") || element.getAttribute("data-tooltip")),
          className: clean(element.className),
          outerHTML: clean(element.outerHTML),
        }))
        .filter((item) => /toolbar|editor|image|picture|photo|upload|menu|insert|图|素材/i.test(`${item.title} ${item.className} ${item.outerHTML}`))
        .slice(0, 80),
      editorClassNames: [...new Set([...document.querySelectorAll("[class]")]
        .flatMap((element) => [...element.classList])
        .filter((className) => /editor|toolbar|menu|image|picture|upload/i.test(className)))].slice(0, 150),
      editors: [...document.querySelectorAll("[contenteditable=true],iframe")].map((element) => ({
        tag: element.tagName,
        role: element.getAttribute("role"),
        className: clean(element.className),
        id: element.id,
        placeholder: element.getAttribute("data-placeholder") || element.getAttribute("placeholder") || "",
        src: element.getAttribute("src") || "",
      })).slice(0, 30),
    };
  });
  const result = await inspect().catch(async () => {
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => undefined);
    await page.waitForTimeout(3000);
    return inspect();
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await context.close().catch(() => undefined);
}
