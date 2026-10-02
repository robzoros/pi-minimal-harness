/**
 * The requirements file: the source of truth for what the workflow delivers.
 *
 * Markdown rather than YAML because the planner is a model writing prose, but
 * with a shape strict enough to check mechanically — which is the whole point.
 * Every rule here is something a human can also verify by eye.
 */

import { promises as fs } from "node:fs";

export const REQUIREMENT_STATUSES = ["approved", "implemented", "validated", "delivered"] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

/** Statuses that imply the earlier ones happened. */
const STATUS_ORDER: RequirementStatus[] = ["approved", "implemented", "validated", "delivered"];

/** Statuses that cannot be claimed without evidence of validation. */
const NEEDS_VALIDATED_BY: RequirementStatus[] = ["validated", "delivered"];

export interface Requirement {
  id: string;
  title: string;
  status?: RequirementStatus;
  acceptance?: string;
  changes?: string[];
  validatedBy?: string[];
}

export interface RequirementsFile {
  path: string;
  exists: boolean;
  requirements: Requirement[];
  /** Human-readable problems, each naming the requirement it belongs to. */
  issues: string[];
}

const HEADING = /^##\s+(REQ-\d+)\s*(?:—|-)?\s*(.*)$/;
const FIELD = /^[-*]\s+\*\*([A-Za-z ]+):\*\*\s*(.*)$/;

/** Parse the markdown requirements file. Pure; never throws on bad content. */
export function parseRequirements(markdown: string, path = ""): RequirementsFile {
  const requirements: Requirement[] = [];
  const issues: string[] = [];
  let current: Requirement | null = null;

  const flush = () => {
    if (!current) return;
    requirements.push(current);
    if (!current.status) issues.push(`${current.id} has no Status`);
    if (!current.acceptance || current.acceptance.trim() === "") issues.push(`${current.id} has no Acceptance criteria`);
    for (const status of NEEDS_VALIDATED_BY) {
      if (current.status === status && (!current.validatedBy || current.validatedBy.length === 0)) {
        issues.push(`${current.id} is "${status}" but lists nothing under Validated by`);
      }
    }
    if (current.status === "delivered") {
      if (!current.changes || current.changes.length === 0) issues.push(`${current.id} is "delivered" but lists no Changes`);
    }
  };

  for (const raw of String(markdown ?? "").split(/\r?\n/)) {
    const heading = raw.match(HEADING);
    if (heading) {
      flush();
      current = { id: heading[1], title: heading[2].trim(), changes: [], validatedBy: [] };
      continue;
    }
    if (!current) continue;
    const field = raw.match(FIELD);
    if (!field) continue;
    const key = field[1].trim().toLowerCase();
    const value = field[2].trim();
    if (key === "status") current.status = value as RequirementStatus;
    else if (key === "acceptance") current.acceptance = value;
    else if (key === "changes") current.changes = value === "" ? [] : value.split(/[,;]/).map((v) => v.trim()).filter(Boolean);
    else if (key === "validated by") current.validatedBy = value === "" ? [] : value.split(/[,;]/).map((v) => v.trim()).filter(Boolean);
  }
  flush();

  if (requirements.length === 0) issues.push("no REQ-NNN requirements found");

  // Unique and monotonic: a duplicated or rewound id breaks traceability.
  const seen = new Set<string>();
  let previous = 0;
  for (const req of requirements) {
    if (seen.has(req.id)) issues.push(`${req.id} is declared more than once`);
    seen.add(req.id);
    const n = Number(req.id.replace("REQ-", ""));
    if (!Number.isInteger(n)) issues.push(`${req.id} does not carry a numeric id`);
    else if (n <= previous) issues.push(`${req.id} breaks the ascending id order (previous was REQ-${String(previous).padStart(3, "0")})`);
    else previous = n;
  }

  for (const req of requirements) {
    if (req.status && !(REQUIREMENT_STATUSES as readonly string[]).includes(req.status)) {
      issues.push(`${req.id} has an unknown status ${JSON.stringify(req.status)} (expected ${REQUIREMENT_STATUSES.join(", ")})`);
    }
  }

  return { path, exists: true, requirements, issues };
}

/** Read and parse. A missing file is an issue, not a throw. */
export async function readRequirementsFile(path: string): Promise<RequirementsFile> {
  let markdown: string;
  try {
    markdown = await fs.readFile(path, "utf8");
  } catch {
    return { path, exists: false, requirements: [], issues: [`requirements file not found at ${path}`] };
  }
  return parseRequirements(markdown, path);
}

/** Requirements whose status is at least `status`, in ascending order. */
export function atLeast(requirements: Requirement[], status: RequirementStatus): Requirement[] {
  const target = STATUS_ORDER.indexOf(status);
  return requirements.filter((r) => r.status !== undefined && STATUS_ORDER.indexOf(r.status) >= target);
}

/** Every id mentioned anywhere in a text, deduplicated and ordered. */
export function citedIds(text: string): string[] {
  return [...new Set([...String(text ?? "").matchAll(/REQ-\d+/g)].map((m) => m[0]))];
}
