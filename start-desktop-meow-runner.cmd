@echo off
cd /d "%~dp0"
npm.cmd run start:local > "%~dp0desktop-game-meow-startup.log" 2>&1
