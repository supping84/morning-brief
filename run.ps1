# 앱 없이 도는 진입점 — 윈도우 작업 스케줄러가 호출
#   .\run.ps1 full    06:30  전체(지표 + 요약 + 스크리너 + 페이지 + 텔레그램)
#   .\run.ps1 quick   09:30 / 12:30 / 15:30  (지표만 + 텔레그램)
param([ValidateSet('full', 'quick')][string]$Mode = 'quick')

Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force out | Out-Null
$log = Join-Path $PSScriptRoot 'out\run.log'
$today = (Get-Date).ToString('yyyy-MM-dd')

function Log($m) { "$((Get-Date).ToString('HH:mm:ss'))  $m" | Out-File $log -Append -Encoding utf8 }
function Run($label, $cmd) {
  Log "▶ $label"
  cmd /c "$cmd >> ""$log"" 2>&1"
  if ($LASTEXITCODE -ne 0) { Log "✖ $label 실패 (exit $LASTEXITCODE)"; return $false }
  return $true
}

"===== $today $Mode =====" | Out-File $log -Append -Encoding utf8
if (-not (Test-Path node_modules)) { Run 'npm install' 'npm install --no-audit --no-fund' | Out-Null }

# 1) 지표 — 항상
if (-not (Run '거시지표' 'node src\macro\index.mjs')) { Log '지표 실패 → 중단'; exit 1 }

# 2) 요약 + 스크리너 — full 일 때만
if ($Mode -eq 'full') {
  # 요약: claude CLI 가 있으면 구독으로, 없고 ANTHROPIC_API_KEY 가 있으면 API 로, 둘 다 없으면 생략
  $summaryPath = "out\summary-$today.txt"
  if (-not (Test-Path $summaryPath)) {
    if (Get-Command claude -ErrorAction SilentlyContinue) {
      $p = Get-Content -Raw src\summary-prompt.md
      $p = $p.Replace('<오늘>', $today)
      Log '▶ 요약 (claude CLI)'
      $p | & claude -p --allowedTools "Read,Write" --permission-mode acceptEdits *>> $log
    } else {
      Log 'ⓘ 요약 생략: claude CLI 없음 (npm i -g @anthropic-ai/claude-code 후 claude login)'
    }
  }
  Run '스크리너' 'node src\screener\index.mjs' | Out-Null
}

# 3) 페이지 빌드 (앱이 켜져 있을 때 게시용. 없어도 텔레그램은 나감)
Run '페이지 빌드' 'node src\app\build.mjs' | Out-Null

# 4) 텔레그램 발송
if (-not (Run "텔레그램($Mode)" "node src\telegram.mjs $Mode")) { Log '텔레그램 실패' }

Log "완료 ($Mode)"
