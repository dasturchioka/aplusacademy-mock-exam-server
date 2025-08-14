# 🔄 OCR Migration: Tesseract.js → docTR

## Overview

Your IELTS Mock Exam Platform now supports **dual OCR capabilities** with seamless switching between Tesseract.js and docTR. This migration provides superior OCR accuracy while maintaining full backward compatibility.

## 🚀 What's New

### **Enhanced OCR Accuracy**

- **docTR**: Advanced deep learning OCR with 95%+ accuracy
- **Tesseract.js**: Reliable fallback with 85-90% accuracy
- **Automatic fallback**: System switches to Tesseract.js if docTR fails

### **Intelligent Service Architecture**

- **Health monitoring**: Real-time service status checking
- **Retry logic**: Automatic retry on failures
- **Performance metrics**: Confidence scores and processing times
- **Flexible configuration**: Easy switching between services

## 📋 Quick Start

### 1. **Run the Setup Script**

```bash
cd cd-mock-exam-server
chmod +x setup-ocr.sh
./setup-ocr.sh
```

### 2. **Configure Environment**

Update your `.env` file with your API keys:

```env
# OCR Service Configuration
OCR_SERVICE=doctr          # Primary service: 'doctr' or 'tesseract'
DOCTR_URL=http://localhost:8001  # docTR service URL
```

### 3. **Start the System**

```bash
# Option A: Start everything together
./start-all.sh

# Option B: Start separately
./start-doctr.sh    # Terminal 1
npm start           # Terminal 2
```

## 🏗️ Architecture

### **Service Layer**

```
┌─────────────────────────────────────────────────────────────┐
│                    Express.js Server                        │
│                                                             │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                OCR Service Layer                        │  │
│  │                                                         │  │
│  │  ┌─────────────────┐    ┌─────────────────────────────┐  │  │
│  │  │   docTR Service │    │   Tesseract.js Service     │  │  │
│  │  │  (Primary)      │    │   (Fallback)               │  │  │
│  │  │                 │    │                            │  │  │
│  │  │ • 95%+ accuracy │    │ • 85-90% accuracy          │  │  │
│  │  │ • GPU support   │    │ • CPU only                 │  │  │
│  │  │ • FastAPI       │    │ • In-process               │  │  │
│  │  │ • Port 8001     │    │ • Built-in                 │  │  │
│  │  └─────────────────┘    └─────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### **Processing Flow**

```
PDF Upload → Image Conversion → OCR Service → Text Cleaning → GPT-4 → JSON
                                     ↓
                           ┌─────────────────────┐
                           │   Health Check      │
                           │                     │
                           ├─ docTR Available?  │
                           │  ✅ Use docTR       │
                           │  ❌ Use Tesseract   │
                           │                     │
                           │   Retry Logic       │
                           │  ┌─ Attempt 1      │
                           │  ├─ Attempt 2      │
                           │  └─ Fallback       │
                           └─────────────────────┘
```

## 🎛️ Configuration Options

### **OCR Service Selection**

```env
# Use docTR as primary (recommended)
OCR_SERVICE=doctr

# Use Tesseract.js as primary
OCR_SERVICE=tesseract
```

### **Service URLs**

```env
# Local development
DOCTR_URL=http://localhost:8001

# Production deployment
DOCTR_URL=http://your-doctr-server:8001
```

### **Performance Tuning**

```javascript
// In ocrService.js
const ocrService = new OCRService({
	primaryService: 'doctr',
	fallbackService: 'tesseract',
	timeout: 30000, // 30 seconds
	maxRetries: 2, // 2 retry attempts
})
```

## 🔍 Monitoring & Debugging

### **Service Status**

```bash
# Check overall status
curl http://localhost:3001/api/ocr/status

# Check docTR health
curl http://localhost:8001/health
```

### **Expected Response**

```json
{
	"success": true,
	"primaryService": "doctr",
	"fallbackService": "tesseract",
	"services": {
		"docTR": {
			"available": true,
			"url": "http://localhost:8001"
		},
		"tesseract": {
			"available": true,
			"version": "tesseract.js 6.0.1"
		}
	}
}
```

## 📊 Performance Comparison

| Feature         | docTR          | Tesseract.js   |
| --------------- | -------------- | -------------- |
| **Accuracy**    | 95-98%         | 85-90%         |
| **Speed**       | Fast (GPU)     | Moderate (CPU) |
| **Languages**   | 50+            | 100+           |
| **Handwriting** | Excellent      | Poor           |
| **Setup**       | Python service | Built-in       |
| **Resources**   | Higher         | Lower          |

## 🔧 API Changes

### **New OCR Result Format**

```javascript
// Old Tesseract.js format
{
  data: { text: "...", confidence: 0.85 }
}

