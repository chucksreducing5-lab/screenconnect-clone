@echo off
REM Remote Support System - Quick Start Script (Windows)
REM This script starts the remote support server

echo ==========================================
echo   Remote Support System - Quick Start
echo ==========================================
echo.

REM Check if we're in the right directory
if not exist "server.js" (
    if exist "remote-support-web\server.js" (
        cd remote-support-web
        echo Changed to remote-support-web directory
        echo.
    ) else (
        echo Error: server.js not found!
        echo Please run this script from the remote-support-web directory
        pause
        exit /b 1
    )
)

REM Check if node_modules exists
if not exist "node_modules" (
    echo Node modules not found. Installing dependencies...
    call npm install
    echo.
)

REM Display access URLs
echo Starting Remote Support Server...
echo.
echo 🚀 Server will be available at:
echo.
echo    Technician Console:  http://localhost:3001/
echo    Customer Landing:    http://localhost:3001/customer-landing
echo    Mobile Download:     http://localhost:3001/mobile-download
echo    Customer Page:       http://localhost:3001/customer
echo.
echo Default Login:
echo    Username: admin
echo    Password: admin
echo.
echo Press Ctrl+C to stop the server
echo.
echo ==========================================
echo.

REM Start the server
node server.js

pause