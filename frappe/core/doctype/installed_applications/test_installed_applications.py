# Copyright (c) 2020, Frappe Technologies and Contributors
# License: MIT. See LICENSE

from dataclasses import FrozenInstanceError
from types import ModuleType
from unittest.mock import MagicMock, call, patch

import frappe
from frappe.core.doctype.installed_applications.installed_applications import (
	InstalledApplications,
	InvalidAppOrder,
	update_installed_apps_order,
)
from frappe.tests import IntegrationTestCase, UnitTestCase
from frappe.utils import (
	AliasSurface,
	AppProviderDescriptor,
	LegacyAppAlias,
	ProviderBindingError,
	ProviderBindingReason,
	ProviderBindingState,
	ProviderContractError,
	get_attr,
	get_capability_provider,
	load_app_provider_descriptor,
	record_app_alias_usage,
	resolve_app_name,
	resolve_dotted_path,
)


class TestInstalledApplications(IntegrationTestCase):
	def test_order_change(self):
		installed_apps = frappe.get_installed_apps(_ensure_on_bench=True)
		update_installed_apps_order(installed_apps)
		self.assertRaises(InvalidAppOrder, update_installed_apps_order, [])
		self.assertRaises(InvalidAppOrder, update_installed_apps_order, [*installed_apps, "deepmind"])


class TestCurrentApplicationIdentity(UnitTestCase):
	def test_setup_completion_uses_generic_wizard_rows(self):
		with (
			patch.object(frappe.db, "table_exists", return_value=True),
			patch("frappe.apps.get_disabled_apps", return_value=["disabled_app"]),
			patch.object(frappe, "get_all", return_value=[1, 1]) as get_all,
		):
			self.assertTrue(frappe.is_setup_complete.__wrapped__())

		get_all.assert_called_once_with(
			"Installed Application",
			{"has_setup_wizard": 1, "app_name": ("not in", ["disabled_app"])},
			pluck="is_setup_complete",
		)

	def test_installed_applications_detects_wizard_apps_from_hooks(self):
		document = MagicMock()
		document.get_app_wise_setup_details.return_value = {}
		rows = []
		document.append.side_effect = lambda key, value: rows.append(value)

		with (
			patch.object(frappe, "get_disabled_apps", return_value=[]),
			patch.object(
				frappe.utils,
				"get_installed_apps_info",
				return_value=[
					{"app_name": "frappe", "version": "17"},
					{"app_name": "anydeals_erp", "version": "17"},
					{"app_name": "payments", "version": "1"},
				],
			),
			patch.object(
				frappe,
				"get_hooks",
				side_effect=lambda app_name: {
					"setup_wizard_stages": ["setup"] if app_name == "anydeals_erp" else []
				},
			),
			patch(
				"frappe.core.doctype.installed_applications.installed_applications.has_non_admin_user",
				return_value=False,
			),
			patch.object(frappe, "clear_cache"),
			patch.object(frappe, "is_setup_complete", return_value=True),
			patch.object(frappe.db, "set_single_value"),
		):
			InstalledApplications.update_versions(document)

		self.assertEqual(
			[(row["app_name"], row["has_setup_wizard"], row["is_setup_complete"]) for row in rows],
			[("frappe", 1, 0), ("anydeals_erp", 1, 0), ("payments", 0, 0)],
		)

	def test_get_attr_rewrites_only_the_legacy_app_prefix(self):
		module = MagicMock(target=object())
		with (
			patch.object(frappe, "get_installed_apps", return_value=["frappe", "anydeals_erp"]),
			patch(
				"frappe.utils.resolve_dotted_path",
				return_value="anydeals_erp.module.target",
			) as resolve_dotted_path,
			patch("frappe.utils.get_module", return_value=module) as get_module,
		):
			self.assertIs(get_attr("erpnext.module.target"), module.target)

		resolve_dotted_path.assert_called_once_with("erpnext.module.target", surface="method")
		get_module.assert_called_once_with("anydeals_erp.module")


