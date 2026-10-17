import { sha256 } from "@polygraph/core";
import { shellQuote, type RemoteSandbox } from "./worker.js";

export interface Finding {
  passed: boolean;
  detail: string;
}

/** Packages the converter depends on: LibreOffice, its UNO runtime and the Python bridge. */
const PACKAGE_PATTERN = "libreoffice|^python3-uno$|^uno-|^ure$|^poppler-utils$";

/** devbox:1 is built with dpkg path excludes, so these files are absent on every stock install. */
const EXCLUDED_BY_IMAGE = /^missing\s+\/usr\/share\/(doc|man|info)\//;

/**
 * Checks the installed LibreOffice packages against dpkg's own checksums. dpkg's database lives in
 * the same rootfs, so this catches careless tampering, not a seller who also rewrites the database;
 * buyer-owned mode removes that dependency.
 */
export async function verifySystemPackages(worker: RemoteSandbox): Promise<Finding> {
  const listing = await worker.sh(`dpkg-query -W -f='\${db:Status-Abbrev} \${Package}\\n' | awk '$1 == "ii" && $2 ~ /${PACKAGE_PATTERN}/ {print $2}'`);
  const packages = listing.stdout.split("\n").map((p) => p.trim()).filter(Boolean);
  if (packages.length === 0) return { passed: false, detail: "no LibreOffice packages installed through dpkg" };

  const run = await worker.sh(`dpkg --verify ${packages.map(shellQuote).join(" ")} 2>&1`, 180_000);
  const lines = run.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const changed = lines.filter((line) => !EXCLUDED_BY_IMAGE.test(line));
  if (changed.length > 0) return { passed: false, detail: `${changed.length} changed files: ${changed.slice(0, 3).join("; ")}` };
  const skipped = lines.length ? `, ${lines.length} doc/man files absent as on the stock image` : "";
  return { passed: true, detail: `${packages.length} packages match dpkg checksums${skipped}` };
}

/**
 * Python startup hook files present on a stock devbox:1, measured on a fresh sandbox (Oct 18):
 * path as listed on the interpreter's path, sha256 of the file it resolves to.
 */
const STOCK_PYTHON_HOOKS = new Map([
  ["/root/.asdf/installs/python/3.13.14/lib/python3.13/site-packages/distutils-precedence.pth", "2638ce9e2500e572a5e0de7faed6661eb569d1b696fcba07b0dd223da5f5d224"],
  ["/usr/lib/python3/dist-packages/distutils-precedence.pth", "2638ce9e2500e572a5e0de7faed6661eb569d1b696fcba07b0dd223da5f5d224"],
  ["/usr/lib/python3.12/sitecustomize.py", "43d81125d92376b1a69d53a71126a041cc9a18d8080e92dea0a2ae23be138b1e"],
]);

/** Prints `listed-path<TAB>resolved-path` for every sitecustomize, usercustomize and .pth file either python3 would load. */
const FIND_HOOKS = [
  `for py in python3 /usr/bin/python3; do`,
  `  $py -c 'import site, sys; print("\\n".join(p for p in site.getsitepackages() + [site.getusersitepackages()] + sys.path if p))' 2>/dev/null;`,
  `done | sort -u | while read -r dir; do`,
  `  [ -d "$dir" ] && find "$dir" -maxdepth 1 \\( -name sitecustomize.py -o -name usercustomize.py -o -name '*.pth' \\) 2>/dev/null;`,
  `done | sort -u | while read -r f; do printf '%s\\t%s\\n' "$f" "$(readlink -f "$f")"; done`,
].join("\n");

/**
 * Code in these files runs before any script, so a seller could hide behaviour there without
 * touching the signed tool. Each one must be on the stock list with stock content, which the
 * buyer hashes itself after downloading it.
 */
export async function verifyPythonHooks(worker: RemoteSandbox): Promise<Finding> {
  const run = await worker.sh(FIND_HOOKS);
  const hooks = run.stdout.split("\n").filter(Boolean).map((line) => line.split("\t") as [string, string]);
  const problems: string[] = [];
  for (const [listed, resolved] of hooks) {
    const expected = STOCK_PYTHON_HOOKS.get(listed);
    if (!expected) {
      problems.push(`added ${listed}`);
      continue;
    }
    const actual = sha256(await worker.download(resolved || listed));
    if (actual !== expected) problems.push(`changed ${listed} (sha256 ${actual.slice(0, 12)}…)`);
  }
  if (problems.length > 0) return { passed: false, detail: problems.join("; ") };
  return { passed: true, detail: `${hooks.length} hook files, all stock and unchanged` };
}
