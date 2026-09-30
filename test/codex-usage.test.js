import assert from "node:assert/strict";
import test from "node:test";
import registerExtension, { fetchCodexUsage, redeemCodexReset, slotForProvider } from "../extensions/codex-usage.js";

function tokenForAccount(accountId) {
	const payload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})).toString("base64url");
	return `header.${payload}.signature`;
}

function jsonResponse(payload, status = 200) {
	return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

const model = (provider) => ({
	provider,
	id: "gpt-5-codex",
	baseUrl: "https://chatgpt.com/backend-api/codex",
});

test("resolves native and numbered Codex provider IDs only", () => {
	assert.equal(slotForProvider("openai-codex"), 1);
	assert.equal(slotForProvider("openai-codex-4"), 4);
	assert.equal(slotForProvider("openai-codex-10"), 10);
	assert.equal(slotForProvider("openai-codex-1"), undefined);
	assert.equal(slotForProvider("openai-codex-04"), undefined);
	assert.equal(slotForProvider("anthropic"), undefined);
});

test("queries only selected slot auth and reports its quotas and reset credits", async () => {
	const token = tokenForAccount("acct-slot-4");
	let resolvedProvider;
	let request;
	const result = await fetchCodexUsage({
		model: model("openai-codex-4"),
		getProviderAuth: async (providerId) => {
			resolvedProvider = providerId;
			return { auth: { apiKey: token } };
		},
		fetchImpl: async (url, options) => {
			request = { url, options };
			return jsonResponse({
					plan_type: "pro",
					rate_limit: {
						primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: 2_000_000_000 },
						secondary_window: { used_percent: 60, limit_window_seconds: 604_800, reset_at: 2_000_100_000 },
					},
					rate_limit_reset_credits: { available_count: 3 },
				});
		},
	});

	assert.equal(resolvedProvider, "openai-codex-4");
	assert.equal(result.slot, 4);
	assert.match(result.text, /Codex #4 \(Pro\)/);
	assert.match(result.text, /75% remaining/);
	assert.match(result.text, /Banked reset credits: 3/);
	assert.equal(request.url, "https://chatgpt.com/backend-api/wham/usage");
	assert.equal(request.options.headers.Authorization, `Bearer ${token}`);
	assert.equal(request.options.headers["ChatGPT-Account-Id"], "acct-slot-4");
});

test("reports zero reset credits distinctly from missing reset-credit data", async () => {
	const fetchImpl = async () => jsonResponse({
		rate_limit_reset_credits: { available_count: 0 },
	});
	const getProviderAuth = async () => ({ auth: { apiKey: tokenForAccount("acct-2") } });
	const zero = await fetchCodexUsage({ model: model("openai-codex-2"), getProviderAuth, fetchImpl });
	assert.match(zero.text, /Banked reset credits: 0/);

	const absent = await fetchCodexUsage({
		model: model("openai-codex-2"), getProviderAuth,
		fetchImpl: async () => jsonResponse({ rate_limit: {} }),
	});
	assert.match(absent.text, /Banked reset credits: unavailable/);
});

test("accepts an exact 64 KiB JSON response and rejects malformed JSON", async () => {
	const getProviderAuth = async () => ({ auth: { apiKey: tokenForAccount("acct-2") } });
	const paddingLength = 64 * 1024 - JSON.stringify({ padding: "" }).length;
	const valid = await fetchCodexUsage({
		model: model("openai-codex-2"), getProviderAuth,
		fetchImpl: async () => jsonResponse({ padding: "x".repeat(paddingLength) }),
	});
	assert.equal(valid.slot, 2);
	await assert.rejects(fetchCodexUsage({
		model: model("openai-codex-2"), getProviderAuth,
		fetchImpl: async () => new Response("{not json}"),
	}), /invalid response/);
});

test("rejects oversized single- and multi-chunk responses and cancels the stream", async () => {
	const getProviderAuth = async () => ({ auth: { apiKey: tokenForAccount("acct-2") } });
	for (const parts of [["x".repeat(64 * 1024 + 1)], ["x".repeat(40 * 1024), "y".repeat(24 * 1024 + 1)]]) {
		let cancelled = false;
		const chunks = [...parts];
		const response = new Response(new ReadableStream({
			pull(controller) {
				const chunk = chunks.shift();
				if (chunk) controller.enqueue(new TextEncoder().encode(chunk));
				else controller.close();
			},
			cancel() { cancelled = true; },
		}, { highWaterMark: 0 }));
		await assert.rejects(fetchCodexUsage({
			model: model("openai-codex-2"), getProviderAuth,
			fetchImpl: async () => response,
		}), /exceeds 64 KiB/);
		assert.equal(cancelled, true);
	}
});

test("fails closed for non-Codex models, nonofficial origins, missing auth, and HTTP errors", async () => {
	const getProviderAuth = async () => ({ auth: { apiKey: tokenForAccount("acct") } });
	await assert.rejects(fetchCodexUsage({ model: model("anthropic"), getProviderAuth }), /Select an OpenAI Codex model/);
	await assert.rejects(fetchCodexUsage({ model: { ...model("openai-codex-4"), baseUrl: "https://proxy.invalid" }, getProviderAuth }), /official ChatGPT endpoint/);
	await assert.rejects(fetchCodexUsage({ model: model("openai-codex-4"), getProviderAuth: async () => undefined }), /No Codex OAuth credential/);
	await assert.rejects(fetchCodexUsage({
		model: model("openai-codex-4"), getProviderAuth,
		fetchImpl: async () => jsonResponse({}, 401),
	}), /HTTP 401/);
});

test("rejects an unsafe account ID without making a request", async () => {
	let requests = 0;
	await assert.rejects(fetchCodexUsage({
		model: model("openai-codex-4"),
		getProviderAuth: async () => ({ auth: { apiKey: tokenForAccount("acct-4\r\nX-Injected: yes") } }),
		fetchImpl: async () => { requests++; return jsonResponse({}); },
	}), /account ID is invalid/);
	assert.equal(requests, 0);
});

test("does not send auth to ChatGPT when the provider auth resolves through a proxy", async () => {
	let requests = 0;
	await assert.rejects(fetchCodexUsage({
		model: model("openai-codex-4"),
		getProviderAuth: async () => ({ auth: { apiKey: tokenForAccount("acct-4"), baseUrl: "https://proxy.invalid" } }),
		fetchImpl: async () => { requests++; return jsonResponse({}); },
	}), /nonofficial provider/);
	assert.equal(requests, 0);
});

test("redeems one freshly revalidated reset only after explicit confirmation", async () => {
	const token = tokenForAccount("acct-slot-4");
	const requests = [];
	const confirmations = [];
	const result = await redeemCodexReset({
		model: model("openai-codex-4"),
		getCurrentModel: () => model("openai-codex-4"),
		getProviderAuth: async (provider) => ({ auth: { apiKey: provider === "openai-codex-4" ? token : "wrong" } }),
		confirm: async (message) => { confirmations.push(message); return true; },
		createRequestId: () => "redeem-request-4",
		fetchImpl: async (url, options) => {
			requests.push({ url, options });
			if (url.endsWith("/rate-limit-reset-credits/consume")) {
				return jsonResponse({ code: "reset", windows_reset: 2 });
			}
			if (url.endsWith("/usage")) {
				return jsonResponse({ rate_limit: { primary_window: { used_percent: 0 } }, rate_limit_reset_credits: { available_count: 0 } });
			}
			return jsonResponse({
				available_count: 1,
				credits: [{ id: "credit-4", status: "available", reset_type: "codex_rate_limits", expires_at: "2026-10-01T00:00:00Z" }],
			});
		},
	});

	assert.equal(result.status, "reset");
	assert.equal(result.windowsReset, 2);
	assert.match(result.usageText, /Banked reset credits: 0/);
	assert.match(confirmations[0], /Codex #4/);
	assert.match(confirmations[0], /one reset/);
	assert.equal(requests.filter(({ url }) => url.endsWith("/consume")).length, 1);
	assert.equal(requests[0].url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
	assert.equal(requests[2].options.method, "POST");
	assert.equal(requests[2].options.headers["ChatGPT-Account-Id"], "acct-slot-4");
	assert.deepEqual(JSON.parse(requests[2].options.body), {
		redeem_request_id: "redeem-request-4",
		credit_id: "credit-4",
	});
});

test("lets the user choose a reset credit before confirming", async () => {
	let consumeBody;
	const result = await redeemCodexReset({
		model: model("openai-codex-4"),
		getCurrentModel: () => model("openai-codex-4"),
		getProviderAuth: async () => ({ auth: { apiKey: tokenForAccount("acct-4") } }),
		selectCredit: async (options) => options.findIndex((option) => option.creditId === "credit-b"),
		confirm: async (message) => { assert.match(message, /2026-10-02T00:00:00\.000Z/); return true; },
		createRequestId: () => "request-choice",
		fetchImpl: async (url, options) => {
			if (url.endsWith("/consume")) {
				consumeBody = JSON.parse(options.body);
				return jsonResponse({ code: "reset", windows_reset: 1 });
			}
			if (url.endsWith("/usage")) return jsonResponse({});
			return jsonResponse({ available_count: 2, credits: [
				{ id: "credit-a", status: "available", reset_type: "codex_rate_limits", expires_at: "2026-10-01T00:00:00Z" },
				{ id: "credit-b", status: "available", reset_type: "codex_rate_limits", expires_at: "2026-10-02T00:00:00Z" },
			] });
		},
	});
	assert.equal(result.status, "reset");
	assert.equal(consumeBody.credit_id, "credit-b");
});

test("cancelled or unavailable reset never reaches the consume endpoint", async () => {
	let requests = 0;
	const options = {
		model: model("openai-codex-2"),
		getCurrentModel: () => model("openai-codex-2"),
		getProviderAuth: async () => ({ auth: { apiKey: tokenForAccount("acct-2") } }),
		createRequestId: () => "must-not-be-used",
		fetchImpl: async () => {
			requests++;
			return jsonResponse({ available_count: 1, credits: [] });
		},
	};
	const cancelled = await redeemCodexReset({ ...options, confirm: async () => false });
	assert.equal(cancelled.status, "cancelled");
	assert.equal(requests, 1);

	const empty = await redeemCodexReset({
		...options,
		confirm: async () => { throw new Error("must not confirm"); },
		fetchImpl: async () => { requests++; return jsonResponse({ available_count: 0, credits: [] }); },
	});
	assert.equal(empty.status, "no_credit");
	assert.equal(requests, 2);
});

test("does not redeem after the active slot changes during confirmation", async () => {
	const originalModel = model("openai-codex-4");
	let requestCount = 0;
	let authCount = 0;
	const redemption = redeemCodexReset({
		model: originalModel,
		getCurrentModel: () => model("openai-codex-2"),
		getProviderAuth: async () => { authCount++; return { auth: { apiKey: tokenForAccount("acct-4") } }; },
		confirm: async () => true,
		createRequestId: () => "unused",
		fetchImpl: async () => { requestCount++; return jsonResponse({ available_count: 1, credits: [] }); },
	});
	await assert.rejects(redemption, /slot changed/);
	assert.equal(authCount, 1);
	assert.equal(requestCount, 1);
});

test("captures the slot identity before awaiting user confirmation", async () => {
	const activeModel = model("openai-codex-4");
	let consumeRequests = 0;
	await assert.rejects(redeemCodexReset({
		model: activeModel,
		getCurrentModel: () => { activeModel.provider = "openai-codex-2"; return activeModel; },
		getProviderAuth: async () => ({ auth: { apiKey: tokenForAccount("acct-4") } }),
		confirm: async () => true,
		fetchImpl: async (url) => {
			if (url.endsWith("/consume")) consumeRequests++;
			return jsonResponse({ available_count: 1, credits: [] });
		},
	}), /slot changed/);
	assert.equal(consumeRequests, 0);
});

test("does not redeem after the selected account changes during confirmation", async () => {
	let authCount = 0;
	let requestCount = 0;
	await assert.rejects(redeemCodexReset({
		model: model("openai-codex-4"),
		getCurrentModel: () => model("openai-codex-4"),
		getProviderAuth: async () => ({ auth: { apiKey: tokenForAccount(++authCount === 1 ? "acct-old" : "acct-new") } }),
		confirm: async () => true,
		fetchImpl: async () => { requestCount++; return jsonResponse({ available_count: 1, credits: [] }); },
	}), /account changed/);
	assert.equal(authCount, 2);
	assert.equal(requestCount, 1);
});

test("does not redeem when the active slot changes during fresh availability", async () => {
	let activeModel = model("openai-codex-4");
	let availabilityReads = 0;
	let consumeRequests = 0;
	await assert.rejects(redeemCodexReset({
		model: activeModel,
		getCurrentModel: () => activeModel,
		getProviderAuth: async () => ({ auth: { apiKey: tokenForAccount("acct-4") } }),
		confirm: async () => true,
		fetchImpl: async (url) => {
			if (url.endsWith("/consume")) consumeRequests++;
			if (url.endsWith("/rate-limit-reset-credits")) {
				availabilityReads++;
				if (availabilityReads === 2) activeModel = model("openai-codex-2");
			}
			return jsonResponse({ available_count: 1, credits: [] });
		},
	}), /slot changed/);
	assert.equal(availabilityReads, 2);
	assert.equal(consumeRequests, 0);
});

test("does not redeem when the account changes during fresh availability", async () => {
	let accountId = "acct-4";
	let availabilityReads = 0;
	let consumeRequests = 0;
	await assert.rejects(redeemCodexReset({
		model: model("openai-codex-4"),
		getCurrentModel: () => model("openai-codex-4"),
		getProviderAuth: async () => ({ auth: { apiKey: tokenForAccount(accountId) } }),
		confirm: async () => true,
		fetchImpl: async (url) => {
			if (url.endsWith("/consume")) consumeRequests++;
			if (url.endsWith("/rate-limit-reset-credits")) {
				availabilityReads++;
				if (availabilityReads === 2) accountId = "acct-other";
			}
			return jsonResponse({ available_count: 1, credits: [] });
		},
	}), /account changed/);
	assert.equal(availabilityReads, 2);
	assert.equal(consumeRequests, 0);
});

test("does not redeem when the slot changes during final auth resolution", async () => {
	let activeModel = model("openai-codex-4");
	let authReads = 0;
	let consumeRequests = 0;
	await assert.rejects(redeemCodexReset({
		model: activeModel,
		getCurrentModel: () => activeModel,
		getProviderAuth: async () => {
			if (++authReads === 3) activeModel = model("openai-codex-2");
			return { auth: { apiKey: tokenForAccount("acct-4") } };
		},
		confirm: async () => true,
		fetchImpl: async (url) => {
			if (url.endsWith("/consume")) consumeRequests++;
			return jsonResponse({ available_count: 1, credits: [] });
		},
	}), /slot changed/);
	assert.equal(authReads, 3);
	assert.equal(consumeRequests, 0);
});

test("does not redeem when the account changes during final auth resolution", async () => {
	let authReads = 0;
	let consumeRequests = 0;
	await assert.rejects(redeemCodexReset({
		model: model("openai-codex-4"),
		getCurrentModel: () => model("openai-codex-4"),
		getProviderAuth: async () => ({ auth: { apiKey: tokenForAccount(++authReads === 3 ? "acct-other" : "acct-4") } }),
		confirm: async () => true,
		fetchImpl: async (url) => {
			if (url.endsWith("/consume")) consumeRequests++;
			return jsonResponse({ available_count: 1, credits: [] });
		},
	}), /account changed/);
	assert.equal(authReads, 3);
	assert.equal(consumeRequests, 0);
});

test("does not redeem a credit that disappeared after confirmation", async () => {
	let availabilityReads = 0;
	let consumeRequests = 0;
	await assert.rejects(redeemCodexReset({
		model: model("openai-codex-4"),
		getCurrentModel: () => model("openai-codex-4"),
		getProviderAuth: async () => ({ auth: { apiKey: tokenForAccount("acct-4") } }),
		confirm: async () => true,
		fetchImpl: async (url) => {
			if (url.endsWith("/consume")) consumeRequests++;
			availabilityReads++;
			return jsonResponse({
				available_count: 1,
				credits: availabilityReads === 1
					? [{ id: "credit-disappears", status: "available", reset_type: "codex_rate_limits" }]
					: [],
			});
		},
	}), /no longer available/);
	assert.equal(availabilityReads, 2);
	assert.equal(consumeRequests, 0);
});

test("reports unknown consume result without retrying", async () => {
	let consumeRequests = 0;
	await assert.rejects(redeemCodexReset({
		model: model("openai-codex-2"),
		getCurrentModel: () => model("openai-codex-2"),
		getProviderAuth: async () => ({ auth: { apiKey: tokenForAccount("acct-2") } }),
		confirm: async () => true,
		fetchImpl: async (url) => {
			if (url.endsWith("/consume")) { consumeRequests++; throw new Error("network failure"); }
			return jsonResponse({ available_count: 1, credits: [] });
		},
	}), /result is unknown/);
	assert.equal(consumeRequests, 1);
});

test("oversized consume response stays unknown and does not trigger retry", async () => {
	let consumeRequests = 0;
	await assert.rejects(redeemCodexReset({
		model: model("openai-codex-2"),
		getCurrentModel: () => model("openai-codex-2"),
		getProviderAuth: async () => ({ auth: { apiKey: tokenForAccount("acct-2") } }),
		confirm: async () => true,
		fetchImpl: async (url) => {
			if (url.endsWith("/consume")) {
				consumeRequests++;
				return jsonResponse({ code: "reset", windows_reset: 1, padding: "x".repeat(64 * 1024) });
			}
			return jsonResponse({ available_count: 1, credits: [] });
		},
	}), /result is unknown/);
	assert.equal(consumeRequests, 1);
});

test("registers a dedicated command and labels result by captured active slot", async () => {
	let command;
	registerExtension({ registerCommand: (name, value) => { if (name === "codex-usage") command = value; } });
	assert.ok(command);
	const notices = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => jsonResponse({ rate_limit_reset_credits: { available_count: 1 } });
	const ctx = {
		hasUI: false,
		model: model("openai-codex-4"),
		modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: tokenForAccount("acct-4") } }) },
		ui: { notify: (message, level) => notices.push({ message, level }) },
	};
	try {
		await command.handler("", ctx);
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.equal(notices.length, 1);
	assert.match(notices[0].message, /Codex #4/);
	assert.match(notices[0].message, /Banked reset credits: 1/);
});

test("command requires confirmation and reports refreshed usage after redemption", async () => {
	let command;
	registerExtension({ registerCommand: (name, value) => { if (name === "codex-usage") command = value; } });
	const notices = [];
	const prompts = [];
	const selections = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, options) => {
		if (url.endsWith("/consume")) return jsonResponse({ code: "reset", windows_reset: 2 });
		if (url.endsWith("/usage")) return jsonResponse({ rate_limit_reset_credits: { available_count: 0 } });
		return jsonResponse({ available_count: 1, credits: [{ id: "credit-2", status: "available", reset_type: "codex_rate_limits" }] });
	};
	const ctx = {
		hasUI: true,
		model: model("openai-codex-2"),
		modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: tokenForAccount("acct-2") } }) },
		ui: {
			select: async (title, options) => { selections.push({ title, options }); return options[0]; },
			confirm: async (title, message) => { prompts.push({ title, message }); return true; },
			notify: (message, level) => notices.push({ message, level }),
		},
	};
	try {
		await command.handler("redeem", ctx);
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.equal(prompts.length, 1);
	assert.equal(selections.length, 1);
	assert.match(selections[0].title, /reset credit/i);
	assert.equal(prompts[0].title, "Redeem Codex reset?");
	assert.match(prompts[0].message, /Codex #2/);
	assert.match(notices[0].message, /Usage reset for Codex #2/);
	assert.match(notices[0].message, /Banked reset credits: 0/);
});

test("default command presents refresh and redeem options", async () => {
	let command;
	registerExtension({ registerCommand: (name, value) => { if (name === "codex-usage") command = value; } });
	const selections = [];
	const notices = [];
	let menuVisits = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url) => jsonResponse(url.endsWith("rate-limit-reset-credits")
		? { available_count: 1, credits: [{ id: "credit-menu", status: "available", reset_type: "codex_rate_limits" }] }
		: { rate_limit_reset_credits: { available_count: 1 } });
	const ctx = {
		hasUI: true,
		model: model("openai-codex-2"),
		modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: tokenForAccount("acct-2") } }) },
		ui: {
			select: async (title, options) => {
				selections.push({ title, options });
				if (title.includes("usage options")) return menuVisits++ === 0 ? options.find((item) => item.startsWith("Redeem")) : "Close";
				return options[0];
			},
			confirm: async () => false,
			notify: (message, level) => notices.push({ message, level }),
		},
	};
	try {
		await command.handler("", ctx);
	} finally {
		globalThis.fetch = originalFetch;
	}
	const menus = selections.filter(({ title }) => title.includes("usage options"));
	assert.equal(menus.length, 2);
	assert.ok(menus[0].options.includes("Refresh usage"));
	assert.ok(menus[0].options.some((item) => item.startsWith("Redeem")));
	assert.equal(menus[1].options.at(-1), "Close");
});

