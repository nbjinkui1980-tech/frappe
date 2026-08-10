// Desk island mount contract.
//
// The island under test is a fixture built in the browser: an ESM blob
// registered in `frappe.boot.assets_json` under the `.island.js` key convention
// and declared in `frappe.boot.ui_islands`, exactly as a real app's build and
// hooks.py would. That keeps the spec on framework's seam and off any app.
//
// Needs the island runtime built (`bench build --app frappe` writes the
// `.runtime.js` keys into assets.json). If the desk page carries no import map
// — no app on the test site declares an island — the spec installs one from
// assets.json before anything loads a module, which is the same map the server
// renders.

const ISLAND = "frappe.cypress_fixture";
const BUNDLE = "cypress_fixture";

const FIXTURE_MODULE = `
	import { h, inject, onMounted } from "vue";

	const HOST = Symbol.for("frappe:island-host");

	const Fixture = {
		props: { label: { type: String, default: "" } },
		emits: ["ready"],
		setup(props, { emit }) {
			const host = inject(HOST);
			window.__island_creations = (window.__island_creations || 0) + 1;
			onMounted(() => emit("ready", host));
			return () =>
				h("div", { class: "fixture", "data-theme-seen": host.theme }, props.label);
		},
	};

	export function mount(el, context) {
		window.__island_host = context.host;
		return window.frappe.ui.mount_vue_island(el, {
			...context,
			component: Fixture,
			configure: () => {
				window.__island_configured = (window.__island_configured || 0) + 1;
				window.__island_creations_at_configure = window.__island_creations || 0;
			},
		});
	}
`;

const FIXTURE_CSS = `.fixture { color: rgb(1, 2, 3); }`;

function blob_url(win, source, type) {
	return win.URL.createObjectURL(new win.Blob([source], { type }));
}

function register_fixture(win) {
	win.frappe.boot.assets_json[`${BUNDLE}.island.js`] = blob_url(
		win,
		FIXTURE_MODULE,
		"text/javascript"
	);
	win.frappe.boot.assets_json[`${BUNDLE}.island.css`] = blob_url(win, FIXTURE_CSS, "text/css");
	win.frappe.boot.ui_islands = { ...win.frappe.boot.ui_islands, [ISLAND]: BUNDLE };
}

// An import map is rejected once module loading has started. Desk loads only
// classic scripts, so a map added right after the page settles still applies.
function ensure_import_map(win) {
	if (win.document.querySelector('script[type="importmap"]')) return;

	const imports = {};
	for (const [key, url] of Object.entries(win.frappe.boot.assets_json)) {
		if (key.endsWith(".runtime.js")) imports[key.slice(0, -".runtime.js".length)] = url;
	}
	expect(imports.vue, "island runtime is built").to.be.a("string");

	const script = win.document.createElement("script");
	script.type = "importmap";
	script.textContent = JSON.stringify({ imports });
	win.document.head.appendChild(script);
}

function host_element(win, id) {
	const el = win.document.createElement("div");
	el.id = id;
	win.document.querySelector("#body").appendChild(el);
	return el;
}

