<#
.SYNOPSIS
  Shows one bottom-right reminder popup for a finished DSH session.

.DESCRIPTION
  Called by the session-done-notifier Host plugin. The plugin passes plain
  text through process arguments, so this file stays ASCII-only; user-visible
  strings never become script code.

  The popup is a borderless topmost WPF card placed at the bottom-right of
  the primary work area. It is shown without activation, fades in, stays for
  a few seconds (hovering pauses the timer), and clicking it brings the DSH
  window forward. It does not use the Windows notification platform, so
  minimizing DSH or hiding it in the tray cannot suppress it.

.PARAMETER Title
  First line, usually the session title.

.PARAMETER Body
  Second line, usually the reply preview.

.PARAMETER Sound
  Play the Windows notification sound when the popup appears.

.PARAMETER Seconds
  How long the popup stays visible; hovering pauses this timer.

.PARAMETER Offset
  Vertical stacking offset in device-independent pixels, so simultaneous
  reminders do not cover each other.

.PARAMETER AppProcess
  Process name to bring to the foreground when the popup is clicked.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body,
  [switch]$Sound,
  [int]$Seconds = 8,
  [int]$Offset = 0,
  [string]$AppProcess = 'DeepSeek Harness',
  [string]$SessionId = '',
  [string]$ActivationFile = '',
  [string]$Kind = 'completed'
)

$ErrorActionPreference = 'Stop'

$script:NotifierLog = Join-Path $env:TEMP 'dsh-session-done-notifier.log'
function Write-NotifierLog([string]$Message) {
  try {
    $entry = '{0:yyyy-MM-dd HH:mm:ss.fff} {1}' -f (Get-Date), $Message
    Add-Content -LiteralPath $script:NotifierLog -Value $entry -Encoding UTF8
    $item = Get-Item -LiteralPath $script:NotifierLog -ErrorAction SilentlyContinue
    if ($null -ne $item -and $item.Length -gt 65536) {
      Set-Content -LiteralPath $script:NotifierLog -Value '' -Encoding UTF8
    }
  } catch {
    # Diagnostics must never break the reminder.
  }
}

Write-NotifierLog "popup start kind=$Kind sound=$($Sound.IsPresent) offset=$Offset"

# The stock chime peaks around a third of full scale, which is easy to miss at
# a low master volume. Normalize a copy to ~92% once, then reuse it. The source
# and cache are local system files; nothing is redistributed with the plugin.
function Get-NotifierChime {
  $source = Join-Path $env:SystemRoot 'Media\Windows Notify System Generic.wav'
  if (-not (Test-Path -LiteralPath $source)) {
    return $null
  }
  $cache = Join-Path $env:TEMP 'dsh-session-done-notifier-chime.wav'
  try {
    if ((Test-Path -LiteralPath $cache) -and ((Get-Item -LiteralPath $cache).LastWriteTimeUtc -ge (Get-Item -LiteralPath $source).LastWriteTimeUtc)) {
      return $cache
    }
  } catch {
    # A stale cache is fine; regeneration below decides again.
  }
  try {
    $bytes = [System.IO.File]::ReadAllBytes($source)
    if ([BitConverter]::ToUInt16($bytes, 20) -ne 1 -or [BitConverter]::ToUInt16($bytes, 34) -ne 16) {
      return $source
    }
    $position = 12
    $dataSize = 0
    while ($position -le $bytes.Length - 8) {
      $chunkId = [System.Text.Encoding]::ASCII.GetString($bytes, $position, 4)
      $chunkSize = [int][BitConverter]::ToUInt32($bytes, $position + 4)
      if ($chunkId -eq 'data') {
        $dataSize = $chunkSize
        break
      }
      $position += 8 + $chunkSize
    }
    if ($dataSize -le 0) {
      return $source
    }
    $dataStart = $position + 8
    $peak = 0
    for ($index = $dataStart; $index -lt $dataStart + $dataSize - 1; $index += 2) {
      $value = [Math]::Abs([int][BitConverter]::ToInt16($bytes, $index))
      if ($value -gt $peak) {
        $peak = $value
      }
    }
    if ($peak -le 0) {
      return $source
    }
    $gain = [double]([int](32767 * 0.92)) / $peak
    if ($gain -le 1.05) {
      return $source
    }
    for ($index = $dataStart; $index -lt $dataStart + $dataSize - 1; $index += 2) {
      $sample = [int]([BitConverter]::ToInt16($bytes, $index) * $gain)
      if ($sample -gt 32767) {
        $sample = 32767
      } elseif ($sample -lt -32768) {
        $sample = -32768
      }
      $pair = [BitConverter]::GetBytes([int16]$sample)
      $bytes[$index] = $pair[0]
      $bytes[$index + 1] = $pair[1]
    }
    [System.IO.File]::WriteAllBytes($cache, $bytes)
    return $cache
  } catch {
    return $source
  }
}

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

