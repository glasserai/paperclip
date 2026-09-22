import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { standardImageDigest } from "./standard-image-contract.mjs";
const descriptor = architecture => ({ platform: { os: "linux", architecture }, digest: `sha256:${"a".repeat(64)}`, size: 100 });
const index = manifests => Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests }));
test("signs the exact registry bytes, including both supported platforms", () => {
  const bytes = index([descriptor("amd64"), descriptor("arm64")]);
  assert.equal(standardImageDigest(bytes), `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
});
test("rejects incomplete, ambiguous, or malformed platform manifests", () => {
  for (const manifests of [[descriptor("amd64")], [descriptor("amd64"), descriptor("amd64"), descriptor("arm64")],
    [{ ...descriptor("amd64"), digest: "mutable-tag" }, descriptor("arm64")],
    [{ ...descriptor("amd64"), size: -1 }, descriptor("arm64")]]) assert.throws(() => standardImageDigest(index(manifests)));
});
