import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  defaultSuiteWeight,
  loadShardDurations,
  partitionGeneralServerSuites,
} from "../general-server-shard.mjs";

import { assertSelectedTests, partitionTestLines } from "../test-line-shard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "run-vitest-stable.mjs");
const durationsManifest = path.join(repoRoot, "scripts", "general-server-shard-durations.json");
const serializedDurationsManifest = path.join(
  repoRoot,
  "scripts",
  "serialized-shard-durations.json",
);

// Membership of general-server-without-chat depends on
// NATIVE_RUNNER_SUITE_LANE (see run-vitest-stable.mjs): a caller that runs
// the native-runner group as its own Rust-cached lane declares it with the
// value "dedicated". Strip the ambient value so every test pins the caller
// it mirrors explicitly — these tests themselves run inside a workflow on CI.
function workflowEnv(envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  if (!("NATIVE_RUNNER_SUITE_LANE" in envOverrides)) {
    delete env.NATIVE_RUNNER_SUITE_LANE;
  }
  return env;
}

function dryRun(args, envOverrides = {}) {
  const result = spawnSync(process.execPath, [script, ...args, "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: workflowEnv(envOverrides),
  });
  return result;
}

function dryRunJson(args, envOverrides = {}) {
  const result = dryRun(args, envOverrides);
  assert.equal(result.status, 0, `expected success for ${args.join(" ")}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const SHARD_COUNT = 12;
const SERIALIZED_SHARD_COUNT = 9;


test("the serialized shards form a complete, non-overlapping partition", () => {
  const shards = Array.from({ length: SERIALIZED_SHARD_COUNT }, (_, index) =>
    dryRunJson(["--mode", "serialized", "--shard-index", String(index), "--shard-count", String(SERIALIZED_SHARD_COUNT)]),
  );

  const total = shards[0].serializedSuiteCount;
  const selected = shards.flatMap((shard) => shard.selectedSerializedSuites);
  assert.equal(selected.length, total, "every serialized suite must be selected exactly once");
  assert.equal(new Set(selected).size, total, "serialized shards must not overlap");
});

test("the general-server shards form a complete, non-overlapping partition", () => {
  const shards = Array.from({ length: SHARD_COUNT }, (_, index) =>
    dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", String(index), "--shard-count", String(SHARD_COUNT)]),
  );

  const total = shards[0].generalServerSuiteCount;
  assert.ok(total > 0, "expected a non-empty general-server suite set");

  const seen = new Set();
  let selectedTotal = 0;
  for (const shard of shards) {
    assert.equal(shard.generalServerSuiteCount, total, "suite count must be stable across shards");
    for (const file of shard.selectedGeneralServerSuites) {
      assert.ok(!seen.has(file), `suite assigned to more than one shard: ${file}`);
      seen.add(file);
      selectedTotal += 1;
    }
  }

  // Every suite runs exactly once: union covers the whole set with no overlap.
  assert.equal(selectedTotal, total, "every suite must be selected exactly once");
  assert.equal(seen.size, total, "union of shards must cover the whole suite set");
});

test("a route/authz suite never leaks into the general-server shards", () => {
  const shard = dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", "0", "--shard-count", SHARD_COUNT.toString()]);
  for (const file of shard.selectedGeneralServerSuites) {
    assert.ok(
      !/[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/.test(file),
      `route/authz suite must stay in the serialized lane, not general-server: ${file}`,
    );
  }
});

test("shard flags are rejected for the workspaces-b group", () => {
  const result = dryRun(["--mode", "general", "--group", "general-workspaces-b", "--shard-index", "0", "--shard-count", "3"]);
  assert.notEqual(result.status, 0, "workspaces-b must not accept shard flags");
});

test("workspaces-a shards map to Vitest native --shard slices over a stable project list", () => {
  const shards = [0, 1].map((index) =>
    dryRunJson([
      "--mode", "general", "--group", "general-workspaces-a",
      "--shard-index", String(index), "--shard-count", "2",
    ]),
  );

  assert.deepEqual(
    shards.map((shard) => shard.workspacesVitestShard),
    ["1/2", "2/2"],
    "each matrix job must pass its own --shard slice to vitest",
  );
  // Vitest's --shard partitions each project's file list deterministically, so
  // an identical project list across jobs is what guarantees complete,
  // non-overlapping coverage of the lane.
  assert.deepEqual(shards[0].workspaceProjects, shards[1].workspaceProjects);
  assert.ok(shards[0].workspaceProjects.length > 0, "workspaces-a must run at least one project");

  const unsharded = dryRunJson(["--mode", "general", "--group", "general-workspaces-a"]);
  assert.deepEqual(
    unsharded.workspaceProjects,
    shards[0].workspaceProjects,
    "sharding must not change which projects the lane covers",
  );
  assert.equal(unsharded.workspacesVitestShard, null);
});

test("duration-aware partition balances skewed weights better than round-robin", () => {
  // Round-robin puts all three heavy suites on shard 0 (indexes 0, 3, 6).
  const files = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  const durations = { a: 30000, d: 30000, g: 30000, b: 100, c: 100, e: 100, f: 100, h: 100, i: 100 };

  const shards = partitionGeneralServerSuites(files, 3, durations);
  const totals = shards.map((shard) => shard.totalWeight);
  const maxTotal = Math.max(...totals);
  const minTotal = Math.min(...totals);
  assert.ok(
    maxTotal - minTotal <= 200,
    `expected near-even shard weights, got ${totals.join(", ")}`,
  );
  assert.equal(
    shards.flatMap((shard) => shard.files).sort().join(","),
    files.join(","),
    "partition must cover every file exactly once",
  );
});

test("the partition is deterministic for identical inputs", () => {
  const files = Array.from({ length: 50 }, (_, index) => `suite-${index}.test.ts`);
  const durations = Object.fromEntries(files.map((file, index) => [file, (index * 37) % 5000]));

  const first = partitionGeneralServerSuites(files, 3, durations);
  const second = partitionGeneralServerSuites(files, 3, durations);
  assert.deepEqual(first, second, "same inputs must always produce the same partition");
});

test("suites missing from the manifest get the median weight", () => {
  assert.equal(defaultSuiteWeight({ a: 100, b: 300, c: 900 }), 300);
  assert.equal(defaultSuiteWeight({ a: 100, b: 300, c: 500, d: 900 }), 400);
  assert.equal(defaultSuiteWeight({}), 1000, "empty manifest falls back to a fixed weight");
});

test("a missing or malformed manifest degrades to uniform weights", () => {
  assert.deepEqual(loadShardDurations(path.join(repoRoot, "scripts", "no-such-manifest.json")), {});

  const files = ["a", "b", "c", "d"];
  const shards = partitionGeneralServerSuites(files, 2, {});
  assert.equal(shards[0].files.length + shards[1].files.length, files.length);
  assert.equal(Math.abs(shards[0].files.length - shards[1].files.length), 0);
});

test("the checked-in manifest loads and covers most of the current suite set", () => {
  const durations = loadShardDurations(durationsManifest);
  assert.ok(Object.keys(durations).length > 0, "manifest must parse to a non-empty duration map");

  const shard = dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", "0", "--shard-count", "1"]);
  const currentFiles = shard.selectedGeneralServerSuites;
  const known = currentFiles.filter((file) => durations[file] !== undefined).length;
  assert.ok(
    known / currentFiles.length >= 0.5,
    `manifest is stale: only ${known} of ${currentFiles.length} suites have recorded durations — regenerate it from a recent PR run (see the manifest's $comment)`,
  );
});

