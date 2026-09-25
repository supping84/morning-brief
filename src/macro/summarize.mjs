// 선택: ANTHROPIC_API_KEY 가 있을 때만 Claude 로 "오늘의 요약" 생성. 없으면 템플릿만 사용 (0원)
// 하루 1회 호출 기준 비용은 월 수백 원 수준
import Anthropic from '@anthropic-ai/sdk';

const SYSTEM = `당신은 한국 증권사 애널리스트의 아침 브리핑 작성자입니다.
주어진 시장 데이터와 헤드라인만 근거로, 한국 투자자가 출근길에 읽을 요약을 씁니다.
형식:
1) 한 줄 총평
2) 핵심 3~5개 불릿 (지수·금리·환율·원자재 중 의미 있는 움직임과 그 배경. 수치 인용)
3) 오늘 국내 장 체크포인트 2~3개
데이터에 없는 사실은 만들지 마세요. 과장 없이 담백하게, 총 350자 이내.`;

export async function summarizeWithClaude(text) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic();
  const res = await client.beta.messages.create({
    model: 'claude-opus-5',
    max_tokens: 2048,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    messages: [{ role: 'user', content: text }],
  });
  if (res.stop_reason === 'refusal') return null;
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}
