/**
 * The subscription transport fixture (server fork, 2026-10-27).
 *
 * The bridges (src/agent/chatgpt-bridge.ts, subscription-bridge.ts) talk
 * to ONE transport: the in-process web owner injected through
 * src/agent/subscription-runtime.ts. These tests used to drive the
 * desktop IPC transport (process.send + "message" events) with scripted
 * fakes; this helper keeps those fakes word-for-word by adapting them to
 * the web runtime: outbound requests become `send(message, callback)`
 * calls with the same {channel, id, op, ...fields} envelope, and the
 * fakes' replies/pushes come back through `emit(message)` — a reply
 * (carrying a pending `id`) settles the request, anything else is a
 * packet publish (state pushes, catalog snapshots).
 */
import { configureWebSubscriptionRuntime, publishWebSubscriptionPacket, resetWebSubscriptionRuntime, type SubscriptionRuntimeChannel } from "../../src/agent/subscription-runtime.ts";

export type FixtureSend = (message: Record<string, unknown>, callback?: (error?: Error) => void) => unknown;

interface Pending { op: string; resolve: (value: unknown) => void; reject: (error: Error) => void }

export function installSubscriptionTransport(send: FixtureSend) {
	const pending = new Map<string, Pending>();
	let counter = 0;
	let current: FixtureSend | null = send;
	const install = () =>
		configureWebSubscriptionRuntime(<T,>(channel: SubscriptionRuntimeChannel, op: string, fields: Record<string, unknown>) =>
			new Promise<T>((resolve, reject) => {
				if (!current) { reject(new Error("fixture transport uninstalled")); return; }
				const id = `fixture:${++counter}`;
				pending.set(id, { op, resolve: (value) => resolve(value as T), reject });
				current({ ...fields, channel, id, op }, (error) => {
					if (error) { pending.delete(id); reject(error); }
				});
			}),
		);
	install();
	return {
		/** The fakes' inbound path: a reply settles its request; a push publishes. */
		emit(message: unknown): void {
			const m = message as { channel?: string; id?: string; op?: string; ok?: boolean; value?: unknown; error?: string };
			if (m?.id && pending.has(m.id)) {
				const call = pending.get(m.id)!;
				pending.delete(m.id);
				if (call.op !== m.op) return;
				if (m.ok) call.resolve(m.value);
				else call.reject(new Error(m.error ?? "fixture request failed"));
				return;
			}
			if (m?.channel === "lh:chatgpt" || m?.channel === "lh:subscriptions") publishWebSubscriptionPacket(m.channel, m as Record<string, unknown>);
		},
		/** Swap the outbound fake (the tests that install process.send later). */
		setSend(next: FixtureSend | null): void { current = next; },
		/** No owner at all: requests reject, pushes are ignored, catalogs read empty. */
		uninstall(): void { current = null; resetWebSubscriptionRuntime(); },
		/** Back after an uninstall. */
		reinstall(): void { current = send; install(); },
	};
}
