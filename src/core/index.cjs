/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/core/index.cjs
 *	@Date: 2026-11-14T13:55:00-08:00 (1794693300)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T13:55:00-08:00 (1794693300)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview CommonJS entry point: the generic CLDMV drop-in shim
 * (CLDMV/.github docs/conventions/package-layout.md).
 *
 * It returns what `import` gives. The package exports many distinct values, so `require("@cldmv/gh-broker")`
 * is the module object, the same as `import * as`. The build copies it verbatim next to the built
 * `index.mjs` in dist/core/, where `./index.mjs` resolves.
 * @module gh-broker/cjs-entry
 */
"use strict";

if (!process.features?.require_module) {
	const error = new Error(
		`@cldmv/gh-broker: require() needs Node.js ^20.19.0 or >=22.13.0 (this is ${process.version}). On older Node.js, load the package with import() instead.`
	);
	error.code = "ERR_REQUIRE_ESM";
	throw error;
}

// Same exports as `import`. One distinct exported value (aliases of it count once) comes back as that value,
// so require(x)(...) works; anything else comes back as the module object ({ default, ...named }).
const esm = require("./index.mjs");
const values = new Set(
	Object.keys(esm)
		.filter((key) => key !== "__esModule")
		.map((key) => esm[key])
);
module.exports = values.size === 1 ? values.values().next().value : esm;