test("redemption command refuses non-interactive mode before network access", async () => {
	let command;
	registerExtension({ registerCommand: (name, value) => { if (name === "codex-usage") command = value; } });
	let requests = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => { requests++; return jsonResponse({}); };
	const notices = [];
	const ctx = {
		hasUI: false,
		model: model("openai-codex-2"),
		modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: tokenForAccount("acct-2") } }) },
		ui: { notify: (message, level) => notices.push({ message, level }) },
	};
	try {
		await command.handler("redeem", ctx);
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.equal(requests, 0);
	assert.match(notices[0].message, /requires interactive confirmation/);
});

test("does not present a result if the active slot changes during the request", async () => {
	let command;
	registerExtension({ registerCommand: (name, value) => { if (name === "codex-usage") command = value; } });
	const notices = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => jsonResponse({ rate_limit_reset_credits: { available_count: 4 } });
	const ctx = {
		model: model("openai-codex-4"),
		modelRegistry: {
			getProviderAuth: async () => {
				ctx.model = model("openai-codex-2");
				return { auth: { apiKey: tokenForAccount("acct-4") } };
			},
		},
		ui: { notify: (message, level) => notices.push({ message, level }) },
	};
	try {
		await command.handler("", ctx);
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.equal(notices.length, 1);
	assert.equal(notices[0].level, "warning");
	assert.match(notices[0].message, /slot changed/);
	assert.doesNotMatch(notices[0].message, /Banked reset credits/);
});
