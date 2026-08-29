#!/usr/bin/env python3
"""Reject direct DDL outside Frappe's schema and migration boundaries."""

from __future__ import annotations

import ast
import re
import sys

DDL = re.compile(r"^\s*(?:alter|create|drop|truncate|rename)\b", re.I)

ALLOWED_PREFIXES = ("frappe/database/", "frappe/patches/", "frappe/tests/")
ALLOWED_FILES = {
	"frappe/commands/site.py",
	"frappe/core/doctype/log_settings/log_settings.py",
	"frappe/email/doctype/email_queue/patches/drop_search_index_on_message_id.py",
	"frappe/installer.py",
	"frappe/model/meta.py",
	"frappe/model/rename_doc.py",
}


def _static_text(node: ast.AST | None) -> str | None:
	if isinstance(node, ast.Constant) and isinstance(node.value, str):
		return node.value
	if isinstance(node, ast.JoinedStr):
		return "".join(
			part.value if isinstance(part, ast.Constant) and isinstance(part.value, str) else "?"
			for part in node.values
		)
	if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add | ast.Mod):
		left = _static_text(node.left)
		right = _static_text(node.right) if isinstance(node.op, ast.Add) else "?"
		return left + right if left is not None and right is not None else None
	if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "format":
		return _static_text(node.func.value)
	return None


def _call_name(node: ast.Call) -> str:
	return (
		node.func.attr
		if isinstance(node.func, ast.Attribute)
		else (node.func.id if isinstance(node.func, ast.Name) else "")
	)


def _query_arg(node: ast.Call) -> ast.AST | None:
	if node.args:
		return node.args[0]
	return next(
		(keyword.value for keyword in node.keywords if keyword.arg in {"query", "query_string"}), None
	)


def _normalized_path(path: str) -> str:
	return path.replace("\\", "/").removeprefix("./")


def _path_allowed(path: str, functions: list[str]) -> bool:
	path = _normalized_path(path)
	if path == "frappe/commands/utils.py":
		return functions[-1:] == ["transform_database"]
	return (
		path in ALLOWED_FILES
		or path.startswith(ALLOWED_PREFIXES)
		or (path.startswith("frappe/") and path.rsplit("/", 1)[-1].startswith("test_"))
	)


class Visitor(ast.NodeVisitor):
	def __init__(self, path: str):
		self.path = path
		self.functions: list[str] = []
		self.violations: list[tuple[int, str]] = []

	def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
		self.functions.append(node.name)
		self.generic_visit(node)
		self.functions.pop()

	visit_AsyncFunctionDef = visit_FunctionDef

	def visit_Call(self, node: ast.Call) -> None:
		name = _call_name(node)
		is_direct_ddl = name == "sql_ddl"
		if name == "sql":
			query = _static_text(_query_arg(node))
			is_direct_ddl = query is not None and DDL.search(query) is not None

		if is_direct_ddl and not _path_allowed(self.path, self.functions):
			self.violations.append(
				(getattr(node, "lineno", 1), "direct DDL must use an approved schema or migration boundary")
			)
		self.generic_visit(node)


def check_source(source: str, path: str) -> list[str]:
	try:
		tree = ast.parse(source, filename=path)
	except SyntaxError:
		return []
	visitor = Visitor(path)
	visitor.visit(tree)
	return [f"{path}:{line}: [ddl-boundary] {message}" for line, message in sorted(set(visitor.violations))]


def check_file(path: str) -> list[str]:
	try:
		with open(path, encoding="utf-8") as source_file:
			return check_source(source_file.read(), path)
	except (OSError, UnicodeDecodeError):
		return []


def main(argv: list[str]) -> int:
	if not argv:
		print("ddl-boundary: no Python files selected", file=sys.stderr)
		return 2
	violations = [violation for path in argv if path.endswith(".py") for violation in check_file(path)]
	if violations:
		print("\n".join(violations))
		print(f"\n{len(violations)} DDL boundary violation(s); inline suppression is not supported.")
		return 1
	return 0


if __name__ == "__main__":
	raise SystemExit(main(sys.argv[1:]))
