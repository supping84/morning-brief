// 공통 유틸: KST 날짜, 숫자 포맷, 타임아웃 fetch

const KST = 'Asia/Seoul';

export function kstNow() {
  return new Date();
}

/** YYYY-MM-DD (KST) */
export function kstDate(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: KST, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** YYYYMMDD (KST) */
export function kstCompact(d = new Date()) {
  return kstDate(d).replaceAll('-', '');
}

/** MM/DD HH:mm (KST) */
export function kstStamp(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: KST, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(dt).map((x) => [x.type, x.value]),
  );
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

export function daysAgo(n, from = new Date()) {
  return new Date(from.getTime() - n * 86400000);
}

export function fmtNum(v, digits = 2) {
  if (v == null || Number.isNaN(v)) return '-';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** +0.35% / -1.20% 형태, 화살표 포함 */
export function fmtPct(v) {
  if (v == null || Number.isNaN(v)) return '';
  const n = Number(v);
  const arrow = n > 0 ? '▲' : n < 0 ? '▼' : '─';
  return `${arrow}${Math.abs(n).toFixed(2)}%`;
}

/** 절대 변화량 (금리 bp 등) */
export function fmtDelta(v, digits = 2, unit = '') {
  if (v == null || Number.isNaN(v)) return '';
  const n = Number(v);
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}${unit}`;
}

export async function fetchJson(url, { timeoutMs = 15000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 morning-brief', ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split('?')[0]}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** 소스 하나가 죽어도 전체가 안 죽게 감싸는 래퍼 */
export async function safe(name, fn) {
  try {
    const v = await fn();
    return { ok: true, name, data: v };
  } catch (e) {
    console.error(`[${name}] 실패: ${e.message}`);
    return { ok: false, name, error: e.message };
  }
}
