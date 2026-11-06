from __future__ import annotations

import json
from typing import Any

import httpx

from .config import get_settings


def build_article_prompt(context: dict[str, Any]) -> list[dict[str, str]]:
    compact_context = json.dumps(context, ensure_ascii=False, indent=2, default=str)
    system = (
        "你是一名专业的中文 SEO/GEO 内容编辑。请使用提供的创作上下文、生成规则、知识库依据和素材，"
        "输出可直接排版发布的完整文章。严格返回 JSON，字段：title、summary、metaDescription、"
        "contentMarkdown、keywords、tags、sections、imageBriefs。\n"
        "【正文硬性规则，违反即失败】\n"
        "1. 禁止只输出大纲/标题骨架。每个 sections[i].content 必须是完整中文正文，至少 180 字；"
        "全文有效正文字符合计不少于 800。\n"
        "2. sections 4～7 节；title 用有信息量的小标题，禁止「第1节」「第2节」这种空壳标题。\n"
        "3. contentMarkdown 必须与 sections 一致，含完整段落正文，不能只有 #/## 标题。\n"
        "4. sections[i] 字段固定为 id、title、content（正文写在 content，不要用 body/text 别名）。\n"
        "【图文排版硬性规则：一段正文配一张图】\n"
        "5. imageBriefs：1 张 purpose=cover 封面 + 每个正文 section 各 1 张 purpose=inline 插图。\n"
        "6. 每张 inline 的 sectionId 必须等于对应 sections[].id；封面 sectionId 为空。\n"
        "7. 预览顺序固定为：封面 → 标题 →（章节正文 → 该章插图）循环。图片 prompt 描述章节语义，不要出文字。\n"
        "不要编造上下文中不存在的数字、案例或来源。"
    )
    user = (
        "请根据以下结构化上下文创作文章。记住：每一节都要写满可直接发布的正文段落，"
        "不要只给标题；排版按「一节正文 + 一张配图」输出。\n"
        f"{compact_context}"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def build_article_repair_prompt(context: dict[str, Any], skeleton: dict[str, Any]) -> list[dict[str, str]]:
    """Second-pass prompt when the model returned title-only empty sections."""
    compact_context = json.dumps(context, ensure_ascii=False, indent=2, default=str)
    compact_skeleton = json.dumps(
        {
            "title": skeleton.get("title"),
            "summary": skeleton.get("summary"),
            "sections": [
                {"id": item.get("id"), "title": item.get("title"), "content": item.get("content")}
                for item in (skeleton.get("sections") or [])
                if isinstance(item, dict)
            ],
            "contentMarkdown": str(skeleton.get("contentMarkdown") or "")[:1200],
        },
        ensure_ascii=False,
        indent=2,
        default=str,
    )
    system = (
        "你是中文内容编辑。上一稿只有标题没有正文，必须重写。严格返回 JSON："
        "title、summary、metaDescription、contentMarkdown、keywords、tags、sections、imageBriefs。\n"
        "每个 sections[i].content 至少 180 字完整正文；禁止空 content 和「第N节」空壳标题。"
        "图文规则：封面1张 + 每节1张 inline 插图，sectionId 对齐 sections[].id。"
    )
    user = (
        f"创作上下文：\n{compact_context}\n\n上一稿骨架（必须补全正文，不要只改标题）：\n{compact_skeleton}"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def offline_article(context: dict[str, Any]) -> dict[str, Any]:
    keyword = str(context.get("keyword") or context.get("primaryKeyword") or "AI SEO").strip()
    rule = context.get("rule") if isinstance(context.get("rule"), dict) else {}
    knowledge_items = context.get("knowledgeItems") or []
    assets = context.get("assets") or []
    knowledge_text = "\n".join(
        str(item.get("content") or item.get("text") or item.get("title") or "")
        for item in knowledge_items
        if isinstance(item, dict)
    )
    asset_text = "、".join(
        str(item.get("altText") or item.get("filename") or item.get("name") or "")
        for item in assets
        if isinstance(item, dict)
    )
    title = f"{keyword} 的 SEO 与 GEO 增长方案"
    sections = [
        {
            "id": "creation-goal",
            "title": "创作目标",
            "content": f"围绕 {keyword} 形成结构清晰、事实可核验的内容，服务品牌表达、读者理解和后续自动发布。",
        },
        {
            "id": "generation-rule",
            "title": "生成规则",
            "content": str(rule.get("content") or rule.get("name") or "按照结构化 SEO 长文规则组织标题、段落、问答和结论。"),
        },
        {
            "id": "knowledge-evidence",
            "title": "知识依据",
            "content": knowledge_text or "当前没有选定知识资料，正式发布前应补充可核验的产品信息、案例或来源。",
        },
        {
            "id": "publishing-flow",
            "title": "发布与搜索观察",
            "content": "文章完成后进入编辑器审阅，再发布到已授权媒体。发布成功、公开可访问和搜索结果观察是三个独立状态。",
        },
    ]
    content = "\n\n".join([f"# {title}", *[f"## {item['title']}\n\n{item['content']}" for item in sections]])
    return {
        "title": title,
        "summary": f"围绕 {keyword} 的 AI 创作、图文装配与发布方案。",
        "metaDescription": f"面向 {keyword} 的 SEO/GEO 内容方案，结合生成规则、知识库、素材库和自动发布链路。",
        "contentMarkdown": content,
        "keywords": [keyword],
        "tags": ["AI创作", "SEO", "GEO"],
        "sections": sections,
        "imageBriefs": [
            {
                "purpose": "cover",
                "sectionId": "",
                "prompt": f"为主题“{keyword}”制作专业、现代、信息清晰的文章封面，不要添加文字",
                "altText": f"{keyword} 文章封面",
                "aspectRatio": "16:9",
                "priority": 1,
            },
            {
                "purpose": "infographic",
                "sectionId": "publishing-flow",
                "prompt": f"制作一张展示 {keyword} 从内容创作、审阅、媒体发布到搜索观察的清晰流程信息图",
                "altText": f"{keyword} 内容发布与搜索观察流程",
                "aspectRatio": "4:3",
                "priority": 2,
            },
        ],
        "assetSuggestions": asset_text,
    }


def build_deepseek_request_payload(context: dict[str, Any], model: str | None = None) -> dict[str, Any]:
    settings = get_settings()
    return {
        "model": model or settings.deepseek_model,
        "messages": build_article_prompt(context),
        "temperature": 0.7,
        "response_format": {"type": "json_object"},
    }


def generate_article_with_deepseek(context: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings()
    if settings.deepseek_offline_mode or not settings.deepseek_api_key:
        return offline_article(context)

    request_payload = build_deepseek_request_payload(context)
    response = httpx.post(
        f"{settings.deepseek_base_url.rstrip('/')}/chat/completions",
        headers={
            "Authorization": f"Bearer {settings.deepseek_api_key}",
            "Content-Type": "application/json",
        },
        json=request_payload,
        timeout=120,
    )
    response.raise_for_status()
    payload = response.json()
    content = payload["choices"][0]["message"]["content"]
    parsed = json.loads(content)
    return parsed if isinstance(parsed, dict) else offline_article(context)


def repair_article_with_deepseek(context: dict[str, Any], skeleton: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings()
    if settings.deepseek_offline_mode or not settings.deepseek_api_key:
        return offline_article(context)
    response = httpx.post(
        f"{settings.deepseek_base_url.rstrip('/')}/chat/completions",
        headers={
            "Authorization": f"Bearer {settings.deepseek_api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": settings.deepseek_model,
            "messages": build_article_repair_prompt(context, skeleton),
            "temperature": 0.55,
            "response_format": {"type": "json_object"},
        },
        timeout=120,
    )
    response.raise_for_status()
    payload = response.json()
    content = payload["choices"][0]["message"]["content"]
    parsed = json.loads(content)
    return parsed if isinstance(parsed, dict) else offline_article(context)


def complete_json_with_deepseek(
    *,
    system: str,
    user: str,
    temperature: float = 0.4,
    timeout: float = 60,
) -> dict[str, Any]:
    """Generic DeepSeek JSON completion using project API key."""
    settings = get_settings()
    if settings.deepseek_offline_mode or not settings.deepseek_api_key:
        raise ValueError("DEEPSEEK_NOT_CONFIGURED")
    response = httpx.post(
        f"{settings.deepseek_base_url.rstrip('/')}/chat/completions",
        headers={
            "Authorization": f"Bearer {settings.deepseek_api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": settings.deepseek_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
            "response_format": {"type": "json_object"},
        },
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    content = payload["choices"][0]["message"]["content"]
    parsed = json.loads(content)
    if not isinstance(parsed, dict):
        raise ValueError("DEEPSEEK_INVALID_JSON")
    return parsed


def offline_generation_rule_draft(payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("name") or "新规则").strip() or "新规则"
    rule_type = str(payload.get("type") or "article")
    scene = str(payload.get("scene") or payload.get("hint") or name).strip()
    is_image = rule_type == "image-text"
    return {
        "name": name,
        "type": rule_type,
        "content": f"{scene}：结构清晰、结论先行、避免空泛营销词",
        "contentRequirements": f"围绕「{scene}」覆盖定义、方法、案例和 FAQ；每个 H2 给一句可引用结论。",
        "humanizationRules": "语气像懂业务的运营顾问，少用夸张词和感叹号。",
        "replacementRules": "将“颠覆式、赋能、下一代”等替换为可验证描述。",
        "formatRules": "摘要 + H2/H3 + FAQ + Meta 描述" if not is_image else "封面、摘要、短段落正文",
        "structureRules": "问题 → 方法 → 案例 → 清单 → FAQ" if not is_image else "背景 → 痛点 → 方案 → 行动建议",
        "internalLinkRules": "可链到相关产品页、发布记录或帮助文档。",
        "externalLinkRules": "外链仅用于权威资料；媒体稿按渠道要求处理。",
        "fixedIntro": f"开篇一句话说明本文解决什么关于「{scene}」的问题。",
        "fixedOutro": "结尾给出可执行下一步和下一次复盘点。",
        "forcedTitleKeywords": [scene[:12]] if scene else [],
        "imageStrategy": "cover-and-inline",
        "geoStrategy": {
            "includeFaq": True,
            "includeCitationSummary": True,
            "trackBrandMention": True,
            "trackCompetitorMention": False,
        },
        "sourceMode": "manual-keywords",
        "modelProvider": "DeepSeek",
        "status": "active",
    }


def draft_generation_rule_with_deepseek(payload: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings()
    if settings.deepseek_offline_mode or not settings.deepseek_api_key:
        return offline_generation_rule_draft(payload)
    name = str(payload.get("name") or "").strip()
    rule_type = str(payload.get("type") or "article")
    scene = str(payload.get("scene") or payload.get("hint") or name or "SEO 内容创作").strip()
    system = (
        "你是 SEO/GEO 内容策略专家。根据用户给出的规则名称和场景，生成可直接写入生成规则表单的中文 JSON。"
        "字段必须包含：name, type, content, contentRequirements, humanizationRules, replacementRules, "
        "formatRules, structureRules, internalLinkRules, externalLinkRules, fixedIntro, fixedOutro, "
        "forcedTitleKeywords(数组), imageStrategy(none|cover|inline|cover-and-inline|thumbnail), "
        "geoStrategy(对象: includeFaq, includeCitationSummary, trackBrandMention, trackCompetitorMention 布尔), "
        "sourceMode(keyword-library|manual-keywords|serp|template), modelProvider(DeepSeek), status(active)。"
        "type 只能是 article 或 image-text。不要编造产品数据，只给写作约束。"
    )
    user = json.dumps(
        {
            "name": name or scene,
            "type": rule_type,
            "scene": scene,
            "extraHint": payload.get("hint") or "",
        },
        ensure_ascii=False,
    )
    try:
        draft = complete_json_with_deepseek(system=system, user=user)
    except Exception:
        return offline_generation_rule_draft(payload)
    base = offline_generation_rule_draft(payload)
    merged = {**base, **{k: v for k, v in draft.items() if v is not None and v != ""}}
    merged["type"] = rule_type if rule_type in {"article", "image-text"} else "article"
    merged["name"] = str(merged.get("name") or name or scene)
    if not isinstance(merged.get("forcedTitleKeywords"), list):
        merged["forcedTitleKeywords"] = [str(merged.get("forcedTitleKeywords") or scene)[:20]]
    if not isinstance(merged.get("geoStrategy"), dict):
        merged["geoStrategy"] = base["geoStrategy"]
    return merged


def offline_article_type_draft(payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("name") or "新文章类型").strip() or "新文章类型"
    category = str(payload.get("category") or "自定义").strip() or "自定义"
    return {
        "name": name,
        "category": category,
        "sourceType": "custom",
        "visible": True,
        "prompt": f"围绕「{name}」输出结构清晰、可执行、适合搜索阅读的中文文章。",
        "matchingRules": f"适合与「{name}」相关的怎么做、对比、清单、FAQ 类意图。",
        "readingRules": "优先读取用户主题、SERP 竞品标题和知识库事实。",
        "outlineRules": "背景 → 核心方法 → 步骤/清单 → 案例 → FAQ → 下一步",
        "titleRules": "标题包含主关键词和明确收益，避免空泛营销词。",
        "descriptionRules": "摘要说明适用对象、核心收益和结果。",
        "writingRules": "结论先行；每段有动作或判断标准；少堆形容词。",
        "rewriteRules": "保留关键实体和数字，压缩重复铺垫。",
        "notes": "由 DeepSeek 辅助生成，可再人工微调。",
    }


def draft_article_type_with_deepseek(payload: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings()
    if settings.deepseek_offline_mode or not settings.deepseek_api_key:
        return offline_article_type_draft(payload)
    name = str(payload.get("name") or "").strip() or "新文章类型"
    category = str(payload.get("category") or "自定义").strip()
    system = (
        "你是中文 SEO 写作模板专家。根据文章类型名称生成可直接写入文章类型库的 JSON。"
        "字段：name, category, prompt, matchingRules, readingRules, outlineRules, titleRules, "
        "descriptionRules, writingRules, rewriteRules, notes。全部用中文短句，具体可执行。"
    )
    user = json.dumps({"name": name, "category": category, "hint": payload.get("hint") or ""}, ensure_ascii=False)
    try:
        draft = complete_json_with_deepseek(system=system, user=user)
    except Exception:
        return offline_article_type_draft(payload)
    base = offline_article_type_draft(payload)
    merged = {**base, **{k: v for k, v in draft.items() if v is not None and v != ""}}
    merged["name"] = str(merged.get("name") or name)
    merged["category"] = str(merged.get("category") or category)
    merged["sourceType"] = "custom"
    merged["visible"] = True
    return merged
