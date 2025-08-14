#!/bin/bash

# OCR Migration Setup Script for IELTS Mock Exam Platform
# This script sets up the docTR OCR service alongside the existing Tesseract.js setup

echo "🚀 IELTS Mock Exam Platform - OCR Migration Setup"
echo "=================================================="
echo

# Check if we're in the right directory
if [ ! -f "server.js" ]; then
    echo "❌ Error: Please run this script from the cd-mock-exam-server directory"
    exit 1
fi

# Step 1: Install Node.js dependencies
echo "📦 Step 1: Installing Node.js dependencies..."
npm install axios form-data
echo "✅ Node.js dependencies installed"
echo

# Step 2: Setup Python environment for docTR
echo "🐍 Step 2: Setting up Python environment for docTR..."

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "❌ Error: Python 3 is not installed. Please install Python 3.8 or higher."
    exit 1
fi

# Create virtual environment for docTR service
echo "Creating Python virtual environment..."
cd ocr-service
python3 -m venv venv
source venv/bin/activate

# Install Python dependencies
echo "Installing Python dependencies..."
pip install --upgrade pip
pip install -r requirements.txt

echo "✅ Python environment setup complete"
echo

# Step 3: Environment configuration
echo "⚙️ Step 3: Environment configuration..."

# Check if .env file exists
if [ ! -f "../.env" ]; then
    echo "Creating .env file..."
    cat > ../.env << EOF
# OpenAI Configuration
OPENAI_API_KEY=sk-your-openai-api-key-here

# Supabase Configuration
SUPABASE_URL=https://your-supabase-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key

# Server Configuration
PORT=3001
NODE_ENV=development

# OCR Service Configuration
OCR_SERVICE=doctr
# Options: 'doctr' (primary), 'tesseract' (fallback)

# docTR Service Configuration
DOCTR_URL=http://localhost:8001
EOF
    echo "✅ .env file created. Please update with your actual API keys."
else
    echo "📝 .env file already exists. Adding OCR configuration..."
    # Add OCR configuration to existing .env if not present
    if ! grep -q "OCR_SERVICE" ../.env; then
        cat >> ../.env << EOF

# OCR Service Configuration
OCR_SERVICE=doctr
# Options: 'doctr' (primary), 'tesseract' (fallback)

# docTR Service Configuration
DOCTR_URL=http://localhost:8001
EOF
        echo "✅ OCR configuration added to .env"
    else
        echo "✅ OCR configuration already present in .env"
    fi
fi

cd ..
echo

# Step 4: Create startup scripts
echo "🔧 Step 4: Creating startup scripts..."

# Create docTR service startup script
cat > start-doctr.sh << 'EOF'
#!/bin/bash
echo "🚀 Starting docTR OCR Service..."
cd ocr-service
source venv/bin/activate
python main.py
EOF

# Create combined startup script
cat > start-all.sh << 'EOF'
#!/bin/bash
echo "🚀 Starting IELTS Mock Exam Platform with OCR Migration..."
echo "==========================================================="

# Start docTR service in background
echo "Starting docTR service..."
cd ocr-service
source venv/bin/activate
python main.py &
DOCTR_PID=$!
cd ..

# Wait for docTR service to start
echo "Waiting for docTR service to initialize..."
sleep 10

# Check if docTR service is running
if curl -s http://localhost:8001/health > /dev/null; then
    echo "✅ docTR service is running"
else
    echo "⚠️ docTR service may not be running properly"
fi

# Start Express server
echo "Starting Express server..."
npm start

# Cleanup on exit
trap 'kill $DOCTR_PID' EXIT
EOF

# Make scripts executable
chmod +x start-doctr.sh
chmod +x start-all.sh

echo "✅ Startup scripts created:"
echo "  - start-doctr.sh: Start only docTR service"
echo "  - start-all.sh: Start both docTR and Express services"
echo

# Step 5: Test the setup
echo "🧪 Step 5: Testing the setup..."

# Test docTR service
echo "Testing docTR service startup..."
cd ocr-service
source venv/bin/activate
python -c "
import sys
try:
    import doctr
    print('✅ docTR imported successfully')
    print(f'   docTR version: {doctr.__version__}')
except ImportError as e:
    print(f'❌ docTR import failed: {e}')
    sys.exit(1)

try:
    import fastapi
    print('✅ FastAPI imported successfully')
except ImportError as e:
    print(f'❌ FastAPI import failed: {e}')
    sys.exit(1)

try:
    import uvicorn
    print('✅ Uvicorn imported successfully')
except ImportError as e:
    print(f'❌ Uvicorn import failed: {e}')
    sys.exit(1)

print('✅ All Python dependencies are working')
"

if [ $? -eq 0 ]; then
    echo "✅ docTR setup test passed"
else
    echo "❌ docTR setup test failed"
    exit 1
fi

cd ..
echo

# Final instructions
echo "🎉 OCR Migration Setup Complete!"
echo "=================================="
echo
echo "📋 Next Steps:"
echo "1. Update your .env file with actual API keys"
echo "2. Start the system using one of these methods:"
echo
echo "   Option A - Start everything together:"
echo "   ./start-all.sh"
echo
echo "   Option B - Start services separately:"
echo "   ./start-doctr.sh     # In terminal 1"
echo "   npm start            # In terminal 2"
echo
echo "🔍 Service URLs:"
echo "   Express Server: http://localhost:3001"
echo "   docTR Service:  http://localhost:8001"
echo "   OCR Status:     http://localhost:3001/api/ocr/status"
echo
echo "⚙️ Configuration:"
echo "   Primary OCR:    docTR (with Tesseract.js fallback)"
echo "   Switch to Tesseract: Set OCR_SERVICE=tesseract in .env"
echo
echo "✅ Your IELTS Mock Exam Platform is now ready with advanced OCR capabilities!"
echo
echo "🆘 If you encounter issues:"
echo "   - Check the docTR service logs for Python errors"
echo "   - Verify your .env configuration"
echo "   - Visit http://localhost:8001/health to test docTR service"
echo "   - Visit http://localhost:3001/api/ocr/status to check OCR status"
echo