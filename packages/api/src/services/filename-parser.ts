interface ParsedMetadata {
  agent_name?: string;
  customer_phone?: string;
  call_date?: string;
}

// Convert a template like "{agent}__{phone}__{date}.mp3" into a regex,
// then extract named groups. Returns empty object if no match.
export function parseFilename(filename: string, template: string | null): ParsedMetadata {
  if (!template) return {};

  const placeholders = ['agent', 'phone', 'date'] as const;
  let regexPattern = template;

  // Escape regex special chars except the placeholders
  regexPattern = regexPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

  // Replace placeholders with named capture groups (non-greedy)
  for (const name of placeholders) {
    regexPattern = regexPattern.replace(
      `{${name}}`,
      `(?<${name}>[^_]+?)`
    );
  }

  // Anchor to whole filename
  const regex = new RegExp(`^${regexPattern}$`);
  const match = regex.exec(filename);
  if (!match?.groups) return {};

  const result: ParsedMetadata = {};
  if (match.groups.agent) result.agent_name = match.groups.agent.replace(/[-_]/g, ' ');
  if (match.groups.phone) result.customer_phone = match.groups.phone;
  if (match.groups.date) result.call_date = match.groups.date;
  return result;
}
