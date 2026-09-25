// 종목 스크리너: DART 재무(주 1회 캐시) → 1차 필터 → Yahoo 시세 → 2차 필터 → 점수 → 후보 + 사업보고서 발췌
// 정성 평가(기술/사업모델)는 run-screener.bat 에서 claude -p 로 이어서 수행
import 'dotenv/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CONFIG as C } from './config.mjs';
import { kstDate } from '../common/util.mjs';

import { fetchListedCorps, fetchFinancials, latestFiscalYear, latestAnnualReportNo, fetchBusinessSection } from './sources/dart.mjs';
import { resolveSymbols, fetchDaily, pmap } from './sources/prices.mjs';
import { fetchDisclosures, fetchNews, overviewExcerpt } from './sources/issues.mjs';
import { financialMetrics, priceMetrics, passPriceFilter, score } from './metrics.mjs';

const env = process.env;
const DATA = path.resolve('data');
const OUT = path.resolve(env.OUT_DIR || 'out', 'screener');

const exists = (p) => access(p).then(() => true, () => false);
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const writeJson = (p, v) => writeFile(p, JSON.stringify(v, null, 1), 'utf8');
const won = (v) => v == null ? '-' : v >= 1e12 ? `${(v / 1e12).toFixed(2)}조` : `${Math.round(v / 1e8).toLocaleString()}억`;
const pct = (v) => v == null ? '-' : `${(v * 100).toFixed(1)}%`;

/** DART 재무 (캐시 7일) */
async function loadFinancials(key) {
  const fy = latestFiscalYear();
  const cachePath = path.join(DATA, `financials-${fy}.json`);
  if (await exists(cachePath)) {
    const c = await readJson(cachePath);
    const ageDays = (Date.now() - Date.parse(c.fetchedAt)) / 86400000;
    if (ageDays < C.financialsTtlDays) { console.log(`재무 캐시 사용 (FY${fy}, ${ageDays.toFixed(1)}일 전, ${Object.keys(c.financials).length}사)`); return c; }
  }
  console.log(`DART 상장사 목록 수신 중…`);
  const corps = await fetchListedCorps(key);
  console.log(`  ${corps.length}사. FY${fy} 주요계정 수신 중 (${Math.ceil(corps.length / 100)}콜)…`);
  const financials = await fetchFinancials(key, corps, fy, {
    onProgress: (i, n, got) => { if (i % 5 === 0 || i === n) process.stdout.write(`  ${i}/${n}\r`); },
  });
  console.log(`  재무 확보 ${Object.keys(financials).length}사`);
  const c = { fy, fetchedAt: new Date().toISOString(), corps, financials };
  await mkdir(DATA, { recursive: true });
  await writeJson(cachePath, c);
  return c;
}

/** 사업보고서 발췌 (접수번호별 캐시) */
async function loadBusinessDoc(key, corpCode, stockCode) {
  const rcept = await latestAnnualReportNo(key, corpCode);
  if (!rcept) return null;
  const p = path.join(DATA, 'docs', `${stockCode}-${rcept}.txt`);
  if (await exists(p)) return { rcept, text: await readFile(p, 'utf8') };
  const text = await fetchBusinessSection(key, rcept, C.docChars);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, text, 'utf8');
  return { rcept, text };
}

