export function expandGeneratedSeeds(config = {}) {
  const templates = new Map((config.templates || []).map((template) => [template.id, template]));
  const publishDate = config.generated_at || new Date().toISOString().slice(0, 10);
  const jobs = [];

  for (const source of config.sources || []) {
    for (const templateId of source.templates || []) {
      const template = templates.get(templateId);
      if (!template) continue;
      const focus = source.focus || source.company;
      jobs.push({
        ...materializeTemplate(template, source, focus),
        id: `generated_${source.key}_${template.id}`,
        company: source.company,
        location: source.locations || [],
        publish_date: publishDate,
        source_url: source.official_url,
        source_channel: "generated-official-source-seed",
        crawler_source_id: source.key,
      });
    }
  }

  return jobs;
}

function materializeTemplate(template, source, focus) {
  const replacements = {
    focus,
    company: source.company,
  };
  const output = {};
  for (const [key, value] of Object.entries(template)) {
    if (key === "id") continue;
    output[key] = replacePlaceholders(value, replacements);
  }
  return output;
}

function replacePlaceholders(value, replacements) {
  if (Array.isArray(value)) return value.map((item) => replacePlaceholders(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replacePlaceholders(item, replacements)]));
  }
  if (typeof value !== "string") return value;
  return value.replace(/\{(\w+)\}/g, (_, key) => replacements[key] ?? "");
}
