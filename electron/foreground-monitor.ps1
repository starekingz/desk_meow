param(
    [int]$OwnerProcessId = 0,
    [long]$OverlayWindowHandle = 0
)

$source = @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class DesktopArrowHook {
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;
    private static LowLevelKeyboardProc callback = HookCallback;
    private static IntPtr hook = IntPtr.Zero;
    private static readonly object outputLock = new object();
    private static string lastActiveState = null;
    private static IntPtr desktopSurface = IntPtr.Zero;
    private static bool layerReadyReported = false;
    private static bool layerErrorReported = false;
    private static string layerError = "not attempted";
    public static uint OwnerProcessId = 0;
    public static IntPtr OverlayWindowHandle = IntPtr.Zero;

    public delegate bool EnumWindowsProc(IntPtr window, IntPtr state);

    private delegate IntPtr LowLevelKeyboardProc(int code, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int x;
        public int y;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(
        int idHook,
        LowLevelKeyboardProc callback,
        IntPtr module,
        uint threadId
    );

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(
        IntPtr hook,
        int code,
        IntPtr wParam,
        IntPtr lParam
    );

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern IntPtr GetParent(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindWindowEx(
        IntPtr parent,
        IntPtr childAfter,
        string className,
        string windowName
    );

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr window, uint command);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr SetWindowLongPtr(
        IntPtr window,
        int index,
        IntPtr newValue
    );

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(
        IntPtr window,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string moduleName);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG message, IntPtr window, uint min, uint max);

    private static bool HasDesktopWindowClass(IntPtr window) {
        // Follow the focused child/owner chain. Desktop icon focus can live on
        // SysListView32 -> SHELLDLL_DefView -> WorkerW even when the top-level
        // foreground handle itself is not WorkerW.
        for (int depth = 0; window != IntPtr.Zero && depth < 12; depth++) {
            var className = new StringBuilder(256);
            GetClassName(window, className, className.Capacity);
            string value = className.ToString();
            if (value == "Progman" || value == "WorkerW" ||
                value == "Shell_TrayWnd" || value == "Shell_SecondaryTrayWnd") return true;
            window = GetParent(window);
        }
        return false;
    }

    private static bool IsLivelyWallpaperWindow(IntPtr window) {
        uint processId;
        GetWindowThreadProcessId(window, out processId);
        if (processId == 0) return false;
        try {
            string name = Process.GetProcessById((int)processId).ProcessName;
            return name.StartsWith("Lively", StringComparison.OrdinalIgnoreCase);
        } catch {
            return false;
        }
    }

    private static IntPtr FindDesktopSurface() {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr top, IntPtr state) {
            if (FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) {
                found = top;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found != IntPtr.Zero ? found : FindWindow("Progman", null);
    }

    private static bool PinOverlayAboveDesktop() {
        if (OverlayWindowHandle == IntPtr.Zero || !IsWindow(OverlayWindowHandle)) {
            layerError = "overlay handle is not a valid window";
            return false;
        }
        if (desktopSurface == IntPtr.Zero || !IsWindow(desktopSurface)) {
            desktopSurface = FindDesktopSurface();
        }
        if (desktopSurface == IntPtr.Zero) {
            layerError = "Explorer desktop surface was not found";
            return false;
        }

        // Keep the overlay as a top-level Electron window, but make Explorer's
        // desktop its owner. Owned windows stay above their owner while still
        // participating in the ordinary (non-topmost) application Z-order.
        if (GetWindow(OverlayWindowHandle, 4) != desktopSurface) { // GW_OWNER
            SetWindowLongPtr(OverlayWindowHandle, -8, desktopSurface); // GWLP_HWNDPARENT
            if (GetWindow(OverlayWindowHandle, 4) != desktopSurface) {
                layerError = "Unable to assign the Explorer desktop owner (Win32 " +
                    Marshal.GetLastWin32Error() + ")";
                return false;
            }
        }

        bool positioned = SetWindowPos(
            OverlayWindowHandle,
            new IntPtr(1), // HWND_BOTTOM; ownership keeps it above Explorer
            0,
            0,
            0,
            0,
            0x0001 | 0x0002 | 0x0010 // NOSIZE | NOMOVE | NOACTIVATE
        );
        if (!positioned) {
            layerError = "SetWindowPos failed with Win32 error " + Marshal.GetLastWin32Error();
        }
        return positioned;
    }

    private static bool IsDesktopForeground() {
        IntPtr foreground = GetForegroundWindow();
        // A missing foreground handle is transient and must not make the
        // overlay cover an application that is still visible.
        if (foreground == IntPtr.Zero) return false;
        uint foregroundProcessId;
        GetWindowThreadProcessId(foreground, out foregroundProcessId);
        if (OwnerProcessId != 0 && foregroundProcessId == OwnerProcessId) {
            // A click on the transparent character layer can briefly make its
            // Chromium child window foreground. Keep that one classified as
            // desktop so pointerdown/click can finish. The settings panel and
            // compact orb have a different top-level handle and remain apps.
            IntPtr root = GetAncestor(foreground, 2); // GA_ROOT
            return OverlayWindowHandle != IntPtr.Zero &&
                (foreground == OverlayWindowHandle || root == OverlayWindowHandle);
        }
        return HasDesktopWindowClass(foreground) || IsLivelyWallpaperWindow(foreground);
    }

    private static void ReportActiveState(object state) {
        bool layerReady = PinOverlayAboveDesktop();
        if (layerReady && !layerReadyReported) {
            layerReadyReported = true;
            lock (outputLock) {
                Console.Out.WriteLine("LAYER:ready");
                Console.Out.Flush();
            }
        } else if (!layerReady && !layerErrorReported) {
            layerErrorReported = true;
            lock (outputLock) {
                Console.Out.WriteLine("LAYER:error:" + layerError);
                Console.Out.Flush();
            }
        }
        string activeState = IsDesktopForeground() ? "desktop" : "app";
        if (activeState == lastActiveState) return;
        lastActiveState = activeState;
        lock (outputLock) {
            Console.Out.WriteLine("ACTIVE:" + activeState);
            Console.Out.Flush();
        }
    }

    private static string Direction(int virtualKey) {
        switch (virtualKey) {
            case 0x25: return "left";
            case 0x27: return "right";
            case 0x26: return "up";
            case 0x28: return "down";
            default: return null;
        }
    }

    private static IntPtr HookCallback(int code, IntPtr wParam, IntPtr lParam) {
        if (code >= 0) {
            int message = wParam.ToInt32();
            int virtualKey = Marshal.ReadInt32(lParam);
            string direction = Direction(virtualKey);
            if (direction != null && IsDesktopForeground()) {
                // Consume both halves of the key event. Letting KEYUP reach
                // Explorer after swallowing KEYDOWN can leave desktop icon
                // selection/navigation in an inconsistent state.
                if (message == WM_KEYDOWN || message == WM_SYSKEYDOWN) {
                    lock (outputLock) {
                        Console.Out.WriteLine("MOVE:" + direction);
                        Console.Out.Flush();
                    }
                }
                if (message == WM_KEYDOWN || message == WM_SYSKEYDOWN ||
                    message == WM_KEYUP || message == WM_SYSKEYUP) {
                    return new IntPtr(1);
                }
            }
        }
        return CallNextHookEx(hook, code, wParam, lParam);
    }

    public static void Run() {
        hook = SetWindowsHookEx(WH_KEYBOARD_LL, callback, GetModuleHandle(null), 0);
        if (hook == IntPtr.Zero) {
            throw new InvalidOperationException("Unable to install keyboard hook.");
        }
        try {
            var activeTimer = new System.Threading.Timer(ReportActiveState, null, 0, 200);
            MSG message;
            try {
                while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {}
            } finally {
                activeTimer.Dispose();
            }
        } finally {
            UnhookWindowsHookEx(hook);
        }
    }
}
"@

Add-Type -TypeDefinition $source -Language CSharp
[DesktopArrowHook]::OwnerProcessId = [uint32]$OwnerProcessId
[DesktopArrowHook]::OverlayWindowHandle = [IntPtr]::new($OverlayWindowHandle)
[DesktopArrowHook]::Run()
