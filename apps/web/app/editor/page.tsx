import { Suspense } from "react";
import EditorInner from "./editor-inner";

export default function EditorPage() {
  return (
    <Suspense fallback={<div className="p-7 text-sm text-muted">正在加载编辑器...</div>}>
      <EditorInner />
    </Suspense>
  );
}