test("the chat integration suite keeps a measured duration for duration-aware fallbacks", () => {
  // The PR and release matrices both run the chat suite in dedicated
  // line-sharded lanes, but the plain general-server group (local full runs)
  // still weighs it into the LPT partition; a median-fallback weight there
  // would silently overload whichever shard receives it.
  const chatSuite = "server/src/__tests__/chat-channels.integration.test.ts";
  const durations = loadShardDurations(durationsManifest);
  assert.ok(
    Number.isFinite(durations[chatSuite]),
    "the full chat cohort must have a measured duration, not the median fallback",
  );
});

test("the checked-in serialized manifest loads and covers most of the current suite set", () => {
  const durations = loadShardDurations(serializedDurationsManifest);
  assert.ok(Object.keys(durations).length > 0, "manifest must parse to a non-empty duration map");

  const shard = dryRunJson(["--mode", "serialized", "--shard-index", "0", "--shard-count", "1"]);
  const currentFiles = shard.selectedSerializedSuites;
  const known = currentFiles.filter((file) => durations[file] !== undefined).length;
  assert.ok(
    known / currentFiles.length >= 0.5,
    `manifest is stale: only ${known} of ${currentFiles.length} suites have recorded durations — regenerate it from a recent PR run (see the manifest's $comment)`,
  );
});

