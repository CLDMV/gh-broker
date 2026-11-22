/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /.configs/eslint.config.mjs
 *	@Date: 2026-05-24T21:13:00-07:00 (1779682380)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:07-07:00 (1790968807)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import js from "@eslint/js";
import globals from "globals";
import json from "@eslint/json";
import jsonvPlugin from "@cldmv/eslint-plugin-jsonv";
import markdown from "@eslint/markdown";
import css from "@eslint/css";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig([
	{
		ignores: [
			"tmp/**",
			"trash/**",
			"node_modules/**",
			"dist/**",
			"build/**",
			".git/**",
			".configs/**",
			".vscode/**",
			"coverage/**",
			"reference/**",
			"types/**",
			"bin/**",
			"*.min.*",
			"**/package-lock.json",
			// Copy file patterns
			"*copy/",
			"*copy (*)/",
			"*copy */",
			"*copy.*",
			"*copy (*).*",
			"*copy *.*",
			"**/*copy/",
			"**/*copy (*)/",
			"**/*copy */",
			"**/*copy.*",
			"**/*copy (*).*",
			"**/*copy *.*"
		]
	},
	{
		files: ["**/*.{js,mjs,cjs}"],
		plugins: { js },
		extends: ["js/recommended"],
		rules: {
			"no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^(_|___.*)$",
					caughtErrorsIgnorePattern: "^(_|___.*)$",
					destructuredArrayIgnorePattern: "^(_|___.*)$",
					varsIgnorePattern: "^(_|___.*)$"
				}
			]
		}
	},
	{
		// TypeScript sources and tests (the ESM daemon, CLI and library).
		files: ["**/*.{ts,mts,cts}"],
		extends: [js.configs.recommended, tseslint.configs.recommended],
		languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.node } },
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					// `const { dropped: _x, ...rest } = obj` is how fields are left out of a copy.
					ignoreRestSiblings: true,
					argsIgnorePattern: "^(_|___.*)$",
					caughtErrorsIgnorePattern: "^(_|___.*)$",
					destructuredArrayIgnorePattern: "^(_|___.*)$",
					varsIgnorePattern: "^(_|___.*)$"
				}
			]
		}
	},
	{
		// Test doubles (fake Octokit, MCP clients, registry stubs) are typed loosely on purpose.
		files: ["tests/**/*.{ts,mts,cts}"],
		rules: { "@typescript-eslint/no-explicit-any": "off" }
	},
	{ files: ["**/*.js"], languageOptions: { sourceType: "commonjs" } },
	{ files: ["**/*.{js,mjs,cjs}"], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
	{
		files: ["tests/**/*.test.vitest.mjs"],
		languageOptions: {
			globals: {
				beforeAll: true,
				beforeEach: true,
				afterAll: true,
				afterEach: true,
				describe: true,
				it: true,
				expect: true,
				test: true,
				vi: true
			}
		}
	},
	{ files: ["**/*.json"], plugins: { json }, language: "json/json", extends: ["json/recommended"] },
	{ files: ["**/*.jsonc"], plugins: { json }, language: "json/jsonc", extends: ["json/recommended"] },
	{ files: ["**/*.json5"], plugins: { json }, language: "json/json5", extends: ["json/recommended"] },
	{ files: ["**/*.jsonv"], plugins: { jsonv: jsonvPlugin }, language: "jsonv/jsonv", ...jsonvPlugin.configs.recommended },
	{
		files: ["**/*.md"],
		plugins: { markdown },
		language: "markdown/gfm",
		extends: ["markdown/recommended"],
		rules: {
			// GitHub alerts like [!NOTE]/[!WARNING] are valid but trip this rule.
			"markdown/no-missing-label-refs": "off"
		}
	},
	{ files: ["**/*.css"], plugins: { css }, language: "css/css", extends: ["css/recommended"] }
]);
