import { Router as RealRouter } from "../../src/router.ts";
import { OtpGate } from "../../src/otp/gate.ts";
import { GhcrService } from "../../src/verbs/ghcr_push.ts";

/**
 * The suite's Router call shape (the parent-ratified call-shape edit, slice 5): the
 * Router stopped default-constructing the daemon's OTP gate and GHCR service — the
 * daemon composition passes both explicitly (src/index.ts). The pre-slice-5 test call
 * sites passed neither, so this subclass fills exactly what the old defaults
 * constructed: the daemon's OtpGate over the config + store, and — when config.ghcr
 * exists — the daemon's GhcrService, the same object the old lazy construction built.
 * Call-shape only; no assertion in any suite changes.
 */
export class HostRouter extends RealRouter {
	constructor(config: any, secrets: any, upstream: any, appAuth?: any, otp?: any, ghcr?: any, resolveToken?: any) {
		super(config, secrets, upstream, appAuth, otp ?? new OtpGate(config, secrets), ghcr ?? (config.ghcr ? new GhcrService(config.ghcr, secrets) : undefined), resolveToken);
	}
}
