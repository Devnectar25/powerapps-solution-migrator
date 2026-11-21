@echo off
rem Creates the "PowerApps Solution Migrator" shortcuts (Powercraft icon) here and on the desktop.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\create-shortcuts.ps1" -Force
if errorlevel 1 (
  echo Could not create the shortcuts.
) else (
  echo Done. Start the migrator with the "PowerApps Solution Migrator" shortcut.
)
pause
