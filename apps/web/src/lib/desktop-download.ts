export const desktopDownloadUrl =
  process.env.NEXT_PUBLIC_DESKTOP_DOWNLOAD_URL || "/downloads/zhixin-ai-windows.exe";

export type DesktopRequirement =
  | "媒体账号授权"
  | "登录态检测"
  | "文章发布"
  | "自动发布"
  | "发布复验";
