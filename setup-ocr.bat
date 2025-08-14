@echo off
echo 🚀 IELTS Mock Exam Platform - OCR Migration Setup
echo ==================================================
echo.

REM Check if we're in the right directory
if not exist "server.js" (
    echo ❌ Error: Please run this script from the cd-mock-exam-server directory
    pause
    exit /b 1
)

REM Step 1: Install Node.js dependencies
echo 📦 Step 1: Installing Node.js dependencies...
call npm install axios form-data
echo ✅ Node.js dependencies installed
echo.

REM Step 2: Setup Python environment for docTR
echo 🐍 Step 2: Setting up Python environment for docTR...

REM Check if Python is installed
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Error: Python is not installed. Please install Python 3.8 or higher.
    pause
    exit /b 1
)

REM Create virtual environment for docTR service
echo Creating Python virtual environment...
cd ocr-service
python -m venv venv
call venv\Scripts\activate.bat

REM Install Python dependencies
echo Installing Python dependencies...
python -m pip install --upgrade pip
pip install -r requirements.txt

echo ✅ Python environment setup complete
echo.

REM Step 3: Environment configuration
echo ⚙️ Step 3: Environment configuration...

REM Check if .env file exists
if not exist "..\\.env" (
    echo Creating .env file...
    (
        echo # OpenAI Configuration
        echo OPENAI_API_KEY=sk-your-openai-api-key-here
        echo.
        echo # Supabase Configuration
        echo SUPABASE_URL=https://your-supabase-project.supabase.co
        echo SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
        echo.
        echo # Server Configuration
        echo PORT=3001
        echo NODE_ENV=development
        echo.
        echo # OCR Service Configuration
        echo OCR_SERVICE=doctr
        echo # Options: 'doctr' ^(primary^), 'tesseract' ^(fallback^)
        echo.
        echo # docTR Service Configuration
        echo DOCTR_URL=http://localhost:8001
    ) > ..\.env
    echo ✅ .env file created. Please update with your actual API keys.
) else (
    echo 📝 .env file already exists. Please add OCR configuration manually:
    echo.
    echo # OCR Service Configuration
    echo OCR_SERVICE=doctr
    echo # Options: 'doctr' ^(primary^), 'tesseract' ^(fallback^)
    echo.
    echo # docTR Service Configuration
    echo DOCTR_URL=http://localhost:8001
)

cd ..
echo.

REM Step 4: Create startup scripts
echo 🔧 Step 4: Creating startup scripts...

REM Create docTR service startup script
(
    echo @echo off
    echo echo 🚀 Starting docTR OCR Service...
    echo cd ocr-service
    echo call venv\Scripts\activate.bat
    echo python main.py
    echo pause
) > start-doctr.bat

REM Create combined startup script
(
    echo @echo off
    echo echo 🚀 Starting IELTS Mock Exam Platform with OCR Migration...
    echo echo ===========================================================
    echo.
    echo echo Starting docTR service...
    echo cd ocr-service
    echo call venv\Scripts\activate.bat
    echo start "docTR Service" cmd /k "python main.py"
    echo cd ..
    echo.
    echo echo Waiting for docTR service to initialize...
    echo timeout /t 10 /nobreak
    echo.
    echo echo Starting Express server...
    echo npm start
) > start-all.bat

echo ✅ Startup scripts created:
echo   - start-doctr.bat: Start only docTR service
echo   - start-all.bat: Start both docTR and Express services
echo.

REM Step 5: Test the setup
echo 🧪 Step 5: Testing the setup...

REM Test docTR service
echo Testing docTR service startup...
cd ocr-service
call venv\Scripts\activate.bat
python -c "import sys; import doctr; print('✅ docTR imported successfully'); print('   docTR version:', doctr.__version__)"
if %errorlevel% neq 0 (
    echo ❌ docTR setup test failed
    pause
    exit /b 1
)

echo ✅ docTR setup test passed
cd ..
echo.

REM Final instructions
echo 🎉 OCR Migration Setup Complete!
echo ==================================
echo.
echo 📋 Next Steps:
echo 1. Update your .env file with actual API keys
echo 2. Start the system using one of these methods:
echo.
echo    Option A - Start everything together:
echo    start-all.bat
echo.
echo    Option B - Start services separately:
echo    start-doctr.bat     ^(in one window^)
echo    npm start           ^(in another window^)
echo.
echo 🔍 Service URLs:
echo    Express Server: http://localhost:3001
echo    docTR Service:  http://localhost:8001
echo    OCR Status:     http://localhost:3001/api/ocr/status
echo.
echo ⚙️ Configuration:
echo    Primary OCR:    docTR ^(with Tesseract.js fallback^)
echo    Switch to Tesseract: Set OCR_SERVICE=tesseract in .env
echo.
echo ✅ Your IELTS Mock Exam Platform is now ready with advanced OCR capabilities!
echo.
echo 🆘 If you encounter issues:
echo    - Check the docTR service logs for Python errors
echo    - Verify your .env configuration
echo    - Visit http://localhost:8001/health to test docTR service
echo    - Visit http://localhost:3001/api/ocr/status to check OCR status
echo.
pause