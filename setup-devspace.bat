@echo off
setlocal

rem 双击运行时保留窗口；在自动化终端中可设置 DEVSPACE_NO_PAUSE=1 跳过暂停。
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-devspace.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%DEVSPACE_NO_PAUSE%"=="1" pause
exit /b %EXIT_CODE%
