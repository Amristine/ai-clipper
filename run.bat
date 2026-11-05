@echo off
title ClipForge
if not exist node_modules (
  echo Dependencies not found. Please run install.bat first.
  pause
  exit /b 1
)
echo Starting ClipForge locally...
call npm run dev
pause
