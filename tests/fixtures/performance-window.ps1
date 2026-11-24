param(
    [Parameter(Mandatory)][int]$TargetProcess,
    [Parameter(Mandatory)][ValidateSet('Cover', 'Minimize', 'Restore')][string]$Action
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TestDesktop {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct Point { public int X, Y; }
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flag);
    public static bool Covers(IntPtr cover, Rect r) {
        foreach (int x in new[] { 10, 50, 90 })
            foreach (int y in new[] { 10, 50, 90 }) {
                var point = new Point { X = r.Left + (r.Right - r.Left) * x / 100, Y = r.Top + (r.Bottom - r.Top) * y / 100 };
                if (GetAncestor(WindowFromPoint(point), 2) != cover) return false;
            }
        return true;
    }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int state);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
"@
$window = (Get-Process -Id $TargetProcess).MainWindowHandle
if ($window -eq [IntPtr]::Zero) { throw "The test window for process $TargetProcess is unavailable during $Action." }
if ($Action -ne 'Cover') {
    $state = if ($Action -eq 'Minimize') { 6 } else { 9 }
    [void][TestDesktop]::ShowWindowAsync($window, $state)
    return
}

[void][TestDesktop]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$rect = [TestDesktop+Rect]::new()
if (![TestDesktop]::GetWindowRect($window, [ref]$rect)) { throw 'Cannot measure the test window.' }
$form = [Windows.Forms.Form]::new()
$form.Text = 'DevShift performance verification'
$form.StartPosition = 'Manual'
$form.FormBorderStyle = 'None'
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.Bounds = [Drawing.Rectangle]::FromLTRB($rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
$form.BackColor = [Drawing.Color]::FromArgb(23, 25, 34)
$label = [Windows.Forms.Label]::new()
$label.Text = 'Verifying DevShift while its dashboard is covered'
$label.ForeColor = [Drawing.Color]::White
$label.Dock = 'Fill'
$label.TextAlign = 'MiddleCenter'
$form.Controls.Add($label)
$timer = [Windows.Forms.Timer]::new()
$timer.Interval = 12000
$timer.Add_Tick({ $form.Close() })
$probe = [Windows.Forms.Timer]::new()
$probe.Interval = 100
$probe.Tag = $false
$probe.Add_Tick({
    if ([TestDesktop]::Covers($form.Handle, $rect)) {
        if (!$probe.Tag) {
            $probe.Tag = $true
            $timer.Stop()
            $timer.Start()
            [Console]::WriteLine('Covered')
        }
    } elseif ($probe.Tag) {
        [Console]::WriteLine('Coverage lost')
        $form.Close()
    }
})
$form.Add_Shown({
    $form.Activate()
    $timer.Start()
    $probe.Start()
})
try { [void]$form.ShowDialog() }
finally { $probe.Dispose(); $timer.Dispose(); $form.Dispose() }
