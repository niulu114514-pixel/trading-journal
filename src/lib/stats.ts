export function monthBounds(month: string): { start: string; end: string } {
  const [year, monthNumber] = month.split('-').map(Number);
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  const nextYear = monthNumber === 12 ? year + 1 : year;
  return { start: `${month}-01`, end: `${nextYear}-${String(nextMonth).padStart(2, '0')}-01` };
}

export function statsPeriodSql(granularity: string): { expression: string; format?: string } | null {
  const formats: Record<string, string> = { day: '%Y-%m-%d', month: '%Y-%m', year: '%Y' };
  if (granularity === 'week') {
    return {
      expression: `strftime('%Y', date(entry_time, '-3 days', 'weekday 4')) || '-W' ||
        printf('%02d', CAST((CAST(strftime('%j', date(entry_time, '-3 days', 'weekday 4')) AS INTEGER) - 1) / 7 + 1 AS INTEGER))`
    };
  }
  return formats[granularity] ? { expression: 'strftime(?, entry_time)', format: formats[granularity] } : null;
}