if (-not ('DshPopupNative' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class DshPopupNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct WINDOWPLACEMENT {
    public int length;
    public int flags;
    public int showCmd;
    public POINT ptMinPosition;
    public POINT ptMaxPosition;
    public RECT rcNormalPosition;
  }

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int count);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("winmm.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool PlaySound(string sound, IntPtr module, uint flags);

  public static IntPtr FindMainWindow(int processId) {
    IntPtr best = IntPtr.Zero;
    int bestScore = int.MinValue;
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      int pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (pid != processId) return true;
      if (GetWindow(hWnd, 4) != IntPtr.Zero) return true;

      StringBuilder cls = new StringBuilder(256);
      GetClassName(hWnd, cls, cls.Capacity);
      string className = cls.ToString();
      if (className != "Chrome_WidgetWin_1" && className != "Chrome_WidgetWin_0") return true;

      // A minimized window reports a placeholder rect, so judge the window by
      // its restored geometry; this is what makes tray/minimized focus work.
      var placement = new WINDOWPLACEMENT();
      placement.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
      if (!GetWindowPlacement(hWnd, ref placement)) return true;
      int width = placement.rcNormalPosition.Right - placement.rcNormalPosition.Left;
      int height = placement.rcNormalPosition.Bottom - placement.rcNormalPosition.Top;
      if (width < 300 || height < 200) return true;

      StringBuilder title = new StringBuilder(512);
      GetWindowText(hWnd, title, title.Capacity);
      int score = (width * height) / 1000;
      if (title.ToString().IndexOf("DeepSeek Harness", StringComparison.OrdinalIgnoreCase) >= 0) score += 1000000;
      if (IsWindowVisible(hWnd)) score += 100000;
      if (IsIconic(hWnd)) score += 50000;
      if (score > bestScore) {
        bestScore = score;
        best = hWnd;
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  public static bool ActivateWindow(IntPtr hWnd) {
    if (IsIconic(hWnd)) {
      ShowWindow(hWnd, 9);
    }
    BringWindowToTop(hWnd);
    bool activated = SetForegroundWindow(hWnd);
    if (!activated) {
      IntPtr foreground = GetForegroundWindow();
      int foregroundPid;
      int targetPid;
      uint foregroundThread = (uint)GetWindowThreadProcessId(foreground, out foregroundPid);
      uint targetThread = (uint)GetWindowThreadProcessId(hWnd, out targetPid);
      if (foregroundThread != 0 && targetThread != 0 && foregroundThread != targetThread) {
        if (AttachThreadInput(foregroundThread, targetThread, true)) {
          BringWindowToTop(hWnd);
          activated = SetForegroundWindow(hWnd);
          AttachThreadInput(foregroundThread, targetThread, false);
        }
      }
    }
    return activated;
  }
}
'@
}

# The popup inherits the Host's ELECTRON_RUN_AS_NODE=1; launching the app
# executable with it would start a Node runtime (and a console) instead of the
# desktop GUI. Start a clean second instance instead: it forwards to the
# running app through its single-instance handler, whose show()/focus() path
# resumes the renderer that hide() throttled.
function Start-DshApplication([string]$Executable) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $Executable
  $info.UseShellExecute = $false
  [void]$info.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
  [void][System.Diagnostics.Process]::Start($info)
}

$work = [System.Windows.SystemParameters]::WorkArea
$width = 380.0
$height = 108.0
$margin = 18.0

$window = New-Object System.Windows.Window
$window.WindowStyle = [System.Windows.WindowStyle]::None
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.ShowActivated = $false
$window.ResizeMode = [System.Windows.ResizeMode]::NoResize
$window.Width = $width
$window.Height = $height
$window.Left = $work.Right - $width - $margin
$window.Top = $work.Bottom - $height - $margin - $Offset
$window.Cursor = [System.Windows.Input.Cursors]::Hand

$border = New-Object System.Windows.Controls.Border
$border.CornerRadius = New-Object System.Windows.CornerRadius 12
$border.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(246, 26, 28, 34))
$border.BorderBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(46, 255, 255, 255))
$border.BorderThickness = New-Object System.Windows.Thickness 1
$border.Padding = New-Object System.Windows.Thickness 16, 14, 16, 14

$shadow = New-Object System.Windows.Media.Effects.DropShadowEffect
$shadow.BlurRadius = 20
$shadow.ShadowDepth = 3
$shadow.Opacity = 0.45
$shadow.Color = [System.Windows.Media.Colors]::Black
$border.Effect = $shadow

