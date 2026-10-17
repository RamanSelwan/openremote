# OpenRemote capture bridge (Windows)
# Reads commands on stdin and writes one line per captured frame:
#   READY <width> <height>            once at startup
#   FRAME <width> <height> <base64>   per CAP command
#   ERR <message>
#   PONG                               per PING

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$dpi = @'
using System;
using System.Runtime.InteropServices;
public static class NativeDpi {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
}
'@
Add-Type -TypeDefinition $dpi
[void][NativeDpi]::SetProcessDPIAware()

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
  Where-Object { $_.MimeType -eq 'image/jpeg' }

Write-Output ("READY {0} {1}" -f $bounds.Width, $bounds.Height)

function Capture-Frame {
  $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
    } finally { $g.Dispose() }

    $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
      [System.Drawing.Imaging.Encoder]::Quality, [long]70)

    $ms = New-Object System.IO.MemoryStream
    try {
      $bmp.Save($ms, $codec, $params)
      $b64 = [Convert]::ToBase64String($ms.ToArray())
    } finally { $ms.Dispose() }

    Write-Output ("FRAME {0} {1} {2}" -f $bounds.Width, $bounds.Height, $b64)
  } finally {
    $bmp.Dispose()
  }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  switch ($line) {
    'CAP' {
      try { Capture-Frame } catch { Write-Output ("ERR " + $_.Exception.Message) }
    }
    'PING' { Write-Output 'PONG' }
    'QUIT' { Write-Output 'BYE'; exit 0 }
    default { Write-Output ("ERR unknown command " + $line) }
  }
}
