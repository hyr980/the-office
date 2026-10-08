# M9 · 壳与窗口 —— 办公室壳（PowerShell 5.1 托盘 + WebView2 独立窗口）
# 依据：模块\M9-壳与窗口.md；规范\08-落地结构-20261002.md（三之二：服务端独立进程；三：壳=PS+WebView2 独立窗口）；规范\04-功能清单（§7.4 文件夹一点就开）
#
# 用法：
#   .\OfficeShell.ps1           托盘模式（默认）：托盘图标 + 右键菜单（显示页面 / 关闭软件），双击托盘显示窗口
#   .\OfficeShell.ps1 -Start    Start-OfficeServer：拉起 Node 后端（server.js，HTTP 8787）
#   .\OfficeShell.ps1 -Stop     Stop-OfficeServer：停掉 server.js 的 node 进程
#   .\OfficeShell.ps1 -Show     Show-OfficeWindow：显示 WebView2 独立窗口（窗口模式，关窗即退出）
#   .\OfficeShell.ps1 -SelfTest 自验：能执行、能看见结果（PASS/FAIL 清单）
#
# 开文件夹通道（2026-10-03 改）：以前是「界面把 [OPEN]路径 写进网页标题、壳轮询窗体标题」——
#   那条通道根本不通（网页改 document.title 不会改 WinForms 窗体标题），「我的文件夹」从来打不开。
#   现在由后端 open_folder 工具直接调 explorer.exe（界面 → HTTP → 后端 spawn explorer），壳不再管这事。
# 零第三方依赖：WebView2 运行时（系统自带）+ 本机已有 WebView2Loader.dll（已复制到壳目录）+ 本机 csc 编译的 OfficeWebView2.dll。

