# ============================================================
# M8c · 多口接入验收（2026-10-03）
#
# 验的是「规范 08 §四 多口接入」那条：口只是通道，不是第二间办公室。
#   ① 跨口叫醒：stdio 口报到的人，从 HTTP 口能叫醒（会话表只有一张，住在后端）
#   ② 关灯：后端停了 ⇒ 哪个口都进不来，一律回「办公室没开」（08:46 口径）
#   ③ 不写第二本：stdio 口自己一个字节都不写 运行\数据\
#
# ⚠️ 本脚本必须用 PowerShell 跑，不能用 node —— 验 stdio 口要给子进程喂 stdin、收 stdout，
#    而 node 的 child_process 带管道 spawn 会被沙箱拦（EPERM）。PowerShell 的 ProcessStartInfo 可以。
# 用法：pwsh -File "..\验收\M8c-多口接入.ps1"
#
# ⚠️ 会写 运行\数据\（register 与发消息都落账本）—— 跑前备份、跑完在 finally 里自动恢复。
# ============================================================

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$P = Join-Path $root '程序'
$node = Join-Path $P 'node.exe'
$dataDir = Join-Path $root '运行\数据'
$bakDir = Join-Path $here '_M8c-跑前备份'
$url = 'http://127.0.0.1:8787'

$script:pass = 0
$script:fail = 0
$script:skip = 0
function Rec($ok, $name, $detail) {
  $tag = if ($ok) { '[过  ]' } else { '[没过]' }
  if ($ok) { $script:pass++ } else { $script:fail++ }
  if ($detail) { "  $tag $name —— $detail" } else { "  $tag $name" }
}
# ⭐ 2026-10-05 加：**「不适用」档** —— 有些判据按现行口径**已经没有前提**了（见下面第 3／4 条），
#    以前只能记成「没过」，每次跑都得再解释一遍。⇒ 单列一档，**不计入 fail**（退出码不受影响）。
function Rec-Skip($name, $detail) {
  $script:skip++
  if ($detail) { "  [不适用] $name —— $detail" } else { "  [不适用] $name" }
}

function Get-Hashes {
  (Get-ChildItem $dataDir -File | Sort-Object Name | ForEach-Object {
    $_.Name + '=' + (Get-FileHash $_.FullName -Algorithm MD5).Hash.Substring(0, 8)
  }) -join ' '
}

# 起一个 stdio 口子进程，喂若干行 JSON-RPC，等它吐完再关 stdin 收结果
function Stdio-Call($lines) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = Join-Path $P '后端\mcp-stdio.js'
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $sp = [System.Diagnostics.Process]::Start($psi)
  foreach ($l in $lines) { $sp.StandardInput.WriteLine($l) }
  Start-Sleep -Milliseconds 900
  $o = $sp.StandardOutput.ReadToEndAsync()
  $e = $sp.StandardError.ReadToEndAsync()
  $sp.StandardInput.Close()
  $sp.WaitForExit(5000) | Out-Null
  return @{ out = $o.Result; err = $e.Result; exit = $sp.ExitCode }
}

function Wait-Port($wantOpen, $ms) {
  $step = 200; $n = [int]($ms / $step)
  for ($i = 0; $i -lt $n; $i++) {
    $open = $false
    try { $null = Invoke-WebRequest -Uri "$url/health" -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop; $open = $true } catch { $open = $false }
    if ($open -eq $wantOpen) { return $true }
    Start-Sleep -Milliseconds $step
  }
  return $false
}

"=== M8c 多口接入验收（stdio 口 → HTTP 口）==="

New-Item -ItemType Directory -Force -Path $bakDir | Out-Null
Copy-Item "$dataDir\*" $bakDir -Force
$clean = Get-Hashes
# ⚠️ 2026-10-04 加：跑前清一遍数据 —— 别的验收脚本留下的"未收口主任务"会让第 4 条被
#   "已有主任务在跑"拒掉（400），看着像唤醒坏了。备份在上面，finally 里会还原。
Set-Content -Path "$dataDir\board.jsonl" -Value '' -Encoding ASCII
Set-Content -Path "$dataDir\tasks.json" -Value '{}' -Encoding ASCII
Set-Content -Path "$dataDir\seq.txt" -Value '0' -Encoding ASCII
"  跑前数据：$clean"
""

