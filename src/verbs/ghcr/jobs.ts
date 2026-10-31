/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/ghcr/jobs.ts
 *	@Date: 2026-10-31T11:08:29-07:00 (1793470109)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-31T11:13:29-07:00 (1793470409)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * In-memory queue for GHCR push jobs.
 *
 * Images are 1–3 GB, far longer than one MCP call should block, so `ghcr_push` enqueues a
 * job and returns its id; `ghcr_push_status` reads it back. Jobs run one at a time (a
 * push saturates the uplink; two at once only make both slower) in submission order.
 *
 * Bounded on purpose: at most `maxPending` queued-or-running jobs (each holds an open
 * archive descriptor), and only the newest `keepFinished` finished jobs are remembered.
 * State lives in memory only, so a broker restart forgets every job; a push that was
 * running is simply not completed (the registry discards an unfinished upload, and no
 * tag moves until the final manifest PUT).
 */

import { randomUUID } from "node:crypto";
import type { PushProgress, PushResult } from "./push.ts";

export type JobState = "queued" | "running" | "succeeded" | "failed";

export interface JobMeta {
	owner: string;
	/** e.g. "ghcr.io/cldmv/hoot" */
	image: string;
	tag: string;
	archive: string;
	archiveBytes: number;
	format: string;
}

export interface Job extends JobMeta {
	job: string;
	state: JobState;
	progress?: PushProgress;
	result?: PushResult;
	error?: string;
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
}

export interface JobHooks {
	/** Does the work. Report progress through `progress`; resolve with the result or throw. */
	run(progress: (p: PushProgress) => void): Promise<PushResult>;
	/** Always called once the job ends (success, failure, or never started). */
	finally?(job: Job): void;
	/** Turns a thrown error into the message stored on the job (must already be secret-free). */
	describeError?(err: unknown): string;
}

export class QueueFull extends Error {}

export class JobQueue {
	private readonly jobs = new Map<string, Job>();
	private readonly pending: Array<{ job: Job; hooks: JobHooks }> = [];
	private running = false;
	private readonly maxPending: number;
	private readonly keepFinished: number;

	constructor({ maxPending = 8, keepFinished = 50 }: { maxPending?: number; keepFinished?: number } = {}) {
		this.maxPending = maxPending;
		this.keepFinished = keepFinished;
	}

	/** Queued + running jobs. */
	activeCount(): number {
		return this.pending.length + (this.running ? 1 : 0);
	}

	submit(meta: JobMeta, hooks: JobHooks): Job {
		if (this.activeCount() >= this.maxPending) throw new QueueFull(`ghcr_push: ${this.activeCount()} pushes are already queued or running — wait for one to finish (ghcr_push_status)`);
		const job: Job = { ...meta, job: randomUUID(), state: "queued", createdAt: new Date().toISOString() };
		this.jobs.set(job.job, job);
		this.pending.push({ job, hooks });
		const snapshot = { ...job }; // as submitted, before pump() may flip it to running
		void this.pump();
		return snapshot;
	}

	get(id: string): Job | undefined {
		const j = this.jobs.get(id);
		return j ? structuredClone(j) : undefined;
	}

	list(owner: string): Job[] {
		return [...this.jobs.values()].filter((j) => j.owner === owner).map((j) => structuredClone(j));
	}

	/** Resolves once nothing is queued or running (for tests and orderly shutdown). */
	async idle(): Promise<void> {
		while (this.activeCount() > 0) await new Promise((r) => setTimeout(r, 5));
	}

	private async pump(): Promise<void> {
		if (this.running) return;
		const next = this.pending.shift();
		if (!next) return;
		this.running = true;
		const { job, hooks } = next;
		job.state = "running";
		job.startedAt = new Date().toISOString();
		try {
			job.result = await hooks.run((p) => {
				job.progress = p;
			});
			job.state = "succeeded";
		} catch (err) {
			job.state = "failed";
			job.error = hooks.describeError ? hooks.describeError(err) : "push failed";
		} finally {
			job.finishedAt = new Date().toISOString();
			try {
				hooks.finally?.(structuredClone(job));
			} catch {
				/* a cleanup/audit hook must not wedge the queue */
			}
			this.running = false;
			this.prune();
			void this.pump();
		}
	}

	private prune(): void {
		const finished = [...this.jobs.values()].filter((j) => j.state === "succeeded" || j.state === "failed");
		for (const j of finished.slice(0, Math.max(0, finished.length - this.keepFinished))) this.jobs.delete(j.job);
	}
}
