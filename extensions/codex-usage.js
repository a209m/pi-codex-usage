import { randomUUID } from "node:crypto";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const RESET_CONSUME_URL = `${RESET_CREDITS_URL}/consume`;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export function slotForProvider(providerId) {
	if (providerId === "openai-codex") return 1;
	const match = /^openai-codex-([2-9]|[1-9]\d+)$/.exec(providerId);
	return match ? Number(match[1]) : undefined;
}

function asObject(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function accountIdFromToken(token) {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		const claims = asObject(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
		const auth = asObject(claims?.["https://api.openai.com/auth"]);
		return typeof auth?.chatgpt_account_id === "string" && auth.chatgpt_account_id
			? auth.chatgpt_account_id
			: undefined;
	} catch {
		return undefined;
	}
}

function resetTime(value) {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value < 10_000_000_000 ? value * 1000 : value;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function windowLabel(window, fallback) {
	const seconds = window.limit_window_seconds;
	if (seconds === 18_000) return `${fallback} (5h)`;
	if (seconds === 604_800) return `${fallback} (7d)`;
	return fallback;
}

function formatUsage(payload, slot) {
	const lines = [];
	const plan = typeof payload.plan_type === "string" && /^[\w.-]{1,40}$/.test(payload.plan_type)
		? ` (${payload.plan_type[0].toUpperCase()}${payload.plan_type.slice(1)})`
		: "";
	lines.push(`Codex #${slot}${plan}`);

	const limits = asObject(payload.rate_limit);
	for (const [key, fallback] of [["primary_window", "Primary"], ["secondary_window", "Secondary"]]) {
		const window = asObject(limits?.[key]);
		if (!window || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) continue;
		const used = Math.max(0, Math.min(100, window.used_percent));
		const reset = resetTime(window.reset_at);
		const date = reset === undefined ? undefined : new Date(reset);
		const resetText = !date || !Number.isFinite(date.getTime()) ? "" : ` · resets ${date.toISOString()}`;
		lines.push(`${windowLabel(window, fallback)}: ${Math.round(100 - used)}% remaining${resetText}`);
	}

	const credits = asObject(payload.credits);
	if (credits?.has_credits === false) lines.push("Credits: none");
	else if (credits?.unlimited === true) lines.push("Credits: unlimited");
	else if (credits?.has_credits === true && (typeof credits.balance === "number" || typeof credits.balance === "string")) {
		const balance = Number(credits.balance);
		if (Number.isFinite(balance)) lines.push(`Credits: ${balance}`);
		else lines.push("Credits: available");
	}

	const resetCredits = asObject(payload.rate_limit_reset_credits);
	const availableCount = resetCreditCount(resetCredits);
	lines.push(`Banked reset credits: ${Number.isSafeInteger(availableCount) && availableCount >= 0 ? availableCount : "unavailable"}`);
	return lines.join("\n");
}

function resetCreditCount(credits) {
	const count = credits?.available_count;
	const parsed = typeof count === "number" || (typeof count === "string" && count.trim())
		? Number(count)
		: Number.NaN;
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function resolveCodexAuth(model, getProviderAuth) {
	const slot = slotForProvider(model?.provider ?? "");
	if (slot === undefined) throw new Error("Select an OpenAI Codex model before running /codex-usage.");
	let origin;
	try {
		origin = new URL(model.baseUrl).origin;
	} catch {
		origin = undefined;
	}
	if (origin !== "https://chatgpt.com") {
		throw new Error("Codex usage cannot send auth to a nonofficial provider; select the official ChatGPT endpoint.");
	}

	const resolved = await getProviderAuth(model.provider);
	const authBaseUrl = resolved?.auth?.baseUrl;
	if (authBaseUrl !== undefined) {
		let authOrigin;
		try {
			authOrigin = new URL(authBaseUrl).origin;
		} catch {
			authOrigin = undefined;
		}
		if (authOrigin !== "https://chatgpt.com") {
			throw new Error("Codex usage cannot send auth to a nonofficial provider.");
		}
	}
	const rawToken = resolved?.auth?.apiKey;
	if (typeof rawToken !== "string" || !rawToken.trim()) throw new Error("No Codex OAuth credential is available for this slot.");
	const token = rawToken.trim().replace(/^Bearer\s+/i, "");
	const accountId = accountIdFromToken(token);
	if (!accountId) throw new Error("The selected Codex credential has no readable account ID.");
	if (accountId.length > 512 || !/^[\x20-\x7e]+$/.test(accountId)) {
		throw new Error("The selected Codex account ID is invalid.");
	}
	return {
		slot,
		providerId: model.provider,
		modelId: model.id,
		accountId,
		headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": accountId },
	};
}

async function fetchJson(url, auth, fetchImpl, timeoutMs, method = "GET", body) {
	const response = await fetchImpl(url, {
		method,
		headers: {
			...auth.headers,
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new Error(`Codex endpoint returned HTTP ${response.status}.`);
	if (!response.body) throw new Error("Codex endpoint returned an invalid response.");
	const reader = response.body.getReader();
	const chunks = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new Error("Codex endpoint response exceeds 64 KiB.");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	let payload;
	try {
		payload = asObject(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
	} catch {
		throw new Error("Codex endpoint returned an invalid response.");
	}
	if (!payload) throw new Error("Codex endpoint returned an invalid response.");
	return payload;
}

export async function fetchCodexUsage({ model, getProviderAuth, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
	const auth = await resolveCodexAuth(model, getProviderAuth);
	const payload = await fetchJson(USAGE_URL, auth, fetchImpl, timeoutMs);
	return {
		slot: auth.slot,
		text: formatUsage(payload, auth.slot),
		availableCount: resetCreditCount(asObject(payload.rate_limit_reset_credits)),
	};
}

function resetCreditsFromPayload(payload) {
	const rawCount = payload.available_count;
	const availableCount = typeof rawCount === "number" || (typeof rawCount === "string" && rawCount.trim())
		? Number(rawCount)
		: Number.NaN;
	if (!Number.isSafeInteger(availableCount) || availableCount < 0) {
		throw new Error("Codex reset endpoint returned an invalid credit count.");
	}
	if (payload.credits !== undefined && !Array.isArray(payload.credits)) {
		throw new Error("Codex reset endpoint returned invalid credits.");
	}
	const options = (payload.credits ?? [])
		.map(asObject)
		.filter((credit) => credit?.status === "available" && credit.reset_type === "codex_rate_limits")
		.map((credit) => {
			if (typeof credit.id !== "string" || !credit.id || credit.id.length > 1024) {
				throw new Error("Codex reset endpoint returned an invalid credit ID.");
			}
			const rawExpiration = credit.expires_at;
			const expiration = rawExpiration == null
				? undefined
				: typeof rawExpiration === "string"
					? Date.parse(rawExpiration)
					: Number.NaN;
			if (expiration !== undefined && !Number.isFinite(expiration)) {
				throw new Error("Codex reset endpoint returned an invalid expiration time.");
			}
			return { creditId: credit.id, expiresAt: expiration };
		})
		.sort((left, right) => (left.expiresAt ?? Infinity) - (right.expiresAt ?? Infinity))
		.slice(0, Math.min(availableCount, 32));
	if (availableCount > 0 && options.length === 0) options.push({});
	return { availableCount, options };
}

function resetConfirmationMessage(slot, availability, option) {
	const expiration = option.expiresAt === undefined
		? ""
		: ` The selected credit expires ${new Date(option.expiresAt).toISOString()}.`;
	return `Redeem one reset credit for Codex #${slot}? It will immediately reset this account's current Codex usage limits. ${availability.availableCount} available.${expiration}`;
}

function sameModel(left, right) {
	return left?.provider === right?.provider && left?.id === right?.id && left?.baseUrl === right?.baseUrl;
}

function resetOptionLabel(option, index) {
	const expiration = option.expiresAt === undefined
		? "expiration unavailable"
		: `expires ${new Date(option.expiresAt).toISOString()}`;
	return `Reset credit ${index + 1} · ${expiration}`;
}

function redemptionSummary(result) {
	return {
		reset: `Usage reset for Codex #${result.slot}.`,
		already_redeemed: `Reset was already completed for Codex #${result.slot}.`,
		nothing_to_reset: `Codex #${result.slot} did not need a usage reset.`,
		no_credit: `No reset credits are available for Codex #${result.slot}.`,
		cancelled: "Codex reset cancelled; no credit was used.",
	}[result.status];
}

export async function redeemCodexReset({
	model,
	getCurrentModel,
	getProviderAuth,
	selectCredit,
	confirm,
	fetchImpl = fetch,
	timeoutMs = REQUEST_TIMEOUT_MS,
	createRequestId = randomUUID,
}) {
	const selectedModel = { provider: model?.provider, id: model?.id, baseUrl: model?.baseUrl };
	const auth = await resolveCodexAuth(selectedModel, getProviderAuth);
	const availability = resetCreditsFromPayload(
		await fetchJson(RESET_CREDITS_URL, auth, fetchImpl, timeoutMs),
	);
	if (availability.availableCount === 0) return { status: "no_credit", slot: auth.slot };
	let selected = availability.options[0];
	if (selectCredit) {
		const selectedIndex = await selectCredit(availability.options, availability.availableCount);
		if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= availability.options.length) {
			return { status: "cancelled", slot: auth.slot };
		}
		selected = availability.options[selectedIndex];
	}
	if (!(await confirm(resetConfirmationMessage(auth.slot, availability, selected)))) {
		return { status: "cancelled", slot: auth.slot };
	}

	const currentModel = getCurrentModel();
	if (!sameModel(selectedModel, currentModel)) {
		throw new Error("The active Codex slot changed during confirmation. No reset was redeemed.");
	}
	const currentAuth = await resolveCodexAuth(selectedModel, getProviderAuth);
	if (currentAuth.accountId !== auth.accountId) {
		throw new Error("The Codex account changed during confirmation. No reset was redeemed.");
	}
	const fresh = resetCreditsFromPayload(
		await fetchJson(RESET_CREDITS_URL, currentAuth, fetchImpl, timeoutMs),
	);
	if (fresh.availableCount === 0) return { status: "no_credit", slot: auth.slot };
	const option = selected.creditId
		? fresh.options.find((candidate) => candidate.creditId === selected.creditId)
		: fresh.options[0];
	if (!option) throw new Error("The selected reset credit is no longer available. Run /codex-usage redeem again.");
	const finalAuth = await resolveCodexAuth(selectedModel, getProviderAuth);
	if (finalAuth.accountId !== auth.accountId) {
		throw new Error("The Codex account changed before redemption. No reset was redeemed.");
	}
	if (!sameModel(selectedModel, getCurrentModel())) {
		throw new Error("The active Codex slot changed before redemption. No reset was redeemed.");
	}

	let result;
	try {
		result = await fetchJson(
			RESET_CONSUME_URL,
			finalAuth,
			fetchImpl,
			timeoutMs,
			"POST",
			{
				redeem_request_id: createRequestId(),
				...(option.creditId ? { credit_id: option.creditId } : {}),
			},
		);
	} catch {
		throw new Error("Codex reset redemption result is unknown. Check /codex-usage before retrying.");
	}
	if (!["reset", "nothing_to_reset", "no_credit", "already_redeemed"].includes(result.code)) {
		throw new Error("Codex reset redemption result is unknown. Check /codex-usage before retrying.");
	}
	const windowsReset = result.windows_reset === undefined ? 0 : Number(result.windows_reset);
	if (!Number.isSafeInteger(windowsReset) || windowsReset < 0) {
		throw new Error("Codex reset redemption result is unknown. Check /codex-usage before retrying.");
	}
	let usageText;
	let remainingCount;
	if (result.code === "reset" || result.code === "already_redeemed") {
		try {
			const usage = await fetchJson(USAGE_URL, finalAuth, fetchImpl, timeoutMs);
			usageText = formatUsage(usage, auth.slot);
			remainingCount = resetCreditCount(asObject(usage.rate_limit_reset_credits));
		} catch {
			// Redemption succeeded; leave refresh to the user if the read-only follow-up fails.
		}
	}
	return { status: result.code, slot: auth.slot, windowsReset, usageText, availableCount: remainingCount };
}

export default function registerCodexUsage(pi) {
	pi.registerCommand("codex-usage", {
		description: "Show or redeem usage for the active Codex account slot",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action && action !== "redeem") {
				ctx.ui.notify("Usage: /codex-usage [redeem]", "warning");
				return;
			}
			const model = { provider: ctx.model?.provider, id: ctx.model?.id, baseUrl: ctx.model?.baseUrl };
			const slot = slotForProvider(model.provider ?? "");
			if (slot === undefined) {
				ctx.ui.notify("Select an OpenAI Codex model before running /codex-usage.", "warning");
				return;
			}
			if (action === "redeem" && !ctx.hasUI) {
				ctx.ui.notify("Reset redemption requires interactive confirmation (TUI or RPC mode).", "warning");
				return;
			}
			const getProviderAuth = (provider) => ctx.modelRegistry.getProviderAuth(provider);
			const redeem = () => redeemCodexReset({
				model,
				getCurrentModel: () => ctx.model,
				getProviderAuth,
				selectCredit: async (options) => {
					const labels = options.map(resetOptionLabel);
					return labels.indexOf(await ctx.ui.select("Choose a reset credit", labels));
				},
				confirm: (message) => ctx.ui.confirm("Redeem Codex reset?", message),
			});
			const reportUsage = async () => {
				if (!sameModel(model, ctx.model)) throw new Error("The active Codex slot changed; run /codex-usage again.");
				const result = await fetchCodexUsage({ model, getProviderAuth });
				if (!sameModel(model, ctx.model)) throw new Error("The active Codex slot changed; run /codex-usage again.");
				return result;
			};
			const showRedemptionError = (error) => {
				const message = error instanceof Error ? error.message : "";
				const safeDetail = /slot changed|account changed|no longer available|result is unknown/.test(message)
					? message
					: `Unable to redeem a reset for Codex #${slot}. Check OAuth and network, then retry.`;
				ctx.ui.notify(safeDetail, "error");
			};
			if (action === "redeem") {
				try {
					const result = await redeem();
					ctx.ui.notify(`${redemptionSummary(result)}\n${result.usageText ?? "Run /codex-usage to refresh current usage."}`, "info");
				} catch (error) {
					showRedemptionError(error);
				}
				return;
			}

			if (!ctx.hasUI) {
				try {
					ctx.ui.notify((await reportUsage()).text, "info");
				} catch {
					if (!sameModel(model, ctx.model)) ctx.ui.notify("Codex slot changed during usage check; run /codex-usage again.", "warning");
					else ctx.ui.notify(`Unable to fetch usage for Codex #${slot}. Check its OAuth login and network, then retry.`, "error");
				}
				return;
			}
			try {
				let usage = await reportUsage();
				while (true) {
					ctx.ui.notify(usage.text, "info");
					const redeemLabel = usage.availableCount === undefined
						? "Redeem usage limit reset…"
						: `Redeem usage limit reset (${usage.availableCount} available)…`;
					const options = ["Refresh usage"];
					if (usage.availableCount !== 0) options.push(redeemLabel);
					options.push("Close");
					const choice = await ctx.ui.select(`Codex #${slot} usage options`, options);
					if (!choice || choice === "Close") return;
					if (choice === "Refresh usage") {
						usage = await reportUsage();
						continue;
					}
					if (choice !== redeemLabel) return;
					const result = await redeem();
					ctx.ui.notify(redemptionSummary(result), "info");
					if (result.status === "cancelled") continue;
					if (result.usageText !== undefined) {
						usage = { slot, text: result.usageText, availableCount: result.availableCount };
						continue;
					}
					if (result.status === "no_credit" || result.status === "nothing_to_reset") {
						usage = await reportUsage();
						continue;
					}
					ctx.ui.notify("Usage refresh failed; run /codex-usage again to check the selected account.", "warning");
					return;
				}
			} catch (error) {
				if (!sameModel(model, ctx.model)) {
					ctx.ui.notify("Codex slot changed; run /codex-usage again.", "warning");
					return;
				}
				if (error instanceof Error && /slot changed|account changed|no longer available|result is unknown/.test(error.message)) {
					showRedemptionError(error);
					return;
				}
				ctx.ui.notify(`Unable to fetch usage for Codex #${slot}. Check its OAuth login and network, then retry.`, "error");
			}
		},
	});
}
