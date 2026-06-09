param(
  [string]$OutputDir = "icons"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $OutputDir)) {
  New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

function New-RoundedRectanglePath {
  param(
    [float]$X,
    [float]$Y,
    [float]$Width,
    [float]$Height,
    [float]$Radius
  )

  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $Radius * 2
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

foreach ($size in @(16, 32, 48, 128)) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $scale = $size / 128.0
  $teal = [System.Drawing.Color]::FromArgb(15, 118, 110)
  $ink = [System.Drawing.Color]::FromArgb(31, 35, 41)
  $paper = [System.Drawing.Color]::FromArgb(255, 255, 255)
  $line = [System.Drawing.Color]::FromArgb(197, 204, 213)

  $docPath = New-RoundedRectanglePath -X (20 * $scale) -Y (12 * $scale) -Width (72 * $scale) -Height (92 * $scale) -Radius (10 * $scale)
  $graphics.FillPath([System.Drawing.SolidBrush]::new($paper), $docPath)
  $graphics.DrawPath([System.Drawing.Pen]::new($line, [Math]::Max(1, 3 * $scale)), $docPath)

  $fold = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(72 * $scale, 12 * $scale),
    [System.Drawing.PointF]::new(92 * $scale, 32 * $scale),
    [System.Drawing.PointF]::new(72 * $scale, 32 * $scale)
  )
  $graphics.FillPolygon([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(232, 246, 244)), $fold)

  foreach ($y in @(46, 60, 74)) {
    $graphics.DrawLine([System.Drawing.Pen]::new($teal, [Math]::Max(1, 5 * $scale)), 34 * $scale, $y * $scale, 72 * $scale, $y * $scale)
  }

  $arrowPen = [System.Drawing.Pen]::new($ink, [Math]::Max(2, 10 * $scale))
  $arrowPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $arrowPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $graphics.DrawLine($arrowPen, 91 * $scale, 54 * $scale, 91 * $scale, 100 * $scale)
  $graphics.DrawLine($arrowPen, 72 * $scale, 82 * $scale, 91 * $scale, 101 * $scale)
  $graphics.DrawLine($arrowPen, 110 * $scale, 82 * $scale, 91 * $scale, 101 * $scale)

  $barPen = [System.Drawing.Pen]::new($teal, [Math]::Max(2, 8 * $scale))
  $barPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $barPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $graphics.DrawLine($barPen, 70 * $scale, 112 * $scale, 112 * $scale, 112 * $scale)

  $path = Join-Path $OutputDir "icon$size.png"
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
}

