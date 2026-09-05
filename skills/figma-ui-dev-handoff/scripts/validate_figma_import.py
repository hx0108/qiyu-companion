#!/usr/bin/env python3
"""Validate structural invariants of a static HTML prepared for Figma import."""

from __future__ import annotations

import argparse
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse


ASCII_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
CHINESE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")


def class_names(attrs: dict[str, str]) -> set[str]:
    return set((attrs.get("class") or "").split())


class ImportHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.frames: list[dict[str, str]] = []
        self.components: list[dict[str, str]] = []
        self.script_count = 0
        self.external_resources: list[str] = []
        self.inline_handlers: list[str] = []

    def handle_starttag(self, tag: str, attrs_raw: list[tuple[str, str | None]]) -> None:
        attrs = {key: value or "" for key, value in attrs_raw}
        classes = class_names(attrs)
        if tag.lower() == "script":
            self.script_count += 1
        if "figma-frame" in classes:
            self.frames.append(attrs)
        if "figma-component" in classes or "data-component-name-zh" in attrs:
            self.components.append(attrs)

        for key, value in attrs.items():
            if key.lower().startswith("on"):
                self.inline_handlers.append(f"<{tag} {key}>")
            if key.lower() not in {"src", "href", "poster", "xlink:href"}:
                continue
            parsed = urlparse(value)
            if parsed.scheme in {"http", "https"} or value.startswith("//"):
                self.external_resources.append(value)


def load_manifest(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if isinstance(payload, list):
        return payload
    screens = payload.get("screens")
    if not isinstance(screens, list):
        raise ValueError("manifest 必须是 screen 数组，或包含 screens 数组的对象")
    return screens


def get_manifest_name(screen: dict) -> str:
    return str(screen.get("name_zh") or screen.get("title") or "")


def validate_named_node(
    attrs: dict[str, str],
    *,
    id_attr: str,
    name_attr: str,
    kind: str,
    errors: list[str],
) -> tuple[str, str]:
    stable_id = attrs.get(id_attr, "")
    name_zh = attrs.get(name_attr, "")
    figma_name = attrs.get("data-figma-name", "")
    aria_label = attrs.get("aria-label", "")
    if not stable_id:
        errors.append(f"{kind} 缺少 {id_attr}")
    elif not ASCII_ID.fullmatch(stable_id):
        errors.append(f"{kind} ID 不是稳定 ASCII 短横线格式: {stable_id}")
    if not name_zh or not CHINESE.search(name_zh):
        errors.append(f"{kind} 缺少中文可读名: {stable_id or '<unknown>'}")
    if figma_name != name_zh or aria_label != name_zh:
        errors.append(
            f"{kind} 中文命名信号不一致: {stable_id or '<unknown>'} "
            f"({name_attr} / data-figma-name / aria-label)"
        )
    return stable_id, name_zh


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--html", required=True, type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--expected-width", type=int)
    parser.add_argument("--expected-height", type=int)
    parser.add_argument("--require-components", action="store_true")
    args = parser.parse_args()

    errors: list[str] = []
    warnings: list[str] = []
    try:
        html = args.html.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as exc:
        print(f"FAIL: 无法读取 HTML: {exc}", file=sys.stderr)
        return 2

    parsed = ImportHTMLParser()
    parsed.feed(html)
    if not parsed.frames:
        errors.append("没有找到 class=figma-frame 的顶层节点")
    if parsed.script_count:
        errors.append(f"包含 {parsed.script_count} 个 <script>，导入版必须无脚本")
    if parsed.inline_handlers:
        errors.append(f"包含 {len(parsed.inline_handlers)} 个内联事件处理器")
    if parsed.external_resources:
        errors.append(f"包含 {len(parsed.external_resources)} 个远程资源引用")

    frame_names: dict[str, str] = {}
    expected_viewport = None
    if args.expected_width and args.expected_height:
        expected_viewport = f"{args.expected_width}x{args.expected_height}"
    elif bool(args.expected_width) != bool(args.expected_height):
        errors.append("--expected-width 与 --expected-height 必须同时提供")

    for attrs in parsed.frames:
        stable_id, name_zh = validate_named_node(
            attrs,
            id_attr="data-screen-id",
            name_attr="data-screen-name-zh",
            kind="Frame",
            errors=errors,
        )
        if stable_id in frame_names:
            errors.append(f"重复 Screen ID: {stable_id}")
        frame_names[stable_id] = name_zh
        expected_dom_id = f"Screen--{stable_id}"
        if stable_id and attrs.get("id") != expected_dom_id:
            errors.append(f"Frame DOM ID 应为 {expected_dom_id}: {stable_id}")
        if expected_viewport and attrs.get("data-viewport") != expected_viewport:
            errors.append(
                f"Frame 视口不匹配: {stable_id}，期望 {expected_viewport}，"
                f"实际 {attrs.get('data-viewport') or '<missing>'}"
            )

    component_ids: set[str] = set()
    for attrs in parsed.components:
        component_id, _ = validate_named_node(
            attrs,
            id_attr="data-component-id",
            name_attr="data-component-name-zh",
            kind="Component",
            errors=errors,
        )
        if component_id in component_ids:
            errors.append(f"重复 Component ID: {component_id}")
        component_ids.add(component_id)
        expected_dom_id = f"Component--{component_id}"
        if component_id and attrs.get("id") != expected_dom_id:
            errors.append(f"Component DOM ID 应为 {expected_dom_id}: {component_id}")

    if args.require_components and not parsed.components:
        errors.append("要求组件命名，但没有找到 class=figma-component 的节点")
    elif not parsed.components:
        warnings.append("未标记可复用组件；若需组件级 Figma 图层命名，请添加 figma-component")

    if args.manifest:
        try:
            screens = load_manifest(args.manifest)
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            errors.append(f"无法读取 manifest: {exc}")
        else:
            manifest_names = {str(item.get("id", "")): get_manifest_name(item) for item in screens}
            if set(manifest_names) != set(frame_names):
                missing_html = sorted(set(manifest_names) - set(frame_names))
                missing_manifest = sorted(set(frame_names) - set(manifest_names))
                if missing_html:
                    errors.append(f"manifest 有但 HTML 缺少: {', '.join(missing_html)}")
                if missing_manifest:
                    errors.append(f"HTML 有但 manifest 缺少: {', '.join(missing_manifest)}")
            for screen_id in sorted(set(manifest_names) & set(frame_names)):
                if manifest_names[screen_id] != frame_names[screen_id]:
                    errors.append(
                        f"中文名不一致 {screen_id}: manifest={manifest_names[screen_id]!r}, "
                        f"HTML={frame_names[screen_id]!r}"
                    )

    print(
        json.dumps(
            {
                "status": "FAIL" if errors else "PASS",
                "frames": len(parsed.frames),
                "components": len(parsed.components),
                "scripts": parsed.script_count,
                "external_resources": len(parsed.external_resources),
                "errors": errors,
                "warnings": warnings,
                "boundary": "结构校验不证明浏览器视觉结果或 Figma 插件导入结果",
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
