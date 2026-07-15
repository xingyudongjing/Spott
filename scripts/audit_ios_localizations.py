#!/usr/bin/env python3
"""Validate Spott's iOS Localizable.strings files.

Checks syntax, duplicate keys, locale key parity, printf placeholder parity, and
optionally coverage against an XLIFF produced by Xcode's localization export.
"""

from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import re
import subprocess
import sys
import xml.etree.ElementTree as ElementTree


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
IOS_ROOT = REPOSITORY_ROOT / "Spott"
LOCALIZATION_FILES = {
    "zh-Hans": IOS_ROOT / "Resources/zh-Hans.lproj/Localizable.strings",
    "ja": IOS_ROOT / "Resources/ja.lproj/Localizable.strings",
    "en": IOS_ROOT / "Resources/en.lproj/Localizable.strings",
}
ENTRY_PATTERN = re.compile(
    r'^"((?:\\.|[^"\\])*)"\s*=\s*"((?:\\.|[^"\\])*)";\s*$'
)
PLACEHOLDER_PATTERN = re.compile(
    r"%(?:\d+\$)?(?:lld|llu|ld|lu|zd|zu|@|d|u|f|s)"
)
SWIFT_RUNTIME_RULES = {
    IOS_ROOT / "DesignSystem/SpottTheme.swift": {
        "forbidden": {
            r"Text\(title\)": "SpottStateCard title bypasses localization",
            r"Text\(message\)": "SpottStateCard message bypasses localization",
            r"Button\(actionTitle,": "SpottStateCard action title bypasses localization",
            r"Label\(banner\.title,": "SyncBanner title bypasses localization",
            r"\.accessibilityLabel\(banner\.title\)": "SyncBanner accessibility label bypasses localization",
        },
        "required": {},
    },
    IOS_ROOT / "Features/Discovery/DiscoveryView.swift": {
        "forbidden": {
            r"Text\(regionTitle\)": "selected region bypasses localization",
            r"Button\(title\)": "region menu item bypasses localization",
            r"Text\(selectedCategory == nil \?": "event section heading bypasses localization",
            r"Text\(value\)": "event tag bypasses localization",
            r"Text\(label\.uppercased\(\)\)": "cover category bypasses localization",
            r"Text\(event\.remaining > 0 \?": "availability label bypasses localization",
            r"Text\(event\.startsAt\?\.formatted": "localized fallback is mixed with verbatim API date content",
        },
        "required": {
            r"Text\(verbatim: event\.priceLabel\)": "API price label must remain verbatim",
            r"Text\(verbatim: event\.title\)": "API event title must remain verbatim",
            r"Text\(verbatim: event\.publicArea\)": "API public area must remain verbatim",
        },
    },
}


def decode_strings_token(token: str) -> str:
    """Decode the JSON-compatible escapes used by the project's .strings files."""
    return json.loads(f'"{token}"')


def parse_strings(path: Path) -> tuple[dict[str, str], list[str]]:
    entries: dict[str, str] = {}
    duplicate_keys: list[str] = []
    in_block_comment = False

    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if in_block_comment:
            if "*/" in line:
                in_block_comment = False
            continue
        if not line or line.startswith("//"):
            continue
        if line.startswith("/*"):
            in_block_comment = "*/" not in line
            continue

        match = ENTRY_PATTERN.fullmatch(line)
        if not match:
            raise ValueError(f"{path}:{line_number}: invalid .strings entry")
        key = decode_strings_token(match.group(1))
        value = decode_strings_token(match.group(2))
        if key in entries:
            duplicate_keys.append(key)
        entries[key] = value

    return entries, duplicate_keys


def placeholder_signature(text: str) -> Counter[str]:
    return Counter(
        re.sub(r"^%(?:\d+\$)?", "%", placeholder)
        for placeholder in PLACEHOLDER_PATTERN.findall(text)
    )


def load_xcode_keys(path: Path) -> set[str]:
    namespace = {"x": "urn:oasis:names:tc:xliff:document:1.2"}
    root = ElementTree.parse(path).getroot()
    keys: set[str] = set()
    for file_node in root.findall("x:file", namespace):
        if not file_node.attrib.get("original", "").endswith("Localizable.strings"):
            continue
        for unit in file_node.findall(".//x:trans-unit", namespace):
            keys.add(unit.attrib["id"])
    return keys


def audit_swift_runtime_localization() -> list[str]:
    failures: list[str] = []
    for path, rules in SWIFT_RUNTIME_RULES.items():
        source = path.read_text(encoding="utf-8")
        for pattern, explanation in rules["forbidden"].items():
            if re.search(pattern, source):
                failures.append(f"{path}: {explanation}")
        for pattern, explanation in rules["required"].items():
            if not re.search(pattern, source):
                failures.append(f"{path}: {explanation}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--xliff",
        type=Path,
        help="Optional XLIFF exported by xcodebuild -exportLocalizations.",
    )
    arguments = parser.parse_args()
    failures: list[str] = []

    syntax_check = subprocess.run(
        ["plutil", "-lint", *(str(path) for path in LOCALIZATION_FILES.values())],
        check=False,
        capture_output=True,
        text=True,
    )
    if syntax_check.returncode != 0:
        failures.append(syntax_check.stdout + syntax_check.stderr)

    failures.extend(audit_swift_runtime_localization())

    parsed: dict[str, dict[str, str]] = {}
    for locale, path in LOCALIZATION_FILES.items():
        try:
            entries, duplicate_keys = parse_strings(path)
        except ValueError as error:
            failures.append(str(error))
            continue
        parsed[locale] = entries
        if duplicate_keys:
            failures.append(f"{locale}: duplicate keys: {sorted(set(duplicate_keys))}")

    if len(parsed) == len(LOCALIZATION_FILES):
        source_keys = set(parsed["zh-Hans"])
        for locale, entries in parsed.items():
            keys = set(entries)
            missing = sorted(source_keys - keys)
            extra = sorted(keys - source_keys)
            if missing or extra:
                failures.append(f"{locale}: missing={missing}, extra={extra}")

        for key in sorted(source_keys):
            expected = placeholder_signature(key)
            for locale, entries in parsed.items():
                actual = placeholder_signature(entries[key])
                if actual != expected:
                    failures.append(
                        f"{locale}: placeholder mismatch for {key!r}: "
                        f"expected {expected}, got {actual}"
                    )

        if arguments.xliff:
            xcode_keys = load_xcode_keys(arguments.xliff)
            missing = sorted(xcode_keys - source_keys)
            if missing:
                failures.append(f"Xcode coverage mismatch: missing={missing}")

    if failures:
        print("iOS localization audit failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    key_count = len(parsed["zh-Hans"])
    coverage = ", covers the Xcode localization export" if arguments.xliff else ""
    print(f"iOS localization audit passed: 3 locales × {key_count} keys{coverage}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
