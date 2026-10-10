/**
 * Adaptive Compaction Extension
 *
 * Scales compaction budgets to the active model's context window:
 *
 *   reserveTokens    = max(16384, window × (window > 500K ? 40% : 10%))
 *   keepRecentTokens = max(20000, window × 10%)
 *
 * reserveTokens sets the trigger line: compaction starts when context usage
 * exceeds window - reserveTokens. It also caps summary output at
 * 0.8 × reserveTokens inside generateSummaryWithUsage.
 *
 * Two parts:
 * 1. agent_end trigger: compacts when usage crosses the adaptive line. The
 *    built-in threshold check stays enabled as a mid-run safety net, and
 *    overflow recovery is unaffected.
 * 2. session_before_compact: recomputes the cut point with the adaptive
 *    keepRecentTokens and regenerates the summary over the reduced span.
 *    Applies to manual /compact, threshold, and overflow compactions alike.
 *    When the configured settings already keep at least as much, the handler
 *    defers to the default implementation.
 */

import {
	findCutPoint,
	generateSummaryWithUsage,
	sessionEntryToContextMessages,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const LARGE_WINDOW_THRESHOLD = 500_000;
const RESERVE_RATIO_LARGE = 0.4;
const RESERVE_RATIO_SMALL = 0.1;
const KEEP_RECENT_RATIO = 0.1;
const MIN_RESERVE_TOKENS = 16_384;
const MIN_KEEP_RECENT_TOKENS = 20_000;

function computeCompactionParams(contextWindow: number): {
	reserveTokens: number;
	keepRecentTokens: number;
	triggerTokens: number;
} {
	const ratio = contextWindow > LARGE_WINDOW_THRESHOLD ? RESERVE_RATIO_LARGE : RESERVE_RATIO_SMALL;
	const reserveTokens = Math.max(MIN_RESERVE_TOKENS, Math.floor(contextWindow * ratio));
	const keepRecentTokens = Math.max(MIN_KEEP_RECENT_TOKENS, Math.floor(contextWindow * KEEP_RECENT_RATIO));
	return { reserveTokens, keepRecentTokens, triggerTokens: contextWindow - reserveTokens };
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (_event, ctx) => {
		const model = ctx.model;
		const usage = ctx.getContextUsage();
		if (!model || model.contextWindow <= 0 || !usage || usage.tokens == null) return;
		const { triggerTokens } = computeCompactionParams(model.contextWindow);
		if (usage.tokens > triggerTokens) ctx.compact();
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		if (!model || model.contextWindow <= 0) return;
		const { reserveTokens, keepRecentTokens } = computeCompactionParams(model.contextWindow);
		const { preparation, branchEntries, customInstructions, signal } = event;

		// The configured settings already retain at least as much; keep default behavior.
		if (keepRecentTokens <= preparation.settings.keepRecentTokens) return;

		// Summarization starts at the previous compaction's retained tail, or at session start.
		let boundaryStart = 0;
		let previousSummary: string | undefined;
		for (let i = branchEntries.length - 1; i >= 0; i--) {
			const entry = branchEntries[i];
			if (entry.type !== "compaction") continue;
			previousSummary = entry.summary;
			const keptIndex = branchEntries.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
			boundaryStart = keptIndex >= 0 ? keptIndex : i + 1;
			break;
		}

		const cut = findCutPoint(branchEntries, boundaryStart, branchEntries.length, keepRecentTokens);
		const firstKeptEntry = branchEntries[cut.firstKeptEntryIndex];
		if (!firstKeptEntry?.id) return;

		// Our cut would retain no more than the prepared default; keep default behavior.
		const defaultIndex = branchEntries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
		if (defaultIndex >= 0 && cut.firstKeptEntryIndex >= defaultIndex) return;

		const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
		const span = branchEntries.slice(boundaryStart, historyEnd);
		const prefix = cut.isSplitTurn ? branchEntries.slice(cut.turnStartIndex, cut.firstKeptEntryIndex) : [];
		const messages = [...span, ...prefix]
			.filter((entry) => entry.type !== "compaction")
			.flatMap((entry) => sessionEntryToContextMessages(entry))
			.filter((message) => message.role !== "system");
		if (messages.length === 0) return;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return;

		const { text, usage } = await generateSummaryWithUsage(
			messages,
			model,
			reserveTokens,
			auth.apiKey,
			auth.headers,
			signal,
			customInstructions,
			previousSummary,
			ctx.thinkingLevel,
		);

		// File lists come from preparation.fileOps, which covers the default (larger)
		// span and may include files our larger retained tail keeps verbatim.
		const readFiles = [...preparation.fileOps.read].sort();
		const modifiedFiles = [...preparation.fileOps.edited].sort();
		let summary = text;
		if (readFiles.length > 0) summary += `\n\n<read-files>\n${readFiles.join("\n")}\n</read-files>`;
		if (modifiedFiles.length > 0) summary += `\n\n<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`;

		return {
			compaction: {
				summary,
				firstKeptEntryId: firstKeptEntry.id,
				tokensBefore: preparation.tokensBefore,
				usage,
				details: { readFiles, modifiedFiles },
			},
		};
	});
}
