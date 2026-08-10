// Copyright (c) 2019, Frappe Technologies Pvt. Ltd. and Contributors
// MIT License. See license.txt

/**
 * `/app/dashboard-view/<reference>` — the one desk dashboard route, drawn by
 * whichever renderer the bridge names: the `insights.dashboard` island, or the
 * legacy widget dashboard below.
 *
 * One route rather than a second page beside this one: every link ever written
 * to a desk dashboard points here, so a site that turns Insights rendering on
 * upgrades where it stands instead of having its sidebars rewritten.
 *
 * The page asks the bridge one question per route and branches on the answer.
 * What the reference names, and which renderer that implies, is entirely
 * `frappe/utils/dashboard_renderer.py`'s to say.
 */

frappe.provide("frappe.dashboards");
frappe.provide("frappe.dashboards.chart_sources");

const ISLAND = "insights.dashboard";

// Set on <body> while the island renderer is the one on screen. It is what
// `dashboard_view.scss` keys the bounded page shell off — see the comment there
// for why the shell stops document-scrolling on this page. The legacy renderer
// below grows with its widgets and must keep the scroll it has always had, so
// the route alone cannot say it.
const ISLAND_PAGE_CLASS = "dashboard-view-island-page";

frappe.pages["dashboard-view"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Dashboard"),
		single_column: true,
	});

	// This route draws no page head by default. The island renders its own header
	// inside its own tree, and desk's would be a second, emptier one above it —
	// off from the start rather than off once the bridge answers, because that
	// answer is a round trip on a site that has Insights and the head would sit
	// on screen for all of it. The legacy renderer asks for it back when it draws.
	//
	// The page itself stays: the body sidebar and the workspace dock resolve
	// their visibility against it, so a route with no page would lose the app
	// frame too.
	page.toggle_page_head(false);

	// A container per renderer, both made up front: the legacy renderer empties
	// what it is given, so the two must never share a parent they draw into.
	const content = $(wrapper).find(".page-content").empty();
	const legacy_container = $('<div class="dashboard-view-legacy">').appendTo(content);
	const island_container = $('<div class="dashboard-view-island">').appendTo(content);

	// The legacy renderer has been reachable as `frappe.dashboard` for years.
	frappe.dashboard = new Dashboard(legacy_container, page);
	const insights = new InsightsDashboard(island_container, page);

	$(wrapper).on("show", async () => {
		const route = frappe.get_route_str();
		const reference = frappe.get_route().slice(1).join("/");

		const renderer = await frappe.ui.get_dashboard_renderer(reference);
		// The route can move, inside this page or off it, while the bridge answers.
		if (frappe.get_route_str() !== route) return;

		if (renderer === "insights") {
			frappe.dashboard.hide();
			insights.show(reference);
		} else {
			insights.hide();
			frappe.dashboard.show();
		}
	});

	$(wrapper).on("hide", () => insights.hide());
};

/**
 * The Insights renderer: one container the `insights.dashboard` island renders
 * into. The island owns the whole page — its own header (breadcrumbs, title,
 * freshness, actions), the filter bar, the grid, and every state, including the
 * quiet one it shows when the reference resolves to nothing. Desk's page head is
 * hidden while it is on screen, so the page has one header rather than an empty
 * one above a full one.
 *
 * The reference is handed over as the route wrote it: a reference can span
 * segments (`insights/sales-performance`), and what one names is Insights' to
 * resolve, never desk's to parse.
 */
class InsightsDashboard {
	constructor(container, page) {
		this.root = container;
		this.container = container[0];
		this.page = page;

		// The island is mounted once and re-pointed after that. Desk keeps the page
		// alive across route changes within it, so a new reference is a prop update —
		// the island re-fetches, the Vue app and its shadow root stay put.
		this.handle = null;
		this.mounting = false;
		this.reference = null;
	}

	show(reference) {
		this.root.show();
		document.body.classList.add(ISLAND_PAGE_CLASS);

		// The head is off for this route already. What it used to carry here was
		// worse than what the island says in its own header anyway: a generic
		// "Dashboard" title (the real one arrives with the island's fetch) and a
		// breadcrumb that went blank whenever the route moved inside the page.
		// The menu belongs to whichever renderer is on screen, so the legacy
		// one's entries go when it leaves.
		this.page.clear_menu();

		if (this.handle || this.mounting) {
			if (reference === this.reference) return;
			this.reference = reference;
			this.handle?.update({ dashboard: reference });
			return;
		}

		this.reference = reference;
		this.mounting = true;
		frappe.ui
			.mount_island(ISLAND, this.container, { props: { dashboard: reference } })
			.then((island) => {
				this.mounting = false;
				// The page can be left, or a legacy dashboard routed to inside it,
				// while the island's module loads. Both clear the reference.
				if (this.reference === null) return island.unmount();
				this.handle = island;
				this.handle.update({ dashboard: this.reference });
			})
			.catch((error) => {
				this.mounting = false;
				console.error(`could not mount the "${ISLAND}" island`, error);
			});
	}

	hide() {
		this.root.hide();
		document.body.classList.remove(ISLAND_PAGE_CLASS);
		this.reference = null;
		this.handle?.unmount();
		this.handle = null;
	}
}

