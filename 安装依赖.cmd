@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装依赖.ps1"
if errorlevel 1 (
  echo Installation failed. Read the error above and try again.
) else (
  echo Installation completed.
)
pause
