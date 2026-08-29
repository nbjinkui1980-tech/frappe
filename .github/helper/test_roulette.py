import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROULETTE_PATH = Path(__file__).with_name("roulette.py")
SPEC = importlib.util.spec_from_file_location("roulette", ROULETTE_PATH)
roulette = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(roulette)


class PostgresFullClassifierTest(unittest.TestCase):
	def test_change_truth_table(self):
		cases = {
			"docs only": (["README.md", "docs/demo.png"], False),
			"ci yaml": ([".github/workflows/server-tests.yml"], True),
			"ci helper": ([".github/helper/roulette.py"], True),
			"database code": (["frappe/database/database.py"], True),
			"mixed docs and ci": (["README.md", ".github/workflows/server-tests.yml"], True),
			"mixed docs and database code": (["README.md", "frappe/model/document.py"], True),
			"unrelated code": (["frappe/utils/data.py"], False),
		}
		for name, (files, expected) in cases.items():
			with self.subTest(name=name):
				self.assertEqual(roulette.requires_postgres_full(files), expected)

	def test_release_candidate_outputs_both_databases(self):
		with tempfile.NamedTemporaryFile() as output:
			env = os.environ | {
				"GITHUB_EVENT_NAME": "workflow_dispatch",
				"GITHUB_OUTPUT": output.name,
				"RELEASE_CANDIDATE": "true",
			}
			subprocess.run([sys.executable, str(ROULETTE_PATH)], check=True, env=env)
			output.seek(0)
			self.assertEqual(output.read().decode().splitlines(), ["build=strawberry", "run_postgres=true"])


if __name__ == "__main__":
	unittest.main()
