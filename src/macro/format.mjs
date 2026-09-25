// 수집 결과 → 텍스트 브리핑 (LLM 없이도 완결되는 템플릿)
import { fmtNum, fmtPct, fmtDelta, kstStamp, kstDate } from '../common/util.mjs';

function line(label, q, digits = 2) {
  if (!q || q.missing || q.price == null) return `  ${label.padEnd(14)} -`;
  return `  ${label.padEnd(14)} ${fmtNum(q.price, digits).padStart(10)}  ${fmtPct(q.changePct)}`;
}

function rateLine(r) {
  if (r.error) return `  ${r.label.padEnd(16)} - (${r.error})`;
  const bp = r.delta == null ? '' : fmtDelta(r.delta * 100, 1, 'bp');
  return `  ${r.label.padEnd(16)} ${fmtNum(r.value, 3).padStart(7)}%  ${bp}  (${r.date.slice(5)})`;
}

export function formatBrief({ markets, exim, ecos, fred, rss, naver, summary }) {
  const L = [];
  const today = kstDate();
  L.push(`📊 모닝 브리핑  ${today} 06:30`);
  L.push('');

  if (summary) {
    L.push('■ 오늘의 요약');
    L.push(summary.trim());
    L.push('');
  }

  if (markets?.ok) {
    const m = markets.data;
    const usTime = m.us.find((x) => x.time)?.time;
    L.push(`■ 간밤 미장 (마감 ${kstStamp(usTime)} KST)`);
    m.us.forEach((q) => L.push(line(q.label, q)));
    L.push('');

    L.push('■ 미 국채금리 (Yahoo, 장중~마감)');
    m.usRates.forEach((q) => {
      if (q.missing || q.price == null) return L.push(`  ${q.label.padEnd(14)} -`);
      L.push(`  ${q.label.padEnd(14)} ${fmtNum(q.price, 3).padStart(7)}%  ${fmtDelta((q.price - q.prevClose) * 100, 1, 'bp')}`);
    });
    L.push('');

    L.push('■ 달러 / 환율');
    m.fx.forEach((q) => L.push(line(q.label, q, /KRW|JPY/.test(q.symbol) ? 2 : 4)));
    L.push('');

    L.push('■ 원자재 (선물, 밤사이 반영)');
    m.commodities.forEach((q) => L.push(line(q.label, q)));
    L.push('');

    L.push('■ 국내 (전일 마감)');
    m.kr.forEach((q) => L.push(line(q.label, q)));
    L.push('');

    L.push('■ 글로벌 참고');
    m.global.forEach((q) => L.push(line(q.label, q, q.symbol === 'BTC-USD' ? 0 : 2)));
    L.push('');
  } else {
    L.push(`■ 시장 데이터 실패: ${markets?.error}`);
    L.push('');
  }

  if (exim?.ok) {
    L.push(`■ 고시환율 (수출입은행, ${exim.data.date} 매매기준율)`);
    exim.data.rates.forEach((r) => L.push(`  ${r.unit.padEnd(9)} ${fmtNum(r.base, 2).padStart(10)}   살때 ${fmtNum(r.tts, 2)} / 팔때 ${fmtNum(r.ttb, 2)}`));
    L.push('');
  }

  if (ecos?.ok || fred?.ok) {
    L.push('■ 금리 확정치');
    if (ecos?.ok) ecos.data.forEach((r) => L.push(rateLine(r)));
    if (fred?.ok) fred.data.forEach((r) => L.push(rateLine(r)));
    L.push('');
  }

  const headlines = [];
  if (rss?.ok) headlines.push(...rss.data.market.map((h) => `  · [${h.source}] ${h.title}`));
  if (naver?.ok) headlines.push(...naver.data.map((h) => `  · [네이버:${h.query}] ${h.title}`));
  if (headlines.length) {
    L.push(`■ 주요 이슈 (밤사이 헤드라인 ${headlines.length}건, 상위 25)`);
    L.push(...headlines.slice(0, 25));
    L.push('');
  }

  const skipped = [markets, exim, ecos, fred, rss, naver].filter((r) => r && !r.ok).map((r) => `${r.name}(${r.error})`);
  if (skipped.length) L.push(`※ 건너뜀: ${skipped.join(', ')}`);

  return L.join('\n');
}

/** LLM 요약용: 사람이 읽는 포맷과 동일하게 주되 헤드라인 링크까지 포함 */
export function formatForLlm(data) {
  const base = formatBrief({ ...data, summary: null });
  const links = data.rss?.ok ? data.rss.data.market.slice(0, 40).map((h) => `- ${h.title} (${h.source})`).join('\n') : '';
  return `${base}\n\n[헤드라인 전체]\n${links}`;
}