test("the real serialized shard partition is duration-balanced", () => {
  const durations = loadShardDurations(serializedDurationsManifest);
  const fallback = defaultSuiteWeight(durations);
  const shards = Array.from({ length: SERIALIZED_SHARD_COUNT }, (_, index) =>
    dryRunJson(["--mode", "serialized", "--shard-index", String(index), "--shard-count", String(SERIALIZED_SHARD_COUNT)]),
  );

  const totals = shards.map((shard) =>
    shard.selectedSerializedSuites.reduce((sum, file) => sum + (durations[file] ?? fallback), 0),
  );
  const maxTotal = Math.max(...totals);
  const minTotal = Math.min(...totals);
  // LPT keeps the spread within the heaviest single suite; use that as the bound.
  const heaviest = Math.max(...Object.values(durations));
  assert.ok(
    maxTotal - minTotal <= heaviest,
    `serialized shard weight spread ${maxTotal - minTotal}ms exceeds heaviest suite ${heaviest}ms: ${totals.join(", ")}`,
  );
});

test("the real shard partition is duration-balanced", () => {
  // Mirrors the PR matrix: general-server-without-chat across SHARD_COUNT
  // runners, with the chat suite carried by the dedicated general-chat lanes
  // and the native-runner suite by its dedicated Rust-cached lane.
  const durations = loadShardDurations(durationsManifest);
  const fallback = defaultSuiteWeight(durations);
  const shards = Array.from({ length: SHARD_COUNT }, (_, index) =>
    dryRunJson(
      ["--mode", "general", "--group", "general-server-without-chat", "--shard-index", String(index), "--shard-count", String(SHARD_COUNT)],
      { NATIVE_RUNNER_SUITE_LANE: "dedicated" },
    ),
  );

  const totals = shards.map((shard) =>
    shard.selectedGeneralServerSuites.reduce((sum, file) => sum + (durations[file] ?? fallback), 0),
  );
  const maxTotal = Math.max(...totals);
  const minTotal = Math.min(...totals);
  // LPT keeps the spread within the heaviest single suite; use that as the
  // bound. The chat and native-runner suites run in their own lanes, so
  // exclude them here.
  const chat = "server/src/__tests__/chat-channels.integration.test.ts";
  const nativeRunner =
    "server/src/services/native-runtime/native-codex-runner.integration.test.ts";
  const heaviest = Math.max(
    ...Object.entries(durations)
      .filter(([file]) => file !== chat && file !== nativeRunner)
      .map(([, ms]) => ms),
  );
  assert.ok(
    maxTotal - minTotal <= heaviest,
    `shard weight spread ${maxTotal - minTotal}ms exceeds heaviest suite ${heaviest}ms: ${totals.join(", ")}`,
  );
});


const chatSuitePath = "server/src/__tests__/chat-channels.integration.test.ts";
const nativeRunnerSuitePath =
  "server/src/services/native-runtime/native-codex-runner.integration.test.ts";