context("Island", () => {
	before(() => {
		cy.login();
	});

	beforeEach(() => {
		cy.visit("/app/website");
		cy.window().then((win) => {
			ensure_import_map(win);
			register_fixture(win);
			win.__island_creations = 0;
			win.__island_configured = 0;
		});
	});

	it("mounts an island into a shadow root", () => {
		cy.window().then((win) => {
			const el = host_element(win, "island-1");
			return win.frappe.ui
				.mount_island(ISLAND, el, { props: { label: "hello" } })
				.then(() => {
					const root = el.querySelector(".frappe-island").shadowRoot;
					expect(root.querySelector(".fixture").textContent).to.equal("hello");
					expect(root.querySelector(".frappe-island-portal")).to.exist;
				});
		});
	});

	it("injects the host context and tracks desk's theme", () => {
		cy.window().then((win) => {
			const el = host_element(win, "island-2");
			return win.frappe.ui.mount_island(ISLAND, el, {}).then(() => {
				const host = win.__island_host;
				expect(host.user).to.equal(win.frappe.session.user);
				expect(host.locale).to.be.a("string");
				expect(host.base_url).to.be.a("string");
				expect(host.theme).to.equal(win.frappe.ui.get_current_theme());

				const root = el.querySelector(".frappe-island").shadowRoot;
				expect(
					root.querySelector(".frappe-island-root").getAttribute("data-theme")
				).to.equal(host.theme);

				win.frappe.ui.set_theme("dark");
				return Cypress.Promise.delay(50).then(() => {
					expect(host.theme).to.equal("dark");
					expect(
						root.querySelector(".fixture").getAttribute("data-theme-seen")
					).to.equal("dark");
					win.frappe.ui.set_theme("light");
				});
			});
		});
	});

	it("calls configure(app) before the app is mounted", () => {
		cy.window().then((win) => {
			const el = host_element(win, "island-3");
			return win.frappe.ui.mount_island(ISLAND, el, {}).then(() => {
				expect(win.__island_configured).to.equal(1);
				// The root component had not been created yet — plugins and
				// global components registered here are in place for it.
				expect(win.__island_creations_at_configure).to.equal(0);
				expect(win.__island_creations).to.equal(1);
			});
		});
	});

	it("routes `on` callbacks to the island", () => {
		cy.window().then((win) => {
			const el = host_element(win, "island-4");
			const ready = cy.stub();
			return win.frappe.ui.mount_island(ISLAND, el, { on: { ready } }).then(() => {
				expect(ready).to.have.been.calledOnce;
			});
		});
	});

	it("update(props) re-renders without re-creating the island", () => {
		cy.window().then((win) => {
			const el = host_element(win, "island-5");
			return win.frappe.ui
				.mount_island(ISLAND, el, { props: { label: "before" } })
				.then((island) => {
					island.update({ label: "after" });
					return Cypress.Promise.delay(50).then(() => {
						const root = el.querySelector(".frappe-island").shadowRoot;
						expect(root.querySelector(".fixture").textContent).to.equal("after");
						expect(win.__island_creations).to.equal(1);
					});
				});
		});
	});

	it("unmounts idempotently", () => {
		cy.window().then((win) => {
			const el = host_element(win, "island-6");
			return win.frappe.ui.mount_island(ISLAND, el, {}).then((island) => {
				island.unmount();
				island.unmount();
				expect(el.querySelector(".frappe-island")).to.be.null;
			});
		});
	});

	it("shares one runtime stylesheet across every island root", () => {
		cy.window().then((win) => {
			const first = host_element(win, "island-7a");
			const second = host_element(win, "island-7b");
			return win.frappe.ui
				.mount_island(ISLAND, first, {})
				.then(() => win.frappe.ui.mount_island(ISLAND, second, {}))
				.then(() => {
					const a = first.querySelector(".frappe-island").shadowRoot;
					const b = second.querySelector(".frappe-island").shadowRoot;
					// Same object, not just same content: fetched once, parsed once.
					expect(a.adoptedStyleSheets[0]).to.equal(b.adoptedStyleSheets[0]);
					// The island's own sheet is adopted after the runtime's, so
					// app styles win ties.
					expect(a.adoptedStyleSheets).to.have.length(2);
					expect(a.adoptedStyleSheets[1].cssRules[0].selectorText).to.equal(".fixture");
				});
		});
	});

	it("explains an island name no app declares", () => {
		cy.window().then((win) => {
			const el = host_element(win, "island-8");
			return win.frappe.ui.mount_island("nosuchapp.nosuchisland", el, {}).then(
				() => {
					throw new Error("expected mount_island to reject");
				},
				(e) => {
					expect(e.message).to.contain("ui_islands");
				}
			);
		});
	});

	it("leaves classic bundles on the page working", () => {
		cy.window().then((win) => {
			const el = host_element(win, "island-9");
			return win.frappe.ui
				.mount_island(ISLAND, el, {})
				.then(() => win.frappe.require("dialog.bundle.js"))
				.then(() => {
					const dialog = new win.frappe.ui.Dialog({ title: "classic" });
					dialog.show();
					expect(dialog.$wrapper.find(".modal-title").text()).to.contain("classic");
					dialog.hide();
				});
		});
	});
});
