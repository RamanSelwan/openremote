# OpenRemote input bridge (Windows)
# Reads one command per line on stdin, injects it with the Win32 API and
# replies with a single "OK"/"ERR ..." line. Started with -STA so SendKeys and
# the clipboard work.
#
# Commands:
#   PING                     -> PONG
#   MOVE <x> <y>             absolute cursor position (physical pixels)
#   BTN <left|right|middle> <down|up>
#   WHEEL <delta>            positive = scroll up
#   KEY <vk-decimal> <down|up>
#   TEXT <sendkeys-string>   literal text (already SendKeys-escaped by the agent)
#   CLIP <base64-utf8>       set the remote clipboard
#   QUIT                     -> BYE, exits

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$native = @'
using System;
using System.Runtime.InteropServices;
public static class NativeInput {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
}
'@
Add-Type -TypeDefinition $native
[void][NativeInput]::SetProcessDPIAware()

$LEFTDOWN = 0x0002;  $LEFTUP = 0x0004
$RIGHTDOWN = 0x0008; $RIGHTUP = 0x0010
$MIDDLEDOWN = 0x0020; $MIDDLEUP = 0x0040
$WHEEL = 0x0800
$KEYEVENTF_KEYUP = 0x0002

function Send-Button([string]$button, [string]$action) {
  $flags = $null
  switch ("$button-$action") {
    'left-down'   { $flags = $LEFTDOWN }
    'left-up'     { $flags = $LEFTUP }
    'right-down'  { $flags = $RIGHTDOWN }
    'right-up'    { $flags = $RIGHTUP }
    'middle-down' { $flags = $MIDDLEDOWN }
    'middle-up'   { $flags = $MIDDLEUP }
  }
  if ($null -eq $flags) { throw "unknown button $button/$action" }
  [void][NativeInput]::mouse_event($flags, 0, 0, 0, [UIntPtr]::Zero)
}

function Handle([string]$line) {
  $parts = $line.Split(' ')
  switch ($parts[0]) {
    'PING'  { Write-Output 'PONG'; return }
    'MOVE'  {
      [void][NativeInput]::SetCursorPos([int]$parts[1], [int]$parts[2])
      Write-Output 'OK'; return
    }
    'BTN'   { Send-Button $parts[1] $parts[2]; Write-Output 'OK'; return }
    'WHEEL' {
      [void][NativeInput]::mouse_event($WHEEL, 0, 0, [uint]([int]$parts[1]), [UIntPtr]::Zero)
      Write-Output 'OK'; return
    }
    'KEY'   {
      $vk = [Convert]::ToByte($parts[1], 10)
      $flags = if ($parts[2] -eq 'up') { $KEYEVENTF_KEYUP } else { 0 }
      [void][NativeInput]::keybd_event($vk, 0, [uint]$flags, [UIntPtr]::Zero)
      Write-Output 'OK'; return
    }
    'TEXT'  {
      $rest = if ($line.Length -gt 5) { $line.Substring(5) } else { '' }
      if ($rest.Length -gt 0) { [System.Windows.Forms.SendKeys]::SendWait($rest) }
      Write-Output 'OK'; return
    }
    'CLIP'  {
      $bytes = [Convert]::FromBase64String($parts[1])
      $text = [System.Text.Encoding]::UTF8.GetString($bytes)
      if ($text.Length -gt 0) { [System.Windows.Forms.Clipboard]::SetText($text) }
      Write-Output 'OK'; return
    }
    'QUIT'  { Write-Output 'BYE'; exit 0 }
    default { Write-Output ("ERR unknown command " + $parts[0]) }
  }
}

Write-Output 'READY'
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line.Length -eq 0) { continue }
  try { Handle $line } catch { Write-Output ("ERR " + $_.Exception.Message) }
}
