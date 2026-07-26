import { getLanguageInfo } from './languages';

export function getLocaleTag(locale: string): string {
  const info = getLanguageInfo(locale);
  return info.numberLocale || locale;
}

export function formatNumber(value: number, locale: string, options?: Intl.NumberFormatOptions): string {
  try {
    return new Intl.NumberFormat(getLocaleTag(locale), options).format(value);
  } catch {
    return value.toString();
  }
}

export function formatInteger(value: number, locale: string): string {
  return formatNumber(Math.round(value), locale, { maximumFractionDigits: 0 });
}

export function formatPercent(value: number, locale: string, options?: Intl.NumberFormatOptions): string {
  return formatNumber(value, locale, { style: 'percent', ...options });
}

export function formatBytes(bytes: number, locale: string): string {
  if (bytes === 0) return `0 B`;
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = parseFloat((bytes / Math.pow(k, i)).toFixed(2));
  const formattedVal = formatNumber(val, locale, { maximumFractionDigits: 2 });
  return `${formattedVal} ${sizes[i]}`;
}

export function formatTransferRate(bytesPerSec: number, locale: string): string {
  const formatted = formatBytes(bytesPerSec, locale);
  return `${formatted}/s`;
}

export function formatDate(date: Date | number | string, locale: string, options?: Intl.DateTimeFormatOptions): string {
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return '—';
    const info = getLanguageInfo(locale);
    return new Intl.DateTimeFormat(info.dateLocale || locale, options || { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
  } catch {
    return '—';
  }
}

export function formatDateTime(date: Date | number | string, locale: string): string {
  return formatDate(date, locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, locale: string): string {
  try {
    return new Intl.RelativeTimeFormat(getLocaleTag(locale), { numeric: 'auto' }).format(value, unit);
  } catch {
    return `${value} ${unit}`;
  }
}

export function formatDuration(seconds: number, locale: string): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) {
    const remMins = mins % 60;
    return `${formatInteger(hrs, locale)}h ${formatInteger(remMins, locale)}m`;
  }
  return `${formatInteger(mins, locale)}m ${formatInteger(secs, locale)}s`;
}

export function formatList(items: string[], locale: string): string {
  try {
    const ListFormat = (Intl as any).ListFormat;
    if (ListFormat) {
      return new ListFormat(getLocaleTag(locale), { style: 'long', type: 'conjunction' }).format(items);
    }
    return items.join(', ');
  } catch {
    return items.join(', ');
  }
}
