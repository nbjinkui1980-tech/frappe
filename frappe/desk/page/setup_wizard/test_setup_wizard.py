# Copyright (c) 2025, Frappe Technologies Pvt. Ltd. and Contributors
# License: MIT. See LICENSE
import json
from collections import defaultdict
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import frappe
from frappe.desk.page.setup_wizard import setup_wizard
from frappe.tests import IntegrationTestCase, UnitTestCase, set_user
from frappe.utils.synchronization import LockTimeoutError


def fake_hooks(apps):
	def get_hooks(hook=None, default=None, app_name=None):
		if app_name:
			return apps.get(app_name, {})
		merged = []
		for app_hooks in apps.values():
			merged += app_hooks.get(hook, [])
		return merged

	return get_hooks


class TestSetupWizardUrl(UnitTestCase):
	def resolve(self, apps):
		with (
			patch.object(frappe, "get_installed_apps", return_value=list(apps)),
			patch.object(frappe, "get_active_apps", return_value=list(apps)),
			patch.object(frappe, "get_hooks", side_effect=fake_hooks(apps)),
		):
			url = setup_wizard.get_setup_wizard_url()
			builtin = setup_wizard.site_requires_builtin_wizard()
			return url, builtin

	def test_defaults_to_desk(self):
		url, builtin = self.resolve({"frappe": {}})
		self.assertEqual(url, "/desk/setup-wizard")
		self.assertFalse(builtin)

	def test_uses_app_url(self):
		url, builtin = self.resolve({"suite": {"setup_wizard_url": ["/suite/setup"]}})
		self.assertEqual(url, "/suite/setup")
		self.assertFalse(builtin)

	def test_last_app_wins(self):
		url, _ = self.resolve(
			{
				"suite": {"setup_wizard_url": ["/suite/setup"]},
				"gameplan": {"setup_wizard_url": ["/gameplan/setup"]},
			}
		)
		self.assertEqual(url, "/gameplan/setup")

	def test_stage_app_forces_desk(self):
		url, builtin = self.resolve(
			{
				"suite": {"setup_wizard_url": ["/suite/setup"]},
				"erpnext": {"setup_wizard_stages": ["erpnext.setup.get_setup_stages"]},
			}
		)
		self.assertEqual(url, "/desk/setup-wizard")
		self.assertTrue(builtin)

	def test_complete_hook_forces_desk(self):
		url, builtin = self.resolve(
			{
				"suite": {"setup_wizard_url": ["/suite/setup"]},
				"crm": {"setup_wizard_complete": ["crm.setup.after_complete"]},
			}
		)
		self.assertEqual(url, "/desk/setup-wizard")
		self.assertTrue(builtin)


class TestCompleteAppSetup(IntegrationTestCase):
	def test_needs_system_manager(self):
		with set_user("Guest"):
			self.assertRaises(frappe.PermissionError, setup_wizard.complete_app_setup)

	def test_refuses_builtin_site(self):
		with patch.object(setup_wizard, "site_requires_builtin_wizard", return_value=True):
			self.assertRaises(frappe.ValidationError, setup_wizard.complete_app_setup)

	def test_skips_when_already_complete(self):
		with (
			patch.object(setup_wizard, "site_requires_builtin_wizard", return_value=False),
			patch.object(frappe, "is_setup_complete", return_value=True),
			patch.object(setup_wizard, "process_setup_stages") as process_stages,
		):
			self.assertEqual(setup_wizard.complete_app_setup(), {"status": "ok"})
			process_stages.assert_not_called()

	def test_lock_timeout_never_reports_false_success(self):
		lock = MagicMock()
		lock.__enter__.side_effect = LockTimeoutError
		with (
			patch.object(setup_wizard, "site_requires_builtin_wizard", return_value=False),
			patch.object(setup_wizard, "filelock", return_value=lock),
		):
			with patch.object(frappe, "is_setup_complete", return_value=False):
				self.assertRaises(frappe.ValidationError, setup_wizard.complete_app_setup)
			with patch.object(frappe, "is_setup_complete", return_value=True):
				self.assertEqual(setup_wizard.complete_app_setup(), {"status": "ok"})


