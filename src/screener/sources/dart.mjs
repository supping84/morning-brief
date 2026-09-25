// 금융감독원 DART OpenAPI (무료, 키 필요, 하루 2만 건)
// 발급: https://opendart.fss.or.kr/ → 인증키 신청
//  - corpCode: 전체 기업코드 (zip/xml). stock_code 있는 것만 = 상장사
//  - fnlttMultiAcnt: 다중회사 주요계정. 100개 회사/1콜, 당기·전기·전전기 3개년이 한 번에 옴
//  - list + document: 최신 사업보고서 원문 → "사업의 내용" 발췌
import { unzipSync, strFromU8 } from 'fflate';
import { fetchJson } from '../../common/util.mjs';

const BASE = 'https://opendart.fss.or.kr/api';

async function fetchZipText(url, preferName) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DART HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  // zip 이 아니면 에러 응답 (xml/json) — 메시지만 뽑아서 던짐
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    const body = strFromU8(buf);
    const msg = body.match(/<message>(.*?)<\/message>/)?.[1] || body.match(/"message"\s*:\s*"([^"]*)"/)?.[1] || body.slice(0, 120);
    throw new Error(`DART: ${msg}`);
  }
  const files = unzipSync(buf);
  // 사업보고서 zip 은 본문(<접수번호>.xml) + 첨부 여러 개. 본문 우선, 없으면 가장 큰 파일
  const names = Object.keys(files);
  const name = (preferName && names.find((n) => n === preferName))
    ?? names.filter((n) => /\.(xml|html?)$/i.test(n)).sort((a, b) => files[b].length - files[a].length)[0]
    ?? names[0];
  return strFromU8(files[name]);
}

/** 상장사 목록: [{corpCode, stockCode, name}] */
export async function fetchListedCorps(key) {
  const xml = await fetchZipText(`${BASE}/corpCode.xml?crtfc_key=${key}`);
  const out = [];
  for (const m of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
    const block = m[1];
    const g = (tag) => block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]?.trim() ?? '';
    const stockCode = g('stock_code');
    if (!/^\d{6}$/.test(stockCode)) continue;
    out.push({ corpCode: g('corp_code'), stockCode, name: g('corp_name') });
  }
  if (!out.length) throw new Error('corpCode 파싱 결과 0건');
  return out;
}

/** 최근 사업보고서 기준연도: 4월 이후면 작년, 그 전엔 재작년 (3월 말 제출 마감) */
export function latestFiscalYear(d = new Date()) {
  return d.getMonth() + 1 >= 4 ? d.getFullYear() - 1 : d.getFullYear() - 2;
}

const num = (s) => {
  if (s == null || s === '' || s === '-') return null;
  const n = Number(String(s).replaceAll(',', ''));
  return Number.isFinite(n) ? n : null;
};

// account_nm 표기 흔들림 흡수
const ACCOUNT = {
  revenue: ['매출액', '수익(매출액)', '영업수익', '매출'],
  opIncome: ['영업이익', '영업이익(손실)', '영업손익'],
  netIncome: ['당기순이익', '당기순이익(손실)', '당기순손익', '당기순이익(손실)'],
  equity: ['자본총계'],
  liabilities: ['부채총계'],
  assets: ['자산총계'],
};

/**
 * 다중회사 주요계정 → { corpCode: { fy, fsDiv, revenue:[당기,전기,전전기], opIncome:[...], netIncome:[...], equity, liabilities, assets } }
 */
