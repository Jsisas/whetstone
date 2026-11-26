import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configYaml, DEFAULTS, loadConfig, matchGlob } from "../src/config.ts";
import { writeFile } from "./stub.ts";

function dirs() {
	const agentDir = mkdtempSync(join(tmpdir(), "whet-agent-"));
	const repo = mkdtempSync(join(tmpdir(), "whet-repo-"));
	return { agentDir, repo };
}

test("the project layer overrides the user layer, which overrides defaults", async () => {
	const { agentDir, repo } = dirs();
	writeFile(agentDir, "whetstone/config.yml", "budget:\n  lines: 80\n  files: 2\nexplanatory: false\n");
	writeFile(repo, ".omp/whetstone.yml", "budget:\n  lines: 40\n");
	const { config, warnings } = await loadConfig(repo, agentDir);
	expect(warnings).toEqual([]);
	expect(config.budget).toEqual({ lines: 40, files: 2 });
	expect(config.explanatory).toBe(false);
	expect(config.quiz).toEqual(DEFAULTS.quiz);
});

test("arrays replace instead of merging", async () => {
	const { agentDir, repo } = dirs();
	writeFile(repo, ".omp/whetstone.yml", "allowedCommands: [ls, pytest]\n");
	const { config } = await loadConfig(repo, agentDir);
	expect(config.allowedCommands).toEqual(["ls", "pytest"]);
});

test("invalid YAML yields a warning and the defaults", async () => {
	const { agentDir, repo } = dirs();
	const file = join(repo, ".omp", "whetstone.yml");
	writeFile(repo, ".omp/whetstone.yml", "budget: [unclosed\n");
	const { config, warnings } = await loadConfig(repo, agentDir);
	expect(config).toEqual(DEFAULTS);
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toStartWith(`Whetstone: ${file} is not valid YAML (`);
	expect(warnings[0]).toEndWith("); ignoring it.");
});

test("wrong-typed values are ignored with a warning", async () => {
	const { agentDir, repo } = dirs();
	writeFile(repo, ".omp/whetstone.yml", "budget: 5\nalwaysOn: true\n");
	const { config, warnings } = await loadConfig(repo, agentDir);
	expect(config.budget).toEqual(DEFAULTS.budget);
	expect(config.alwaysOn).toBe(true);
	expect(warnings).toHaveLength(1);
});

test("globs are anchored at the repository root", () => {
	expect(matchGlob("AGENTS.md", "AGENTS.md")).toBe(true);
	expect(matchGlob("AGENTS.md", "docs/AGENTS.md")).toBe(false);
	expect(matchGlob("**/AGENTS.md", "docs/AGENTS.md")).toBe(true);
	expect(matchGlob("**/migrations/**", "migrations/0001.sql")).toBe(true);
	expect(matchGlob("**/*.test.*", "src/a.test.ts")).toBe(true);
	expect(matchGlob("src/*.ts", "src/deep/a.ts")).toBe(false);
});

test("the init template parses back to the defaults", () => {
	expect(Bun.YAML.parse(configYaml())).toEqual(DEFAULTS);
});
