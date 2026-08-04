# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and Contributors
# License: MIT. See LICENSE
import json
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils.island import get_import_map, get_import_map_tag, get_ui_islands

ASSETS_JSON = {
	"desk.bundle.js": "/assets/frappe/dist/js/desk.bundle.ABC.js",
	"vue.runtime.js": "/assets/frappe/dist/island/runtime/vue/index.HASH1.js",
	"vue-router.runtime.js": "/assets/frappe/dist/island/runtime/vue-router/index.HASH2.js",
	"@tiptap/pm/state.runtime.js": "/assets/frappe/dist/island/runtime/@tiptap/pm/state.HASH3.js",
	"island_runtime.css": "/assets/frappe/dist/island/runtime/island_runtime.HASH4.css",
	"insights_dashboard.island.js": "/assets/insights/dist/insights_dashboard.HASH5.js",
	"insights_dashboard.island.css": "/assets/insights/dist/insights_dashboard.HASH6.css",
}


class TestUiIslandsRegistry(IntegrationTestCase):
	def test_registry_unwraps_the_hook_lists(self):
		with self.patch_hooks({"ui_islands": {"insights.dashboard": ["insights_dashboard"]}}):
			self.assertEqual(get_ui_islands(), {"insights.dashboard": "insights_dashboard"})

	def test_registry_merges_islands_of_several_apps(self):
		with self.patch_hooks(
			{
				"ui_islands": {
					"insights.dashboard": ["insights_dashboard"],
					"helpdesk.ticket": ["helpdesk_ticket"],
				}
			}
		):
			self.assertEqual(
				get_ui_islands(),
				{
					"insights.dashboard": "insights_dashboard",
					"helpdesk.ticket": "helpdesk_ticket",
				},
			)

	def test_last_app_to_declare_a_name_wins(self):
		with self.patch_hooks({"ui_islands": {"insights.dashboard": ["original", "override"]}}):
			self.assertEqual(get_ui_islands(), {"insights.dashboard": "override"})

	def test_registry_is_empty_without_the_hook(self):
		with self.patch_hooks({"ui_islands": {}}):
			self.assertEqual(get_ui_islands(), {})

	def test_registry_reaches_the_browser_through_boot(self):
		# The loader resolves island names client-side, so boot has to carry them.
		frappe.local.request = None
		self.addCleanup(lambda: delattr(frappe.local, "request"))
		self.assertIn("ui_islands", frappe.sessions.get())


class TestIslandImportMap(IntegrationTestCase):
	def setUp(self):
		patcher = patch("frappe.utils.get_assets_json", return_value=ASSETS_JSON)
		patcher.start()
		self.addCleanup(patcher.stop)

	def test_map_holds_every_runtime_specifier(self):
		imports = get_import_map()["imports"]
		self.assertEqual(
			imports,
			{
				"@tiptap/pm/state": "/assets/frappe/dist/island/runtime/@tiptap/pm/state.HASH3.js",
				"vue": "/assets/frappe/dist/island/runtime/vue/index.HASH1.js",
				"vue-router": "/assets/frappe/dist/island/runtime/vue-router/index.HASH2.js",
			},
		)

	def test_map_leaves_classic_bundles_and_island_entries_out(self):
		# The classic loader owns `.bundle.js`; island entries are resolved by
		# assets.json at mount, not by a bare specifier.
		imports = get_import_map()["imports"]
		self.assertNotIn("desk", imports)
		self.assertNotIn("insights_dashboard", imports)
		self.assertNotIn("island_runtime", imports)

	def test_tag_is_empty_when_no_app_ships_an_island(self):
		with self.patch_hooks({"ui_islands": {}}):
			self.assertEqual(get_import_map_tag(), "")

	def test_tag_carries_the_map_when_an_app_ships_an_island(self):
		with self.patch_hooks({"ui_islands": {"insights.dashboard": ["insights_dashboard"]}}):
			tag = get_import_map_tag()

		self.assertTrue(tag.startswith('<script type="importmap">'))
		payload = json.loads(tag[len('<script type="importmap">') : -len("</script>")])
		self.assertEqual(payload, get_import_map())

	def test_desk_head_renders_the_tag(self):
		from frappe.utils.jinja_globals import island_import_map

		with self.patch_hooks({"ui_islands": {"insights.dashboard": ["insights_dashboard"]}}):
			self.assertEqual(island_import_map(), get_import_map_tag())

	def test_tag_escapes_markup_in_the_payload(self):
		assets = ASSETS_JSON | {"</script>.runtime.js": "/assets/frappe/dist/x.js"}
		with (
			patch("frappe.utils.get_assets_json", return_value=assets),
			self.patch_hooks({"ui_islands": {"insights.dashboard": ["insights_dashboard"]}}),
		):
			tag = get_import_map_tag()

		self.assertEqual(tag.count("</script>"), 1)