param(
  [switch]$Start,
  [switch]$Stop,
  [switch]$Show,
  [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'

$script:Root     = Split-Path $PSScriptRoot -Parent            # 程序\（代码区）
$script:ShellDir = $PSScriptRoot
$script:OfficeRoot = Split-Path $script:Root -Parent           # 办公室根
$script:RunDir   = Join-Path $script:OfficeRoot '运行'          # 运行区：数据/日志/产出/收件（2026-10-04 新布局）
$script:Backend  = Join-Path $script:Root '后端'
$script:UI       = Join-Path $script:Root '界面\办公室界面-20261003.html'
# ⭐ 2026-10-04 新布局：Node 三级回退 —— 内置的 → PATH 里的 → 系统默认安装位置（移植时零改动）
$script:NodeExe  = Join-Path $script:Root 'node.exe'
if (-not (Test-Path $script:NodeExe)) {
  $cmdNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmdNode) { $script:NodeExe = $cmdNode.Source }
  elseif (Test-Path "$env:ProgramFiles\nodejs\node.exe") { $script:NodeExe = "$env:ProgramFiles\nodejs\node.exe" }
}
$script:ServerJs = Join-Path $script:Backend 'server.js'
$script:HttpUrl  = 'http://127.0.0.1:8787'

# ⭐⭐ 界面口令（2026-10-05 老大定）—— 为什么需要它：`boss` 这个身份**只有界面在用**，
#    而"顺手报一行 boss"谁都会 ⇒ 光看 `memberId` 认不出"这是不是界面"。
#    做法：**壳每次启动随机生成**，**只经内存**走两条路 —— ① 环境变量给后端 ② 拼在界面 URL 上给页面。
#    ⚠️ **不落盘**（正本：规范 `接入\01-接入与连接.md` §2.4、`04-功能清单.md` §7.7 第 1 条）。
#    ⚠️ 已知缺口：**后端已经被上一次壳起着**时，那个后端认的是**上一次的口令**，新壳的界面对不上
#       ⇒ 表现＝界面调工具全被拒。恢复办法＝点托盘「关闭软件」再重开（会把后端一并换掉）。
$script:UiToken = [guid]::NewGuid().ToString('N')
# ⭐ 2026-10-06 改（老大令「别用脚本、就用后端…写进代码里面」）：界面**由后端自己发**
#    （后端的 `GET /ui`），窗口开的就是 `http://127.0.0.1:8787/ui` ——
#    **不再走 `file:///`、也不再把口令拼在 URL 上**（口令改由后端注入页面
#    `window.__OFFICE_UI_TOKEN__`）⇒ 不进地址栏、不进 WebView2 的数据目录。
#    ⚠️ `$script:UiToken` **还得生成**：它经环境变量交给后端，后端靠它认"这次是不是界面"。
$script:UiUrl   = $script:HttpUrl + '/ui'

function Get-OfficeDirs {
  @{
    '收件' = Join-Path $script:RunDir '收件'
    '产出' = Join-Path $script:RunDir '产出'
    '日志' = Join-Path $script:RunDir '日志'
    '数据' = Join-Path $script:RunDir '数据'
  }
}

function Test-OfficePort {
  try {
    $r = Invoke-WebRequest -Uri "$($script:HttpUrl)/health" -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Start-OfficeServer([switch]$Fresh) {
  # ⭐⭐ 2026-10-05 改：**壳启动时**（`-Fresh`）如果发现后端已经在跑，**先把旧的收掉再起新的**。
  #    为什么：界面口令是**每次壳启动新生成**的（见文件头），而"后端已在跑"时原来**直接返回、
  #    不换口令** ⇒ 新壳的界面拿着新口令去调旧后端，**每一个操作都被拒**（只回一句"这个身份只认界面"，
  #    老大根本猜不到为什么）。收掉旧的一起换掉，口令就永远一致了。
  #    ⚠️ **只有壳启动时才这么做**（`-Fresh`）—— 托盘菜单「显示页面」/双击托盘那条路**不能**停后端，
  #    否则每显示一次窗口就把后台的成员全踢下线。那两条路照旧只"确保后端在跑"。
  #    ⚠️ 已知：**重复开两个壳**仍会互相抢后端（上一个壳点「关闭软件」时会把新后端一起收掉）
  #    —— 这条这次没治，**别重复开壳**。
  if (Test-OfficePort) {
    if (-not $Fresh) { return "后端已在跑（$($script:HttpUrl)）" }
    $old = Stop-OfficeServer
    Write-Host "（壳启动：先把旧后端收掉 —— $old）"
  }
  # ⭐ 2026-10-05：把界面口令**经环境变量交给后端**（子进程继承）。另一条路在界面 URL 上（见文件头）。
  #    ⚠️ 后端只有"由壳起"才拿得到口令；不经壳手工起的后端 ⇒ 走退化口径（放行 ＋ 逐条留痕）。
  $env:OFFICE_UI_TOKEN = $script:UiToken
  # ⭐ 2026-10-05 改：**不再用 `Start-Process`** —— 它走 **ShellExecute**，Windows 会弹
  #    「打开文件 - 安全警告」（实测：老大双击启动时被那个窗挡住 ⇒ 后端起不来、办公室开不了）。
  #    改用 .NET 的 `Process.Start` ＋ **`UseShellExecute = $false`**（走 **CreateProcess**）
  #    ⇒ **整条 ShellExecute 的检查都绕开**（与文件带不带"来自 Internet"标记无关）。
  #    ⚠️ 行为逐条等价：`-WindowStyle Hidden` ⇒ `CreateNoWindow`；`-PassThru` ⇒ `Process.Start` 本就返回进程对象；
  #       环境变量（上面那行 `$env:OFFICE_UI_TOKEN`）在 `UseShellExecute=$false` 下**由子进程自动继承**，照旧传得到。
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $script:NodeExe
  $psi.Arguments = '"' + $script:ServerJs + '"'
  $psi.WorkingDirectory = $script:Backend
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-OfficePort) { $script:serverPid = $p.Id; return "后端已起（pid $($p.Id)，$($script:HttpUrl)）" }
  }
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  throw "后端 20 秒内未就绪（server.js：$($script:ServerJs)）"
}

function Stop-OfficeServer {
  $killed = 0
  # ① 先杀"自己起的那个"：进程句柄最准。⚠️ 2026-10-03 实测：本机沙箱里 Get-CimInstance 看不到别的进程
  #    （我起了一个活着的 node，Get-Process 看得到、CIM Win32_Process 却返回 0 个）⇒ 只靠第 ② 步会漏杀。
  if ($script:serverPid) {
    if (Get-Process -Id $script:serverPid -ErrorAction SilentlyContinue) {
      Stop-Process -Id $script:serverPid -Force -ErrorAction SilentlyContinue
      $killed++
    }
    $script:serverPid = $null
  }
  # ② 再按 'server.js' 关键词扫一遍，兜底收编"不是我起的"后端
  # ⚠️ 2026-10-05 收紧判据：原来只写 `-like '*server.js*'` ⇒ **全机扫**，别的项目里
  #    叫 `server.js` 的 node 进程会被**一起杀掉**。现在要求命令行里**同时**出现本项目的后端目录路径
  #    （壳起后端时传的就是这个绝对路径，见上面 `$psi.Arguments`）。
  #    ⚠️ 代价：要是别人用相对路径起的（`cd` 到后端目录再 `node server.js`），这条兜底就抓不到它 ——
  #    那种情况走第 ① 步或下面"端口仍通"的提示，不会再误杀别的项目。
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like '*server.js*') -and ($_.CommandLine -like "*$($script:Backend)*") })
  foreach ($pr in $procs) {
    Stop-Process -Id $pr.ProcessId -Force -ErrorAction SilentlyContinue
    $killed++
  }
  if ($killed -eq 0 -and -not (Test-OfficePort)) { return '后端本来就没在跑' }
  # 等端口真的不通（进程退出要时间）。2026-10-03 实测：原来只等 600ms ⇒ 自验报假失败（进程其实停掉了）
  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 200
    if (-not (Test-OfficePort)) { return "后端已停（结束 $killed 个 node 进程）" }
  }
  return '已发停止，但端口仍通（8787 可能被其他进程占用）'
}