class TestCurrentSetupStageBehavior(UnitTestCase):
	def test_tasks_are_marked_complete_before_the_current_success_tail(self):
		events = []
		stages = [
			{
				"tasks": [
					{
						"fn": lambda args: events.append("task:anydeals_erp"),
						"args": {},
						"app_name": "anydeals_erp",
					},
					{"fn": lambda args: events.append("task:frappe"), "args": {}},
				]
			}
		]

		with (
			patch.object(setup_wizard, "get_setup_provider", return_value=None),
			patch.object(setup_wizard, "get_setup_wizard_completed_apps", return_value=[]),
			patch.object(frappe, "publish_realtime"),
			patch.object(
				setup_wizard,
				"enable_setup_wizard_complete",
				side_effect=lambda app: events.append(f"complete:{app}"),
			),
			patch.object(
				setup_wizard, "run_setup_success", side_effect=lambda args: events.append("success")
			),
			patch.object(
				setup_wizard,
				"apply_telemetry_preference",
				side_effect=lambda enabled: events.append("preference"),
			),
			patch.object(
				setup_wizard,
				"clear_cache_after_maintenance",
				side_effect=lambda: events.append("clear-cache"),
			),
			patch(
				"frappe.utils.telemetry.capture",
				side_effect=lambda event, source, **kwargs: events.append(f"capture:{event}"),
			),
		):
			self.assertEqual(setup_wizard.process_setup_stages(stages, {}), {"status": "ok"})

		self.assertEqual(
			events,
			[
				"capture:initiated_server_side",
				"task:anydeals_erp",
				"complete:anydeals_erp",
				"task:frappe",
				"complete:frappe",
				"success",
				"capture:completed_server_side",
				"preference",
				"clear-cache",
			],
		)

	def test_current_wrapping_task_commits(self):
		with (
			patch.object(setup_wizard, "disable_future_access"),
			patch.dict(frappe.flags, in_provider_setup=False),
			patch.object(frappe.db, "commit") as commit,
			patch.object(frappe, "clear_cache"),
			patch.object(frappe, "get_cached_doc", return_value=None),
		):
			setup_wizard.run_post_setup_complete({})

		commit.assert_called_once_with()

	def test_builtin_success_tail_failure_keeps_current_handler_boundary(self):
		with (
			patch.object(setup_wizard, "get_setup_provider", return_value=None),
			patch.object(setup_wizard, "get_setup_wizard_completed_apps", return_value=[]),
			patch.object(setup_wizard, "run_setup_success", side_effect=RuntimeError("late failure")),
			patch.object(setup_wizard, "handle_setup_exception") as handle_setup_exception,
			patch.object(setup_wizard, "clear_cache_after_maintenance"),
			patch("frappe.utils.telemetry.capture"),
		):
			with self.assertRaisesRegex(RuntimeError, "late failure"):
				setup_wizard.process_setup_stages([], {})

		handle_setup_exception.assert_not_called()