// New unified format
{
  text: "...",
  confidence: 0.95,
  processingTime: 1200,
  service: "docTR",
  metadata: {
    model: "docTR",
    filename: "page-1.png",
    file_size: 1024000
  }
}
```

### **Error Handling**

```javascript
try {
	const result = await ocrService.extractText(imagePath)
	console.log(`OCR by ${result.service}: ${result.confidence}`)
} catch (error) {
	console.error('OCR failed:', error.message)
	// Automatic fallback already attempted
}
```

## 🚀 Production Deployment

### **Docker Configuration**

```dockerfile
# In your Dockerfile
FROM node:18

# Install Python for docTR
RUN apt-get update && apt-get install -y python3 python3-pip

# Copy and install dependencies
COPY package*.json ./
RUN npm install

COPY ocr-service/ ./ocr-service/
RUN cd ocr-service && pip3 install -r requirements.txt

# Start services
CMD ["./start-all.sh"]
```

### **Environment Variables**

```env
# Production settings
NODE_ENV=production
OCR_SERVICE=doctr
DOCTR_URL=http://doctr-service:8001

# Scale settings
OCR_TIMEOUT=60000
OCR_MAX_RETRIES=3
```

### **Service Monitoring**

```javascript
// Add to your monitoring system
const ocrStatus = await fetch('/api/ocr/status')
const data = await ocrStatus.json()

if (!data.services.docTR.available) {
	// Alert: docTR service is down
	sendAlert('docTR service unavailable')
}
```

## 🐛 Troubleshooting

### **Common Issues**

#### **1. docTR Service Won't Start**

```bash
# Check Python installation
python3 --version

# Check dependencies
cd ocr-service
source venv/bin/activate
python -c "import doctr; print('OK')"

# Check port availability
lsof -i :8001
```

#### **2. OCR Accuracy Issues**

```bash
# Check image quality
file your-image.png
identify your-image.png

# Test with different density
convert input.pdf -density 400 output.png
```

#### **3. Performance Issues**

```bash
# Monitor memory usage
htop

# Check disk space
df -h

# Monitor network
netstat -an | grep 8001
```

### **Debug Mode**

```env
# Enable debug logging
NODE_ENV=development
DEBUG=ocr:*

# Test single image
curl -X POST -F "file=@test.png" http://localhost:8001/ocr
```

## 🔄 Rollback Instructions

### **Switch Back to Tesseract.js**

```env
# In .env file
OCR_SERVICE=tesseract
```

### **Disable docTR Service**

```bash
# Stop docTR service
pkill -f "python ocr_server.py"

# Restart Express server
npm restart
```

## 📈 Performance Metrics

### **Success Metrics**

- **Accuracy**: >95% text extraction accuracy
- **Speed**: <5 seconds per page processing
- **Availability**: 99.9% service uptime
- **Fallback**: <1% fallback usage rate

### **Monitoring Endpoints**

```bash
# Service health
GET /api/ocr/status

# Processing metrics
GET /api/metrics/ocr

# System status
GET /api/status
```

## 🎯 Migration Benefits

### **Before Migration**

- ✅ Single OCR service (Tesseract.js)
- ✅ Built-in processing
- ❌ 85-90% accuracy
- ❌ No fallback mechanism
- ❌ Limited performance tuning

### **After Migration**

- ✅ Dual OCR services (docTR + Tesseract.js)
- ✅ 95%+ accuracy with docTR
- ✅ Automatic fallback mechanism
- ✅ Health monitoring
- ✅ Performance metrics
- ✅ Flexible configuration
- ✅ Production-ready scaling

## 📝 Next Steps

1. **Monitor Performance**: Track accuracy improvements
2. **Optimize Configuration**: Tune timeout and retry settings
3. **Scale Infrastructure**: Add multiple docTR instances
4. **Implement Caching**: Cache OCR results for faster processing
5. **Add Monitoring**: Set up alerts for service health

## 🆘 Support

### **Getting Help**

- Check service logs: `tail -f logs/ocr-service.log`
- Visit health endpoints: `http://localhost:8001/health`
- Review configuration: `cat .env`

### **Reporting Issues**

Include in your bug report:

- Service status output
- Error logs
- Configuration details
- Sample images (if applicable)

---

**Your IELTS Mock Exam Platform is now equipped with state-of-the-art OCR capabilities! 🎉**