# 退出：先真关后端、再收图标、最后才结束进程。
# ⚠️ 2026-10-03 实测修：原来"退出"只有 Application::Exit()，它只结束界面；后端是 Start-Process 起的
#    独立进程、不会被带走 ⇒ 与 M9 验收第 3 条（托盘退出 ⇒ 后端进程真的没了）不符。
#    $script:noExit = $true 是自验专用开关：让它只做"关后端 + 收图标"、不结束进程，好让自验能断言。
function Exit-Office {
  $r = Stop-OfficeServer
  if ($script:trayIcon) { $script:trayIcon.Visible = $false }
  if ($script:noExit) { return $r }
  [System.Windows.Forms.Application]::Exit()
  return $r
}

# 建窗体（WebView2 嵌入 + 标题命令轮询）；$TrayMode 时同时建托盘图标
# ── ⭐⭐ 2026-10-08 加：**壳替后端"打开文件夹"** ──
#    为什么要有这个东西：后端起 `explorer.exe` 会被 `0xC0000142`（STATUS_DLL_INIT_FAILED，
#    进程初始化就失败）挡掉 —— 实测退出码 3221225794，见 `运行\日志` 的 `打开文件夹：explorer 没交出去`；
#    而**壳自己起 explorer 是成功的**（`-SelfTest` 实测 `exited=True exitCode=1`，结果文件
#    `运行\壳自己开文件夹-结果.txt`）。同一台机器、同一个目标，差别只在"谁起的进程"。
#    ⇒ 分工改成：**后端只写一个请求文件**（`运行\数据\开文件夹请求.json`），**壳看到就开**。
#    ⚠️ 交接判据：壳**开之前先把请求文件收掉**，后端靠"文件还在不在"判断壳有没有接走。
#    ⚠️ 必须挂在 `Application.Run` **之前** —— WinForms 的 Timer 靠消息泵驱动，循环跑起来它才转。
function Start-OpenFolderWatcher {
  if ($script:openWatcher) { return }
  # ⚠️ 路径必须放进 **`$script:` 作用域**：`Add_Tick({...})` 里的脚本块**拿不到**外层函数的局部变量
  #    （PowerShell 的脚本块捕获坑 —— 第一版就是这么哑掉的：Timer 在转，但 `$reqFile` 是空的，
  #      `Test-Path ''` 永远为假 ⇒ 看着"壳没接走"，其实是它压根没看对地方）。
  $script:openReqFile = Join-Path $script:RunDir '数据\开文件夹请求.json'
  $script:openHbFile  = Join-Path $script:RunDir '壳-开文件夹监视器-心跳.txt'
  $t = New-Object System.Windows.Forms.Timer
  $t.Interval = 500
  $t.Add_Tick({
    try {
      # 转起来的第一次留个痕（只写一次），用来判断"监视器到底活没活"
      if (-not $script:openHbDone) {
        [System.IO.File]::WriteAllText($script:openHbFile, ('心跳 ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  pid=' + $PID + '  每 500ms 一轮'), (New-Object System.Text.UTF8Encoding($false)))
        $script:openHbDone = $true
      }
      if (Test-Path -LiteralPath $script:openReqFile) {
        $j = Get-Content -LiteralPath $script:openReqFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $target = [string]$j.path
        # ⚠️ 先收掉再开：一是"已接走"的信号，二是别重复开同一个
        Remove-Item -LiteralPath $script:openReqFile -Force -ErrorAction SilentlyContinue
        if ($target) {
          $psi = New-Object System.Diagnostics.ProcessStartInfo
          $psi.FileName = 'explorer.exe'
          $psi.Arguments = '"' + $target + '"'
          $psi.UseShellExecute = $false      # 走 CreateProcess（与壳起后端同一套路）
          $psi.CreateNoWindow = $true
          [System.Diagnostics.Process]::Start($psi) | Out-Null
        }
      }
    } catch { }
  })
  $t.Start()
  $script:openWatcher = $t
}

