# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and Contributors
# License: MIT. See LICENSE
import json

import click

import frappe
from frappe.commands import get_site, pass_context
from frappe.utils.bench_helper import CliCtxObj


@click.command(
	"typed-semantics-v2",
	help="Scan and backfill legacy empty-string typed column values ('' -> NULL) for typed semantics v2",
)
@click.option("--dry-run", is_flag=True, default=False, help="Read-only scan; requires --report")
@click.option(
	"--report",
	"report_path",
	type=click.Path(dir_okay=False),
	help="Plan/report JSON output path (with --dry-run)",
)
@click.option("--apply", "apply_flag", is_flag=True, default=False, help="Apply a plan; requires --plan")
@click.option(
	"--plan",
	"plan_path",
	type=click.Path(exists=True, dir_okay=False),
	help="Plan JSON from --dry-run (with --apply)",
)
@pass_context
def typed_semantics_v2(context: CliCtxObj, dry_run: bool, report_path: str, apply_flag: bool, plan_path: str):
	from frappe.database.typed_semantics_migration import apply_plan, build_plan

	if dry_run == apply_flag:
		raise click.UsageError("pass exactly one of --dry-run or --apply")
	if dry_run and (not report_path or plan_path):
		raise click.UsageError("--dry-run requires --report <json> and does not take --plan")
	if apply_flag and (not plan_path or report_path):
		raise click.UsageError("--apply requires --plan <json> and does not take --report")

	site = get_site(context)
	frappe.init(site)
	frappe.connect()

	try:
		if dry_run:
			plan = build_plan()
			with open(report_path, "w") as f:
				json.dump(plan, f, indent=2, sort_keys=True, default=str)
			classification = plan["classification"]
			candidates = sum(c["empty_string_rows"] for c in plan["writable_columns"])
			invalid = sum(c["invalid_json_rows"] for c in plan["writable_columns"])
			click.echo(
				f"plan written to {report_path}: writable={classification['writable']}"
				f" report_only={classification['report_only']} unknown={classification['unknown']}"
				f" empty_string_candidates={candidates} invalid_json_rows={invalid}"
			)
			return

		if not frappe.conf.get("maintenance_mode"):
			raise click.ClickException(
				"enable maintenance mode first: bench --site {} set-config maintenance_mode 1".format(site)
			)

		with open(plan_path) as f:
			plan = json.load(f)
		try:
			stats = apply_plan(plan)
		except ValueError as e:
			raise click.ClickException(str(e)) from e
		click.secho(
			f"applied plan: {stats['columns_written']} columns, audit rescan clean.",
			fg="green",
		)
		click.echo("next step: bench --site {} set-config typed_semantics_v2 1".format(site))
	except click.ClickException:
		raise
	except Exception as e:
		frappe.db.rollback()
		raise click.ClickException(str(e)) from e


commands = [typed_semantics_v2]
