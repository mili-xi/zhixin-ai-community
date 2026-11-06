from app.illustrated_content import (
    assemble_markdown,
    build_content_blocks,
    calculate_inline_image_target,
    compose_rich_article_html,
    evaluate_article_quality,
    normalize_article_output,
    plan_required_images,
)


def article_output():
    return {
        "title": "AI SEO 实践指南",
        "summary": "一份清晰的实践指南。",
        "metaDescription": "介绍 AI SEO 的实施步骤和注意事项。",
        "keywords": ["AI SEO"],
        "tags": ["SEO"],
        "sections": [
            {"id": "overview", "title": "为什么需要 AI SEO", "content": "这是第一节内容。" * 30},
            {"id": "workflow", "title": "实施流程", "content": "这是第二节内容。" * 30},
        ],
        "imageBriefs": [
            {"purpose": "cover", "prompt": "AI SEO 封面", "altText": "AI SEO 实践指南封面", "aspectRatio": "16:9"},
            {"purpose": "inline", "sectionId": "workflow", "prompt": "AI SEO 工作流程图", "altText": "AI SEO 工作流程", "aspectRatio": "16:9"},
        ],
    }


def test_normalize_article_output_keeps_stable_sections_and_limits_inline_briefs():
    output = article_output()
    output["imageBriefs"].extend(
        {"purpose": "inline", "sectionId": f"extra-{index}", "prompt": f"插图 {index}", "altText": f"插图 {index}"}
        for index in range(5)
    )

    normalized = normalize_article_output(output, max_inline_images=3)

    assert [section["id"] for section in normalized["sections"]] == ["overview", "workflow"]
    assert len([brief for brief in normalized["imageBriefs"] if brief["purpose"] == "inline"]) == 3
    assert normalized["contentMarkdown"].startswith("# AI SEO 实践指南")


def test_normalize_article_output_uses_alt_text_when_image_prompt_is_missing():
    output = article_output()
    output["imageBriefs"][0]["prompt"] = ""
    output["imageBriefs"][0]["altText"] = "面向 AI SEO 实践指南的专业无文字封面"

    normalized = normalize_article_output(output)

    assert normalized["imageBriefs"][0]["prompt"] == "面向 AI SEO 实践指南的专业无文字封面"


def test_plan_required_images_reuses_selected_assets_before_generating():
    article = normalize_article_output(article_output())
    selected_assets = [
        {"id": "asset-cover", "type": "cover", "url": "/uploads/cover.png", "altText": "已有封面"},
    ]

    plan = plan_required_images(article, selected_assets, image_strategy="cover-and-inline", max_inline_images=2)

    assert plan[0]["action"] == "reuse"
    assert plan[0]["assetId"] == "asset-cover"
    assert any(item["action"] == "generate" and item["purpose"] == "inline" for item in plan)


def test_assemble_markdown_inserts_image_at_bound_section():
    article = normalize_article_output(article_output())
    images = [{
        "purpose": "inline",
        "sectionId": "workflow",
        "url": "/uploads/workflow.png",
        "altText": "AI SEO 工作流程",
    }]

    markdown = assemble_markdown(article, images)

    workflow_heading = markdown.index("## 实施流程")
    image_position = markdown.index("![AI SEO 工作流程](/uploads/workflow.png)")
    assert image_position > workflow_heading


def test_quality_requires_cover_when_strategy_requests_it():
    article = normalize_article_output(article_output())
    ready = evaluate_article_quality(article, [{"purpose": "cover", "altText": "封面", "url": "/cover.png"}], "cover")
    missing = evaluate_article_quality(article, [], "cover")

    assert ready["status"] == "ready"
    assert missing["status"] == "review_required"
    assert "MISSING_COVER" in missing["issues"]


def test_quality_rejects_image_bound_to_unknown_section():
    article = normalize_article_output(article_output())
    quality = evaluate_article_quality(article, [{
        "purpose": "inline",
        "sectionId": "missing-section",
        "url": "/missing.png",
        "altText": "无法装配的图片",
    }], "inline")

    assert quality["status"] == "review_required"
    assert "INVALID_IMAGE_SECTION" in quality["issues"]