$grid = New-Object System.Windows.Controls.Grid
$iconColumn = New-Object System.Windows.Controls.ColumnDefinition
$iconColumn.Width = [System.Windows.GridLength]::new(36)
$textColumn = New-Object System.Windows.Controls.ColumnDefinition
$textColumn.Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
[void]$grid.ColumnDefinitions.Add($iconColumn)
[void]$grid.ColumnDefinitions.Add($textColumn)

$iconSpecs = @{
  completed = @{ color = '#4ADE80'; paths = 'M5 12.5l4.5 4.5L19 7.5' }
  question  = @{ color = '#60A5FA'; paths = 'M9.2 9.2a2.8 2.8 0 1 1 4.4 2.3c-.9.7-1.6 1.3-1.6 2.6M12 18.5h.01' }
  plan      = @{ color = '#A78BFA'; paths = 'M7 4h7l3 3v13H7zM10 11h5M10 14h5M10 17h3' }
  approval  = @{ color = '#FBBF24'; paths = 'M12 3l7 3v5c0 4.4-2.9 7.4-7 8.9C7.9 18.4 5 15.4 5 11V6zM9 12l2 2 4-4' }
  error     = @{ color = '#F87171'; paths = 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18M12 7.5v5.5M12 16.8h.01' }
  aborted   = @{ color = '#94A3B8'; paths = 'M7.5 7.5h9v9h-9z' }
  limit     = @{ color = '#FB923C'; paths = 'M12 3.5L21 19H3zM12 9v4.5M12 16.6h.01' }
  blocked   = @{ color = '#FB7185'; paths = 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18M6.5 6.5l11 11' }
}
$iconSpec = $iconSpecs[$Kind]
if ($null -eq $iconSpec) {
  $iconSpec = $iconSpecs['completed']
}
$accent = [System.Windows.Media.ColorConverter]::ConvertFromString($iconSpec.color)
$iconBrush = New-Object System.Windows.Media.SolidColorBrush $accent
$badgeColor = [System.Windows.Media.Color]::FromArgb(38, $accent.R, $accent.G, $accent.B)

$badge = New-Object System.Windows.Controls.Border
$badge.Width = 32
$badge.Height = 32
$badge.CornerRadius = New-Object System.Windows.CornerRadius 9
$badge.Background = New-Object System.Windows.Media.SolidColorBrush $badgeColor
$badge.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Left
$badge.VerticalAlignment = [System.Windows.VerticalAlignment]::Top
[System.Windows.Controls.Grid]::SetColumn($badge, 0)

$icon = New-Object System.Windows.Shapes.Path
$icon.Data = [System.Windows.Media.Geometry]::Parse($iconSpec.paths)
$icon.Stroke = $iconBrush
$icon.StrokeThickness = 2
$icon.StrokeStartLineCap = [System.Windows.Media.PenLineCap]::Round
$icon.StrokeEndLineCap = [System.Windows.Media.PenLineCap]::Round
$icon.StrokeLineJoin = [System.Windows.Media.PenLineJoin]::Round
$icon.Fill = $null
$icon.Stretch = [System.Windows.Media.Stretch]::Uniform
$icon.Width = 20
$icon.Height = 20
$icon.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Center
$icon.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
$badge.Child = $icon
[void]$grid.Children.Add($badge)

$panel = New-Object System.Windows.Controls.StackPanel
[System.Windows.Controls.Grid]::SetColumn($panel, 1)

$titleBlock = New-Object System.Windows.Controls.TextBlock
$titleBlock.Text = $Title
$titleBlock.FontFamily = New-Object System.Windows.Media.FontFamily -ArgumentList 'Segoe UI'
$titleBlock.FontSize = 14
$titleBlock.FontWeight = [System.Windows.FontWeights]::SemiBold
$titleBlock.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(242, 255, 255, 255))
$titleBlock.TextTrimming = [System.Windows.TextTrimming]::CharacterEllipsis
$titleBlock.TextWrapping = [System.Windows.TextWrapping]::NoWrap
$titleBlock.ToolTip = $Title

$bodyBlock = New-Object System.Windows.Controls.TextBlock
$bodyBlock.Text = $Body
$bodyBlock.FontFamily = New-Object System.Windows.Media.FontFamily -ArgumentList 'Segoe UI'
$bodyBlock.FontSize = 12
$bodyBlock.Margin = New-Object System.Windows.Thickness 0, 5, 0, 0
$bodyBlock.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(186, 255, 255, 255))
$bodyBlock.TextWrapping = [System.Windows.TextWrapping]::Wrap
$bodyBlock.MaxHeight = 46
$bodyBlock.ToolTip = $Body

[void]$panel.Children.Add($titleBlock)
[void]$panel.Children.Add($bodyBlock)
[void]$grid.Children.Add($panel)

$border.Child = $grid
$window.Content = $border

$script:lastActivatedHandle = [IntPtr]::Zero

