// Fixture island entry: the `mount(el, { host, props, on })` envelope.
import { createApp, reactive } from "vue";
import Panel from "./Panel.vue";
import "./panel.css";

export function mount(el, { host, props = {}, on = {} } = {}) {
	const state = reactive({ ...props });
	const app = createApp(Panel, state);
	app.provide("host", host);
	app.mount(el);

	return {
		update: (next) => Object.assign(state, next),
		unmount: () => {
			app.unmount();
			on.unmounted?.();
		},
	};
}