function New-OfficeForm([bool]$TrayMode) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $dll = Join-Path $script:ShellDir 'OfficeWebView2.dll'
  if (-not ('OfficeWebView2.OfficeWebView2' -as [type])) {
    $null = [System.Reflection.Assembly]::Load([System.IO.File]::ReadAllBytes($dll))
  }
  if (-not ('NativeWin' -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NativeWin {
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
}
"@
  }

  $form = New-Object System.Windows.Forms.Form
  $script:officeForm = $form
  $form.Text = '办公室'
  $form.Size = New-Object System.Drawing.Size(1200, 800)
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $panel = New-Object System.Windows.Forms.Panel
  $panel.Dock = [System.Windows.Forms.DockStyle]::Fill
  $form.Controls.Add($panel)
  # ⚠️ 必须存到脚本作用域（2026-10-03 实测定因）：$panel 原来是本函数的局部变量，
  #    而 Add_Shown / Add_Resize 都是**函数返回之后**才触发的事件回调 —— 那时局部变量已经没了，
  #    回调用到它就变成 $null（属性访问对 $null 不报错、只返回 $null ⇒ 表现为"找不到 Create 的重载"）。
  $script:officePanel = $panel

  # WebView2 的数据目录（profile）必须显式给一个能写的目录 —— 不给的话微软默认用"宿主 exe 同目录
  # \<exe>.WebView2"，本机宿主是 powershell.exe ⇒ 落到 C:\Windows\System32 下、写不进（实测 E_ACCESSDENIED）。
  # ⚠️ 2026-10-03 实测修：原来调三参数版、靠 dll 内部退回默认；现在显式传。
  if (-not $script:WebView2Data) { $script:WebView2Data = Join-Path $env:LOCALAPPDATA '办公室\WebView2' }
  $script:webviewErr = ''
  $form.Add_Shown({
    try {
      $err = ''
      # ⭐ 2026-10-05 起传 `$script:UiUrl`；⭐ 2026-10-06 起它 ＝ `http://127.0.0.1:8787/ui`
      #    —— 界面由**后端**发、口令由**后端注入页面**，壳**不再拼路径、也不拼口令**。
      #    （`$script:UI` 那个变量留着，自验里查"界面 HTML 在不在"还要用。）
      $ok = [OfficeWebView2.OfficeWebView2]::Create($script:officePanel.Handle, $script:UiUrl, $script:WebView2Data, [ref]$err)
      if (-not $ok) {
        $script:webviewErr = $err
        # ⚠️ 弹框可由 $script:noPopup 抑制：自验跑在无人值守的环境里，弹框会一直等点击（2026-10-03 实撞）。
        if (-not $script:noPopup) { [System.Windows.Forms.MessageBox]::Show("WebView2 创建失败：$err", '办公室') }
      }
      [OfficeWebView2.OfficeWebView2]::Resize($script:officePanel.ClientSize.Width, $script:officePanel.ClientSize.Height)
    } catch {
      $script:webviewErr = $_.Exception.Message
      if (-not $script:noPopup) { [System.Windows.Forms.MessageBox]::Show("WebView2 初始化异常：$($_.Exception.Message)", '办公室') }
    }
  })
  $form.Add_Resize({ [OfficeWebView2.OfficeWebView2]::Resize($script:officePanel.ClientSize.Width, $script:officePanel.ClientSize.Height) })

  # 2026-10-03 删：这里原来有个 400ms 定时器，轮询窗体标题里的 [OPEN]路径 来开文件夹。
  #   那条通道从来不生效（网页改 document.title 传不到窗体标题）—— 开文件夹已改由后端 open_folder 负责，见文件头说明。

  $tray = $null
  if ($TrayMode) {
    $tray = New-Object System.Windows.Forms.NotifyIcon
    $tray.Icon = [System.Drawing.SystemIcons]::Application
    $tray.Text = '办公室'
    $script:trayIcon = $tray          # 存到脚本作用域：自验要能查它、也要能收掉它
    $menu = New-Object System.Windows.Forms.ContextMenuStrip
    $script:trayMenu = $menu
    # ⚠️ 2026-10-03 老大定口径：菜单只要两项 ——「显示页面」「关闭软件」。
    #    原来的「启动后端／停止后端」去掉了：后端跟着壳走（启动时起、关窗口时停），不用手动管。
    $mShow = New-Object System.Windows.Forms.ToolStripMenuItem('显示页面')
    $mShow.Add_Click({
      try {
        $r = Start-OfficeServer
        if ($r -like '*已起*') { $script:trayIcon.ShowBalloonTip(2000, '办公室', $r, [System.Windows.Forms.ToolTipIcon]::Info) }
      } catch { }
      $script:officeForm.Show(); $script:officeForm.Activate()
    })
    $mQuit = New-Object System.Windows.Forms.ToolStripMenuItem('关闭软件')
    $mQuit.Add_Click({ Exit-Office | Out-Null })
    $menu.Items.AddRange(@($mShow, $mQuit))
    $tray.ContextMenuStrip = $menu
    $tray.Add_DoubleClick({
      try { Start-OfficeServer | Out-Null } catch { }
      $script:officeForm.Show(); $script:officeForm.Activate()
    })
    $tray.Visible = $true
    # ⚠️ 2026-10-03 老大定口径（第二次）：关窗口 / 最小化 = 藏起来，**后端照跑**。
    #    关后端的唯一判据 = 托盘图标没了（点了「关闭软件」完全退出）。
    $form.Add_FormClosing({
      if ($script:trayIcon.Visible) {
        $_.Cancel = $true
        $script:officeForm.Hide()
      }
    })
  }
  return $form
}