export async function fetchFinancials(key, corps, fy, { onProgress } = {}) {
  const out = {};
  const chunks = [];
  for (let i = 0; i < corps.length; i += 100) chunks.push(corps.slice(i, i + 100));

  for (let i = 0; i < chunks.length; i++) {
    const codes = chunks[i].map((c) => c.corpCode).join(',');
    const url = `${BASE}/fnlttMultiAcnt.json?crtfc_key=${key}&corp_code=${codes}&bsns_year=${fy}&reprt_code=11011`;
    let j;
    try { j = await fetchJson(url, { timeoutMs: 30000 }); }
    catch (e) { console.error(`  DART 청크 ${i + 1}/${chunks.length} 실패: ${e.message}`); continue; }
    if (j.status === '013') { onProgress?.(i + 1, chunks.length, 0); continue; } // 조회 결과 없음
    if (j.status !== '000') throw new Error(`DART ${j.status}: ${j.message}`);

    // 회사별 → 연결(CFS) 우선, 없으면 별도(OFS)
    const byCorp = new Map();
    for (const r of j.list || []) {
      if (!byCorp.has(r.corp_code)) byCorp.set(r.corp_code, { CFS: [], OFS: [] });
      byCorp.get(r.corp_code)[r.fs_div === 'CFS' ? 'CFS' : 'OFS'].push(r);
    }
    for (const [corpCode, { CFS, OFS }] of byCorp) {
      const rows = CFS.length ? CFS : OFS;
      const pick = (names) => rows.find((r) => names.includes(r.account_nm.replace(/\s/g, '')));
      const series = (names) => { const r = pick(names); return r ? [num(r.thstrm_amount), num(r.frmtrm_amount), num(r.bfefrmtrm_amount)] : null; };
      const rec = {
        fy,
        fsDiv: CFS.length ? 'CFS' : 'OFS',
        revenue: series(ACCOUNT.revenue),
        opIncome: series(ACCOUNT.opIncome),
        netIncome: series(ACCOUNT.netIncome),
        equity: series(ACCOUNT.equity)?.[0] ?? null,
        liabilities: series(ACCOUNT.liabilities)?.[0] ?? null,
        assets: series(ACCOUNT.assets)?.[0] ?? null,
        rceptNo: rows[0]?.rcept_no,
      };
      out[corpCode] = rec;
    }
    onProgress?.(i + 1, chunks.length, byCorp.size);
  }
  return out;
}

/** 최신 사업보고서 접수번호 */
export async function latestAnnualReportNo(key, corpCode) {
  // bgn_de 없으면 013(데이터 없음)이 돌아옴 → 18개월 전부터 정기공시(A)만
  const bgn = new Date(Date.now() - 548 * 86400000).toISOString().slice(0, 10).replaceAll('-', '');
  const j = await fetchJson(`${BASE}/list.json?crtfc_key=${key}&corp_code=${corpCode}&bgn_de=${bgn}&pblntf_ty=A&page_count=20`);
  if (j.status !== '000') return null;
  // 최신순. 첨부정정/첨부추가는 본문이 없으니 제외, 원본 또는 [기재정정] 본문만
  const list = (j.list || []).filter((r) => r.report_nm.includes('사업보고서') && !/첨부/.test(r.report_nm));
  return list[0]?.rcept_no ?? null;
}

/** 사업보고서 원문에서 "사업의 내용" 부근 텍스트 발췌 */
export async function fetchBusinessSection(key, rceptNo, maxChars) {
  const raw = await fetchZipText(`${BASE}/document.xml?crtfc_key=${key}&rcept_no=${rceptNo}`, `${rceptNo}.xml`);
  const text = raw
    .replace(/<TABLE[\s\S]*?<\/TABLE>/gi, ' [표] ')   // 표는 노이즈가 커서 제거
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t　]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n');
  // "II. 사업의 내용" ~ "III. 재무에 관한 사항". 목차에도 같은 문구가 있으므로
  // 두 문구 사이 간격이 실제 본문만큼(1,500자 이상) 벌어진 첫 구간을 택함
  const MIN_BODY = 1500;
  let from = -1, end = -1;
  // 1순위: "II. 사업의 내용" 절 제목의 마지막 등장 (앞쪽 등장은 목차·회사개요의 참조 문구)
  const heads = [...text.matchAll(/(?:II|Ⅱ)\s*\.\s*사업의\s*내용/g)];
  if (heads.length) {
    from = heads.at(-1).index;
    const e = text.slice(from).search(/(?:III|Ⅲ)\s*\.\s*재무에\s*관한\s*사항/);
    end = e > 0 ? from + e : from + maxChars;
    return text.slice(from, Math.min(end, from + maxChars)).trim();
  }
  // 2순위: 절 번호 없이 문구만 있는 경우
  for (const m of text.matchAll(/사업의\s*내용/g)) {
    const rest = text.slice(m.index);
    const e = rest.search(/재무에\s*관한\s*사항/);
    if (e < 0 || e >= MIN_BODY) { from = m.index; end = e < 0 ? m.index + maxChars : m.index + e; break; }
  }
  if (from < 0) { from = 0; end = maxChars; } // 못 찾으면 앞부분
  return text.slice(from, Math.min(end, from + maxChars)).trim();
}
