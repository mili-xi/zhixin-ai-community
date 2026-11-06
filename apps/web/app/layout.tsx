import { CreationTaskProvider } from "@/components/creation-task-provider";
import { DesktopRequirementProvider } from "@/components/desktop-requirement-provider";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "智心AI SEO/GEO 发布系统",
  description: "面向内容生成、渠道发布和公开可见性观察的 Web-first 工作台"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <DesktopRequirementProvider>
          <CreationTaskProvider>{children}</CreationTaskProvider>
        </DesktopRequirementProvider>
      </body>
    </html>
  );
}