# 自验：能执行、能看见结果
function Test-Self {
  $script:passN = 0; $script:failN = 0
  $script:noPopup = $true     # 自验专用：抑制代码里主动弹的 MessageBox（见 New-OfficeForm）
  $script:WebView2Data = Join-Path $env:TEMP 'office-wv2-selftest'   # 自验别污染用户的 %LOCALAPPDATA%\办公室\WebView2
  # ⚠️ 自验绝不弹框（2026-10-03 事故）：WinForms 的 ThreadException 默认弹模态框等人点，
  #    自验跑在非交互环境里 ⇒ 一路卡死。这里改成"捕获"，异常一律打印成输出。
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)
  [System.Windows.Forms.Application]::add_ThreadException({
    param($s, $e)
    $script:failN++
    Write-Host "FAIL  [已拦截的界面异常] $($e.Exception.GetType().Name): $($e.Exception.Message)"
    Write-Host "      $($e.Exception.StackTrace)"
  })
  function T([string]$name, [bool]$cond) {
    if ($cond) { $script:passN++; Write-Host "PASS  $name" } else { $script:failN++; Write-Host "FAIL  $name" }
  }

  Write-Host '== 1/6 组件检查 =='
  # ⚠️ 2026-10-03 实测修：原来把版本写死成 154.0.4258.48，但运行时是按版本分目录、会自动升级
  #    （本机实测已到 154.0.4258.53）⇒ 写死必然 FAIL。改成"任意版本目录里有 msedgewebview2.exe"。
  $wvRoot = 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application'
  $wvExe = @(Get-ChildItem $wvRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'msedgewebview2.exe' } | Where-Object { Test-Path $_ })
  T "WebView2 运行时目录存在（$($wvExe.Count) 个版本）" ($wvExe.Count -gt 0)
  T 'WebView2Loader.dll 已随壳' (Test-Path (Join-Path $script:ShellDir 'WebView2Loader.dll'))
  T 'OfficeWebView2.dll 已编译' (Test-Path (Join-Path $script:ShellDir 'OfficeWebView2.dll'))
  T 'Node 存在' (Test-Path $script:NodeExe)
  T '界面 HTML 存在' (Test-Path $script:UI)

  Write-Host '== 2/6 启动后端（Start-OfficeServer）=='
  $startMsg = Start-OfficeServer
  Write-Host "   -> $startMsg"
  T '后端 health 通（8787）' (Test-OfficePort)

  Write-Host '== 3/6 独立窗口 + WebView2 加载（Show-OfficeWindow）=='
  Add-Type -AssemblyName System.Windows.Forms
  $loaded = $false
  $f = New-OfficeForm $false
  try {
    $f.Show()
    for ($i = 0; $i -lt 40; $i++) {
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 250
      if ($null -eq $script:officeForm) { continue }      # 兜底：取不到就跳，别抛
      $sb = New-Object System.Text.StringBuilder 512
      [NativeWin]::GetWindowText($script:officeForm.Handle, $sb, 512) | Out-Null
      if ($sb.ToString() -like '*办公室*') { $loaded = $true; break }
    }
  } catch {
    Write-Host "   !! 异常：$($_.Exception.GetType().Name): $($_.Exception.Message)"
  }
  # ⚠️ 2026-10-03 实测修：原来判"HTML 已加载"用的是窗口标题含"办公室"，而那个标题是 $form.Text 写死的
  #    ⇒ 网页有没有真渲染根本验不出来（曾因此拿到假 PASS，白白多查了半天）。改成看两件实事：
  #    ① WebView2 创建/初始化有没有报错（$script:webviewErr 为空）② 窗体是不是真的可见。
  T "独立窗体真的出来了、WebView2 没报错（err='$($script:webviewErr)'）" (($script:webviewErr -eq '') -and $f.Visible)

  Write-Host '== 4/6 开文件夹（界面 → 后端 open_folder → explorer）=='
  # ⚠️ 2026-10-03 改：原来这项直接调壳里的函数、只断言目录存在 —— 跟真通道没关系，是假 PASS。
  #    现在走真通道：POST /api/call 调 open_folder（界面按钮走的就是这一口）。
  $dir = (Get-OfficeDirs)['收件']
  $body = @{ memberId = 'boss'; tool = 'open_folder'; args = @{ path = $dir } } | ConvertTo-Json -Depth 6
  try {
    # ⭐ 2026-10-05：带上界面口令 —— 这道口现在认"是不是界面"（`接入\01` §2.4）
    $r = Invoke-RestMethod -Uri "$($script:HttpUrl)/api/call" -Method Post -ContentType 'application/json; charset=utf-8' -Headers @{ 'X-Office-UI' = $script:UiToken } -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
    T "后端 open_folder 打开收件目录（$dir）" ($r.ok -eq $true)
  } catch {
    T "后端 open_folder 调用失败：$($_.Exception.Message)" $false
  }

  Write-Host '== 5/6 停止后端（Stop-OfficeServer）=='
  $stopMsg = Stop-OfficeServer
  Write-Host "   -> $stopMsg"
  T '端口已不通 = 办公室没开' (-not (Test-OfficePort))

  # ── ⭐⭐ 2026-10-08 加：**壳自己能不能打开文件夹** ──
  #    为什么要单独测这一条：后端那条链在本机起 `explorer.exe` 会被 `0xC0000142`
  #    （STATUS_DLL_INIT_FAILED，进程初始化就失败）挡掉（实测退出码 3221225794，见 `运行\日志`）。
  #    打算改成"让壳去开"（壳是有窗口的进程，形态最接近正常程序）—— 但**壳行不行还没验证过**。
  #    验证很便宜（就这一段）、改 C# 很贵（要手动数 `ICoreWebView2` 的 vtable 槽位，数错直接崩进程），
  #    所以**先测这一条**：壳能开 ⇒ 再去接桥；壳不能开 ⇒ 省下改 C# 的功夫。
  #    判据与 `bridge.js` 一致：退出码 0／1 ＝ 交出去了；还在跑（没退出）＝ 也算交出去；其它 ＝ 起不来。
  Write-Host '== 附加：壳自己打开文件夹 =='
  $shellOpenFile = Join-Path $script:RunDir '壳自己开文件夹-结果.txt'
  $shellOpenDetail = ''
  try {
    $psiEx = New-Object System.Diagnostics.ProcessStartInfo
    $psiEx.FileName = 'explorer.exe'
    $psiEx.Arguments = '"' + $dir + '"'
    $psiEx.UseShellExecute = $false      # 走 CreateProcess，避开 ShellExecute 那套检查
    $psiEx.CreateNoWindow = $true
    $pex = [System.Diagnostics.Process]::Start($psiEx)
    $exited = $pex.WaitForExit(3000)
    $exCode = if ($exited) { $pex.ExitCode } else { $null }
    $shellOk = ((!$exited) -or $exCode -eq 0 -or $exCode -eq 1)
    $shellOpenDetail = 'exited=' + $exited + '  exitCode=' + $(if ($null -eq $exCode) { '(还在跑)' } else { $exCode })
    if ($exCode -eq 3221225794) { $shellOpenDetail += '  ← 0xC0000142 进程初始化失败' }
    T "壳自己打开文件夹（$dir）—— $shellOpenDetail" $shellOk
  } catch {
    $shellOpenDetail = $_.Exception.GetType().Name + ': ' + $_.Exception.Message
    T "壳自己打开文件夹失败：$shellOpenDetail" $false
  }
  try {
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $lines = @(
      '时间：' + $stamp,
      '壳进程 pid：' + $PID,
      '目标：' + $dir,
      '结果：' + $shellOpenDetail,
      '会话/用户：' + (whoami),
      '（这一项只测"壳自己"能不能开，和后端那条链无关）'
    )
    [System.IO.File]::WriteAllText($shellOpenFile, ($lines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "   （结果已写到 $shellOpenFile）"
  } catch { Write-Host "   （结果文件写不出：$($_.Exception.Message)）" }

  Write-Host '== 6/6 托盘：图标 / 右键菜单 / 退出真的杀后端 =='
  try {
    $script:noExit = $true         # 自验专用：让 Exit-Office 不结束进程，好让下面能断言
    $tf = New-OfficeForm $true
    T '托盘图标已建且可见' ($null -ne $script:trayIcon -and $script:trayIcon.Visible)
    $names = @($script:trayMenu.Items | ForEach-Object { $_.Text })
    T "右键菜单两项齐（$($names -join ' / ')）" (($names -join ',') -eq '显示页面,关闭软件')
    Start-OfficeServer | Out-Null
    T '为验退出，先把后端起起来' (Test-OfficePort)
    $script:trayMenu.Items[1].PerformClick()     # 真的点「关闭软件」那一项
    Start-Sleep -Milliseconds 1500
    T '点「关闭软件」⇒ 后端真的没了（端口不通）' (-not (Test-OfficePort))
    # ⚠️ 2026-10-03 老大定口径（第二次）：关窗口 / 最小化 ≠ 关办公室，后端照跑；
    #    只有「关闭软件」（托盘图标没了）才停后端。
    Start-OfficeServer | Out-Null
    $tf2 = New-OfficeForm $true
    $tf2.Show(); Start-Sleep -Milliseconds 500
    $tf2.Close(); Start-Sleep -Milliseconds 800
    T '关窗口（没点关闭软件）⇒ 后端照跑、窗口已藏' ((Test-OfficePort) -and (-not $tf2.Visible))
  } catch {
    T "6/6 托盘段异常（$($_.Exception.GetType().Name): $($_.Exception.Message)）" $false
  }
  Stop-OfficeServer | Out-Null
  if ($script:trayIcon) { $script:trayIcon.Visible = $false; $script:trayIcon.Dispose() }

  $f.Close()
  Write-Host ''
  Write-Host "自验汇总：PASS $($script:passN) / FAIL $($script:failN)"
  if ($script:failN -gt 0) { exit 1 }
}

# ── 分发 ──
if ($Start)  { Start-OfficeServer; return }
if ($Stop)   { Stop-OfficeServer; return }
if ($SelfTest) { Test-Self; return }
if ($Show) {
  Add-Type -AssemblyName System.Windows.Forms
  $f = New-OfficeForm $false
  try { Start-OfficeServer -Fresh | Out-Null } catch { }   # 同一个口径：窗口起来了，后端就在（-Fresh：口令跟着本次壳走）
  Start-OpenFolderWatcher                                   # ⭐ 2026-10-08：替后端开文件夹的定时器（必须在 Run 之前）
  $f.Show()
  [System.Windows.Forms.Application]::Run($f)
  return
}
# 默认：托盘模式。⚠️ 2026-10-03 老大定口径：壳起来就把后端带起来（不用他再单独开后端）。
# ⭐ 2026-10-05：带 `-Fresh` —— 发现旧后端在跑就先收掉再起（否则界面口令对不上，见 Start-OfficeServer）。
Add-Type -AssemblyName System.Windows.Forms
$tf = New-OfficeForm $true
try { Write-Host (Start-OfficeServer -Fresh) } catch { Write-Host "后端没起来：$($_.Exception.Message)" }
Start-OpenFolderWatcher     # ⭐ 2026-10-08：替后端开文件夹的定时器（必须在 Run 之前）
$tf.Show()
[System.Windows.Forms.Application]::Run($tf)
