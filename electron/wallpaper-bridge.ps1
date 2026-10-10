param(
  [Parameter(Mandatory = $true)]
  [UInt64]$WindowHandle,

  [Parameter(Mandatory = $true)]
  [ValidateSet("attach", "detach")]
  [string]$Mode,

  [int]$X = 0,
  [int]$Y = 0,
  [int]$Width = 1920,
  [int]$Height = 1080
)

$source = @"
using System;
using System.Runtime.InteropServices;

public static class DesktopWallpaperBridge {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindowEx(
        IntPtr parent,
        IntPtr childAfter,
        string className,
        string windowName
    );

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd,
        uint msg,
        IntPtr wParam,
        IntPtr lParam,
        uint flags,
        uint timeout,
        out IntPtr result
    );

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetParent(IntPtr child, IntPtr newParent);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool MoveWindow(
        IntPtr hWnd,
        int x,
        int y,
        int width,
        int height,
        bool repaint
    );

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );

    public static readonly IntPtr HWND_TOP = IntPtr.Zero;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_SHOWWINDOW = 0x0040;

    public static IntPtr FindWallpaperHost() {
        IntPtr progman = FindWindow("Progman", null);
        IntPtr result;
        SendMessageTimeout(
            progman,
            0x052C,
            new IntPtr(0xD),
            IntPtr.Zero,
            0,
            1000,
            out result
        );
        SendMessageTimeout(
            progman,
            0x052C,
            new IntPtr(0xD),
            new IntPtr(1),
            0,
            1000,
            out result
        );
        SendMessageTimeout(
            progman,
            0x052C,
            IntPtr.Zero,
            IntPtr.Zero,
            0,
            1000,
            out result
        );

        IntPtr host = IntPtr.Zero;
        EnumWindows(delegate(IntPtr top, IntPtr state) {
            IntPtr icons = FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (icons != IntPtr.Zero) {
                IntPtr candidate = top;
                while ((candidate = FindWindowEx(IntPtr.Zero, candidate, "WorkerW", null)) != IntPtr.Zero) {
                    RECT bounds;
                    if (IsWindowVisible(candidate) &&
                        GetWindowRect(candidate, out bounds) &&
                        bounds.Right > bounds.Left &&
                        bounds.Bottom > bounds.Top) {
                        host = candidate;
                        break;
                    }
                }
            }
            return host == IntPtr.Zero;
        }, IntPtr.Zero);

        return host;
    }

    public static bool Attach(IntPtr child) {
        IntPtr host = FindWallpaperHost();
        if (host == IntPtr.Zero) return false;

        SetParent(child, host);

        RECT rect;
        if (!GetClientRect(host, out rect)) return false;
        bool moved = MoveWindow(
            child,
            0,
            0,
            rect.Right - rect.Left,
            rect.Bottom - rect.Top,
            true
        );
        SetWindowPos(
            child,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW
        );
        return moved;
    }

    public static bool Detach(IntPtr child, int x, int y, int width, int height) {
        SetParent(child, IntPtr.Zero);
        return MoveWindow(child, x, y, width, height, true);
    }
}
"@

Add-Type -TypeDefinition $source -Language CSharp
$handle = [IntPtr]::new([Int64]$WindowHandle)

if ($Mode -eq "attach") {
  $success = [DesktopWallpaperBridge]::Attach($handle)
} else {
  $success = [DesktopWallpaperBridge]::Detach($handle, $X, $Y, $Width, $Height)
}

if ($success) {
  Write-Output "OK"
  exit 0
}

Write-Error "Windows desktop wallpaper host operation failed."
exit 1
