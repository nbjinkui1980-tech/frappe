import json
import tempfile
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch

import frappe
from frappe.installer import sync_installed_apps_to_site_config_strict
from frappe.tests import UnitTestCase


class TestStrictInstalledAppsMirror(UnitTestCase):
	def setUp(self):
		super().setUp()
		self.directory = tempfile.TemporaryDirectory()
		self.addCleanup(self.directory.cleanup)
		self.config = Path(self.directory.name) / "site_config.json"
		self.original = {"db_name": "test", "installed_apps": ["erpnext"]}

	def _reset_config(self):
		self.config.write_text(json.dumps(self.original), encoding="utf-8")

	def _call(self, *, readback=None):
		if readback is None:

			def readback(**kwargs):
				return frappe._dict(json.loads(self.config.read_text(encoding="utf-8")))

		with (
			patch("frappe.installer.get_site_config_path", return_value=str(self.config)),
			patch("frappe.installer.filelock", return_value=nullcontext()),
			patch("frappe.config.clear_site_config_cache"),
			patch("frappe.config.get_site_config", side_effect=readback),
		):
			sync_installed_apps_to_site_config_strict(["anydeals_erp"])

	def test_strict_mirror_preserves_config_and_reads_back_exact_order(self):
		self._reset_config()
		self._call()
		self.assertEqual(
			json.loads(self.config.read_text(encoding="utf-8")),
			{"db_name": "test", "installed_apps": ["anydeals_erp"]},
		)

	def test_strict_mirror_fails_at_each_atomic_write_boundary(self):
		failures = (
			("temporary write", "frappe.installer.json.dump"),
			("fsync", "frappe.installer.os.fsync"),
			("replace", "frappe.installer.os.replace"),
		)
		for stage, target in failures:
			with self.subTest(stage=stage):
				self._reset_config()
				with patch(target, side_effect=OSError(stage)), self.assertRaisesRegex(OSError, stage):
					self._call()
				self.assertEqual(json.loads(self.config.read_text(encoding="utf-8")), self.original)
				self.assertEqual(list(self.config.parent.glob(".site_config.*.tmp")), [])

	def test_strict_mirror_rejects_readback_mismatch(self):
		self._reset_config()
		with self.assertRaisesRegex(RuntimeError, "readback mismatch"):
			self._call(readback=lambda **kwargs: frappe._dict(installed_apps=["erpnext"]))
