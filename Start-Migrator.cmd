@echo off
rem PowerApps Solution Migrator - double-click to start.
rem Installs the required components on first run (or after an update), then starts the
rem migrator in the background (no window) and opens it in your browser. Closing the migrator
rem tab in the browser stops it. Messages are written to data\logs\migrator.log.
setlocal
cd /d "%~dp0"
title PowerApps Solution Migrator

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed. It is needed to run the migrator.
  echo Opening https://nodejs.org - install the LTS version, then double-click this file again.
  start "" https://nodejs.org/en/download
  echo.
  pause
  exit /b 1
)

node scripts\check-deps.js
if errorlevel 2 (
  echo.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)
if errorlevel 1 (
  echo.
  echo Installing the required components. This takes a minute and is only needed once...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo The installation failed. Check your internet connection or proxy, then try again.
    echo If your company uses a proxy, run:  npm config set proxy http://your-proxy:port
    pause
    exit /b 1
  )
  node scripts\check-deps.js --stamp
)

rem Create or refresh the shortcuts with the Powercraft icon (here and on the desktop).
set "MAKE_SHORTCUT="
if not exist "PowerApps Solution Migrator.lnk" set MAKE_SHORTCUT=1
if not exist "data\.shortcut-v3" set MAKE_SHORTCUT=1
if defined MAKE_SHORTCUT powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\create-shortcuts.ps1" >nul 2>nul

rem Start the migrator hidden (no window, nothing in the taskbar) and open the browser. It stops
rem by itself when you close the migrator tab, so this window can close now.
echo Starting the PowerApps Solution Migrator in the background...
start "" wscript.exe //nologo "%~dp0scripts\start-hidden.vbs" /server
exit
