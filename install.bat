@echo off
title ClipForge Setup
echo ======================================
echo       ClipForge - Local Setup
echo ======================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 20 LTS or newer from https://nodejs.org/
  pause
  exit /b 1
)
echo Installing project dependencies...
call npm install
if errorlevel 1 (
  echo Dependency installation failed.
  pause
  exit /b 1
)
echo.
echo Setup complete. Double-click run.bat to start ClipForge.
pause