export async function runScreener() {
  const key = env.DART_API_KEY;
  if (!key) throw new Error('DART_API_KEY 가 필요합니다 (.env). 발급: https://opendart.fss.or.kr/');
  const t0 = Date.now();
  const today = kstDate();
  const outDir = path.join(OUT, today);
  await mkdir(path.join(outDir, 'docs'), { recursive: true });

  // 1) 재무 필터
  const { fy, corps, financials } = await loadFinancials(key);
  const byCorp = new Map(corps.map((c) => [c.corpCode, c]));
  const stage1 = [];
  for (const [corpCode, f] of Object.entries(financials)) {
    const fm = financialMetrics(f);
    if (fm) stage1.push({ ...byCorp.get(corpCode), fm });
  }
  console.log(`1차(재무: ${C.profitYears}년 흑자·이익률·부채·ROE) 통과: ${stage1.length}사`);

  // 2) 심볼·시총
  console.log('Yahoo 심볼/시총 조회…');
  const quotes = await resolveSymbols(stage1.map((c) => c.stockCode));
  const stage2 = stage1.filter((c) => {
    const q = quotes[c.stockCode];
    return q && q.marketCap != null && q.marketCap >= C.minMarketCap && q.marketCap <= C.maxMarketCap;
  });
  console.log(`  시총 ${won(C.minMarketCap)}~${won(C.maxMarketCap)} 범위: ${stage2.length}사 → 1년 일봉 수신 (동시 ${C.chartConcurrency})…`);

  // 3) 시세 지표
  let done = 0;
  const charts = await pmap(stage2, async (c) => {
    const bars = await fetchDaily(quotes[c.stockCode].symbol);
    if (++done % 25 === 0) process.stdout.write(`  ${done}/${stage2.length}\r`);
    return { pm: priceMetrics(bars, quotes[c.stockCode].marketCap), bars };
  }, C.chartConcurrency);

  const passed = [];
  stage2.forEach((c, i) => {
    const r = charts[i];
    if (!r.ok || !passPriceFilter(r.value.pm)) return;
    const sc = score(c.fm, r.value.pm);
    // 핸드폰 페이지 일봉(캔들)용: 최근 6개월 [날짜, 시, 고, 저, 종, 거래량]
    const ohlc = r.value.bars.slice(-130).map((b) => [b.date.toISOString().slice(0, 10), b.open, b.high, b.low, b.close, b.volume]);
    passed.push({ code: c.stockCode, name: c.name, corpCode: c.corpCode, symbol: quotes[c.stockCode].symbol, fm: c.fm, pm: r.value.pm, ...sc, ohlc });
  });
  passed.sort((a, b) => b.score - a.score);
  const candidates = passed.slice(0, C.topN);
  console.log(`2차(시세: 변동성·박스권·등락·유동성) 통과: ${passed.length}사 → 상위 ${candidates.length} 후보`);

  // 4) 사업보고서 발췌 (정성 평가 입력)
  console.log('사업보고서 발췌 수신…');
  const docs = await pmap(candidates, (c) => loadBusinessDoc(key, c.corpCode, c.code), 2);
  candidates.forEach((c, i) => {
    const d = docs[i];
    c.doc = d.ok && d.value ? path.join('docs', `${c.code}.txt`) : null;
    c.docError = d.ok ? null : d.error;
  });
  await Promise.all(candidates.map((c, i) => c.doc ? writeFile(path.join(outDir, c.doc), docs[i].value.text, 'utf8') : null));
  candidates.forEach((c, i) => { c.overview = docs[i].ok && docs[i].value ? overviewExcerpt(docs[i].value.text) : ''; });

  // 4b) 주요 이슈: 최근 공시 + 뉴스 헤드라인 (사업개요 버튼용)
  console.log('최근 공시·뉴스 수신…');
  const issues = await pmap(candidates, async (c) => {
    const [disc, news] = await Promise.all([
      fetchDisclosures(key, c.corpCode).catch(() => []),
      fetchNews(c.name).catch(() => []),
    ]);
    return { disclosures: disc, news };
  }, 3);
  candidates.forEach((c, i) => { c.issues = issues[i].ok ? issues[i].value : { disclosures: [], news: [] }; });

  // 5) 출력
  const md = renderMarkdown(candidates, { fy, today, stage1: stage1.length, stage2: stage2.length, passed: passed.length });
  await writeJson(path.join(outDir, 'candidates.json'), { date: today, fy, config: C, candidates });
  await writeFile(path.join(outDir, 'candidates.md'), md, 'utf8');

  // 후보 구성이 지난 실행과 같으면 LLM 단계 스킵할 수 있게 플래그
  const hash = createHash('sha1').update(candidates.map((c) => c.code).join(',')).digest('hex');
  const lastPath = path.join(DATA, 'last-candidates.sha1');
  const changed = !(await exists(lastPath)) || (await readFile(lastPath, 'utf8')).trim() !== hash;
  await writeFile(lastPath, hash, 'utf8');
  await writeFile(path.join(outDir, 'CHANGED'), changed ? '1' : '0', 'utf8');

  console.log(`\n${md.split('\n').slice(0, 20).join('\n')}\n…`);
  console.log(`저장: ${outDir}  후보 ${changed ? '변경됨 → 정성 평가 필요' : '지난번과 동일'}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  // 텔레그램 발송은 src/telegram.mjs 가 전담 (중복 발송 방지)
  return { outDir, candidates, changed };
}

function renderMarkdown(cands, m) {
  const L = [];
  L.push(`# 종목 스크리너 후보  ${m.today}  (재무 FY${m.fy})`);
  L.push('');
  L.push(`1차 재무 통과 ${m.stage1} → 시총 범위 ${m.stage2} → 시세 조건 통과 ${m.passed} → 상위 ${cands.length}`);
  L.push('');
  L.push('| # | 종목 | 시총 | 점수 | 영업이익률 | ROE | 부채비율 | PBR | PER | 6M변동성 | 6M등락 | 52주고점比 | 근거 |');
  L.push('|--:|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|');
  cands.forEach((c, i) => {
    L.push(`| ${i + 1} | ${c.name} (${c.code}) | ${won(c.pm.marketCap)} | ${c.score} | ${pct(c.fm.opMargin)} | ${pct(c.fm.roe)} | ${pct(c.fm.debtRatio)} | ${c.pbr.toFixed(2)} | ${c.per?.toFixed(1) ?? '-'} | ${pct(c.pm.annVol)} | ${pct(c.pm.ret6m)} | ${pct(c.pm.fromHigh52w)} | ${c.why.join(', ')} |`);
  });
  L.push('');
  L.push('## 3개년 실적 (억원, 당기→전전기)');
  L.push('');
  cands.forEach((c) => {
    const f = c.fm;
    L.push(`- **${c.name}** 매출 ${won(f.revenue)} · 영업이익 ${f.opIncome.map(won).join(' / ')} · 순이익 ${f.netIncome.map(won).join(' / ')} ${c.doc ? '' : `· ⚠ 사업보고서 없음(${c.docError ?? ''})`}`);
  });
  return L.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runScreener().catch((e) => { console.error(`스크리너 실패: ${e.message}`); if (env.DEBUG) console.error(e.stack); process.exit(1); });
}