// Mirrors pr-trusted.yml's General tests job, which declares
// NATIVE_RUNNER_SUITE_LANE=dedicated: the chat suite runs in its dedicated
// lanes and the cargo-dependent native-runner suite in its own Rust-cached
// matrix lane, so together the three cover the full server group exactly.
test("12 PR without-chat shards plus the dedicated chat and native-runner lanes cover the original server group exactly", () => {
  const prEnv = { NATIVE_RUNNER_SUITE_LANE: "dedicated" };
  const full = dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", "0", "--shard-count", "1"], prEnv);
  const shards = Array.from({ length: 12 }, (_, index) => dryRunJson([
    "--mode", "general", "--group", "general-server-without-chat",
    "--shard-index", String(index), "--shard-count", "12",
  ], prEnv));
  const files = shards.flatMap((shard) => shard.selectedGeneralServerSuites);
  assert.ok(!files.includes(chatSuitePath));
  assert.ok(!files.includes(nativeRunnerSuitePath));
  assert.deepEqual([...files, chatSuitePath, nativeRunnerSuitePath].sort(), full.selectedGeneralServerSuites.sort());
  assert.equal(new Set(files).size, files.length);
  const defaultRun = dryRunJson([], prEnv);
  assert.ok(defaultRun.generalServerSuiteCount === full.generalServerSuiteCount);
});

// Mirrors release-verify.yml (10 shards, called by the Release and Cloud
// readiness workflows) and local runs: no dedicated Rust-cached lane is
// declared there, so the native-runner suite must stay in the server shards.
// Anything but the exact "dedicated" declaration degrades the same way.
for (const [caller, envOverrides] of [["no lane declaration", {}], ["an unrecognized lane declaration", { NATIVE_RUNNER_SUITE_LANE: "piggyback" }]]) {
  test(`10 without-chat shards under ${caller} keep the native-runner suite and cover the server group with chat alone`, () => {
    const full = dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", "0", "--shard-count", "1"], envOverrides);
    const shards = Array.from({ length: 10 }, (_, index) => dryRunJson([
      "--mode", "general", "--group", "general-server-without-chat",
      "--shard-index", String(index), "--shard-count", "10",
    ], envOverrides));
    const files = shards.flatMap((shard) => shard.selectedGeneralServerSuites);
    assert.ok(!files.includes(chatSuitePath));
    assert.ok(files.includes(nativeRunnerSuitePath));
    assert.deepEqual([...files, chatSuitePath].sort(), full.selectedGeneralServerSuites.sort());
    assert.equal(new Set(files).size, files.length);
  });
}

test("the native-runner lane runs exactly the cargo-dependent vertical-slice suite", () => {
  const lane = dryRunJson(["--mode", "general", "--group", "general-server-native-runner"]);
  assert.deepEqual(lane.selectedGeneralServerSuites, [
    "server/src/services/native-runtime/native-codex-runner.integration.test.ts",
  ]);
});

test("shard flags are rejected for the native-runner group", () => {
  const result = dryRun(["--mode", "general", "--group", "general-server-native-runner", "--shard-index", "0", "--shard-count", "2"]);
  assert.notEqual(result.status, 0, "the native-runner lane is a single suite and must not accept shard flags");
});

