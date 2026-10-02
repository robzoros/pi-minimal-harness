/**
 * Indentation-aware editing of `harness.config.yaml`.
 *
 * The installer's rule is that a user's configuration is never overwritten, so
 * anything that writes it has to add or update in place without disturbing the
 * formatting around it. No YAML parser, no dependency: the file is a known,
 * small shape, and a rewrite that reformatted it would be a bug, not a
 * convenience.
 */

const BLOCK_LINE = /^ {2}([A-Za-z0-9_-]+):\s*$/;
const FIELD_LINE = /^ {4}([A-Za-z0-9_-]+):/;

function agentRange(lines: string[], agent: string): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(BLOCK_LINE);
    if (match && match[1] === agent) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (BLOCK_LINE.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * Set `fields` on one agent block, inserting any that are absent directly after
 * its `model:` line (or at the top of the block when there is no model).
 */
export function setAgentFields(text: string, agent: string, fields: Record<string, string>): string {
  const lines = text.split(/\r?\n/);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const range = agentRange(lines, agent);
  if (!range) return text;

  const next = [...lines];
  const missing: string[] = [];
  for (const [field, value] of Object.entries(fields)) {
    let found = false;
    for (let i = range.start + 1; i < range.end; i++) {
      const match = next[i].match(FIELD_LINE);
      if (match && match[1] === field) {
        next[i] = `    ${field}: ${value}`;
        found = true;
        break;
      }
    }
    if (!found) missing.push(`    ${field}: ${value}`);
  }

  if (missing.length > 0) {
    let anchor = range.start;
    for (let i = range.start + 1; i < range.end; i++) {
      if (/^ {4}model:/.test(next[i])) {
        anchor = i;
        break;
      }
    }
    next.splice(anchor + 1, 0, ...missing);
  }
  return next.join(eol);
}

/** Which agents are defined, in file order. */
export function listAgents(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.match(BLOCK_LINE)?.[1] ?? null)
    .filter((name): name is string => name !== null);
}
