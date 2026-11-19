@echo off
title Stem Mixer
cd /d "%~dp0"
if not exist "%~dp0app\launcher.ps1" (
  echo.
  echo  Stem Mixer is still inside the .zip file.
  echo  Right-click the .zip, choose "Extract All...", then open the extracted
  echo  folder and double-click "Start Stem Mixer" from there.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\launcher.ps1"
if errorlevel 1 (
  echo.
  pause
)