// The PR-side exclusion above is safe only while the wiring it assumes holds:
// pr-trusted.yml's General tests job declares the dedicated lane to the shard
// script and carries exactly one Rust-cached matrix entry for the group,
// while callers without such a lane (release-verify.yml) declare nothing and
// keep the suite in their shards.
test("the PR workflow wiring for the dedicated native-runner lane holds", () => {
  const trustedWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/pr-trusted.yml"), "utf8");

  assert.equal(
    trustedWorkflow.match(/NATIVE_RUNNER_SUITE_LANE: dedicated/g)?.length,
    1,
    "the General tests job must declare the dedicated native-runner lane exactly once",
  );
  assert.equal(
    trustedWorkflow.match(/group: general-server-native-runner/g)?.length,
    1,
    "exactly one matrix entry must run the native-runner group",
  );
  assert.match(
    trustedWorkflow,
    /- group: general-server-native-runner\n\s+group_label: native-runner\n\s+rust_cache: true/,
    "the native-runner matrix entry must opt into the Rust cache restore",
  );
  assert.equal(
    trustedWorkflow.match(/if: \$\{\{ matrix\.rust_cache \}\}/g)?.length,
    2,
    "the toolchain pin and cache restore must both be gated on the lane's rust_cache flag",
  );

  const lanes = [...trustedWorkflow.matchAll(/command: test:typescript:vitest --shard=(\d+)\/(\d+)/g)]
    .map((match) => [Number(match[1]), Number(match[2])]);
  assert.ok(lanes.length > 0, "expected sharded test:typescript:vitest lanes in pr-trusted.yml");
  assert.equal(new Set(lanes.map(([, count]) => count)).size, 1, "vitest lanes must agree on the shard count");
  const shardCount = lanes[0][1];
  assert.deepEqual(
    lanes.map(([index]) => index).sort((left, right) => left - right),
    Array.from({ length: shardCount }, (_, index) => index + 1),
    "vitest lanes must cover every shard exactly once",
  );

  // release-verify.yml has no dedicated lane, so it must not declare one:
  // its without-chat shards keep the native-runner suite.
  const releaseWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/release-verify.yml"), "utf8");
  assert.ok(
    !releaseWorkflow.includes("NATIVE_RUNNER_SUITE_LANE"),
    "release-verify.yml must not declare a dedicated native-runner lane it does not provide",
  );
  assert.ok(
    !releaseWorkflow.includes("general-server-native-runner"),
    "release-verify.yml covers the suite inside its server shards, not a dedicated lane",
  );

  // The suite's cargo build only becomes an incremental rebuild if the lane
  // reads the same cache master writes; a drifted copy of the restore block
  // silently reverts the lane to a cold compile.
  const restoreBlocks = trustedWorkflow.match(/shared-key: release-runner-v1/g);
  assert.ok(restoreBlocks.length >= 2, "the native-runner lane must reuse the release-runner-v1 restore contract");

  const runnerPackage = JSON.parse(
    readFileSync(path.join(repoRoot, "packages/paperclip-runner/package.json"), "utf8"),
  );
  assert.equal(
    runnerPackage.scripts["test:typescript:vitest"],
    "pnpm run ensure:eval-build-deps && pnpm run build:rust && vitest run",
    "the vitest lanes run the plain package chain; the PR-lane wrapper is gone",
  );
});

const lineShardFile = path.join(repoRoot, "server/src/__tests__/chat-channels.integration.test.ts");
const caseAt = (line, name) => ({ name, file: lineShardFile, projectName: "@paperclipai/server", location: { line, column: 3 } });

test("test-line shards cover nested and parameterized cases exactly once without splitting a source line", () => {
  const cases = [caseAt(10, "suite > nested > first"), caseAt(10, "suite > nested > second"),
    caseAt(20, "same name"), caseAt(30, "same name"), caseAt(40, "last"), caseAt(50, "new case")];
  const shards = partitionTestLines(cases, 3, lineShardFile);
  assert.deepEqual(shards.map((shard) => shard.tests.length), [2, 2, 2]);
  assert.equal(shards.filter((shard) => shard.lines.includes(10)).length, 1);
  assert.equal(shards.find((shard) => shard.lines.includes(10)).tests.length, 2);
  assert.equal(shards.flatMap((shard) => shard.lines).length, 5);
  assert.deepEqual(shards.flatMap((shard) => shard.tests).sort((a, b) => a.location.line - b.location.line), cases);
  assert.deepEqual(partitionTestLines([...cases].reverse(), 3, lineShardFile).map((shard) => shard.lines), shards.map((shard) => shard.lines));
});

test("line-shard collection rejects empty, foreign, or unlocated tests and invalid shard counts", () => {
  const good = caseAt(10, "valid");
  for (const input of [[], null, [{ ...good, file: "/another.test.ts" }], [{ ...good, projectName: "wrong" }],
    [{ ...good, location: undefined }], [{ ...good, location: { line: 0 } }], [{ ...good, name: "" }]]) {
    assert.throws(() => partitionTestLines(input, 1, lineShardFile));
  }
  for (const count of [0, -1, 1.5, Infinity, 2]) assert.throws(() => partitionTestLines([good], count, lineShardFile));
});

test("filtered collection must match the exact assigned case identities, including duplicates", () => {
  const expected = [caseAt(10, "same"), caseAt(10, "same"), caseAt(20, "nested > case")];
  assertSelectedTests(expected, [...expected].reverse(), lineShardFile);
  for (const actual of [expected.slice(1), [...expected, caseAt(30, "extra")],
    [expected[0], expected[1], caseAt(20, "renamed")],
    [expected[0], expected[1], caseAt(21, "nested > case")]]) {
    assert.throws(() => assertSelectedTests(expected, actual, lineShardFile));
  }
});
