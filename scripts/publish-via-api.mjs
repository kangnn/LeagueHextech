/**
 * Publishes the local commit through the GitHub Git Data API instead of `git push`.
 *
 * The proxy this machine uses drops the POST body of `git-receive-pack`, so pushing over HTTPS fails at
 * the send-pack stage ("SSL_ERROR_SYSCALL") while plain API calls to api.github.com work fine. This script
 * rebuilds the commit server-side from the same file contents:
 *
 *   blobs -> tree -> commit -> update ref
 *
 * Inputs come from the environment so nothing sensitive is ever written to disk or printed:
 *   GH_TOKEN        token taken from the local credential manager by the caller
 *   PUBLISH_FILES   newline separated list of repo-relative paths to publish
 *   PUBLISH_MESSAGE commit message
 *   PUBLISH_TAG     optional tag to point at the new commit
 *   PUBLISH_OWNER / PUBLISH_REPO / PUBLISH_BRANCH
 */
import { readFileSync } from "node:fs";

const { GH_TOKEN, PUBLISH_FILES, PUBLISH_MESSAGE, PUBLISH_TAG, PUBLISH_OWNER, PUBLISH_REPO, PUBLISH_BRANCH } = process.env;
const api = "https://api.github.com";
const headers = {
  Authorization: `token ${GH_TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "leaguehextech-publish",
  "Content-Type": "application/json"
};

async function call(method, route, body) {
  const response = await fetch(`${api}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new Error(`${method} ${route} -> HTTP ${response.status} ${data?.message ?? text.slice(0, 200)}`);
  }
  return data;
}

const files = PUBLISH_FILES.split("\n").map((line) => line.trim()).filter(Boolean);
if (files.length === 0) throw new Error("没有需要发布的文件");

const ref = await call("GET", `/repos/${PUBLISH_OWNER}/${PUBLISH_REPO}/git/ref/heads/${PUBLISH_BRANCH}`);
const baseCommit = await call("GET", `/repos/${PUBLISH_OWNER}/${PUBLISH_REPO}/git/commits/${ref.object.sha}`);
console.log(`远端基线: ${ref.object.sha.slice(0, 7)}`);

const tree = [];
for (const path of files) {
  const content = readFileSync(path);
  const blob = await call("POST", `/repos/${PUBLISH_OWNER}/${PUBLISH_REPO}/git/blobs`, {
    content: content.toString("base64"),
    encoding: "base64"
  });
  tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  console.log(`  blob ${path} (${content.length} 字节)`);
}

const newTree = await call("POST", `/repos/${PUBLISH_OWNER}/${PUBLISH_REPO}/git/trees`, {
  base_tree: baseCommit.tree.sha,
  tree
});
const commit = await call("POST", `/repos/${PUBLISH_OWNER}/${PUBLISH_REPO}/git/commits`, {
  message: PUBLISH_MESSAGE,
  tree: newTree.sha,
  parents: [ref.object.sha]
});
await call("PATCH", `/repos/${PUBLISH_OWNER}/${PUBLISH_REPO}/git/refs/heads/${PUBLISH_BRANCH}`, { sha: commit.sha, force: false });
console.log(`提交: ${commit.sha.slice(0, 7)}  ${commit.message.split("\n")[0]}`);

if (PUBLISH_TAG) {
  try {
    await call("POST", `/repos/${PUBLISH_OWNER}/${PUBLISH_REPO}/git/refs`, { ref: `refs/tags/${PUBLISH_TAG}`, sha: commit.sha });
    console.log(`标签: ${PUBLISH_TAG} -> ${commit.sha.slice(0, 7)}`);
  } catch (error) {
    // A pre-existing tag is worth reporting clearly rather than pretending the publish failed.
    console.log(`标签未创建：${error.message}`);
  }
}
console.log("完成");