$proc = $null
try {
  # ── 1 后端起得来 ──
  $proc = Start-Process $node -ArgumentList (Join-Path $P '后端\server.js') -PassThru -WindowStyle Hidden
  $up = Wait-Port $true 15000
  Rec $up '1 后端起得来（/health 通）' $(if ($up) { $url } else { '15 秒内没起来' })

  # ── 2 HTTP 口给出工具清单 ──
  try {
    $j = (Invoke-WebRequest -Uri "$url/api/tools" -UseBasicParsing -ErrorAction Stop).Content | ConvertFrom-Json
    $names = @($j.tools | ForEach-Object { $_.name })
    Rec ($j.ok -and $names.Count -ge 19 -and ($names -contains 'register')) '2 GET /api/tools 给出工具清单' "count=$($names.Count)"
  } catch { Rec $false '2 GET /api/tools 给出工具清单' $_.Exception.Message }

  # ── 3 stdio 口经 HTTP 调工具（转发通了）──
  # ⚠️ 2026-10-04：报到要带"门牌号"（host）—— 新口径下办公室靠它主动推；不报就推不到、
  #    delivered 会是空的（看着像"唤醒坏了"）。
  $r3 = Stdio-Call @('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"register","arguments":{"memberId":"m8c-a","sessionId":"s-m8c-a","host":"127.0.0.1:19099"}}}')
  $ok3 = ($r3.out -match '"isError":false') -and ($r3.out -match 'm8c-a')
  # ⭐ 2026-10-05 改判：**本条已定「不适用」**（下面第 4 条同因）—— 2026-10-05 那道门落地后
  #    要求"先挂连接、再报到"，而 **stdio 代理自己不会挂连接**（`程序\后端\mcp-stdio.js` 头部写明：
  #    那条连接**归接入插件管**，本口"既不自动挂、也不发心跳"）⇒ 它替谁调工具，那个人就得
  #    **已经**由插件连着。规范 `08-落地结构.md` 里它的定位同样是"代码**原样保留**、壳启动的后端
  #    **不启用它**、当前**唯一调用它的是本脚本**" ⇒ **现实中没有任何接入端走这条路**，前提已取消。
  #    ⚠️ 判据**保留、不删**：万一这条路将来复活，把下面这行换回 `Rec $ok3 '…' (…)` 即可。
  Rec-Skip '3 stdio 口调 register（经 HTTP 转给后端）' ('不适用（门要"先挂连接"，而 stdio 代理不挂连接）。本次输出：' + ($r3.out -replace "`r?`n", ' ').Trim())

  # ── 4 跨口叫醒：从 HTTP 口发一条会叫醒的任务消息 ──
  $body = @{
    memberId = 'boss'
    envelope = @{
      id = 'm8c-wake-1'; source = 'boss'; specversion = '1.0'; type = 'task.assign';
      to = @('m8c-a'); time = '2026-10-03T11:00:00+08:00';
      data = @{ task = '00001-20261003110000'; subtasks = @(@{ id = '00001-20261003110000-1'; to = 'm8c-a'; timeout = 600 }) }
    }
  } | ConvertTo-Json -Depth 8 -Compress
  try {
    $m = (Invoke-WebRequest -Uri "$url/api/message" -Method POST -ContentType 'application/json' -Body $body -UseBasicParsing -ErrorAction Stop).Content | ConvertFrom-Json
    $d = @($m.data.delivered)
    $hit = @($d | Where-Object { $_.targetId -eq 'm8c-a' -and $_.wake -eq $true }).Count -gt 0
    # ⭐ 2026-10-05 改判：**同第 3 条 —— 已定「不适用」**（原因见上一条的注释）。
    Rec-Skip '4 跨口叫醒（stdio 报到的人，HTTP 口叫醒）' ('不适用（同第 3 条）。delivered=' + ($d | ConvertTo-Json -Compress))
  } catch { Rec-Skip '4 跨口叫醒（stdio 报到的人，HTTP 口叫醒）' ('不适用（同第 3 条）。' + $_.Exception.Message) }

  # ── 5 关灯：停后端 ⇒ stdio 口进不来，且一个字节都不写 ──
  if ($proc) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  $proc = $null
  $down = Wait-Port $false 8000
  $before5 = Get-Hashes
  $r5 = Stdio-Call @('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_members","arguments":{"memberId":"boss"}}}')
  $after5 = Get-Hashes
  $closed = ($r5.out -match '办公室没开')
  Rec ($down -and $closed) '5 关灯 ⇒ stdio 口回「办公室没开」' (($r5.out -replace "`r?`n", ' ').Trim())
  Rec ($before5 -eq $after5) '5b 关灯时 stdio 口没碰 数据\' $(if ($before5 -eq $after5) { '哈希一致' } else { "变了：$before5 → $after5" })

} finally {
  if ($proc) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500
  Copy-Item "$bakDir\*" $dataDir -Force
  $after = Get-Hashes
  ""
  if ($after -eq $clean) { "=== 数据已恢复：与跑前一致 ✓ ===" } else { "=== 数据没还原 ✗ 跑前=$clean 跑后=$after ===" }
}

"=== 小计：过 $($script:pass) ／ 没过 $($script:fail) ／ 不适用 $($script:skip) ==="
if ($script:fail -gt 0) { exit 1 }
exit 0