def long_article_output():
    output = article_output()
    output["sections"] = [
        {"id": f"section-{index}", "title": f"重点章节 {index}", "content": (f"第 {index} 节的详细内容。" * 55)}
        for index in range(1, 5)
    ]
    output["imageBriefs"] = [
        {"purpose": "cover", "prompt": "文章封面", "altText": "文章封面"},
        {"purpose": "inline", "sectionId": "section-2", "prompt": "第二节配图", "altText": "第二节配图", "priority": 1},
        {"purpose": "inline", "sectionId": "section-2", "prompt": "重复配图", "altText": "重复配图", "priority": 2},
        {"purpose": "inline", "sectionId": "missing", "prompt": "无效配图", "altText": "无效配图", "priority": 3},
    ]
    return output


def test_dynamic_inline_target_is_one_image_per_body_section():
    article = normalize_article_output(long_article_output(), max_inline_images=5)

    # Layout rule: one section body → one inline image (capped by max).
    assert calculate_inline_image_target(article, max_inline_images=5) == 4
    assert calculate_inline_image_target(article, max_inline_images=2) == 2


def test_planner_replaces_duplicate_and_invalid_briefs_with_distinct_sections():
    article = normalize_article_output(long_article_output(), max_inline_images=5)

    plan = plan_required_images(article, [], image_strategy="cover-and-inline", max_inline_images=5)
    inline = [item for item in plan if item["purpose"] != "cover"]

    assert len(inline) == 4
    assert len({item["sectionId"] for item in inline}) == 4
    assert all(item["sectionId"] in {"section-1", "section-2", "section-3", "section-4"} for item in inline)


def test_normalize_keeps_markdown_body_when_sections_are_empty_shells():
    output = {
        "title": "高中学习方法",
        "summary": "科学学习策略。",
        "metaDescription": "掌握科学学习策略。",
        "keywords": ["学习方法"],
        "tags": ["教育"],
        "sections": [
            {"id": "s1", "title": "第 1 节", "content": ""},
            {"id": "s2", "title": "第 2 节", "content": ""},
        ],
        "contentMarkdown": "\n\n".join([
            "# 高中学习方法",
            "## 为什么方法比勤奋更重要",
            "很多同学把时间堆在刷题上，却忽略复盘和间隔复习。真正拉开差距的是能否用对方法。" * 3,
            "## 费曼学习法怎么落地",
            "用自己的话讲给别人听，讲不出来的地方就是知识漏洞，再回去补教材和例题。" * 3,
        ]),
        "imageBriefs": [],
    }

    normalized = normalize_article_output(output, max_inline_images=5)

    assert all(len(section["content"]) >= 40 for section in normalized["sections"])
    assert "费曼学习法" in normalized["contentMarkdown"]
    assert "本节暂无" not in normalized["contentMarkdown"]
    inline_briefs = [brief for brief in normalized["imageBriefs"] if brief["purpose"] == "inline"]
    assert len(inline_briefs) >= 2


def test_normalize_accepts_body_alias_fields():
    output = {
        "title": "别名字段测试",
        "sections": [
            {"id": "a", "title": "开篇", "body": "这是用 body 字段写的完整段落。" * 8},
            {"id": "b", "title": "方法", "paragraphs": ["第一段说明方法。", "第二段给出步骤。" * 10]},
        ],
        "contentMarkdown": "",
    }

    normalized = normalize_article_output(output, max_inline_images=3)

    assert len(normalized["sections"][0]["content"]) >= 40
    assert "方法" in normalized["sections"][1]["title"]
    assert len(normalized["sections"][1]["content"]) >= 20


def test_content_blocks_place_image_after_matching_section():
    article = normalize_article_output(article_output())
    images = [{
        "purpose": "inline",
        "sectionId": "workflow",
        "url": "/uploads/workflow.png",
        "path": "C:/uploads/workflow.png",
        "altText": "AI SEO 工作流程",
    }]

    blocks = build_content_blocks(article, images)
    workflow_index = next(index for index, block in enumerate(blocks) if block["type"] == "section" and block["sectionId"] == "workflow")

    assert blocks[workflow_index + 1]["type"] == "image"
    assert blocks[workflow_index + 1]["sectionId"] == "workflow"






