@echo off
rem Runs the migrator server in a visible window, for troubleshooting (the shortcut and
rem Start-Migrator.cmd start it hidden). This window closes by itself when you close the
rem migrator tab in your browser.
cd /d "%~dp0.."
title PowerApps Solution Migrator - close the browser tab to stop
node server.js
if errorlevel 1 (
  echo.
  echo The migrator stopped because of an error. See the messages above.
  pause
)
exit
