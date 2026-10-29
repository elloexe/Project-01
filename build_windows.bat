@echo off
REM ============================================================
REM  Build ello Crew for Windows.
REM  Requires Node.js 20+ (https://nodejs.org). Double-click this file.
REM  Output: dist\ello-Crew-<version>-portable.exe and dist\ello-Crew-Setup-<version>.exe
REM ============================================================
setlocal
cd /d "%~dp0"

echo [ello Crew] Installing dependencies...
call npm ci || call npm install || goto :err

echo [ello Crew] Building the .exe files (takes a minute)...
call npm run dist:win || goto :err

echo.
echo [ello Crew] Done. Your apps are in:
echo     %CD%\dist
echo.
explorer dist
pause
endlocal
exit /b 0

:err
echo.
echo [ello Crew] Build failed. Make sure Node.js 20+ is installed (node --version).
echo.
pause
endlocal
exit /b 1
