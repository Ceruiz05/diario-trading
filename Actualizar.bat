@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Leyendo operaciones de NinjaTrader...
python sync\sincronizar.py
echo.
pause
