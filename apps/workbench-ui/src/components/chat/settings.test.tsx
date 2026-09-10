import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { apiFetch } from "../../auth";
import { SettingsPanel } from "./settings";

vi.mock("../../auth", () => ({ apiFetch: vi.fn() }));
const api = vi.mocked(apiFetch);
const response = (data: unknown, ok = true) =>
	({ ok, json: async () => data }) as Response;

function mount() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<SettingsPanel />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});

it("leaving an untouched optional field does not write empty defaults", async () => {
	api.mockResolvedValue(response({ provider: "claude" }));
	mount();
	const model = await screen.findByLabelText("模型");
	fireEvent.focus(model);
	fireEvent.blur(model);
	expect(
		api.mock.calls.filter(([, init]) => init?.method === "PATCH"),
	).toHaveLength(0);
});

it("a late save response does not overwrite newer input", async () => {
	let finish!: (value: Response) => void;
	const pending = new Promise<Response>((resolve) => {
		finish = resolve;
	});
	api.mockImplementation(async (_, init) =>
		init?.method === "PATCH"
			? pending
			: response({ provider: "claude", model: "original" }),
	);
	mount();
	const model = await screen.findByLabelText("模型");
	fireEvent.change(model, { target: { value: "saved-value" } });
	fireEvent.blur(model);
	await waitFor(() =>
		expect(api.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(
			true,
		),
	);
	fireEvent.change(model, { target: { value: "newer-input" } });
	await act(async () =>
		finish(response({ provider: "claude", model: "saved-value" })),
	);
	expect(model).toHaveValue("newer-input");
});

it("failed saves keep the input and can be retried", async () => {
	let fail = true;
	api.mockImplementation(async (_, init) =>
		init?.method === "PATCH"
			? response({ provider: "claude", model: "edited" }, !fail)
			: response({ provider: "claude", model: "original" }),
	);
	mount();
	const model = await screen.findByLabelText("模型");
	fireEvent.change(model, { target: { value: "edited" } });
	fireEvent.blur(model);
	await screen.findByRole("alert");
	expect(model).toHaveValue("edited");
	expect(screen.queryByText("已保存")).toBeNull();
	fail = false;
	fireEvent.click(screen.getByRole("button", { name: "重试" }));
	await screen.findByText("已保存");
	expect(model).toHaveValue("edited");
});
