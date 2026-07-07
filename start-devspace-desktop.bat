@echo off
setlocal

rem 首次使用请先双击 setup-devspace.bat；本入口会构建并打开桌面控制台。
cd /d "%~dp0"
call npm run desktop
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%DEVSPACE_NO_PAUSE%"=="1" pause
exit /b %EXIT_CODE%
