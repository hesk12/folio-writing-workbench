@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open.ps1"
if errorlevel 1 pause
