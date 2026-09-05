#!/usr/bin/env python3
"""Validate the shared screen manifest used by Figma and UI/dev handoff artifacts."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ASCII_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
CHINESE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
SOURCE_STATUSES = {"implemented", "designed", "planned", "deprecated"}


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: validate_handoff_manifest.py <screen-manifest.json>", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        print(f"FAIL: 无法读取 manifest: {exc}", file=sys.stderr)
        return 2

    errors: list[str] = []
    warnings: list[str] = []
    require(isinstance(payload, dict), "manifest 顶层必须是对象", errors)
    if errors:
        print(json.dumps({"status": "FAIL", "errors": errors}, ensure_ascii=False, indent=2))
        return 1

    for key in ("schema_version", "project", "version", "viewport", "figma_pages", "screens", "components"):
        require(key in payload, f"缺少顶层字段: {key}", errors)

    viewport = payload.get("viewport", {})
    require(isinstance(viewport, dict), "viewport 必须是对象", errors)
    if isinstance(viewport, dict):
        require(isinstance(viewport.get("width"), int) and viewport.get("width", 0) > 0, "viewport.width 无效", errors)
        require(isinstance(viewport.get("height"), int) and viewport.get("height", 0) > 0, "viewport.height 无效", errors)

    pages = payload.get("figma_pages", [])
    screens = payload.get("screens", [])
    components = payload.get("components", [])
    require(isinstance(pages, list), "figma_pages 必须是数组", errors)
    require(isinstance(screens, list) and len(screens) > 0, "screens 必须是非空数组", errors)
    require(isinstance(components, list), "components 必须是数组", errors)
    if not all(isinstance(value, list) for value in (pages, screens, components)):
        print(json.dumps({"status": "FAIL", "errors": errors}, ensure_ascii=False, indent=2))
        return 1

    require(len(pages) <= 3, f"Figma Page 分组超过 3 个: {len(pages)}", errors)
    page_ids: set[str] = set()
    assigned: list[str] = []
    for page in pages:
        page_id = str(page.get("id", ""))
        name_zh = str(page.get("name_zh", ""))
        require(bool(ASCII_ID.fullmatch(page_id)), f"Figma Page ID 无效: {page_id!r}", errors)
        require(page_id not in page_ids, f"重复 Figma Page ID: {page_id}", errors)
        require(bool(CHINESE.search(name_zh)), f"Figma Page 缺少中文名: {page_id}", errors)
        page_ids.add(page_id)
        page_screens = page.get("screen_ids", [])
        require(isinstance(page_screens, list), f"Figma Page screen_ids 必须是数组: {page_id}", errors)
        if isinstance(page_screens, list):
            assigned.extend(str(item) for item in page_screens)

    screen_ids: set[str] = set()
    referenced_components: set[str] = set()
    for screen in screens:
        screen_id = str(screen.get("id", ""))
        name_zh = str(screen.get("name_zh", ""))
        require(bool(ASCII_ID.fullmatch(screen_id)), f"Screen ID 无效: {screen_id!r}", errors)
        require(screen_id not in screen_ids, f"重复 Screen ID: {screen_id}", errors)
        require(bool(CHINESE.search(name_zh)), f"Screen 缺少中文 Frame 名: {screen_id}", errors)
        require("｜" in name_zh, f"Screen 中文名应使用“模块｜状态”: {name_zh!r}", errors)
        require(screen.get("figma_page_id") in page_ids, f"Screen 未映射到有效 Figma Page: {screen_id}", errors)
        require(screen.get("source_status") in SOURCE_STATUSES, f"Screen source_status 无效: {screen_id}", errors)
        require(bool(screen.get("acceptance_criteria")), f"Screen 缺少验收条件: {screen_id}", errors)
        screen_ids.add(screen_id)
        for component_id in screen.get("component_ids", []):
            referenced_components.add(str(component_id))

    require(len(assigned) == len(set(assigned)), "Figma Page 分组中存在重复 Screen", errors)
    require(set(assigned) == screen_ids, "Figma Page 分组必须且只能覆盖全部 Screen", errors)

    component_ids: set[str] = set()
    for component in components:
        component_id = str(component.get("id", ""))
        name_zh = str(component.get("name_zh", ""))
        require(bool(ASCII_ID.fullmatch(component_id)), f"Component ID 无效: {component_id!r}", errors)
        require(component_id not in component_ids, f"重复 Component ID: {component_id}", errors)
        require(bool(CHINESE.search(name_zh)), f"Component 缺少中文名: {component_id}", errors)
        require(bool(component.get("code_name")), f"Component 缺少代码侧名称: {component_id}", errors)
        component_ids.add(component_id)

    missing_components = sorted(referenced_components - component_ids)
    require(not missing_components, f"Screen 引用了未定义组件: {', '.join(missing_components)}", errors)
    unused_components = sorted(component_ids - referenced_components)
    if unused_components:
        warnings.append(f"未被 Screen 引用的组件: {', '.join(unused_components)}")

    print(
        json.dumps(
            {
                "status": "FAIL" if errors else "PASS",
                "figma_pages": len(pages),
                "screens": len(screens),
                "components": len(components),
                "errors": errors,
                "warnings": warnings,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
