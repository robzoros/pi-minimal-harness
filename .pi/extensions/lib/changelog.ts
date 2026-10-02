/**
 * Changelog validation for the deliverer.
 *
 * One question, answerable mechanically: is every requirement marked delivered
 * actually cited in the `[Unreleased]` section? The citation is what ties "we
 * changed behaviour" to "we said why", and it is the one link in the
 * traceability chain that no agent can assert without evidence.
 */

import { promises as fs } from "node:fs";
import { citedIds, type Requirement } from "./requirements.ts";
import type { Check } from "./validate.ts";

const UNRELEASED = /^\s*##\s+\[?unreleased\]?/i;
const NEXT_HEADING = /^\s*##\s+/;

/** The text under the `[Unreleased]` heading, or "" when there is none. */
export function unreleasedSection(markdown: string): string {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => UNRELEASED.test(line));
  if (start === -1) return "";
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (NEXT_HEADING.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

/** Requirements whose status is exactly `delivered`. */
export function deliveredRequirements(requirements: Requirement[]): Requirement[] {
  return requirements.filter((r) => r.status === "delivered");
}

/**
 * Check that the changelog can back the delivery.
 *
 * A missing changelog fails. An empty `[Unreleased]` fails when something is
 * marked delivered, and passes when nothing is — a workflow that changed no
 * behaviour owes no entry.
 */
export function validateChangelog(markdown: string, requirements: Requirement[], path = "CHANGELOG.md"): Check[] {
  const checks: Check[] = [];
  const delivered = deliveredRequirements(requirements);

  if (String(markdown ?? "").trim() === "") {
    return [{ label: `${path} exists`, ok: false, severity: "error", detail: "the changelog is missing or empty" }];
  }

  const section = unreleasedSection(markdown);
  checks.push({
    label: `${path} has an [Unreleased] section`,
    ok: section !== "" || delivered.length === 0,
    severity: "error",
    detail: section === "" ? "no [Unreleased] heading found" : undefined,
  });

  if (delivered.length === 0) {
    checks.push({
      label: "every delivered requirement is cited in [Unreleased]",
      ok: true,
      severity: "error",
      detail: "nothing is marked delivered",
    });
    return checks;
  }

  const cited = new Set(citedIds(section));
  const missing = delivered.filter((r) => !cited.has(r.id)).map((r) => r.id);
  checks.push({
    label: "every delivered requirement is cited in [Unreleased]",
    ok: missing.length === 0,
    severity: "error",
    detail: missing.length === 0 ? `${delivered.length} delivered requirement(s) cited` : `missing: ${missing.join(", ")}`,
  });
  return checks;
}

/** Read the changelog and validate it. A missing file is an error, not a throw. */
export async function readAndValidateChangelog(path: string, requirements: Requirement[]): Promise<Check[]> {
  let markdown: string;
  try {
    markdown = await fs.readFile(path, "utf8");
  } catch {
    return validateChangelog("", requirements, path);
  }
  return validateChangelog(markdown, requirements, path);
}
