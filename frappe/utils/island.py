# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and Contributors
# License: MIT. See LICENSE
"""Desk islands: the app registry and the runtime import map.

An app declares an island in `hooks.py`, against the bundle base name its build
registers in assets.json:

    ui_islands = {"insights.dashboard": "insights_dashboard"}

The `.island.js` / `.island.css` key forms are distinct from the legacy
`.bundle.js` one, so the module loader and the classic loader never claim the
same asset.
"""

import json

import frappe

RUNTIME_JS_SUFFIX = ".runtime.js"
ISLAND_JS_SUFFIX = ".island.js"
ISLAND_CSS_SUFFIX = ".island.css"


def get_ui_islands() -> dict[str, str]:
	"""Island name -> bundle base name, across every installed app."""
	islands = {}

	for name, value in frappe.get_hooks("ui_islands", default={}).items():
		# A dict hook collects one list of values per key. An island resolves to
		# exactly one bundle, so the last app to declare the name wins.
		islands[name] = value[-1] if isinstance(value, list) else value

	return islands


def strip_runtime_keys(assets_json: dict[str, str]) -> dict[str, str]:
	"""assets.json without its `.runtime.js` entries.

	Boot embeds this in every desk page; the import map (below) is the only
	reader of `.runtime.js` keys, and desk already inlines that map, so boot
	would otherwise carry the same ~400 entries twice.
	"""
	return {key: url for key, url in assets_json.items() if not key.endswith(RUNTIME_JS_SUFFIX)}


def get_import_map() -> dict[str, dict[str, str]]:
	"""The runtime import map: every bare specifier in the closure -> its hashed file.

	A pure transform over assets.json — the runtime build registers each entry
	specifier under `<specifier>.runtime.js` — so hashed filenames never reach a
	template.
	"""
	from frappe.utils import get_assets_json

	imports = {
		key.removesuffix(RUNTIME_JS_SUFFIX): url
		for key, url in get_assets_json().items()
		if key.endswith(RUNTIME_JS_SUFFIX)
	}

	return {"imports": dict(sorted(imports.items()))}


def get_import_map_tag() -> str:
	"""The import map desk emits in its head, or "" when no app ships an island.

	A browser rejects an import map once module loading has started, so this
	cannot be deferred to the moment an island mounts: either the page carries
	the map from the start, or no island on it can resolve `vue`. Sites with no
	island-shipping app can never mount one, and pay nothing.
	"""
	if not get_ui_islands():
		return ""

	import_map = get_import_map()
	if not import_map["imports"]:
		return ""

	payload = json.dumps(import_map, separators=(",", ":")).replace("<", "\\u003c")
	return f'<script type="importmap">{payload}</script>'
