// M9 · 壳与窗口 —— WebView2 嵌入 helper（零第三方依赖）
// 依据：模块\M9-壳与窗口.md；规范\08-落地结构-20261002.md 三（壳=PS+WebView2 独立窗口）
//
// 方式：P/Invoke 本机 WebView2Loader.dll（从本机已有软件目录复制，非新安装）+ CLR 生成的 COM 回调包装。
//
// ⚠️ 2026-10-03 实测修（证据：验收\_诊断-webview.txt / _diag-create.log / _探测2-*.txt）：
//    ① 原来用"手写 COM vtable + Marshal.GetFunctionPointerForDelegate"造完成回调，
//       会让 CreateCoreWebView2EnvironmentWithOptions 一句就 0xC0000409 进程级崩溃（三跑三崩）；
//       改成 [ComImport] 声明回调接口 + [ComVisible] 实现类，由 CLR 造 CCW —— 同机同 dll 下 6ms 正常返回、回调到达。
//    ② userDataFolder 传 null 时，微软默认用"宿主 exe 同目录\<exe>.WebView2"，而宿主是 powershell.exe
//       ⇒ 落到 C:\Windows\System32\... ⇒ 写不进去（实测 hr=0x80070005 E_ACCESSDENIED）⇒ 必须显式给可写目录。
// 只调用有把握的少量槽位：环境 CreateCoreWebView2Controller / 控制器 put_Bounds + get_CoreWebView2 / WebView Navigate。
// ⚠️ 2026-10-05 删掉一句过期注释：原来这里写"开文件夹不依赖 WebView 事件：HTML 把命令写进窗口标题
//    （[OPEN]前缀），壳轮询标题调起资源管理器" —— **那条通道 2026-10-03 已整个删掉**
//    （网页改 document.title 传不到 WinForms 窗体标题，它从来没生效过）；开文件夹现在由后端
//    `open_folder` 直接调 explorer（见 `程序\后端\bridge.js`），**与本 helper 无关**。
//
// 编译（本机 csc，.NET Framework 4.x，供 PowerShell 5.1 Add-Type 加载）：
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:library
//     /out:OfficeWebView2.dll /r:System.Windows.Forms.dll OfficeWebView2.cs

using System;
using System.Runtime.InteropServices;

namespace OfficeWebView2
{
    /// <summary>WebView2Loader.dll 原生导出（导出序号：1 CompareBrowserVersions / 2 CreateCoreWebView2Environment / 3 CreateCoreWebView2EnvironmentWithOptions / 4 GetAvailableCoreWebView2BrowserVersionString）</summary>
    internal static class Loader
    {
        private const string Dll = "WebView2Loader.dll";

