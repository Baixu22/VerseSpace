import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// Default 1000ms is tight for CI runners; match the root frontend suite.
configure({ asyncUtilTimeout: 3000 });

// jsdom ships no layout engine. The dashboard's primitives (assistant-ui
// viewport, radix slots) probe these lazily during mount — stub them as
// no-ops so the render smoke test exercises app code, not browser quirks.
if (typeof Element !== "undefined") {
	Element.prototype.scrollIntoView ??= () => {};
	Element.prototype.scrollTo ??= () => {};
	Element.prototype.scrollBy ??= () => {};
}

if (typeof window !== "undefined") {
	if (typeof window.ResizeObserver === "undefined") {
		class ResizeObserverMock {
			observe() {}
			unobserve() {}
			disconnect() {}
		}
		window.ResizeObserver =
			ResizeObserverMock as unknown as typeof ResizeObserver;
		globalThis.ResizeObserver =
			ResizeObserverMock as unknown as typeof ResizeObserver;
	}

	if (typeof window.matchMedia === "undefined") {
		window.matchMedia = ((query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		})) as unknown as typeof window.matchMedia;
	}
}
