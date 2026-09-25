# 윈도우 작업 스케줄러 등록 — 앱이 꺼져 있어도 텔레그램으로 브리핑이 옴
#   등록:  .\install-task.ps1
#   해제:  .\install-task.ps1 -Remove
#   확인:  Get-ScheduledTask MorningBrief*
param([switch]$Remove)

$script = Join-Path $PSScriptRoot 'run.ps1'
$tasks = @(
  @{ Name = 'MorningBrief-0630'; Time = '06:30'; Mode = 'full'  },
  @{ Name = 'MorningBrief-0930'; Time = '09:30'; Mode = 'quick' },
  @{ Name = 'MorningBrief-1230'; Time = '12:30'; Mode = 'quick' },
  @{ Name = 'MorningBrief-1530'; Time = '15:30'; Mode = 'quick' }
)

if ($Remove) {
  foreach ($t in $tasks) { Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false -ErrorAction SilentlyContinue }
  Write-Host "삭제됨: $($tasks.Name -join ', ')"
  exit
}

foreach ($t in $tasks) {
  $action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
             -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Mode $($t.Mode)" `
             -WorkingDirectory $PSScriptRoot
  $trigger = New-ScheduledTaskTrigger -Daily -At $t.Time
  # WakeToRun: 절전 중이면 깨움 / StartWhenAvailable: 그 시각에 꺼져 있었으면 켜진 직후 실행
  $settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -RunOnlyIfNetworkAvailable `
              -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host "등록: $($t.Name)  매일 $($t.Time)  ($($t.Mode))"
}
Write-Host ''
Write-Host '바로 테스트:  Start-ScheduledTask -TaskName MorningBrief-0930'
Write-Host '로그:         out\run.log'
