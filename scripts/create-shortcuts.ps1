# Creates "PowerApps Solution Migrator" shortcuts with the Powercraft icon:
# one in the migrator folder and (once) one on the desktop.
#   -Force   also re-create the desktop shortcut if it was removed earlier
param([switch]$Force)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
# The shortcut runs the hidden launcher: no console window and nothing in the taskbar.
$target = Join-Path $env:SystemRoot "System32\wscript.exe"
$launcher = Join-Path $root "scripts\start-hidden.vbs"
$icon = Join-Path $root "public\brand\powercraft.ico"
$name = "PowerApps Solution Migrator.lnk"
$dataDir = Join-Path $root "data"
$marker = Join-Path $dataDir ".desktop-shortcut"

$places = @($root)
$desktop = [Environment]::GetFolderPath("Desktop")
# The desktop shortcut is created once and kept up to date; if you delete it, it is not forced back.
if ($desktop) {
  $onDesktop = Test-Path (Join-Path $desktop $name)
  if ($onDesktop -or $Force -or -not (Test-Path $marker)) { $places += $desktop }
}

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in $places) {
  $lnk = $shell.CreateShortcut((Join-Path $dir $name))
  $lnk.TargetPath = $target
  $lnk.Arguments = "//nologo `"$launcher`""
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = "PowerApps Solution Migrator by Powercraft"
  $lnk.WindowStyle = 1
  $lnk.Save()
}

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
Set-Content -Path $marker -Value (Get-Date -Format o)
Set-Content -Path (Join-Path $dataDir ".shortcut-v3") -Value (Get-Date -Format o)
Write-Host ("Shortcut created in: " + ($places -join ", "))
