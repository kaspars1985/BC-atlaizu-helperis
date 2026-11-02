@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" -Register
echo.
pause