def test_compose_rich_article_html_uses_clean_block_spacing():
    html = compose_rich_article_html([
        {"type": "title", "text": "Article Title"},
        {"type": "section", "sectionId": "workflow", "title": "Workflow", "content": "First paragraph.\n\nSecond paragraph."},
        {"type": "image", "sectionId": "workflow", "url": "/uploads/workflow.png", "altText": "Workflow image"},
    ])

    assert 'style="margin: 0 0 24px;"' in html
    assert 'style="margin: 0 0 12px; line-height: 1.8;"' in html
    assert 'style="margin: 20px 0; text-align: center;"' in html
    assert 'style="display: block; max-width: 100%; height: auto; margin: 0 auto 8px;"' in html
    assert 'style="margin: 0; font-size: 12px; color: #666; text-align: center;"' in html


def test_build_content_blocks_prefers_explicit_sections_and_keeps_inline_images():
    article = {
        "title": "Structured Publishing Article",
        "contentMarkdown": "This markdown body should be ignored when sections exist.",
        "sections": [
            {"id": "intro", "title": "Introduction", "content": "First section body."},
            {"id": "result", "title": "Result", "content": "Second section body."},
        ],
    }
    images = [
        {
            "purpose": "inline",
            "sectionId": "intro",
            "url": "/uploads/intro.png",
            "path": "C:/uploads/intro.png",
            "altText": "Intro image",
        },
        {
            "purpose": "inline",
            "sectionId": "result",
            "url": "/uploads/result.png",
            "path": "C:/uploads/result.png",
            "altText": "Result image",
        },
    ]

    blocks = build_content_blocks(article, images)

    assert [block["type"] for block in blocks] == ["title", "section", "image", "section", "image"]
    assert [block.get("sectionId") for block in blocks if block["type"] != "title"] == ["intro", "intro", "result", "result"]
    assert blocks[2]["url"] == "/uploads/intro.png"
    assert blocks[4]["url"] == "/uploads/result.png"

def test_markdown_only_article_builds_structured_publish_blocks():
    article = {
        "title": "Structured Markdown Article",
        "contentMarkdown": (
            "# Structured Markdown Article\n\n"
            "## Opening\n\n"
            "The first paragraph explains the publishing workflow.\n\n"
            "![Workflow image](/uploads/workflow.png)\n\n"
            "## Result\n\n"
            "The second paragraph confirms the platform receives rich content."
        ),
    }

    normalized = normalize_article_output(article)
    blocks = build_content_blocks(normalized, [])
    html = compose_rich_article_html(blocks, include_images=True)

    assert [block["type"] for block in blocks] == ["title", "section", "image", "section"]
    assert [section["title"] for section in normalized["sections"]] == ["Opening", "Result"]
    assert '<h2 style="margin: 0 0 12px; line-height: 1.4;">Opening</h2>' in html
    assert '<img src="/uploads/workflow.png"' in html
    assert "## Opening" not in html
    assert "![Workflow image]" not in html


def test_quality_requires_inline_images_when_strategy_requests_them():
    article = normalize_article_output(article_output())
    quality = evaluate_article_quality(
        article,
        [{"purpose": "cover", "altText": "封面", "url": "/cover.png"}],
        "cover-and-inline",
    )

    assert quality["status"] == "review_required"
    assert "MISSING_INLINE_IMAGES" in quality["issues"]


def test_build_content_blocks_drops_image_blocks_without_any_source():
    article = {
        "title": "Orphan image blocks",
        "contentMarkdown": "",
        "contentBlocks": [
            {"type": "section", "sectionId": "intro", "title": "Introduction", "content": "Section body." * 30},
            {"type": "image", "sectionId": "intro", "assetId": "asset-orphan", "altText": "Orphan"},
        ],
    }

    blocks = build_content_blocks(article, [])

    assert [block["type"] for block in blocks] == ["title", "section"]