class TestProviderSetupFinalizer(UnitTestCase):
	def provider(self):
		return SimpleNamespace(kind="erp", canonical_app="suite")

	def test_provider_tasks_are_finalized_once_in_the_success_tail(self):
		events = []
		provider = self.provider()
		stages = [
			{
				"tasks": [
					{
						"fn": lambda args: events.append("task:suite"),
						"args": {},
						"app_name": "suite",
					},
					{
						"fn": lambda args: events.append("task:frappe"),
						"args": {},
						"app_name": "frappe",
					},
				]
			}
		]

		with (
			patch.object(setup_wizard, "get_setup_provider", return_value=provider),
			patch.object(setup_wizard, "get_setup_wizard_completed_apps", return_value=[]),
			patch.object(frappe, "publish_realtime"),
			patch.object(
				setup_wizard,
				"enable_setup_wizard_complete",
				side_effect=lambda app: events.append(f"complete:{app}"),
			),
			patch.object(
				setup_wizard, "run_setup_success", side_effect=lambda args: events.append("success")
			),
			patch.object(
				setup_wizard, "finalize_provider", side_effect=lambda value: events.append("finalize")
			),
			patch.object(
				setup_wizard,
				"clear_setup_complete_request_cache",
				side_effect=lambda: events.append("cache"),
			),
			patch.object(frappe, "is_setup_complete", side_effect=lambda: events.append("re-read") or True),
			patch.object(
				setup_wizard,
				"apply_telemetry_preference",
				side_effect=lambda enabled: events.append("preference"),
			),
			patch.object(setup_wizard, "clear_cache_after_maintenance"),
			patch(
				"frappe.utils.telemetry.capture",
				side_effect=lambda event, source, **kwargs: events.append(f"capture:{event}"),
			),
		):
			self.assertEqual(setup_wizard.process_setup_stages(stages, {}), {"status": "ok"})

		self.assertEqual(
			events,
			[
				"capture:initiated_server_side",
				"task:suite",
				"task:frappe",
				"complete:frappe",
				"success",
				"finalize",
				"cache",
				"re-read",
				"capture:completed_server_side",
				"preference",
			],
		)

	def test_setup_provider_is_selected_by_task_owner(self):
		descriptor = SimpleNamespace(canonical_app="suite", kind="erp")
		provider = SimpleNamespace(
			canonical_app="suite", kind="erp", state=setup_wizard.ProviderBindingState.FRESH
		)
		stages = [{"tasks": [{"app_name": "suite"}, {"app_name": "frappe"}]}]
		with (
			patch.object(frappe.utils, "_get_provider_descriptors", return_value=(descriptor,)),
			patch.object(frappe.utils, "get_capability_provider", return_value=provider) as get_provider,
		):
			self.assertIs(setup_wizard.get_setup_provider(stages), provider)

		get_provider.assert_called_once_with("erp")

	def test_setup_without_provider_owner_keeps_builtin_path(self):
		descriptor = SimpleNamespace(canonical_app="suite", kind="erp")
		with (
			patch.object(frappe.utils, "_get_provider_descriptors", return_value=(descriptor,)),
			patch.object(frappe.utils, "get_capability_provider") as get_provider,
		):
			self.assertIsNone(setup_wizard.get_setup_provider([{"tasks": [{"app_name": "frappe"}]}]))

		get_provider.assert_not_called()

	def test_multiple_setup_provider_owners_fail_closed(self):
		descriptors = (
			SimpleNamespace(canonical_app="suite", kind="erp"),
			SimpleNamespace(canonical_app="search", kind="search"),
		)
		stages = [{"tasks": [{"app_name": "suite"}, {"app_name": "search"}]}]
		with patch.object(frappe.utils, "_get_provider_descriptors", return_value=descriptors):
			with self.assertRaisesRegex(setup_wizard.ProviderContractError, "more than one Provider"):
				setup_wizard.get_setup_provider(stages)

	def test_finalizer_writes_three_states_in_order_without_commit(self):
		events = []
		with (
			patch.object(frappe.db, "set_value", side_effect=lambda *args: events.append("completion")),
			patch.object(frappe.db, "get_global", return_value='{"search": "search_app"}'),
			patch.object(
				frappe.db,
				"set_global",
				side_effect=lambda *args: events.append(("binding", json.loads(args[1]))),
			),
			patch.object(frappe.db, "set_single_value", side_effect=lambda *args: events.append("system")),
			patch.object(frappe.db, "commit") as commit,
		):
			setup_wizard.finalize_provider(self.provider())

		self.assertEqual(
			events,
			[
				"completion",
				("binding", {"search": "search_app", "erp": "suite"}),
				"system",
			],
		)
		commit.assert_not_called()

	def test_finalizer_stops_at_each_failed_write(self):
		for failed_method in ("set_value", "set_global", "set_single_value"):
			with self.subTest(failed_method=failed_method):
				methods = {
					name: MagicMock(side_effect=RuntimeError(name) if name == failed_method else None)
					for name in ("set_value", "set_global", "set_single_value")
				}
				with (
					patch.object(frappe.db, "set_value", methods["set_value"]),
					patch.object(frappe.db, "get_global", return_value="{}"),
					patch.object(frappe.db, "set_global", methods["set_global"]),
					patch.object(frappe.db, "set_single_value", methods["set_single_value"]),
					patch.object(frappe.db, "commit") as commit,
				):
					with self.assertRaisesRegex(RuntimeError, failed_method):
						setup_wizard.finalize_provider(self.provider())
				commit.assert_not_called()

	def test_clears_only_setup_complete_request_cache_bucket(self):
		def unrelated():
			pass

		request_cache = defaultdict(dict)
		request_cache[frappe.is_setup_complete.__wrapped__][()] = False
		request_cache[unrelated][()] = "keep"
		with patch.object(frappe.local, "request_cache", request_cache):
			setup_wizard.clear_setup_complete_request_cache()

		self.assertNotIn(frappe.is_setup_complete.__wrapped__, request_cache)
		self.assertEqual(request_cache[unrelated][()], "keep")

	def test_provider_wrapping_does_not_commit(self):
		with (
			patch.object(setup_wizard, "disable_future_access"),
			patch.dict(frappe.flags, in_provider_setup=True),
			patch.object(frappe.db, "commit") as commit,
			patch.object(frappe, "clear_cache"),
			patch.object(frappe, "get_cached_doc", return_value=None),
		):
			setup_wizard.run_post_setup_complete({})

		commit.assert_not_called()

	def test_each_late_failure_rolls_back_and_uses_existing_failure_response(self):
		provider = self.provider()
		for failed_step in ("finalizer", "re-read", "preference"):
			with self.subTest(failed_step=failed_step):
				finalizer_error = RuntimeError("finalizer") if failed_step == "finalizer" else None
				preference_error = RuntimeError("preference") if failed_step == "preference" else None
				with (
					patch.object(setup_wizard, "get_setup_provider", return_value=provider),
					patch.object(setup_wizard, "get_setup_wizard_completed_apps", return_value=[]),
					patch.object(setup_wizard, "run_setup_success"),
					patch.object(setup_wizard, "finalize_provider", side_effect=finalizer_error),
					patch.object(setup_wizard, "clear_setup_complete_request_cache"),
					patch.object(frappe, "is_setup_complete", return_value=failed_step != "re-read"),
					patch.object(setup_wizard, "apply_telemetry_preference", side_effect=preference_error),
					patch.object(setup_wizard, "handle_setup_exception") as handle_setup_exception,
					patch.object(setup_wizard, "clear_cache_after_maintenance"),
					patch.object(frappe, "log_error"),
					patch.object(frappe, "publish_realtime"),
					patch("frappe.utils.telemetry.capture"),
				):
					with self.assertRaises(Exception):
						setup_wizard.process_setup_stages([], {})

				handle_setup_exception.assert_called_once_with({})
				self.assertEqual(frappe.response["setup_wizard_failure_message"], "Failed to complete setup")

	def test_background_finalizer_failure_rolls_back_and_publishes_only_failure(self):
		with (
			patch.object(setup_wizard, "get_setup_provider", return_value=self.provider()),
			patch.object(setup_wizard, "get_setup_wizard_completed_apps", return_value=[]),
			patch.object(setup_wizard, "run_setup_success"),
			patch.object(setup_wizard, "finalize_provider", side_effect=RuntimeError("finalizer")),
			patch.object(frappe.db, "rollback") as rollback,
			patch.object(setup_wizard, "clear_cache_after_maintenance"),
			patch.object(frappe, "log_error"),
			patch.object(frappe, "publish_realtime") as publish_realtime,
			patch("frappe.utils.telemetry.capture"),
		):
			self.assertIsNone(setup_wizard.process_setup_stages([], {}, is_background_task=True))

		rollback.assert_called_once_with()
		publish_realtime.assert_called_once_with(
			"setup_task",
			{"status": "fail", "fail_msg": "Failed to complete setup"},
			user=frappe.session.user,
		)

	def test_retry_after_committed_stage_reuses_authority_and_finalizes_once(self):
		provider = self.provider()
		authority = set()
		finalizer_attempts = 0

		def run_committed_stage(args):
			authority.add("regional-field")

		def finalize(value):
			nonlocal finalizer_attempts
			finalizer_attempts += 1
			if finalizer_attempts == 1:
				raise RuntimeError("late failure")
			authority.add((value.kind, value.canonical_app))

		stages = [{"tasks": [{"fn": run_committed_stage, "args": {}, "app_name": provider.canonical_app}]}]
		with (
			patch.object(setup_wizard, "get_setup_provider", return_value=provider),
			patch.object(setup_wizard, "get_setup_wizard_completed_apps", return_value=[]),
			patch.object(setup_wizard, "enable_setup_wizard_complete") as mark_complete,
			patch.object(setup_wizard, "run_setup_success"),
			patch.object(setup_wizard, "finalize_provider", side_effect=finalize),
			patch.object(setup_wizard, "clear_setup_complete_request_cache"),
			patch.object(frappe, "is_setup_complete", return_value=True),
			patch.object(setup_wizard, "apply_telemetry_preference"),
			patch.object(setup_wizard, "handle_setup_exception"),
			patch.object(setup_wizard, "clear_cache_after_maintenance"),
			patch.object(frappe, "log_error"),
			patch.object(frappe, "publish_realtime"),
			patch("frappe.utils.telemetry.capture"),
		):
			with self.assertRaisesRegex(RuntimeError, "late failure"):
				setup_wizard.process_setup_stages(stages, {})
			self.assertEqual(setup_wizard.process_setup_stages(stages, {}), {"status": "ok"})

		self.assertEqual(authority, {"regional-field", ("erp", "suite")})
		self.assertEqual(finalizer_attempts, 2)
		mark_complete.assert_not_called()