        [DllImport(Dll, CallingConvention = CallingConvention.Winapi, CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern int CreateCoreWebView2EnvironmentWithOptions(
            [MarshalAs(UnmanagedType.LPWStr)] string browserExecutableFolder,
            [MarshalAs(UnmanagedType.LPWStr)] string userDataFolder,
            IntPtr environmentOptions,
            IntPtr environmentCreatedHandler);

        [DllImport(Dll, CallingConvention = CallingConvention.Winapi, CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern int GetAvailableCoreWebView2BrowserVersionString(
            [MarshalAs(UnmanagedType.LPWStr)] string browserExecutableFolder,
            out IntPtr versionInfo);
    }

    /// <summary>vtable 槽位工具：0-2 为 IUnknown，方法从槽 3 起。</summary>
    internal static class Vtbl
    {
        internal static IntPtr Method(IntPtr obj, int methodIndex /*1-based*/)
        {
            IntPtr vtbl = Marshal.ReadIntPtr(obj);
            return Marshal.ReadIntPtr(vtbl, (methodIndex + 2) * IntPtr.Size);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct RECT { public int left, top, right, bottom; }

    /// <summary>ICoreWebView2Environment：方法 1 CreateCoreWebView2Controller</summary>
    internal static class EnvVtbl
    {
        internal delegate int CreateControllerDel(IntPtr self, IntPtr parentWindow, IntPtr handler);
        internal static int CreateController(IntPtr env, IntPtr parent, IntPtr handler)
        {
            return Marshal.GetDelegateForFunctionPointer<CreateControllerDel>(Vtbl.Method(env, 1))(env, parent, handler);
        }
    }

    /// <summary>ICoreWebView2Controller：槽 4 SetBounds / 槽 23 get_CoreWebView2（槽号已按 webview2-com-sys 的 #[repr(C)] 顺序核准，2026-10-03）</summary>
    internal static class CtrlVtbl
    {
        internal delegate int PutBoundsDel(IntPtr self, ref RECT bounds);
        internal delegate int GetCoreWebView2Del(IntPtr self, out IntPtr webview);
        internal static void PutBounds(IntPtr ctrl, ref RECT b)
        {
            int hr = Marshal.GetDelegateForFunctionPointer<PutBoundsDel>(Vtbl.Method(ctrl, 4))(ctrl, ref b);
            if (hr < 0) throw new COMException("put_Bounds hr=" + hr.ToString("X8"), hr);
        }
        internal static IntPtr GetCoreWebView2(IntPtr ctrl)
        {
            IntPtr wv;
            int hr = Marshal.GetDelegateForFunctionPointer<GetCoreWebView2Del>(Vtbl.Method(ctrl, 23))(ctrl, out wv);
            if (hr < 0) throw new COMException("get_CoreWebView2 hr=" + hr.ToString("X8"), hr);
            if (wv == IntPtr.Zero) throw new COMException("get_CoreWebView2 返回空指针（槽位对不上？）");
            return wv;
        }
    }

    /// <summary>ICoreWebView2：槽 3 Navigate（槽号已按 webview2-com-sys 的 #[repr(C)] 顺序核准；槽 4 是 NavigateToString）</summary>
    internal static class WebVtbl
    {
        internal delegate int NavigateDel(IntPtr self, [MarshalAs(UnmanagedType.LPWStr)] string uri);
        internal static void Navigate(IntPtr wv, string uri)
        {
            if (wv == IntPtr.Zero) throw new COMException("Navigate 拿到空指针（get_CoreWebView2 没成功？）");
            int hr = Marshal.GetDelegateForFunctionPointer<NavigateDel>(Vtbl.Method(wv, 3))(wv, uri);
            if (hr < 0) throw new COMException("Navigate hr=" + hr.ToString("X8"), hr);
        }
    }

    // ───────── 完成回调：交给 CLR 造 COM 包装（2026-10-03 替换原手写 vtable 版）─────────
    // 原写法自己拼 vtable、塞堆内存、用 Marshal.GetFunctionPointerForDelegate 造托管 thunk，
    // 在原生侧回调这条路上会让进程 0xC0000409 崩溃。这里改为只声明接口、由 CLR 生成 CCW。

    /// <summary>ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler</summary>
    [ComImport, Guid("B3288F8A-F93B-42D9-91A4-A262AABC973C"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IEnvCompleted
    {
        [PreserveSig] int Invoke(int errorCode, IntPtr createdEnvironment);
    }

    /// <summary>ICoreWebView2CreateCoreWebView2ControllerCompletedHandler</summary>
    [ComImport, Guid("6C4819F3-C9B7-4260-8127-C9B244A62A8B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ICtrlCompleted
    {
        [PreserveSig] int Invoke(int errorCode, IntPtr createdController);
    }

    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.None)]
    internal sealed class EnvCompleted : IEnvCompleted
    {
        public Action<int, IntPtr> Cb;
        public int Invoke(int errorCode, IntPtr createdEnvironment)
        {
            var cb = Cb;
            if (cb != null) cb(errorCode, createdEnvironment);
            return 0;
        }
    }

    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.None)]
    internal sealed class CtrlCompleted : ICtrlCompleted
    {
        public Action<int, IntPtr> Cb;
        public int Invoke(int errorCode, IntPtr createdController)
        {
            var cb = Cb;
            if (cb != null) cb(errorCode, createdController);
            return 0;
        }
    }

    /// <summary>对外入口（PowerShell Add-Type 调用）</summary>
    public static class OfficeWebView2
    {
        private static IntPtr _ctrl;
        private static readonly object Sync = new object();
        /// <summary>保活：CCW 的接口指针要等异步回调用完，这些实现对象不能被 GC 收走。</summary>
        private static readonly System.Collections.Generic.List<object> KeepAlive = new System.Collections.Generic.List<object>();

        /// <summary>诊断口：设了就把内部每一步写出去（验收用；产品不设就不输出）。</summary>
        public static Action<string> Log;

        /// <summary>诊断口：指定用哪个运行时目录（null = 系统默认）。用来排查某个版本的运行时起不来的情况。</summary>
        public static string BrowserFolder;

        private static void L(string m)
        {
            var log = Log;
            if (log == null) return;
            try { log(m); } catch { }
        }

        /// <summary>创建 WebView2 并嵌入父窗口（必须在 UI 线程调用；内部用 DoEvents 等回调）。userDataFolder 必须是可写目录。</summary>
        public static bool Create(IntPtr parentHwnd, string url, string userDataFolder, out string error)
        {
            error = "";
            try
            {
                int co = CoInitializeEx(IntPtr.Zero, 0x2); // COINIT_APARTMENTTHREADED
                if (co < 0) { error = "CoInitializeEx=" + co.ToString("X8"); return false; }

                IntPtr env = IntPtr.Zero;
                int envHr = int.MinValue;
                // ⚠️ 必须检查回调给的 hr：环境创建失败时第二个参数仍是非空废指针，
                //    直接用它去读 vtable 会 AccessViolation（2026-10-03 实撞）。
                L("主线程=" + System.Threading.Thread.CurrentThread.ManagedThreadId + "，userDataFolder=" + (userDataFolder ?? "(null)"));
                var eh = new EnvCompleted { Cb = (hr, e) =>
                {
                    envHr = hr;
                    L("环境回调：线程=" + System.Threading.Thread.CurrentThread.ManagedThreadId + " hr=" + hr.ToString("X8") + " env=" + e.ToString("X"));
                    if (hr >= 0)
                    {
                        // ⚠️ 回调给的环境是"借出"的：回调一返回它就把引用放开，指针随即失效
                        //（实测：回调内读 vtable 正常，出了 DoEvents 循环再读就 AccessViolation）。
                        // 要留住就得在回调里自己 AddRef 一次。
                        env = e;
                        Marshal.AddRef(e);
                        try { L("回调内读 env 的 vtable = " + Marshal.ReadIntPtr(e).ToString("X") + "（已 AddRef）"); }
                        catch (Exception ex) { L("回调内读 vtable 失败：" + ex.GetType().Name); }
                    }
                } };
                IntPtr ehPtr = Marshal.GetComInterfaceForObject(eh, typeof(IEnvCompleted));
                KeepAlive.Add(eh);
                L("browserExecutableFolder=" + (BrowserFolder ?? "(null)"));
                int r = Loader.CreateCoreWebView2EnvironmentWithOptions(BrowserFolder, userDataFolder, IntPtr.Zero, ehPtr);
                if (r < 0) { error = "CreateEnvironmentWithOptions=" + r.ToString("X8"); return false; }
                if (!WaitUntil(() => envHr != int.MinValue, 20000)) { error = "环境创建回调未到"; return false; }
                if (envHr < 0) { error = "环境创建失败 hr=" + envHr.ToString("X8"); return false; }

                IntPtr ctrl = IntPtr.Zero;
                int ctrlHr = int.MinValue;
                var ch = new CtrlCompleted { Cb = (hr, c) =>
                {
                    ctrlHr = hr;
                    L("控制器回调：线程=" + System.Threading.Thread.CurrentThread.ManagedThreadId + " hr=" + hr.ToString("X8") + " ctrl=" + c.ToString("X"));
                    if (hr >= 0) { ctrl = c; Marshal.AddRef(c); }   // 同上：借出的引用自己留住
                } };
                IntPtr chPtr = Marshal.GetComInterfaceForObject(ch, typeof(ICtrlCompleted));
                KeepAlive.Add(ch);
                r = EnvVtbl.CreateController(env, parentHwnd, chPtr);
                if (r < 0) { error = "CreateController=" + r.ToString("X8"); return false; }
                if (!WaitUntil(() => ctrlHr != int.MinValue, 20000)) { error = "控制器回调未到"; return false; }
                if (ctrlHr < 0) { error = "控制器创建失败 hr=" + ctrlHr.ToString("X8"); return false; }

                lock (Sync) { _ctrl = ctrl; }
                RECT b0 = new RECT { left = 0, top = 0, right = 8, bottom = 8 };
                CtrlVtbl.PutBounds(ctrl, ref b0);
                IntPtr wv = CtrlVtbl.GetCoreWebView2(ctrl);
                WebVtbl.Navigate(wv, url);
                return true;
            }
            catch (Exception ex)
            {
                error = ex.GetType().Name + ": " + ex.Message;
                return false;
            }
        }

        /// <summary>兼容三参数调用：不给目录时，用一个一定可写的用户目录（避免又落到 System32）。</summary>
        public static bool Create(IntPtr parentHwnd, string url, out string error)
        {
            string dir = null;
            try
            {
                dir = System.IO.Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "办公室", "WebView2");
                System.IO.Directory.CreateDirectory(dir);
            }
            catch { dir = null; }
            return Create(parentHwnd, url, dir, out error);
        }

        /// <summary>调整 WebView 尺寸（窗体 Resize 时调用）</summary>
        public static void Resize(int width, int height)
        {
            lock (Sync)
            {
                if (_ctrl == IntPtr.Zero) return;
                try { RECT b1 = new RECT { left = 0, top = 0, right = width, bottom = height }; CtrlVtbl.PutBounds(_ctrl, ref b1); }
                catch { /* 窗口销毁期忽略 */ }
            }
        }

        private static bool WaitUntil(Func<bool> cond, int timeoutMs)
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            while (!cond())
            {
                System.Windows.Forms.Application.DoEvents();
                System.Threading.Thread.Sleep(15);
                if (sw.ElapsedMilliseconds > timeoutMs) return false;
            }
            return true;
        }

        [DllImport("ole32.dll")]
        private static extern int CoInitializeEx(IntPtr pv, uint coInit);
    }
}
