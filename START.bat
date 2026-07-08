@echo off

chcp 65001 >nul

title Green Logistics Attendance

cd /d "%~dp0"



echo ========================================

echo  Green Logistics Attendance System

echo ========================================

echo.



if not exist ".env" (

    echo Creating .env from .env.example...

    copy /Y ".env.example" ".env" >nul

)



if not exist "node_modules" (

    echo Installing dependencies...

    call npm install

    if errorlevel 1 (

        echo ERROR: npm install failed. Install Node.js LTS first.

        pause

        exit /b 1

    )

)



if not exist "data" mkdir data



REM Stop any leftover server from previous run

call scripts\stop-server.bat



if not exist "node_modules\.prisma\client\index.js" (

    echo First-time setup...

    call npm run setup

    if errorlevel 1 (

        echo.

        echo Setup failed. Run FIX-PRISMA.bat then try again.

        pause

        exit /b 1

    )

) else (

    echo Checking database...

    call npm run db:push:fast

)



echo.

echo Starting server...

echo Open: http://localhost:3847

echo Login: admin / Admin123!@Green

echo.

echo To STOP: close this window or run STOP.bat

echo.

call npm run dev