class TestProviderContract(UnitTestCase):
	def setUp(self):
		super().setUp()
		load_app_provider_descriptor.clear_cache()
		resolve_app_name.clear_cache()
		resolve_dotted_path.clear_cache()

	def tearDown(self):
		load_app_provider_descriptor.clear_cache()
		resolve_app_name.clear_cache()
		resolve_dotted_path.clear_cache()
		super().tearDown()

	@staticmethod
	def descriptor(
		canonical_app: str = "virtual_erp",
		aliases: tuple[str, ...] = ("legacy_erp",),
		*,
		kind: str = "erp",
	) -> AppProviderDescriptor:
		return AppProviderDescriptor(
			schema_version=1,
			kind=kind,
			canonical_app=canonical_app,
			legacy_aliases=tuple(LegacyAppAlias(name=name, remove_in="v19") for name in aliases),
		)

	@staticmethod
	def raw_descriptor(**overrides):
		descriptor = {
			"schema_version": 1,
			"kind": "erp",
			"canonical_app": "virtual_erp",
			"legacy_aliases": [{"name": "legacy_erp", "remove_in": "v19"}],
		}
		descriptor.update(overrides)
		return descriptor

	def virtual_hooks(self, descriptor=None):
		module = ModuleType("virtual_erp.hooks")
		if descriptor is not None:
			module.frappe_app_provider = descriptor
		return module

	def provider_patches(
		self,
		*,
		descriptors=None,
		bindings=None,
		installed=("virtual_erp",),
		disabled=(),
		setup_complete=0,
		reloaded=None,
	):
		descriptors = descriptors if descriptors is not None else (self.descriptor(),)
		bindings = bindings if bindings is not None else {}
		globals_by_key = {
			"active_app_providers": frappe.as_json(bindings),
			"installed_apps": frappe.as_json(installed),
			"disabled_apps": frappe.as_json(disabled),
		}
		return (
			patch("frappe.utils._get_provider_descriptors", return_value=descriptors),
			patch.object(frappe.db, "get_global", side_effect=globals_by_key.get),
			patch.object(frappe.db, "get_value", return_value=setup_complete),
			patch(
				"frappe.utils._load_raw_app_provider_descriptor",
				return_value=reloaded if reloaded is not None else descriptors[0] if descriptors else None,
			),
		)

	def assert_binding_error(self, reason, **state):
		patches = self.provider_patches(**state)
		with (
			patches[0],
			patches[1],
			patches[2],
			patches[3],
			self.assertRaises(ProviderBindingError) as raised,
		):
			get_capability_provider("erp")
		self.assertEqual((raised.exception.kind, raised.exception.reason), ("erp", reason))

	def test_raw_loader_validates_and_freezes_virtual_app_descriptor(self):
		module = self.virtual_hooks(self.raw_descriptor())
		with (
			patch.object(frappe, "get_all_apps", return_value=["frappe", "virtual_erp"]),
			patch("frappe.utils.importlib.import_module", return_value=module),
		):
			descriptor = load_app_provider_descriptor("virtual_erp")

		self.assertEqual(descriptor, self.descriptor())
		with self.assertRaises(FrozenInstanceError):
			descriptor.kind = "other"

	def test_raw_loader_rejects_missing_target_unknown_schema_and_fields(self):
		with (
			patch.object(frappe, "get_all_apps", return_value=["frappe"]),
			self.assertRaises(ProviderContractError),
		):
			load_app_provider_descriptor("virtual_erp")

		for raw in (
			self.raw_descriptor(schema_version=2),
			{**self.raw_descriptor(), "setup_complete": True},
		):
			load_app_provider_descriptor.clear_cache()
			with (
				self.subTest(raw=raw),
				patch.object(frappe, "get_all_apps", return_value=["virtual_erp"]),
				patch("frappe.utils.importlib.import_module", return_value=self.virtual_hooks(raw)),
				self.assertRaises(ProviderContractError),
			):
				load_app_provider_descriptor("virtual_erp")

	def test_alias_resolution_is_exact_and_rejects_conflicts_and_cycles(self):
		descriptor = self.descriptor()
		with (
			patch.object(frappe, "get_all_apps", return_value=["virtual_erp"]),
			patch("frappe.utils._get_provider_descriptors", return_value=(descriptor,)),
			patch("frappe.utils.record_app_alias_usage") as record_usage,
		):
			self.assertEqual(resolve_app_name("legacy_erp"), "virtual_erp")
			self.assertEqual(resolve_app_name("myerpnext"), "myerpnext")
			self.assertEqual(
				resolve_dotted_path("legacy_erp.module.method", surface="method"),
				"virtual_erp.module.method",
			)
			self.assertEqual(
				resolve_dotted_path("legacy_erp.module.method", surface="method"),
				"virtual_erp.module.method",
			)
			self.assertEqual(
				resolve_dotted_path("myerpnext.module.method", surface="method"),
				"myerpnext.module.method",
			)
			record_usage.assert_has_calls(
				[
					call("legacy_erp", "virtual_erp", AliasSurface.METHOD, __name__),
					call("legacy_erp", "virtual_erp", AliasSurface.METHOD, __name__),
				]
			)
			self.assertEqual(record_usage.call_count, 2)

		resolve_app_name.clear_cache()
		with (
			patch.object(frappe, "get_all_apps", return_value=["legacy_erp", "virtual_erp"]),
			patch("frappe.utils._get_provider_descriptors", return_value=(descriptor,)),
			self.assertRaises(ProviderContractError),
		):
			resolve_app_name("legacy_erp")

		cycle = (
			self.descriptor("provider_a", ("provider_b",)),
			self.descriptor("provider_b", ("provider_a",)),
		)
		with (
			patch.object(frappe, "get_all_apps", return_value=[]),
			patch("frappe.utils._get_provider_descriptors", return_value=cycle),
			self.assertRaises(ProviderContractError),
		):
			resolve_app_name.__wrapped__("provider_a")

	def test_invalid_dotted_path_fails_closed(self):
		for path in ("legacy_erp", "legacy_erp..method", "https://example.com", "a@b.com"):
			with self.subTest(path=path), self.assertRaises(ProviderContractError):
				resolve_dotted_path(path, surface="method")

		with self.assertRaises(ProviderContractError):
			resolve_dotted_path("legacy_erp.module.method", surface="unknown")

	def test_alias_usage_sink_is_best_effort_and_site_scoped(self):
		hooks = ModuleType("virtual_erp.hooks")
		hooks.app_alias_usage_sink = "virtual_erp.telemetry.record"
		sink = MagicMock(side_effect=RuntimeError("redis unavailable"))
		logger = MagicMock()
		with (
			patch.object(frappe.local, "site", "test.local"),
			patch.object(frappe, "get_installed_apps", return_value=["virtual_erp"]),
			patch("frappe.utils.importlib.import_module", return_value=hooks),
			patch.object(frappe, "get_attr", return_value=sink, create=True),
			patch.object(frappe, "logger", return_value=logger),
		):
			self.assertIsNone(
				record_app_alias_usage("legacy_erp", "virtual_erp", AliasSurface.API, "frappe.handler")
			)

		sink.assert_called_once_with("legacy_erp", "virtual_erp", AliasSurface.API, "frappe.handler")
		logger.warning.assert_called_once()

		with (
			patch.object(frappe.local, "site", None),
			patch.object(frappe, "get_installed_apps") as get_installed_apps,
		):
			record_app_alias_usage("legacy_erp", "virtual_erp", AliasSurface.API, "frappe.handler")
		get_installed_apps.assert_not_called()

	def test_no_provider_and_fresh_and_bound_states(self):
		patches = self.provider_patches(descriptors=())
		with patches[0], patches[1], patches[2], patches[3]:
			self.assertIsNone(get_capability_provider("erp"))

		patches = self.provider_patches()
		with patches[0], patches[1], patches[2], patches[3]:
			provider = get_capability_provider("erp")
		self.assertEqual(
			(provider.state, provider.binding_app),
			(ProviderBindingState.FRESH, None),
		)

		patches = self.provider_patches(bindings={"erp": "virtual_erp"}, setup_complete=1)
		with patches[0], patches[1], patches[2], patches[3]:
			provider = get_capability_provider("erp")
		self.assertEqual(
			(provider.state, provider.binding_app),
			(ProviderBindingState.BOUND, "virtual_erp"),
		)

	def test_binding_failures_have_stable_reasons(self):
		self.assert_binding_error(
			ProviderBindingReason.NO_DESCRIPTOR_FOR_BOUND_KIND,
			descriptors=(),
			bindings={"erp": "virtual_erp"},
		)
		self.assert_binding_error(
			ProviderBindingReason.CANONICAL_APP_NOT_INSTALLED,
			installed=(),
		)
		self.assert_binding_error(
			ProviderBindingReason.CANONICAL_APP_NOT_ACTIVE,
			disabled=("virtual_erp",),
		)
		self.assert_binding_error(
			ProviderBindingReason.INSTALLED_APPLICATION_MISSING,
			setup_complete=None,
		)
		self.assert_binding_error(
			ProviderBindingReason.SETUP_COMPLETE_WITHOUT_BINDING,
			setup_complete=1,
		)
		self.assert_binding_error(
			ProviderBindingReason.SETUP_INCOMPLETE_WITH_BINDING,
			bindings={"erp": "virtual_erp"},
		)
		self.assert_binding_error(
			ProviderBindingReason.BINDING_APP_MISMATCH,
			bindings={"erp": "other_erp"},
		)

		for bindings in ('{"erp": 1}', '{"erp": "virtual_erp", "erp": "other_erp"}'):
			patches = self.provider_patches()
			with (
				self.subTest(bindings=bindings),
				patches[0],
				patch.object(frappe.db, "get_global", return_value=bindings),
				patches[2],
				patches[3],
				self.assertRaises(ProviderBindingError) as raised,
			):
				get_capability_provider("erp")
			self.assertEqual(raised.exception.reason, ProviderBindingReason.BINDING_VALUE_INVALID)

		self.assert_binding_error(
			ProviderBindingReason.DESCRIPTOR_MISMATCH,
			bindings={"erp": "virtual_erp"},
			setup_complete=1,
			reloaded=self.descriptor(aliases=()),
		)

	def test_invalid_setup_completion_is_contract_error(self):
		patches = self.provider_patches(setup_complete=2)
		with (
			patches[0],
			patches[1],
			patches[2],
			patches[3],
			self.assertRaises(ProviderContractError) as raised,
		):
			get_capability_provider("erp")
		self.assertNotIsInstance(raised.exception, ProviderBindingError)

	def test_duplicate_provider_fails_closed(self):
		descriptors = (self.descriptor("virtual_erp"), self.descriptor("second_erp"))
		patches = self.provider_patches(descriptors=descriptors)
		with patches[0], patches[1], patches[2], patches[3], self.assertRaises(ProviderContractError):
			get_capability_provider("erp")

	def test_provider_discovery_rejects_alias_conflicts_before_returning_provider(self):
		states = (
			(["legacy_erp", "virtual_erp"], (self.descriptor(),)),
			(
				[],
				(
					self.descriptor(aliases=("shared_alias",)),
					self.descriptor("other_provider", ("shared_alias",), kind="other"),
				),
			),
			(
				[],
				(
					self.descriptor(aliases=("other_provider",)),
					self.descriptor("other_provider", ("virtual_erp",), kind="other"),
				),
			),
		)
		for apps, descriptors in states:
			patches = self.provider_patches(descriptors=descriptors)
			with (
				self.subTest(apps=apps, descriptors=descriptors),
				patch.object(frappe, "get_all_apps", return_value=apps),
				patches[0],
				patches[1],
				patches[2],
				patches[3],
				self.assertRaises(ProviderContractError),
			):
				get_capability_provider("erp")

	def test_binding_state_is_never_cached(self):
		descriptor = self.descriptor()
		state = {"binding": {}, "complete": 0}

		def get_global(key):
			return frappe.as_json(
				{
					"active_app_providers": state["binding"],
					"installed_apps": ["virtual_erp"],
					"disabled_apps": [],
				}[key]
			)

		with (
			patch("frappe.utils._get_provider_descriptors", return_value=(descriptor,)),
			patch.object(frappe.db, "get_global", side_effect=get_global),
			patch.object(frappe.db, "get_value", side_effect=lambda *args: state["complete"]),
			patch("frappe.utils._load_raw_app_provider_descriptor", return_value=descriptor),
		):
			self.assertEqual(get_capability_provider("erp").state, ProviderBindingState.FRESH)
			state.update(binding={"erp": "virtual_erp"}, complete=1)
			self.assertEqual(get_capability_provider("erp").state, ProviderBindingState.BOUND)

	def test_site_cache_isolated_and_clear_cache_reloads_descriptor(self):
		import frappe.cache_manager
		import frappe.website.router

		clear_provider_caches = frappe.clear_cache
		original_site = frappe.local.site
		modules = {
			"site-one": self.virtual_hooks(self.raw_descriptor()),
			"site-two": self.virtual_hooks(self.raw_descriptor(legacy_aliases=[])),
		}
		try:
			with (
				patch.object(frappe, "get_all_apps", return_value=["virtual_erp"]),
				patch(
					"frappe.utils.importlib.import_module",
					side_effect=lambda *args: modules[frappe.local.site],
				) as import_module,
			):
				frappe.local.site = "site-one"
				self.assertEqual(len(load_app_provider_descriptor("virtual_erp").legacy_aliases), 1)
				frappe.local.site = "site-two"
				self.assertEqual(len(load_app_provider_descriptor("virtual_erp").legacy_aliases), 0)
				frappe.local.site = "site-one"
				load_app_provider_descriptor("virtual_erp")
				self.assertEqual(import_module.call_count, 2)
				self.assertEqual(resolve_app_name("legacy_erp"), "virtual_erp")
				self.assertEqual(
					resolve_dotted_path("legacy_erp.module.method", surface="method"),
					"virtual_erp.module.method",
				)

				modules["site-one"] = self.virtual_hooks(self.raw_descriptor(legacy_aliases=[]))
				with (
					patch.object(frappe.cache, "get_keys", return_value=[]),
					patch.object(frappe.cache, "delete_value"),
					patch.object(frappe, "get_hooks", return_value=[]),
					patch.object(frappe.cache_manager, "reset_metadata_version"),
					patch.object(frappe.client_cache, "clear_cache"),
					patch.object(frappe.website.router, "clear_routing_cache"),
				):
					clear_provider_caches()
				self.assertEqual(len(load_app_provider_descriptor("virtual_erp").legacy_aliases), 0)
				self.assertEqual(resolve_app_name("legacy_erp"), "legacy_erp")
				self.assertEqual(
					resolve_dotted_path("legacy_erp.module.method", surface="method"),
					"legacy_erp.module.method",
				)
		finally:
			frappe.local.site = original_site

	def test_migrate_setup_uses_the_same_cache_invalidation_path(self):
		from frappe.migrate import SiteMigration

		migration = SiteMigration()
		with (
			patch.object(frappe, "get_site_path", return_value="/tmp/provider-touched-tables.json"),
			patch.object(frappe, "clear_cache") as clear_cache,
			patch("frappe.migrate.os.path.exists", return_value=False),
			patch.object(migration, "lower_lock_timeout"),
			patch.object(migration, "kill_idle_connections"),
		):
			try:
				migration.setUp()
			finally:
				# setUp() flips process-global maintenance flags; UnitTestCase does
				# not restore flags, so reset them here to keep this process clean
				# for every test that runs after this one.
				frappe.flags.in_migrate = False
				frappe.flags.pop("touched_tables", None)

		clear_cache.assert_called_once_with()