$window.Add_MouseLeftButtonUp({
  Write-NotifierLog 'click begin'
  try {
    if ($SessionId -ne '' -and $ActivationFile -ne '') {
      try {
        $payload = @{
          sessionId = $SessionId
          at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        } | ConvertTo-Json -Compress
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($ActivationFile, $payload, $utf8)
        Write-NotifierLog "activation written session=$SessionId"
      } catch {
        Write-NotifierLog "activation write failed: $($_.Exception.Message)"
      }
    }
    $activated = $false
    for ($attempt = 0; $attempt -lt 2 -and -not $activated; $attempt++) {
      if ($attempt -gt 0) {
        Start-Sleep -Milliseconds 250
      }
      foreach ($process in Get-Process -Name $AppProcess -ErrorAction SilentlyContinue) {
        $handle = [DshPopupNative]::FindMainWindow($process.Id)
        if ($handle -eq [IntPtr]::Zero) {
          continue
        }

        if (-not [DshPopupNative]::IsWindowVisible($handle)) {
          # A window hidden through Electron's hide() keeps its renderer
          # throttled: native ShowWindow presents a stale, frozen frame. Ask
          # the running app to show itself instead; its single-instance
          # handler calls window.show() and window.focus(), exactly like a
          # tray click. The launched process only forwards and exits.
          $executable = $null
          try {
            $executable = $process.Path
          } catch {
            $executable = $null
          }
          if (-not [string]::IsNullOrEmpty($executable)) {
            Start-DshApplication $executable
            Write-NotifierLog "click attempt=$attempt pid=$($process.Id) hidden; relaunched=$executable"
            $activated = $true
            break
          }
          Write-NotifierLog "click attempt=$attempt pid=$($process.Id) hidden; no executable path"
          continue
        }

        $visibleBefore = [DshPopupNative]::IsWindowVisible($handle)
        $iconicBefore = [DshPopupNative]::IsIconic($handle)
        $activated = [DshPopupNative]::ActivateWindow($handle)
        $visibleAfter = [DshPopupNative]::IsWindowVisible($handle)
        $script:lastActivatedHandle = $handle
        Write-NotifierLog "click attempt=$attempt pid=$($process.Id) hwnd=$handle visible=$visibleBefore iconic=$iconicBefore activated=$activated afterVisible=$visibleAfter"
        if ($activated) {
          # Ignore a second click from an accidental double-click while the
          # popup fades out; otherwise it could land on the window underneath.
          $window.IsEnabled = $false
          Start-Sleep -Milliseconds 250
          break
        }
      }
    }
    if (-not $activated) {
      $running = @(Get-Process -Name $AppProcess -ErrorAction SilentlyContinue)
      if ($running.Count -eq 0) {
        Write-NotifierLog 'click app not running; launching through the shell'
        Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList 'shell:AppsFolder\com.deepseek.dsh'
      } else {
        Write-NotifierLog 'click no usable window while the app is running; leaving it untouched'
      }
    }
  } catch {
    Write-NotifierLog "click error=$($_.Exception.Message)"
  }
  $window.Close()
})

$window.Opacity = 0
$window.Add_Loaded({
  $animation = New-Object System.Windows.Media.Animation.DoubleAnimation
  $animation.From = 0
  $animation.To = 1
  $animation.Duration = [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(170))
  $window.BeginAnimation([System.Windows.Window]::OpacityProperty, $animation)

  if ($Sound) {
    $chime = Get-NotifierChime
    try {
      $played = $false
      if ($null -ne $chime) {
        $played = [DshPopupNative]::PlaySound($chime, [IntPtr]::Zero, 0x20003)
      }
      if ($played) {
        Write-NotifierLog "sound played file=$chime"
      } else {
        [System.Media.SystemSounds]::Asterisk.Play()
        Write-NotifierLog 'sound fallback=SystemSounds'
      }
    } catch {
      Write-NotifierLog "sound error=$($_.Exception.Message)"
    }
  } else {
    Write-NotifierLog 'sound disabled'
  }
})

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds([Math]::Max(2, $Seconds))
$timer.Add_Tick({
  $timer.Stop()
  $window.Close()
})
$window.Add_MouseEnter({ $timer.Stop() })
$window.Add_MouseLeave({ $timer.Start() })
$timer.Start()

$window.ShowDialog() | Out-Null

if ($script:lastActivatedHandle -ne [IntPtr]::Zero) {
  Start-Sleep -Milliseconds 300
  Write-NotifierLog "post-click handle=$($script:lastActivatedHandle) visible=$([DshPopupNative]::IsWindowVisible($script:lastActivatedHandle)) iconic=$([DshPopupNative]::IsIconic($script:lastActivatedHandle))"
}
Write-NotifierLog 'popup closed'
