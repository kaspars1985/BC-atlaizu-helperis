@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================================
echo   BC Pavadzīmju Audita un Rindu Atlaižu Rīks
echo ============================================================
echo.
echo   Serveris tiks palaists un pārlūks atvērsies automātiski:
echo   http://localhost:3456
echo.
echo   Lai apturētu serveri, aizveriet šo logu vai nospiediet Ctrl+C.
echo ============================================================
echo.

echo Pārbauda, vai ports 3456 jau tiek izmantots...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:"TCP.*:3456 .*LISTENING"') do (
    echo   Atrasts process ar PID %%P, kas klausās portā 3456. Aptur...
    taskkill /F /PID %%P >nul 2>&1
)
echo.

node server.js

if errorlevel 1 (
    echo.
    echo ============================================================
    echo   KĻŪDA: Serveris beidza darbu ar kļūdu.
    echo   Lūdzu, izlasiet kļūdas ziņojumu augstāk.
    echo ============================================================
    pause
)
