import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** Validate the multi-platform index before it becomes a signed build contract. */
export function standardImageDigest(bytes) {
  const index = JSON.parse(bytes.toString("utf8"));
  assert.equal(index.schemaVersion, 2);
  assert.ok(["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"].includes(index.mediaType));
  assert.ok(Array.isArray(index.manifests));
  for (const architecture of ["amd64", "arm64"]) {
    const matches = index.manifests.filter(item => item.platform?.os === "linux" && item.platform?.architecture === architecture);
    assert.equal(matches.length, 1, `Expected exactly one linux/${architecture} image`);
    assert.match(matches[0].digest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(matches[0].size) && matches[0].size > 0);
  }
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const digest = standardImageDigest(await readFile(process.argv[2]));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `digest=${digest}\n`);
  console.log(digest);
}
