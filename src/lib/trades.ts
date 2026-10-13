export function normalizeTradeTimeframes(value: unknown, fallback = ''): string {
  const items = (Array.isArray(value) ? value : String(value ?? '').split(/[,，]/))
    .map(item => String(item).trim())
    .filter(Boolean);
  return [...new Set(items)].join(',') || fallback;
}