class Dashboard {
	constructor(container, page) {
		this.root = container;
		$(`<div class="dashboard" style="overflow: visible; margin: var(--margin-md);">
			<div class="dashboard-graph"></div>
		</div>`).appendTo(container.empty());
		this.container = container.find(".dashboard-graph");
		this.page = page;
	}

	show() {
		this.root.show();
		// widgets, a page title and a breadcrumb: this renderer draws into desk's
		// head, so it asks for it back.
		this.page.toggle_page_head(true);
		this.route = frappe.get_route();
		this.set_breadcrumbs();
		if (this.route.length > 1) {
			// from route
			this.show_dashboard(this.route.slice(-1)[0]);
		} else {
			// last opened
			if (frappe.last_dashboard) {
				frappe.set_re_route("dashboard-view", frappe.last_dashboard);
			} else {
				// default dashboard
				frappe.db.get_list("Dashboard", { filters: { is_default: 1 } }).then((data) => {
					if (data && data.length) {
						frappe.set_re_route("dashboard-view", data[0].name);
					} else {
						// no default, get the latest one
						frappe.db.get_list("Dashboard", { limit: 1 }).then((data) => {
							if (data && data.length) {
								frappe.set_re_route("dashboard-view", data[0].name);
							} else {
								// create a new dashboard!
								frappe.new_doc("Dashboard");
							}
						});
					}
				});
			}
		}
	}

	// Giving up the page means giving up its menu and its body, so the next show
	// draws both again. Only a renderer switch inside the page gets here; leaving
	// the page keeps what was drawn, as it always has.
	hide() {
		this.root.hide();
		this.dashboard_name = null;
	}

	show_dashboard(current_dashboard_name) {
		if (this.dashboard_name !== current_dashboard_name) {
			this.dashboard_name = current_dashboard_name;
			let title = this.dashboard_name;
			if (!this.dashboard_name.toLowerCase().includes(__("dashboard"))) {
				// ensure dashboard title has "dashboard"
				title = __("{0} Dashboard", [__(title)]);
			}
			this.page.set_title(__(title));
			this.set_dropdown();
			this.container.empty();
			this.refresh();
		}
		this.charts = {};
		frappe.last_dashboard = current_dashboard_name;
	}

	set_breadcrumbs() {
		frappe.breadcrumbs.add("Desk", "Dashboard");
	}

	refresh() {
		frappe.run_serially([() => this.render_cards(), () => this.render_charts()]);
	}

	render_charts() {
		return this.get_permitted_items(
			"frappe.desk.doctype.dashboard.dashboard.get_permitted_charts"
		).then((charts) => {
			if (!charts.length) {
				return;
			}

			frappe.dashboard_utils.get_dashboard_settings().then((settings) => {
				let chart_config = settings.chart_config ? JSON.parse(settings.chart_config) : {};
				this.charts = charts.map((chart) => {
					return {
						chart_name: chart.chart,
						label: chart.chart,
						chart_settings: chart_config[chart.chart] || {},
						...chart,
					};
				});

				this.chart_group = new frappe.widget.WidgetGroup({
					title: null,
					container: this.container,
					type: "chart",
					columns: 2,
					options: {
						allow_sorting: false,
						allow_create: false,
						allow_delete: false,
						allow_hiding: false,
						allow_edit: false,
					},
					widgets: this.charts,
				});
			});
		});
	}

	render_cards() {
		return this.get_permitted_items(
			"frappe.desk.doctype.dashboard.dashboard.get_permitted_cards"
		).then((cards) => {
			if (!cards.length) {
				return;
			}

			this.number_cards = cards.map((card) => {
				return {
					name: card.card,
				};
			});

			this.number_card_group = new frappe.widget.WidgetGroup({
				container: this.container,
				type: "number_card",
				columns: 3,
				options: {
					allow_sorting: false,
					allow_create: false,
					allow_delete: false,
					allow_hiding: false,
					allow_edit: false,
				},
				widgets: this.number_cards,
			});
		});
	}

	get_permitted_items(method) {
		return frappe
			.xcall(method, {
				dashboard_name: this.dashboard_name,
			})
			.then((items) => {
				return items;
			});
	}

	set_dropdown() {
		this.page.clear_menu();

		this.page.add_menu_item(__("Edit"), () => {
			frappe.set_route("Form", "Dashboard", frappe.dashboard.dashboard_name);
		});

		this.page.add_menu_item(__("New"), () => {
			frappe.new_doc("Dashboard");
		});

		this.page.add_menu_item(__("Refresh All"), () => {
			this.chart_group && this.chart_group.widgets_list.forEach((chart) => chart.refresh());
			this.number_card_group &&
				this.number_card_group.widgets_list.forEach((card) => card.render_card());
		});

		frappe.db.get_list("Dashboard").then((dashboards) => {
			dashboards.map((dashboard) => {
				let name = dashboard.name;
				if (name != this.dashboard_name) {
					this.page.add_menu_item(
						name,
						() => frappe.set_route("dashboard-view", name),
						1
					);
				}
			});
		});
	}
}
