import path from "node:path";

import { visit } from "unist-util-visit";

// A relative target 404s under `base`: a .md link becomes its published route, anything else in
// docs/ a repository URL. A target above docs/ (../README.md) resolves against the repo root.
export function rewriteMarkdownLinks({ docsRoot, repoRoot, base, repository, ref }) {
  return (tree, file) => {
    visit(tree, "link", (link) => {
      const [target, hash] = link.url.split("#");

      if (!target || target.startsWith("http")) {
        return;
      }

      const sourceDir = path.dirname(file.path);
      const absolute = path.resolve(sourceDir, target);
      const relativeToDocsRoot = path.relative(docsRoot, absolute);
      const suffix = hash ? `#${hash}` : "";

      if (relativeToDocsRoot.startsWith("..")) {
        const relativeToRepoRoot = path.relative(repoRoot, absolute);

        if (relativeToRepoRoot.startsWith("..")) {
          throw new Error(`${file.path}: link target escapes the repository: ${link.url}`);
        }

        const kind = target.endsWith("/") ? "tree" : "blob";

        link.url = `${repository}/${kind}/${ref}/${relativeToRepoRoot}${suffix}`;

        return;
      }

      if (target.endsWith(".md")) {
        link.url = `${base}/${relativeToDocsRoot.replace(/\.md$/, "").toLowerCase()}/${suffix}`;

        return;
      }

      // A trailing slash names which of git's two path views this is; the link check verifies it.
      const kind = target.endsWith("/") ? "tree" : "blob";

      link.url = `${repository}/${kind}/${ref}/docs/${relativeToDocsRoot}${suffix}`;
    });
  };
}
