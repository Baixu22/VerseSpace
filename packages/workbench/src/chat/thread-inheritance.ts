import { randomUUID } from "node:crypto";

import type { FootprintUsed } from "../blackboard/sessions";

import type { ForkAgentPlan, ForkInheritance } from "./fork";

import type { ThreadContext } from "./thread-context";

export async function inheritParentFootprint(
	context: ThreadContext,
	id: string,
	plan: ForkAgentPlan,
): Promise<{ refs: string[]; comparable: boolean }> {
	const [view, lines] = await Promise.all([
		context.bb.sessions.readSetView(
			plan.sourceThreadId,
			plan.sourceFootprintSeq,
		),
		context.bb.sessions.footprint(plan.sourceThreadId),
	]);
	const lineRefs = new Map(
		lines.map((line) => [
			line.seq,
			line.eventId ? `footprint:${line.eventId}` : `footprintSeq:${line.seq}`,
		]),
	);
	const refs = new Set<string>();
	const used: FootprintUsed[] = [];
	for (const [, claim] of view.reads) {
		const { seq: _seq, spool: _spool, ...withoutLocalOnly } = claim;
		used.push(withoutLocalOnly);
		const ref = lineRefs.get(claim.seq);
		if (ref) {
			refs.add(ref);
		}
	}
	if (used.length === 0) {
		return { refs: [], comparable: false };
	}
	const refList = [...refs];
	await context.bb.sessions.recordActivity(id, {
		activity: `inherited-${randomUUID()}`,
		agent: id,
		used,
		generated: [],
		facets: {
			tool: "inherited",
			inherited: true,
			sourceWriter: plan.sourceThreadId,
			refs: refList,
		},
	});
	await context.bb.events.append({
		timestamp: new Date().toISOString(),
		source: "sessions",
		type: "footprint.inherited",
		payload: {
			writer: id,
			sourceWriter: plan.sourceThreadId,
			sourceFootprintSeq: plan.sourceFootprintSeq,
			refs: refList,
			paths: used.map((claim) => claim.path),
		},
	});
	return {
		refs: refList,
		comparable: used.some((claim) => claim.version != null),
	};
}

export async function observeForkInheritance(
	context: ThreadContext,
	id: string,
	provider: string,
	observation: {
		agentContextInherited: boolean;
		premiseInherited: boolean;
		mode?: string;
		refs?: string[];
	},
): Promise<void> {
	if (context.observingInheritance.has(id)) {
		return;
	}
	context.observingInheritance.add(id);
	try {
		const meta = await context.store.get(id);
		if (
			!meta.forkInheritance ||
			meta.forkInheritance.agentContextInherited !== null
		) {
			return;
		}
		const observed: ForkInheritance = {
			transcriptInherited: true,
			agentContextInherited: observation.agentContextInherited,
			premiseInherited: observation.premiseInherited,
			observedAt: new Date().toISOString(),
			provider,
		};
		meta.forkInheritance = observed;
		await context.store.saveMeta(meta);
		await context.store.appendThreadEvent("thread.inheritance_observed", id, {
			provider,
			transcriptInherited: true,
			agentContextInherited: observed.agentContextInherited,
			premiseInherited: observed.premiseInherited,
			...(observation.mode ? { mode: observation.mode } : {}),
			...(observation.refs?.length ? { refs: observation.refs } : {}),
		});
	} finally {
		context.observingInheritance.delete(id);
	}
}
