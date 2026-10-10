param(
    [int]$OwnerProcessId = 0
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
    public static uint OwnerProcessId = 0;

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
            if (value == "Progman" || value == "WorkerW") return true;
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

    private static bool IsDesktopForeground() {
        IntPtr foreground = GetForegroundWindow();
        // Windows 11 can report no activated foreground window after the user
        // clicks the desktop/Lively wallpaper. In that state the desktop is the
        // active surface and bare arrow keys should control the character.
        if (foreground == IntPtr.Zero) return true;
        uint foregroundProcessId;
        GetWindowThreadProcessId(foreground, out foregroundProcessId);
        if (OwnerProcessId != 0 && foregroundProcessId == OwnerProcessId) return true;
        return HasDesktopWindowClass(foreground) || IsLivelyWallpaperWindow(foreground);
    }

    private static void ReportActiveState(object state) {
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
[DesktopArrowHook]::Run()
