const express = require('express')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const pdf = require('pdf-poppler')
const Tesseract = require('tesseract.js')
const OpenAI = require('openai')
const { createClient } = require('@supabase/supabase-js')
const cors = require('cors')
const sharp = require('sharp')
const { v4: uuidv4 } = require('uuid')
const getPrompt = require('../utils/getPrompt')
const OCRService = require('../services/ocrService')
const nodemailer = require("nodemailer")
require("dotenv").config()
const app = express()

const port = process.env.PORT || 3001

// Initialize OpenAI and Supabase clients
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Initialize OCR Service
const ocrService = new OCRService({
  primaryService: process.env.OCR_SERVICE || 'doctr',
  fallbackService: 'tesseract',
  doctrUrl: process.env.DOCTR_URL || 'http://localhost:8001',
  timeout: 30000,
  maxRetries: 2
})

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'https://novda-mock-exam.vercel.app', 'https://www.aplusacademy.uz', 'https://novda-mock-exam-demo.vercel.app', 'https://aplusacademy-mock-exam.vercel.app'], // your frontend port
  credentials: true
}))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Serve static files from uploads directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads')
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true })
    }
    cb(null, uploadDir)
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9)
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname))
  },
})

const upload = multer({ storage })

app.post('/api/upload-listening-audio', upload.array('audio', 10), (req, res) => {
  try {
    const fileUrls = req.files.map(file => `/uploads/${file.filename}`);
    res.json({ success: true, urls: fileUrls });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
});
// Note: cleanOCRText function moved to OCRService.cleanOCRText

// Helper function to merge duplicate parts
function mergeDuplicateParts(parts) {
  const mergedParts = []
  const partMap = new Map()

  parts.forEach(part => {
    if (partMap.has(part.part)) {
      // Merge questions from duplicate part
      const existingPart = partMap.get(part.part)
      // Ensure both parts have questions arrays before concatenating
      const existingQuestions = existingPart.questions || []
      const newQuestions = part.questions || []
      existingPart.questions = existingQuestions.concat(newQuestions)
    } else {
      // Ensure the part has a questions array
      partMap.set(part.part, { ...part, questions: part.questions || [] })
    }
  })

  // Convert map back to array, sorted by part number
  return Array.from(partMap.values()).sort((a, b) => a.part - b.part)
}

// Helper function to extract and upload images
async function extractAndUploadImages(imageFiles, testId) {
  const uploadedImages = []

  for (const imageFile of imageFiles) {
    try {
      // Detect if this is a map/diagram using OCR
      const ocrResult = await ocrService.extractText(imageFile)
      const ocrText = ocrResult.text

      const isMapImage = detectMapImage(ocrText)

      let processedImagePath = imageFile

      if (isMapImage) {
        // Crop the image to focus on the map area
        processedImagePath = await cropMapImage(imageFile, testId)
      }

      // Generate unique filename
      const filename = `${testId}-${uuidv4()}.png`
      const uploadPath = path.join(__dirname, 'uploads', filename)

      // Copy processed image to uploads directory
      fs.copyFileSync(processedImagePath, uploadPath)

      const imageUrl = `http://localhost:3001/uploads/${filename}`
      uploadedImages.push({
        url: imageUrl,
        filename: filename,
        isMap: isMapImage
      })

      // Clean up temporary processed image if it was created
      if (processedImagePath !== imageFile) {
        fs.unlinkSync(processedImagePath)
      }

    } catch (error) {
      console.error('Error processing image:', error)
    }
  }

  return uploadedImages
}

// Helper function to detect if an image contains a map
function detectMapImage(ocrText) {
  const mapKeywords = [
    'map', 'plan', 'diagram', 'layout', 'floor plan', 'museum', 'building',
    'entrance', 'exit', 'reception', 'café', 'shop', 'gallery', 'room',
    'north', 'south', 'east', 'west', 'stairs', 'lift', 'elevator',
    'parking', 'garden', 'path', 'route', 'direction', 'location'
  ]

  const lowerText = ocrText.toLowerCase()
  return mapKeywords.some(keyword => lowerText.includes(keyword))
}

// Helper function to crop map images intelligently
async function cropMapImage(imagePath, testId) {
  try {
    const image = sharp(imagePath)
    const metadata = await image.metadata()

    // Calculate crop dimensions (80% width, 60% height, centered)
    const cropWidth = Math.floor(metadata.width * 0.8)
    const cropHeight = Math.floor(metadata.height * 0.6)
    const left = Math.floor((metadata.width - cropWidth) / 2)
    const top = Math.floor((metadata.height - cropHeight) / 2)

    const croppedImagePath = path.join(__dirname, 'uploads', `temp-cropped-${testId}.png`)

    await image
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .png({ quality: 90 })
      .toFile(croppedImagePath)

    return croppedImagePath
  } catch (error) {
    console.error('Error cropping image:', error)
    return imagePath // Return original if cropping fails
  }
}

// Helper function to inject image objects into questions
function injectImageObjects(structure, uploadedImages) {
  if (!uploadedImages || uploadedImages.length === 0) return structure

  const modifiedStructure = JSON.parse(JSON.stringify(structure))

  // Find map-labelling questions and inject image before them
  modifiedStructure.parts.forEach(part => {
    const questions = part.questions || []
    const newQuestions = []

    for (let i = 0; i < questions.length; i++) {
      const question = questions[i]

      // Check if this is the first map-labelling question in this part
      if (question.type === 'map-labelling' && !newQuestions.some(q => q.type === 'image')) {
        // Find a map image to insert
        const mapImage = uploadedImages.find(img => img.isMap)
        if (mapImage) {
          // Insert image object before map-labelling questions
          newQuestions.push({
            type: 'image',
            questionId: `listening-${structure.test}-${part.part}-map`,
            url: mapImage.url,
            headline: 'Map'
          })
        }
      }

      newQuestions.push(question)
    }

    part.questions = newQuestions
  })

  return modifiedStructure
}

// Helper function to process base64 images from OpenAI response
async function processBase64Images(structure) {
  const modifiedStructure = JSON.parse(JSON.stringify(structure))

  for (const part of modifiedStructure.parts) {
    for (const question of part.questions) {
      if (question.type === "image" && question.base64) {
        try {
          // Convert base64 to buffer
          const base64Data = question.base64.replace(/^data:image\/png;base64,/, "")
          const buffer = Buffer.from(base64Data, 'base64')

          // Generate unique filename
          const filename = `${question.questionId || `image-${Date.now()}`}.png`
          const filepath = path.join(__dirname, 'uploads', filename)

          // Write file to uploads directory
          fs.writeFileSync(filepath, buffer)

          // Create URL and update question
          const imageUrl = `http://localhost:3001/uploads/${filename}`
          question.url = imageUrl
          delete question.base64

          console.log(`✅ Processed base64 image: ${filename}`)
        } catch (error) {
          console.error('❌ Failed to process base64 image:', error)
          // Keep base64 for manual handling
        }
      }
    }
  }

  return modifiedStructure
}

// Helper function to link matching questions with draggable variants
function linkMatchingQuestions(structure) {
  const modifiedStructure = JSON.parse(JSON.stringify(structure))

  modifiedStructure.parts.forEach(part => {
    let draggableVariants = []
    const questions = part.questions || []

    // Find divider with draggable variants
    const divider = questions.find(q => q.type === 'divider' && q.draggableVariants)
    if (divider && divider.draggableVariants) {
      draggableVariants = divider.draggableVariants
    }

    // Apply draggable variants to matching questions
    questions.forEach(question => {
      if (question.type === 'matching' && draggableVariants.length > 0) {
        question.draggableVariants = draggableVariants
      }
    })
  })

  return modifiedStructure
}

// Helper function to standardize question IDs (ensure hyphens, not en-dashes)
function standardizeQuestionIds(structure) {
  const modifiedStructure = JSON.parse(JSON.stringify(structure))

  modifiedStructure.parts.forEach(part => {
    part.questions.forEach(question => {
      if (question.questionId) {
        question.questionId = question.questionId.replace(/[–—]/g, '-')
      }
      if (question.numberRange) {
        question.numberRange = question.numberRange.replace(/[–—]/g, '-')
      }
    })
  })

  return modifiedStructure
}

// Enhanced post-processing validation functions
function validateAndFixStructure(structure) {
  console.log('🔧 Validating and fixing structure...')

  // Ensure basic structure exists
  if (!structure.test) structure.test = "1"
  if (!structure.section) structure.section = "Listening"
  if (!structure.parts || !Array.isArray(structure.parts)) {
    structure.parts = []
  }

  // Validate each part
  structure.parts.forEach((part, index) => {
    if (!part.part) part.part = index + 1
    if (!part.instructions) part.instructions = `Part ${part.part} instructions`
    if (!part.questionsRange) {
      const start = (part.part - 1) * 10 + 1
      const end = part.part * 10
      part.questionsRange = `${start}-${end}`
    }
    if (!part.questions || !Array.isArray(part.questions)) {
      part.questions = []
    }

    // Validate each question
    part.questions.forEach((question, qIndex) => {
      if (!question.questionId) {
        question.questionId = `listening-${structure.test}-${part.part}-${qIndex + 1}`
      }
      if (!question.number) {
        question.number = (part.part - 1) * 10 + qIndex + 1
      }
      if (!question.type) {
        question.type = autoDetectQuestionType(question)
      }
      if (!question.inputType) {
        question.inputType = getInputTypeForQuestionType(question.type)
      }
      if (!question.answerConstraints) {
        question.answerConstraints = getDefaultAnswerConstraints(question.type)
      }
      if (question.isInteractive === undefined) {
        question.isInteractive = true
      }
      if (!question.answer) {
        question.answer = { correct: "", accepted: [] }
      }
    })
  })

  console.log('✅ Structure validation complete')
  return structure
}

function autoDetectQuestionType(question) {
  const text = (question.text || question.questionText || '').toLowerCase()
  const instructions = (question.instructions || '').toLowerCase()

  // Type detection based on common patterns
  if (text.includes('____') || text.includes('...')) {
    if (instructions.includes('map') || instructions.includes('diagram') || instructions.includes('label')) {
      return 'map-labelling'
    }
    if (instructions.includes('form') || instructions.includes('notes') || instructions.includes('table')) {
      return 'form-fill'
    }
    return 'sentence-completion'
  }

  if (question.textList || question.options) {
    if (instructions.includes('choose two') || instructions.includes('choose three')) {
      return 'multi-select'
    }
    return 'multiple-choice'
  }

  if (question.draggableVariants || instructions.includes('match')) {
    return 'matching'
  }

  if (instructions.includes('short answer') || instructions.includes('no more than')) {
    return 'short-answer'
  }

  // Default fallback
  return 'form-fill'
}

function getInputTypeForQuestionType(type) {
  const typeMap = {
    'form-fill': 'text',
    'multiple-choice': 'radio',
    'multi-select': 'checkbox',
    'matching': 'drag',
    'map-labelling': 'text',
    'short-answer': 'text',
    'sentence-completion': 'text'
  }
  return typeMap[type] || 'text'
}

function getDefaultAnswerConstraints(type) {
  const constraintMap = {
    'form-fill': 'ONE WORD AND/OR A NUMBER',
    'multiple-choice': 'CHOOSE THE CORRECT LETTER A, B OR C',
    'multi-select': 'CHOOSE TWO LETTERS A-E',
    'matching': 'CHOOSE FROM THE BOX A-H',
    'map-labelling': 'LABEL FROM MAP A-H',
    'short-answer': 'NO MORE THAN THREE WORDS',
    'sentence-completion': 'ONE WORD ONLY'
  }
  return constraintMap[type] || 'ONE WORD AND/OR A NUMBER'
}

function enforceQuestionNumbering(structure) {
  console.log('🔢 Enforcing proper question numbering...')

  structure.parts.forEach((part, partIndex) => {
    part.questions.forEach((question, questionIndex) => {
      if (question.type !== 'divider' && question.type !== 'image') {
        const expectedNumber = (partIndex * 10) + questionIndex + 1
        question.number = expectedNumber

        // Update question ID to match
        if (question.questionId) {
          question.questionId = `listening-${structure.test}-${part.part}-${expectedNumber}`
        }
      }
    })
  })

  console.log('✅ Question numbering complete')
  return structure
}

function validateRequiredFields(structure) {
  console.log('🔍 Validating required fields...')

  const errors = []

  // Check main structure
  if (!structure.test) errors.push('Missing test number')
  if (!structure.section) errors.push('Missing section name')
  if (!structure.parts || !Array.isArray(structure.parts)) {
    errors.push('Missing or invalid parts array')
  }

  // Check each part
  structure.parts.forEach((part, partIndex) => {
    if (!part.part) errors.push(`Part ${partIndex}: Missing part number`)
    if (!part.instructions) errors.push(`Part ${partIndex}: Missing instructions`)
    if (!part.questionsRange) errors.push(`Part ${partIndex}: Missing questionsRange`)
    if (!part.questions || !Array.isArray(part.questions)) {
      errors.push(`Part ${partIndex}: Missing or invalid questions array`)
    }

    // Check each question
    part.questions.forEach((question, questionIndex) => {
      if (question.type === 'divider' || question.type === 'image') return

      if (!question.questionId) {
        errors.push(`Part ${partIndex}, Question ${questionIndex}: Missing questionId`)
      }
      if (!question.number) {
        errors.push(`Part ${partIndex}, Question ${questionIndex}: Missing number`)
      }
      if (!question.type) {
        errors.push(`Part ${partIndex}, Question ${questionIndex}: Missing type`)
      }
      if (!question.inputType) {
        errors.push(`Part ${partIndex}, Question ${questionIndex}: Missing inputType`)
      }
      if (question.isInteractive === undefined) {
        errors.push(`Part ${partIndex}, Question ${questionIndex}: Missing isInteractive`)
      }
      if (!question.answer) {
        errors.push(`Part ${partIndex}, Question ${questionIndex}: Missing answer object`)
      }
    })
  })

  if (errors.length > 0) {
    console.log('⚠️  Validation errors found:', errors)
  } else {
    console.log('✅ All required fields validated')
  }

  return { valid: errors.length === 0, errors }
}

// Main processing endpoint
app.post('/api/extract/listening', upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'audio', maxCount: 4 }
]), async (req, res) => {
  const tempDir = path.join(__dirname, 'uploads', `pdf-${Date.now()}`)

  try {
    // Create temporary directory
    fs.mkdirSync(tempDir, { recursive: true })

    const pdfFile = req.files['file'][0]
    const audioFiles = req.files['audio'] || []

    console.log('Processing PDF:', pdfFile.originalname)
    console.log('Audio files:', audioFiles.map(f => f.originalname))

    // Convert PDF to images
    const options = {
      format: 'png',
      out_dir: tempDir,
      out_prefix: 'page',
      page: null,
      density: 400 // Higher density for better OCR
    }

    await pdf.convert(pdfFile.path, options)

    // Get all generated images
    const imageFiles = fs.readdirSync(tempDir)
      .filter(file => file.startsWith('page-') && file.endsWith('.png'))
      .map(file => path.join(tempDir, file))

    console.log(`Generated ${imageFiles.length} images`)

    // Extract and upload images for maps/diagrams
    const uploadedImages = await extractAndUploadImages(imageFiles, `listening-${Date.now()}`)

    // Process each image with OCR
    let combinedText = ''
    for (const imageFile of imageFiles) {
      console.log(`Processing image: ${imageFile}`)

      const ocrResult = await ocrService.extractText(imageFile)
      const cleanedText = OCRService.cleanOCRText(ocrResult.text)
      combinedText += cleanedText + '\n\n'

      console.log(`✅ OCR completed using ${ocrResult.service} with ${ocrResult.confidence.toFixed(2)} confidence`)
    }

    console.log('Combined OCR text length:', combinedText.length)

    // Get the listening prompt
    const prompt = await getPrompt.getStrictSystemPrompt('listening')

    // Parse with GPT-4 (with retry logic)
    let structure
    let attempts = 0
    const maxAttempts = 3

    while (attempts < maxAttempts) {
      attempts++
      console.log(`GPT-4 attempt ${attempts}/${maxAttempts}`)

      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: combinedText }
          ],
          max_tokens: 8000, // GPT-4o has 128,000 token context window
          temperature: 0.1
        })

        const rawResponse = completion.choices[0]?.message?.content

        // Validate response
        if (!rawResponse) {
          console.error('Empty response from OpenAI')
          if (attempts === maxAttempts) {
            throw new Error('Empty response from OpenAI after all attempts')
          }
          continue
        }

        console.log('Raw GPT response length:', rawResponse.length)
        console.log('Raw GPT response preview:', rawResponse.substring(0, 200) + '...')

        // Parse JSON response with robust cleaning and fallback
        try {
          structure = OCRService.parseJsonSafely(rawResponse, `GPT-4 attempt ${attempts}`)
          console.log('Successfully parsed JSON structure')
          break // Success, exit retry loop
        } catch (parseError) {
          console.error(`JSON parse error (attempt ${attempts}):`, parseError)

          if (attempts === maxAttempts) {
            throw new Error(`Invalid JSON response from AI after ${maxAttempts} attempts: ${parseError.message}`)
          }

          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      } catch (apiError) {
        console.error(`OpenAI API error (attempt ${attempts}):`, apiError)

        if (attempts === maxAttempts) {
          throw new Error(`OpenAI API failed after ${maxAttempts} attempts: ${apiError.message}`)
        }

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }

    // Apply enhanced post-processing pipeline
    console.log('🚀 Starting enhanced post-processing pipeline...')

    // Step 1: Merge duplicate parts
    structure = mergeDuplicateParts(structure.parts ? structure.parts : [])
    structure = { ...structure, parts: structure }

    // Step 2: Validate and fix basic structure
    structure = validateAndFixStructure(structure)

    // Step 3: Inject image objects
    structure = injectImageObjects(structure, uploadedImages)

    // Step 4: Process base64 images from OpenAI
    structure = await processBase64Images(structure)

    // Step 5: Link matching questions with draggable variants
    structure = linkMatchingQuestions(structure)

    // Step 6: Standardize question IDs (ensure hyphens, not en-dashes)
    structure = standardizeQuestionIds(structure)

    // Step 7: Enforce proper question numbering
    structure = enforceQuestionNumbering(structure)

    // Step 8: Final validation
    const validation = validateRequiredFields(structure)
    if (!validation.valid) {
      console.log('⚠️  Structure validation failed:', validation.errors)
      // Continue processing but log errors for debugging
    }

    console.log('✅ Enhanced post-processing pipeline complete')

    // Clean up temporary files
    fs.rmSync(tempDir, { recursive: true, force: true })
    fs.unlinkSync(pdfFile.path)

    res.json({
      success: true,
      structure,
      uploadedImages: uploadedImages.map(img => ({
        url: img.url,
        filename: img.filename,
        isMap: img.isMap
      }))
    })

  } catch (error) {
    console.error('Processing error:', error)

    // Clean up on error
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }

    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Reading extraction endpoint
app.post('/api/extract/reading', upload.fields([
  { name: 'file', maxCount: 1 }
]), async (req, res) => {
  const tempDir = path.join(__dirname, 'uploads', `pdf-${Date.now()}`)

  try {
    // Create temporary directory
    fs.mkdirSync(tempDir, { recursive: true })

    const pdfFile = req.files['file'][0]

    console.log('Processing Reading PDF:', pdfFile.originalname)

    // Convert PDF to images
    const options = {
      format: 'png',
      out_dir: tempDir,
      out_prefix: 'page',
      page: null,
      density: 400 // Higher density for better OCR
    }

    await pdf.convert(pdfFile.path, options)

    // Get all generated images
    const imageFiles = fs.readdirSync(tempDir)
      .filter(file => file.startsWith('page-') && file.endsWith('.png'))
      .map(file => path.join(tempDir, file))

    console.log(`Generated ${imageFiles.length} images`)

    // Extract and upload images for diagrams/tables
    const uploadedImages = await extractAndUploadImages(imageFiles, `reading-${Date.now()}`)

    // Process each image with OCR
    let combinedText = ''
    for (const imageFile of imageFiles) {
      console.log(`Processing image: ${imageFile}`)

      const ocrResult = await ocrService.extractText(imageFile)
      const cleanedText = OCRService.cleanOCRText(ocrResult.text)
      combinedText += cleanedText + '\n\n'

      console.log(`✅ OCR completed using ${ocrResult.service} with ${ocrResult.confidence.toFixed(2)} confidence`)
    }

    console.log('Combined OCR text length:', combinedText.length)

    // Get the reading prompt
    const prompt = await getPrompt.getStrictSystemPrompt('reading')

    // Parse with GPT-4 (with retry logic)
    let structure
    let attempts = 0
    const maxAttempts = 3

    while (attempts < maxAttempts) {
      attempts++
      console.log(`GPT-4 attempt ${attempts}/${maxAttempts}`)

      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: combinedText }
          ],
          max_tokens: 8000,
          temperature: 0.1
        })

        const rawResponse = completion.choices[0]?.message?.content

        // Validate response
        if (!rawResponse) {
          console.error('Empty response from OpenAI')
          if (attempts === maxAttempts) {
            throw new Error('Empty response from OpenAI after all attempts')
          }
          continue
        }

        console.log('Raw GPT response length:', rawResponse.length)
        console.log('Raw GPT response preview:', rawResponse.substring(0, 200) + '...')

        // Parse JSON response with robust cleaning and fallback
        try {
          structure = OCRService.parseJsonSafely(rawResponse, `GPT-4 Reading attempt ${attempts}`)
          console.log('Successfully parsed JSON structure')
          break // Success, exit retry loop
        } catch (parseError) {
          console.error(`JSON parse error (attempt ${attempts}):`, parseError)

          if (attempts === maxAttempts) {
            throw new Error(`Invalid JSON response from AI after ${maxAttempts} attempts: ${parseError.message}`)
          }

          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      } catch (apiError) {
        console.error(`OpenAI API error (attempt ${attempts}):`, apiError)

        if (attempts === maxAttempts) {
          throw new Error(`OpenAI API failed after ${maxAttempts} attempts: ${apiError.message}`)
        }

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }

    // Apply enhanced post-processing pipeline for reading
    console.log('🚀 Starting enhanced post-processing pipeline for reading...')

    // Step 1: Merge duplicate parts
    structure = mergeDuplicateParts(structure.parts ? structure.parts : [])
    structure = { ...structure, parts: structure }

    // Step 2: Validate and fix basic structure
    structure = validateAndFixStructure(structure)

    // Step 3: Inject image objects
    structure = injectImageObjects(structure, uploadedImages)

    // Step 4: Process base64 images from OpenAI
    structure = await processBase64Images(structure)

    // Step 5: Link matching questions with draggable variants
    structure = linkMatchingQuestions(structure)

    // Step 6: Standardize question IDs (ensure hyphens, not en-dashes)
    structure = standardizeQuestionIds(structure)

    // Step 7: Enforce proper question numbering
    structure = enforceQuestionNumbering(structure)

    // Step 8: Final validation
    const validation = validateRequiredFields(structure)
    if (!validation.valid) {
      console.log('⚠️  Reading structure validation failed:', validation.errors)
      // Continue processing but log errors for debugging
    }

    console.log('✅ Enhanced post-processing pipeline for reading complete')

    // Clean up temporary files
    fs.rmSync(tempDir, { recursive: true, force: true })
    fs.unlinkSync(pdfFile.path)

    res.json({
      success: true,
      structure,
      uploadedImages: uploadedImages.map(img => ({
        url: img.url,
        filename: img.filename,
        isMap: img.isMap
      }))
    })

  } catch (error) {
    console.error('Reading processing error:', error)

    // Clean up on error
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }

    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Writing extraction endpoint
app.post('/api/extract/writing', upload.fields([
  { name: 'file', maxCount: 1 }
]), async (req, res) => {
  const tempDir = path.join(__dirname, 'uploads', `pdf-${Date.now()}`)

  try {
    // Create temporary directory
    fs.mkdirSync(tempDir, { recursive: true })

    const pdfFile = req.files['file'][0]

    console.log('Processing Writing PDF:', pdfFile.originalname)

    // Convert PDF to images
    const options = {
      format: 'png',
      out_dir: tempDir,
      out_prefix: 'page',
      page: null,
      density: 400 // Higher density for better OCR
    }

    await pdf.convert(pdfFile.path, options)

    // Get all generated images
    const imageFiles = fs.readdirSync(tempDir)
      .filter(file => file.startsWith('page-') && file.endsWith('.png'))
      .map(file => path.join(tempDir, file))

    console.log(`Generated ${imageFiles.length} images`)

    // Extract and upload images for Task 1 visuals (graphs, charts, etc.)
    const uploadedImages = await extractAndUploadImages(imageFiles, `writing-${Date.now()}`)

    // Process each image with OCR
    let combinedText = ''
    for (const imageFile of imageFiles) {
      console.log(`Processing image: ${imageFile}`)

      const ocrResult = await ocrService.extractText(imageFile)
      const cleanedText = OCRService.cleanOCRText(ocrResult.text)
      combinedText += cleanedText + '\n\n'

      console.log(`✅ OCR completed using ${ocrResult.service} with ${ocrResult.confidence.toFixed(2)} confidence`)
    }

    console.log('Combined OCR text length:', combinedText.length)

    // Get the writing prompt
    const prompt = await getPrompt.getStrictSystemPrompt('writing')

    // Parse with GPT-4 (with retry logic)
    let structure
    let attempts = 0
    const maxAttempts = 3

    while (attempts < maxAttempts) {
      attempts++
      console.log(`GPT-4 attempt ${attempts}/${maxAttempts}`)

      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: combinedText }
          ],
          max_tokens: 8000,
          temperature: 0.1
        })

        const rawResponse = completion.choices[0]?.message?.content

        // Validate response
        if (!rawResponse) {
          console.error('Empty response from OpenAI')
          if (attempts === maxAttempts) {
            throw new Error('Empty response from OpenAI after all attempts')
          }
          continue
        }

        console.log('Raw GPT response length:', rawResponse.length)
        console.log('Raw GPT response preview:', rawResponse.substring(0, 200) + '...')

        // Parse JSON response with robust cleaning and fallback
        try {
          structure = OCRService.parseJsonSafely(rawResponse, `GPT-4 Writing attempt ${attempts}`)
          console.log('Successfully parsed JSON structure')
          break // Success, exit retry loop
        } catch (parseError) {
          console.error(`JSON parse error (attempt ${attempts}):`, parseError)

          if (attempts === maxAttempts) {
            throw new Error(`Invalid JSON response from AI after ${maxAttempts} attempts: ${parseError.message}`)
          }

          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      } catch (apiError) {
        console.error(`OpenAI API error (attempt ${attempts}):`, apiError)

        if (attempts === maxAttempts) {
          throw new Error(`OpenAI API failed after ${maxAttempts} attempts: ${apiError.message}`)
        }

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }

    // Apply enhanced post-processing pipeline for writing
    console.log('🚀 Starting enhanced post-processing pipeline for writing...')

    // Step 1: Merge duplicate parts
    structure = mergeDuplicateParts(structure.parts ? structure.parts : [])
    structure = { ...structure, parts: structure }

    // Step 2: Validate and fix basic structure
    structure = validateAndFixStructure(structure)

    // Step 3: Inject image objects (for Task 1 visuals)
    structure = injectImageObjects(structure, uploadedImages)

    // Step 4: Process base64 images from OpenAI
    structure = await processBase64Images(structure)

    // Step 5: Standardize question IDs (ensure hyphens, not en-dashes)
    structure = standardizeQuestionIds(structure)

    // Step 6: Final validation
    const validation = validateRequiredFields(structure)
    if (!validation.valid) {
      console.log('⚠️  Writing structure validation failed:', validation.errors)
      // Continue processing but log errors for debugging
    }

    console.log('✅ Enhanced post-processing pipeline for writing complete')

    // Clean up temporary files
    fs.rmSync(tempDir, { recursive: true, force: true })
    fs.unlinkSync(pdfFile.path)

    res.json({
      success: true,
      structure,
      uploadedImages: uploadedImages.map(img => ({
        url: img.url,
        filename: img.filename,
        isMap: img.isMap
      }))
    })

  } catch (error) {
    console.error('Writing processing error:', error)

    // Clean up on error
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }

    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Save listening structure endpoint
app.post('/api/tests/:id/listening/save', async (req, res) => {
  try {
    const { id } = req.params
    const { structure } = req.body

    const { data, error } = await supabase
      .from('tests')
      .update({
        listening: structure,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)

    if (error) {
      throw error
    }

    res.json({
      success: true,
      message: 'Listening structure saved successfully'
    })

  } catch (error) {
    console.error('Save error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Create new test endpoint
app.post('/api/tests', async (req, res) => {
  try {
    const { title, edition, test_number, section, listening, reading, writing, listening_audios } = req.body

    if (!title || !edition || !test_number || !section) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: title, edition, test_number, section'
      });
    }

    // 🔍 Step 1: Get existing row (if any)
    const { data: existing, error: fetchError } = await supabase
      .from('tests')
      .select('*')
      .eq('edition', edition.trim())
      .eq('test_number', parseInt(test_number))
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') throw fetchError; // skip if not found

    // 🔧 Step 2: Merge current section with existing data
    const merged = {
      title: title.trim(),
      edition: edition.trim(),
      test_number: parseInt(test_number),
      section,
      listening: section === 'Listening' ? listening : existing?.listening ?? null,
      reading: section === 'Reading' ? reading : existing?.reading ?? null,
      writing: section === 'Writing' ? writing : existing?.writing ?? null,
      listening_audios: section === 'Listening' ? listening_audios : existing?.listening_audios ?? null,
    };

    // 💾 Step 3: Upsert full merged object
    const { data, error } = await supabase
      .from('tests')
      .upsert([merged], { onConflict: 'edition,test_number' })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, test: data });
  } catch (error) {
    console.error('Create test error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again.',
    });
  }
});

// Delete test endpoint
app.delete('/api/tests/:id', async (req, res) => {
  try {
    const { id } = req.params

    // Check if test exists
    const { data: existingTest, error: checkError } = await supabase
      .from('tests')
      .select('*')
      .eq('id', id)
      .single()

    if (checkError || !existingTest) {
      return res.status(404).json({
        success: false,
        message: 'Test not found'
      })
    }

    // Delete the test
    const { error } = await supabase
      .from('tests')
      .delete()
      .eq('id', id)

    if (error) throw error

    res.json({
      success: true,
      message: 'Test deleted successfully'
    })
  } catch (error) {
    console.error('Delete test error:', error)
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again.'
    })
  }
})

// Get all tests endpoint
app.get('/api/tests', async (req, res) => {
  try {
    const includeSections = req.query['include-sections'] === 'true'
    let query

    if (includeSections) {
      query = supabase.from('tests').select('*')
    } else {
      query = supabase
        .from('tests')
        .select('id, title, edition, test_number, section, created_at, updated_at, listening_audios')
    }

    const { data, error } = await query

    const { data: activeTestRow } = await supabase
      .from('active_tests')
      .select('test_id')
      .eq('is_active', true)
      .maybeSingle()

    if (error) throw error

    res.json({
      success: true,
      tests: data,
      activeTestId: activeTestRow?.test_id || null
    })

  } catch (error) {
    console.error('Get tests error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})


// Get single test endpoint
app.get('/api/tests/:id', async (req, res) => {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from('tests')
      .select('*')
      .eq('id', id)
      .single()

    if (error) {
      throw error
    }

    res.json({
      success: true,
      test: data
    })

  } catch (error) {
    console.error('Get test error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Update test endpoint
app.put('/api/tests/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { title, edition, test_number, listening, reading, writing } = req.body

    // Check if test exists
    const { data: existingTest, error: checkError } = await supabase
      .from('tests')
      .select('*')
      .eq('id', id)
      .single()

    if (checkError || !existingTest) {
      return res.status(404).json({
        success: false,
        error: 'Test not found'
      })
    }

    // Update the test
    const { data, error } = await supabase
      .from('tests')
      .update({
        title: title || existingTest.title,
        edition: edition || existingTest.edition,
        test_number: test_number || existingTest.test_number,
        listening: listening || existingTest.listening,
        reading: reading || existingTest.reading,
        writing: writing || existingTest.writing,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    res.json({
      success: true,
      test: data,
      message: 'Test updated successfully'
    })

  } catch (error) {
    console.error('Update test error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

app.post('/api/admin/set-global-active-test', async (req, res) => {
  const { test_id, admin_id } = req.body

  try {
    // 1. Deactivate all previous
    const { error: updateError } = await supabase
      .from('active_tests')
      .update({ is_active: false })
      .neq('test_id', test_id)

    if (updateError) throw updateError

    // 2. Upsert active test
    const { error: upsertError } = await supabase
      .from('active_tests')
      .upsert({
        test_id,
        is_active: true,
        created_by: admin_id, // 👈 use this
      }, { onConflict: ['test_id'] })

    if (upsertError) throw upsertError

    return res.json({ success: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, message: 'Failed to set global active test' })
  }
})


app.post('/api/admin/assign-test-to-user', async (req, res) => {
  const { user_id, test_id, admin_id } = req.body

  try {
    // First, delete any existing test assignments for this user to ensure only one active assignment
    const { error: deleteError } = await supabase
      .from('user_assigned_tests')
      .delete()
      .eq('user_id', user_id)

    if (deleteError) throw deleteError

    // Then insert the new test assignment
    const { error: insertError } = await supabase
      .from('user_assigned_tests')
      .insert({
        user_id,
        test_id,
        assigned_by: admin_id,
      })

    if (insertError) throw insertError

    return res.json({ success: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, message: 'Failed to assign test to user' })
  }
})



// Enhanced image upload endpoint with better validation
app.post('/api/upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      })
    }

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif']
    if (!allowedTypes.includes(req.file.mimetype)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid file type. Only JPEG, PNG, and GIF images are allowed.'
      })
    }

    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024 // 5MB in bytes
    if (req.file.size > maxSize) {
      return res.status(400).json({
        success: false,
        error: 'File too large. Maximum size is 5MB.'
      })
    }

    // Validate that it's a real file, not a base64 blob
    if (req.file.originalname.includes('blob') || req.file.originalname.includes('base64')) {
      return res.status(400).json({
        success: false,
        error: 'Base64 blobs are not allowed. Please upload a real image file.'
      })
    }

    // Extract metadata from request
    const { questionId, test, section, part } = req.body

    // Generate proper filename based on IELTS structure
    const timestamp = Date.now()
    const extension = path.extname(req.file.originalname) || '.png'
    let finalFileName

    if (questionId && test && section && part) {
      finalFileName = `${section.toLowerCase()}-${test}-${part}-${questionId}${extension}`
    } else {
      finalFileName = `image-${timestamp}${extension}`
    }

    // Move file to proper location
    const finalPath = path.join(__dirname, 'uploads', finalFileName)
    fs.renameSync(req.file.path, finalPath)

    // Generate URL
    const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${finalFileName}`

    // Store metadata
    const metadata = {
      questionId,
      test,
      section,
      part,
      originalName: req.file.originalname,
      filename: finalFileName,
      path: finalPath,
      size: req.file.size,
      mimetype: req.file.mimetype,
      uploadedAt: new Date().toISOString()
    }

    console.log('✅ Image uploaded successfully:', metadata)

    res.json({
      success: true,
      url: imageUrl,
      filename: finalFileName,
      metadata
    })

  } catch (error) {
    console.error('❌ Upload image error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Delete image endpoint
app.delete('/api/delete-image', async (req, res) => {
  try {
    const { questionId, test, section, part } = req.body

    if (!questionId) {
      return res.status(400).json({ success: false, error: 'Question ID required' })
    }

    const glob = require('glob')

    // Generate potential file patterns
    const patterns = [
      `${section.toLowerCase()}-${test}-${section.toLowerCase()}-${part}-${questionId}.*`,
      `${section.toLowerCase()}-${test}-${part}-${questionId}.*`,
      `${questionId}.*`
    ]

    let deletedFiles = []

    for (const pattern of patterns) {
      const files = glob.sync(path.join(__dirname, 'uploads', pattern))
      for (const file of files) {
        try {
          fs.unlinkSync(file)
          deletedFiles.push(path.basename(file))
          console.log('🗑️ Deleted image:', path.basename(file))
        } catch (error) {
          console.warn('Failed to delete file:', file, error.message)
        }
      }
    }

    res.json({
      success: true,
      deletedFiles,
      message: `Deleted ${deletedFiles.length} files`
    })
  } catch (error) {
    console.error('Delete error:', error)
    res.status(500).json({ success: false, error: 'Delete failed' })
  }
})

// Batch create questions endpoint
app.post('/api/questions/batch-create', async (req, res) => {
  try {
    const { test, section, type, questions, draggableVariants } = req.body

    console.log('🔄 Batch creating questions:', {
      test,
      section,
      type,
      questionCount: questions?.length,
      hasVariants: !!draggableVariants
    })

    // Validate input
    if (!test || !section || !type || !questions || !Array.isArray(questions)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: test, section, type, questions array'
      })
    }

    // Validate questions array
    for (const question of questions) {
      if (!question.number && !question.numberRange) {
        return res.status(400).json({
          success: false,
          error: 'Each question must have either number or numberRange'
        })
      }
      if (!question.inputType) {
        return res.status(400).json({
          success: false,
          error: 'Each question must have inputType'
        })
      }
    }

    // Generate question IDs and process questions
    const processedQuestions = questions.map(question => {
      const questionId = `${section.toLowerCase()}-${test}-${question.part || 1}-${question.number || question.numberRange}`

      return {
        questionId,
        type,
        inputType: question.inputType,
        number: question.number,
        numberRange: question.numberRange,
        text: question.text || question.questionText || '',
        questionText: question.questionText || question.text || '',
        answerConstraints: question.answerConstraints || '',
        maxSelectableAnswers: question.maxSelectableAnswers,
        isInteractive: true,
        answer: question.answer || {
          correct: '',
          accepted: []
        },
        draggableVariants: type === 'matching' ? draggableVariants : undefined
      }
    })

    console.log('✅ Processed questions:', processedQuestions.length)

    res.json({
      success: true,
      questions: processedQuestions,
      message: `Successfully created ${processedQuestions.length} questions`
    })

  } catch (error) {
    console.error('Batch create error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Individual question create endpoint
app.post('/api/questions/create', async (req, res) => {
  try {
    const { test, section, questions, part, draggableVariants, imageUrl } = req.body

    console.log('🔄 Creating individual questions:', {
      test,
      section,
      part,
      questionCount: questions?.length,
      hasVariants: !!draggableVariants,
      hasImage: !!imageUrl
    })

    // Validate input
    if (!test || !section || !questions || !Array.isArray(questions)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: test, section, questions array'
      })
    }

    // Process questions with proper validation
    const processedQuestions = questions.map(question => {
      // Generate proper questionId
      const questionId = `${section.toLowerCase()}-${test}-${part}-${question.number || Date.now()}`

      // Validate required fields
      if (!question.type) {
        throw new Error('Question type is required')
      }
      if (!question.inputType) {
        throw new Error('Input type is required')
      }
      if (!question.answer?.correct) {
        throw new Error('Correct answer is required')
      }

      return {
        questionId,
        type: question.type,
        inputType: question.inputType,
        number: question.number,
        text: question.text || question.questionText || '',
        questionText: question.questionText || question.text || '',
        answerConstraints: question.answerConstraints || '',
        maxSelectableAnswers: question.maxSelectableAnswers,
        isInteractive: true,
        answer: question.answer,
        draggableVariants: question.type === 'matching' ? draggableVariants : undefined,
        url: question.type === 'map-labelling' ? imageUrl : undefined
      }
    })

    console.log('✅ Individual questions created:', processedQuestions.length)

    res.json({
      success: true,
      questions: processedQuestions,
      message: `Successfully created ${processedQuestions.length} questions`
    })

  } catch (error) {
    console.error('❌ Create questions error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// User Management Endpoints
app.post('/api/users', async (req, res) => {
  try {
    const { full_name, email } = req.body

    // Generate 8-digit ID
    const id = Math.floor(10_000_000 + Math.random() * 90_000_000).toString()



    const { data, error } = await supabase
      .from('users')
      .insert([{ id, full_name, email }])
      .select()

    if (error) throw error

    res.json({
      success: true,
      user: data[0]
    })
  } catch (error) {
    console.error('Create user error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

app.get("/api/users/count", async (req, res) => {
  try {
    const { error, data } = await supabase.from("users").select("id")

    if (error) {
      return res.status(400).json(error)
    }

    return res.json({ success: true, count: data.length  })
  } catch (error) {
    console.error('Get users count error:', error)
    return res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

app.get('/api/users', async (req, res) => {
  const { offset = 0, limit = 10, search = '' } = req.query;

  try {
    let query = supabase
      .from('users_search_view')
      .select('*', { count: 'exact' });

    if (search && search.trim()) {
      const searchTerm = search.trim();

      query = query.or(`full_name.ilike.%${searchTerm}%,email.ilike.%${searchTerm}%,id.ilike.%${searchTerm}%`);
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) throw error;

    res.json({
      success: true,
      users: data || [],
      total: count || 0,
      offset: parseInt(offset),
      limit: parseInt(limit),
      search: search || '',
    });
  } catch (error) {
    console.error('Users fetch error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// Delete user endpoint
app.delete('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params

    // Check if user exists
    const { data: existingUser, error: checkError } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .single()

    if (checkError || !existingUser) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      })
    }

    // Don't allow deleting admin users
    if (existingUser.role === 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Cannot delete admin users'
      })
    }

    // Delete the user
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', id)

    if (error) throw error

    res.json({
      success: true,
      message: 'User deleted successfully'
    })
  } catch (error) {
    console.error('Delete user error:', error)
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again.'
    })
  }
})

// Exam Entry Approval Endpoints
app.post('/api/users/approve-entry', async (req, res) => {
  try {
    const { approval_id, action, approved_by } = req.body

    // Validate action
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid action. Must be approve or reject'
      })
    }

    // Determine status based on action
    const status = action === 'approve' ? 'approved' : 'rejected'

    const { data, error } = await supabase
      .from('exam_entry_approvals')
      .update({
        status: status,
        approved_by,
        approved_at: new Date().toISOString()
      })
      .eq('id', approval_id)
      .eq('status', 'pending')
      .select()

    if (error) throw error

    if (data.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Approval not found or already processed'
      })
    }

    res.json({
      success: true,
      approval: data[0]
    })
  } catch (error) {
    console.error('Approve entry error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

app.post("/api/users/send-approval", async (req, res) => {
  try {
    const { studentId } = req.body

    // Check if user exists
    const { data: existStudent, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("id", studentId)
      .single()

    if (userError || !existStudent) {
      return res.status(404).json({
        approved: false,
        message: "Your ID is not found on our system, try again!"
      })
    }

    // Check if user already has an approval record
    const { data: existingApproval, error: approvalError } = await supabase
      .from("exam_entry_approvals")
      .select("*")
      .eq("user_id", studentId)
      .single()

    if (approvalError && approvalError.code !== 'PGRST116') {
      throw approvalError
    }

    // If no existing approval, create one
    if (!existingApproval) {
      const { error: insertError } = await supabase
        .from("exam_entry_approvals")
        .insert({
          user_id: studentId,
          status: 'pending'
        })

      if (insertError) throw insertError

      return res.json({
        approved: false,
        message: "Request submitted. Please wait for admin approval."
      })
    }

    // Return approval status
    return res.json({
      approved: existingApproval.status === 'approved',
      message: existingApproval.status === 'approved'
        ? "You are approved! Redirecting to exam..."
        : "Please wait for admin approval."
    })

  } catch (error) {
    console.error('Send approval error:', error)
    res.status(500).json({
      approved: false,
      message: "Server error. Please try again."
    })
  }
})

app.get('/api/approvals', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('exam_entry_approvals')
      .select(`
        *,
        users!exam_entry_approvals_user_id_fkey(full_name, email)
      `)
      .order('created_at', { ascending: false })

    if (error) throw error

    res.json({
      success: true,
      approvals: data
    })
  } catch (error) {
    console.error('Get approvals error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Test Management Endpoints
app.post('/api/tests/active', async (req, res) => {
  try {
    const { test_id, created_by } = req.body

    // First, deactivate any existing active tests
    await supabase
      .from('active_tests')
      .update({ is_active: false })
      .eq('is_active', true)

    // Then create new active test
    const { data, error } = await supabase
      .from('active_tests')
      .insert([{ test_id, created_by, is_active: true }])
      .select()

    if (error) throw error

    res.json({
      success: true,
      active_test: data[0]
    })
  } catch (error) {
    console.error('Set active test error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

app.get('/api/tests/active', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('active_tests')
      .select(`
        *,
        tests(*)
      `)
      .eq('is_active', true)
      .single()

    if (error && error.code !== 'PGRST116') throw error

    res.json({
      success: true,
      active_test: data
    })
  } catch (error) {
    console.error('Get active test error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// User Assigned Tests Endpoints
app.post('/api/user-assigned-tests', async (req, res) => {
  try {
    const { user_id, test_id, assigned_by } = req.body

    const { data, error } = await supabase
      .from('user_assigned_tests')
      .insert([{ user_id, test_id, assigned_by }])
      .select()

    if (error) throw error

    res.json({
      success: true,
      assignment: data[0]
    })
  } catch (error) {
    console.error('Assign test error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

app.get('/api/user-assigned-tests/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params

    const { data, error } = await supabase
      .from('user_assigned_tests')
      .select(`
        *,
        tests(*)
      `)
      .eq('user_id', user_id)

    if (error) throw error

    res.json({
      success: true,
      assigned_tests: data
    })
  } catch (error) {
    console.error('Get assigned tests error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Delete user assigned test
app.delete('/api/user-assigned-tests/:user_id/:test_id', async (req, res) => {
  try {
    const { user_id, test_id } = req.params

    const { data, error } = await supabase
      .from('user_assigned_tests')
      .delete()
      .eq('user_id', user_id)
      .eq('test_id', test_id)
      .select()

    if (error) throw error

    res.json({
      success: true,
      deleted: data[0] || null,
      message: 'Test assignment removed successfully'
    })
  } catch (error) {
    console.error('Delete user assignment error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Delete exam entry approval (called when writing section is completed)
app.delete('/api/exam-entry-approvals/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params

    const { data, error } = await supabase
      .from('exam_entry_approvals')
      .delete()
      .eq('user_id', user_id)
      .select()

    if (error) throw error

    res.json({
      success: true,
      deleted: data,
      message: 'Exam entry approval deleted successfully'
    })
  } catch (error) {
    console.error('Delete exam entry approval error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Results Management Endpoints
app.post('/api/results', async (req, res) => {
  try {

    const {
      results,
      listening_score,
      reading_score,
      writing_score,
      overall_score, exam_taker_id, test_id
    } = req.body

    const { data, error } = await supabase
      .from('results')
      .insert([{
        exam_taker_id,
        test_id,
        results,
        listening_score,
        reading_score,
        writing_score,
        overall_score
      }])
      .select()

    if (error) throw error

    res.json({
      success: true,
      result: data[0]
    })
  } catch (error) {
    console.error('Save results error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

app.get("/api/results/count", async (req, res) => {
  try {
    const { error, data } = await supabase.from("results").select("id")

    if (error) {
      return res.status(400).json(error)
    }

    return res.json({ success: true, count: data.length })
  } catch (error) {
    console.error('Get results count error:', error)
    return res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

app.get('/api/results', async (req, res) => {
  const { offset = 0, limit = 10, search = '' } = req.query

  try {
    let query = supabase
      .from('results_search_view')
      .select('*', { count: 'exact' })

    if (search && search.trim()) {
      const searchTerm = `%${search.trim()}%`

      query = query.or(
        `result_id_text.ilike.${searchTerm},exam_taker_id_text.ilike.${searchTerm},test_id_text.ilike.${searchTerm},full_name.ilike.${searchTerm},email.ilike.${searchTerm},title.ilike.${searchTerm},edition.ilike.${searchTerm}`
      )
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1)

    if (error) {
      console.error('Results query error:', error)
      throw error
    }

    res.json({
      success: true,
      results: data || [],
      total: count || 0,
      offset: parseInt(offset),
      limit: parseInt(limit),
      search: search || '',
    })
  } catch (error) {
    console.error('Get results error:', error)
    res.status(500).json({
      success: false,
      error: error.message,
    })
  }
})

app.get('/api/results/user/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params

    const { data, error } = await supabase
      .from('results')
      .select(`
        *,
        tests(title, edition, test_number)
      `)
      .eq('exam_taker_id', user_id)
      .order('taken_date', { ascending: false })

    if (error) throw error

    res.json({
      success: true,
      results: data
    })
  } catch (error) {
    console.error('Get user results error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Update result with scores and grading information
app.patch('/api/results/:resultId/grade', async (req, res) => {
  try {
    const { resultId } = req.params
    const {
      results,
      listening_score,
      reading_score,
      writing_score,
      speaking_score,
      overall_score,
      reviewed_by
    } = req.body

    const updateData = {
      reviewed_by,
      reviewed_at: new Date().toISOString()
    }

    // Add scores if provided
    if (listening_score !== undefined) updateData.listening_score = listening_score
    if (reading_score !== undefined) updateData.reading_score = reading_score
    if (writing_score !== undefined) updateData.writing_score = writing_score
    if (speaking_score !== undefined) updateData.speaking_score = speaking_score
    if (overall_score !== undefined) updateData.overall_score = overall_score

    // Add updated results if provided
    if (results !== undefined) updateData.results = results

    const { data, error } = await supabase
      .from('results')
      .update(updateData)
      .eq('id', resultId)
      .select(`
        *,
        users!results_exam_taker_id_fkey(id, full_name, email),
        tests!results_test_id_fkey(id, title, edition)
      `, { count: 'exact' })

    if (error) throw error

    res.json({
      success: true,
      result: data[0]
    })
  } catch (error) {
    console.error('Grade result error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Send results email to exam taker
app.post('/api/results/:resultId/send-email', async (req, res) => {
  try {
    const { resultId } = req.params

    // First get the result data
    const { data: result, error: fetchError } = await supabase
      .from('results')
      .select(`
        *,
        users!results_exam_taker_id_fkey(full_name, email),
        tests!results_test_id_fkey(title, edition)
      `)
      .eq('id', resultId)
      .single()

    if (fetchError) throw fetchError

    // const transporter = nodemailer.createTransport({
    //   host: 'smtp.resend.com',
    //   secure: true,
    //   port: 465,
    //   auth: {
    //     user: 'resend',
    //     pass: 're_xxxxxxxxx',
    //   },
    // });

    // const info = await transporter.sendMail({
    //   from: 'onboarding@resend.dev',
    //   to: 'delivered@resend.dev',
    //   subject: 'Hello World',
    //   html: `
    //   <p><strong>Aplusacademy IELTS Mock Result</strong></p>
    //   <p>Date: <strong>${mockExamDate}</strong></p>
    //   <p><strong>${studentName}</strong>, here are your scores:</p>
    //   <ul>
    //     <li>Listening: ${listening}</li>
    //     <li>Reading: ${reading}</li>
    //     <li>Writing: ${writing}</li>
    //     <li>Speaking: ${speaking}</li>
    //     <li><strong>Overall Band: ${overall}</strong></li>
    //   </ul>
    //   `,
    // });
    function formatDate(isoString) {
      const date = new Date(isoString);
      const options = {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Tashkent',
        hour12: false
      };
      return date.toLocaleString('en-US', options);
    }

    const formattedDate = formatDate(result.created_at);
    // Call the Supabase edge function to send email
    const emailResponse = await fetch(process.env.SEND_EMAIL_FN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        resultId: result.id,
        examTakerId: result.exam_taker_id,
        studentName: result.users.full_name,
        studentEmail: result.users.email,
        testTitle: result.tests.title,
        mockExamDate: formattedDate,
        listening: result.listening_score,
        reading: result.reading_score,
        writing: result.writing_score,
        speaking: result.speaking_score,
        overall: result.overall_score
      })
    })

    if (!emailResponse.ok) {
      throw new Error('Failed to send email via edge function')
    }

    // Update the result to mark email as sent
    const { data, error } = await supabase
      .from('results')
      .update({ email_sent: true })
      .eq('id', resultId)
      .select()

    if (error) throw error

    console.log(emailResponse);


    res.json({
      success: true,
      result: data[0],
      message: 'Email sent successfully'
    })
  } catch (error) {
    console.error('Send email error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// SectionCompletion API endpoints
// Create new result endpoint
app.post('/api/results/create', async (req, res) => {
  try {
    const { exam_taker_id, test_id, results } = req.body

    if (!exam_taker_id || !test_id || !results) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: exam_taker_id, test_id, results'
      })
    }

    const { data, error } = await supabase
      .from('results')
      .insert([{
        exam_taker_id,
        test_id,
        results,
        taken_date: new Date().toISOString().split('T')[0],
        listening_score: null,
        reading_score: null,
        writing_score: null,
        overall_score: null
      }])
      .select()
      .single()

    if (error) throw error

    res.json({
      success: true,
      resultId: data.id,
      result: data
    })
  } catch (error) {
    console.error('Create result error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Get specific result endpoint with full details
app.get('/api/results/:resultId', async (req, res) => {
  try {
    const { resultId } = req.params
    console.log('Fetching result with ID:', resultId)

    const { data, error } = await supabase
      .from('results')
      .select(`
        *,
        users!results_exam_taker_id_fkey(id, full_name, email),
        tests!results_test_id_fkey(id, title, edition)
      `)
      .eq('id', resultId)
      .single()

    if (error) {
      console.error('Supabase error:', error)
      if (error.code === 'PGRST116') {
        // No rows returned
        return res.status(404).json({
          success: false,
          error: 'Result not found'
        })
      }
      throw error
    }

    if (!data) {
      console.log('No data returned for result ID:', resultId)
      return res.status(404).json({
        success: false,
        error: 'Result not found'
      })
    }

    console.log('Result found:', data.id)
    res.json({
      success: true,
      result: data
    })
  } catch (error) {
    console.error('Get result error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

app.put('/api/results/:resultId', async (req, res) => {
  try {
    const { resultId } = req.params
    const { results: newSections } = req.body

    if (
      !Array.isArray(newSections) ||
      newSections.some(section => typeof section !== 'object' || Array.isArray(section))
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid "results" field: must be an array of objects like [{ Listening: [...] }, { Reading: [...] }]',
      })
    }

    // 1. Get existing result row
    const { data: existingResult, error: fetchError } = await supabase
      .from('results')
      .select('results')
      .eq('id', resultId)
      .single()

    if (fetchError) throw fetchError

    let existingResults = existingResult.results || []

    // 2. Merge logic — remove old sections if they exist, then add new ones
    for (const sectionObj of newSections) {
      const sectionName = Object.keys(sectionObj)[0]
      const sectionData = sectionObj[sectionName]

      // Remove old section with the same name
      existingResults = existingResults.filter(section => !section[sectionName])

      // Add new section
      existingResults.push({ [sectionName]: sectionData })
    }

    // 3. Update the row in DB
    const { data, error } = await supabase
      .from('results')
      .update({
        results: existingResults,
        updated_at: new Date().toISOString(),
      })
      .eq('id', resultId)
      .select()
      .single()

    if (error) throw error

    res.json({
      success: true,
      result: data,
    })
  } catch (error) {
    console.error('Update result error:', error)
    res.status(500).json({
      success: false,
      error: error.message,
    })
  }
})


// Exam Session Management Endpoints
app.post('/api/exam-sessions', async (req, res) => {
  try {
    const { user_id, test_id, session_data, current_section } = req.body

    const { data, error } = await supabase
      .from('exam_sessions')
      .insert([{
        user_id,
        test_id,
        session_data,
        current_section
      }])
      .select()

    if (error) throw error

    res.json({
      success: true,
      session: data[0]
    })
  } catch (error) {
    console.error('Create session error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

app.put('/api/exam-sessions/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { session_data, current_section, status } = req.body

    const { data, error } = await supabase
      .from('exam_sessions')
      .update({
        session_data,
        current_section,
        status,
        last_activity: new Date().toISOString()
      })
      .eq('id', id)
      .select()

    if (error) throw error

    res.json({
      success: true,
      session: data[0]
    })
  } catch (error) {
    console.error('Update session error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

app.get('/api/exam-sessions/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params

    const { data, error } = await supabase
      .from('exam_sessions')
      .select(`
        *,
        tests(title, edition, test_number)
      `)
      .eq('user_id', user_id)
      .eq('status', 'active')
      .order('last_activity', { ascending: false })
      .limit(1)

    if (error) throw error

    res.json({
      success: true,
      session: data[0] || null
    })
  } catch (error) {
    console.error('Get session error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Admin Authentication Endpoint
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body

    // Check if admin exists in users table
    const { data: admin, error: adminError } = await supabase
      .from('users')
      .select('*')
      .eq('role', 'admin')
      .eq('email', email)
      .single()

    if (adminError || !admin) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      })
    }

    // Check password (in production, use proper hashing)
    if (admin.password !== password) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      })
    }

    res.json({
      success: true,
      admin: {
        id: admin.id,
        full_name: admin.full_name,
        email: admin.email,
        role: admin.role
      }
    })
  } catch (error) {
    console.error('Admin login error:', error)
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again.'
    })
  }
})

// OCR Service Status Endpoint
app.get('/api/ocr/status', async (req, res) => {
  try {
    const status = await ocrService.getServiceStatus()
    res.json({
      success: true,
      ...status
    })
  } catch (error) {
    console.error('OCR status error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Get User's Active Test Endpoint
app.get('/api/exam/active/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params

    // First check if user has a specifically assigned test
    const { data: assignedTest, error: assignedError } = await supabase
      .from('user_assigned_tests')
      .select(`
        test_id,
        tests (*)
      `)
      .eq('user_id', user_id)
      .order('assigned_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (assignedError && assignedError.code !== 'PGRST116') {
      throw assignedError
    }

    // If user has assigned test, return it
    if (assignedTest) {
      return res.json({
        success: true,
        test: assignedTest.tests,
        source: 'assigned'
      })
    }

    // Otherwise, get the globally active test
    const { data: activeTest, error: activeError } = await supabase
      .from('active_tests')
      .select(`
        test_id,
        tests (*)
      `)
      .eq('is_active', true)
      .maybeSingle()

    if (activeError && activeError.code !== 'PGRST116') {
      throw activeError
    }

    if (!activeTest) {
      return res.status(404).json({
        success: false,
        message: 'No active test available'
      })
    }

    res.json({
      success: true,
      test: activeTest.tests,
      source: 'global'
    })

  } catch (error) {
    console.error('Get active test error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Check User Exam Access Endpoint
app.get('/api/exam/access/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params

    // Check if user exists
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('id', user_id)
      .single()

    if (userError || !user) {
      return res.status(404).json({
        success: false,
        hasAccess: false,
        message: 'User not found'
      })
    }

    // Check approval status
    const { data: approval, error: approvalError } = await supabase
      .from('exam_entry_approvals')
      .select('*')
      .eq('user_id', user_id)
      .eq('status', 'approved')
      .maybeSingle()

    if (approvalError && approvalError.code !== 'PGRST116') {
      throw approvalError
    }

    const hasAccess = !!approval || user.role === 'admin'

    res.json({
      success: true,
      hasAccess,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: user.role
      },
      approval
    })

  } catch (error) {
    console.error('Check exam access error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Email Results Endpoint
app.post('/api/results/email', async (req, res) => {
  try {
    const { result_id, user_email, user_name } = req.body

    // Get the result details
    const { data: result, error: resultError } = await supabase
      .from('results')
      .select(`
        *,
        tests(title, edition)
      `)
      .eq('id', result_id)
      .single()

    if (resultError) throw resultError

    // Create email content
    const emailContent = `
Dear ${user_name},

Your IELTS practice test results are now available!

Test: ${result.tests.title}
Taken: ${new Date(result.taken_date).toLocaleDateString()}

Your Scores:
- Listening: ${result.listening_score || 'Pending'}/40
- Reading: ${result.reading_score || 'Pending'}/40
- Writing: ${result.writing_score || 'Pending'}/9
- Overall Band Score: ${result.overall_score || 'Pending'}/9

${result.overall_score ?
        result.overall_score >= 7 ? 'Excellent work! You\'re on track for a high IELTS score.' :
          result.overall_score >= 6 ? 'Good progress! Keep practicing to improve your score.' :
            'Keep working hard! Practice regularly to improve your IELTS performance.'
        : 'Your results are being reviewed and scored.'}

Thank you for taking the IELTS practice test.

Best regards,
IELTS Practice Team
    `

    // Note: In a real implementation, you would integrate with an email service like:
    // - SendGrid
    // - Mailgun
    // - AWS SES
    // - Nodemailer with SMTP

    console.log('Email would be sent to:', user_email)
    console.log('Email content:', emailContent)

    // Update the email_sent flag
    const { error: updateError } = await supabase
      .from('results')
      .update({ email_sent: true })
      .eq('id', result_id)

    if (updateError) throw updateError

    res.json({
      success: true,
      message: 'Results sent via email successfully',
      // In development, return the email content for testing
      debug: process.env.NODE_ENV === 'development' ? {
        to: user_email,
        subject: `IELTS Practice Test Results - ${result.tests.title}`,
        content: emailContent
      } : undefined
    })

  } catch (error) {
    console.error('Email results error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

app.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));

// Update user endpoint
app.put('/api/admin/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params
    const { full_name, email, id: newId } = req.body

    if (!full_name || !email) {
      return res.status(400).json({
        success: false,
        error: 'Full name and email are required'
      })
    }

    // If changing ID, check if new ID already exists
    if (newId && newId !== userId) {
      const { data: existingUser } = await supabase
        .from('users')
        .select('id')
        .eq('id', newId)
        .single()

      if (existingUser) {
        return res.status(400).json({
          success: false,
          error: 'User ID already exists'
        })
      }
    }

    // Update user
    const { data, error } = await supabase
      .from('users')
      .update({
        full_name: full_name.trim(),
        email: email.trim(),
        ...(newId && newId !== userId && { id: newId })
      })
      .eq('id', userId)
      .select()
      .single()

    if (error) {
      console.error('Update user error:', error)
      throw error
    }

    res.json({
      success: true,
      user: data,
      message: 'User updated successfully'
    })
  } catch (error) {
    console.error('Update user error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Delete single user endpoint
app.delete('/api/admin/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params

    // First, delete all user's results
    const { error: resultsError } = await supabase
      .from('results')
      .delete()
      .eq('exam_taker_id', userId)

    if (resultsError) {
      console.error('Delete user results error:', resultsError)
      throw resultsError
    }

    // Then delete user assigned tests
    const { error: assignmentsError } = await supabase
      .from('user_assigned_tests')
      .delete()
      .eq('user_id', userId)

    if (assignmentsError) {
      console.error('Delete user assignments error:', assignmentsError)
    }

    // Finally, delete the user
    const { error: userError } = await supabase
      .from('users')
      .delete()
      .eq('id', userId)

    if (userError) {
      console.error('Delete user error:', userError)
      throw userError
    }

    res.json({
      success: true,
      message: 'User and all related data deleted successfully'
    })
  } catch (error) {
    console.error('Delete user error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Delete multiple users endpoint
app.delete('/api/admin/users', async (req, res) => {
  try {
    const { userIds } = req.body

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'User IDs array is required'
      })
    }

    // Delete all results for these users
    const { error: resultsError } = await supabase
      .from('results')
      .delete()
      .in('exam_taker_id', userIds)

    if (resultsError) {
      console.error('Delete users results error:', resultsError)
      throw resultsError
    }

    // Delete all assignments for these users
    const { error: assignmentsError } = await supabase
      .from('user_assigned_tests')
      .delete()
      .in('user_id', userIds)

    if (assignmentsError) {
      console.error('Delete users assignments error:', assignmentsError)
    }

    // Delete the users
    const { error: usersError } = await supabase
      .from('users')
      .delete()
      .in('id', userIds)

    if (usersError) {
      console.error('Delete users error:', usersError)
      throw usersError
    }

    res.json({
      success: true,
      message: `${userIds.length} users and all related data deleted successfully`
    })
  } catch (error) {
    console.error('Delete users error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Delete single result endpoint
app.delete('/api/admin/results/:resultId', async (req, res) => {
  try {
    const { resultId } = req.params

    const { error } = await supabase
      .from('results')
      .delete()
      .eq('id', resultId)

    if (error) {
      console.error('Delete result error:', error)
      throw error
    }

    res.json({
      success: true,
      message: 'Result deleted successfully'
    })
  } catch (error) {
    console.error('Delete result error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Delete multiple results endpoint
app.delete('/api/admin/results', async (req, res) => {
  try {
    const { resultIds } = req.body

    if (!resultIds || !Array.isArray(resultIds) || resultIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Result IDs array is required'
      })
    }

    const { error } = await supabase
      .from('results')
      .delete()
      .in('id', resultIds)

    if (error) {
      console.error('Delete results error:', error)
      throw error
    }

    res.json({
      success: true,
      message: `${resultIds.length} results deleted successfully`
    })
  } catch (error) {
    console.error('Delete results error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// Update user ID after exam completion
app.put('/api/users/:userId/update-id', async (req, res) => {
  try {
    const { userId } = req.params

    // Generate 8-digit ID
    const newId = Math.floor(10_000_000 + Math.random() * 90_000_000).toString()

    // Check if new ID already exists (very unlikely but good to check)
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('id', newId)
      .single()

    if (existingUser) {
      // Recursively try again if ID exists
      return res.redirect(307, `/api/users/${userId}/update-id`)
    }

    // Update user ID
    const { data, error } = await supabase
      .from('users')
      .update({ id: newId })
      .eq('id', userId)
      .select()
      .single()

    if (error) {
      console.error('Update user ID error:', error)
      throw error
    }

    // Update all results to use new ID
    const { error: resultsError } = await supabase
      .from('results')
      .update({ exam_taker_id: newId })
      .eq('exam_taker_id', userId)

    if (resultsError) {
      console.error('Update results user ID error:', resultsError)
      // Don't throw error here as user ID is already updated
    }

    // Update all assignments to use new ID
    const { error: assignmentsError } = await supabase
      .from('user_assigned_tests')
      .update({ user_id: newId })
      .eq('user_id', userId)

    if (assignmentsError) {
      console.error('Update assignments user ID error:', assignmentsError)
      // Don't throw error here as user ID is already updated
    }

    res.json({
      success: true,
      user: data,
      newId,
      message: 'User ID updated successfully'
    })
  } catch (error) {
    console.error('Update user ID error:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

app.post('/api/writing/evaluate', async (req, res) => {
  try {
    const { text, taskType } = req.body || {}
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ success: false, error: 'Missing text' })
    }

    // Select prompts based on task type (task1 = Report, task2 = Essay)
    let systemPrompt = ''
    let userPrompt = ''
    if (taskType === 'task1') {
      systemPrompt = `You are an IELTS Writing Task 1 (Academic) examiner using the official British Council band descriptors:
- Task Achievement (TA)
- Coherence and Cohesion (CC)
- Lexical Resource (LR)
- Grammatical Range and Accuracy (GRA)

Scoring rules:
- Task Achievement is based on accurate description of data, clear comparisons, correct trend analysis, and coverage of key features.
- Coherence and Cohesion: paragraph structure, logical flow, linking devices.
- Lexical Resource: range of vocabulary, correct collocations, appropriateness.
- Grammatical Range and Accuracy: variety of sentence structures, tense usage, agreement, punctuation.

Important:
- Give realistic scores (0.0–9.0, half bands allowed).
- Be strict: do not overestimate.
- Output must be only JSON, no extra explanation.
- Excerpts in highlights must be short (5–10 words, exactly as in the essay).
- Suggestions must be short, actionable, and relevant.

Overall score = average of the four criteria, rounded to the nearest 0.5.`
      userPrompt = `Evaluate the following IELTS Writing Task 1 essay.

Return ONLY this JSON structure:
{
  "overallScore": number,
  "criteria": {
    "taskAchievement": number,
    "coherenceAndCohesion": number,
    "lexicalResource": number,
    "grammaticalRangeAndAccuracy": number
  },
  "highlights": [
    {
      "type": "grammar" | "coherence" | "vocabulary",
      "excerpt": string,
      "suggestion": string
    }
  ],
  "summary": string,
  "statistics": {
    "wordCount": number,
    "uniqueWordCount": number,
    "overusedWords": [string],
    "topicRelevance": number
  }
}

Essay:
${text}`
    } else {
      // Default to Task 2 prompts (existing)
      systemPrompt = `You are an IELTS Writing Task 2 examiner following the official British Council band descriptors:
- Task Response (TR)
- Coherence and Cohesion (CC)
- Lexical Resource (LR)
- Grammatical Range and Accuracy (GRA)

You must evaluate the essay realistically, as a human examiner would — no generosity, no over-scoring.

Output strictly in the given JSON format.
No extra text, no Markdown, no explanations outside JSON.

Highlighting rules:
- "grammar" → tense, articles, agreement, prepositions, sentence structure
- "coherence" → paragraphing, connections, ordering, linking words
- "vocabulary" → overused words, wrong collocations, informal phrases
- excerpt: short (5–10 words), exactly as in essay
- suggestion: actionable and concise

Scoring rules:
- Score each criterion 0.0–9.0 (half bands allowed)
- overallScore = average of 4 criteria (rounded to nearest 0.5)
- Be strict but fair, never exceeding realistic IELTS levels.`
      userPrompt = `Evaluate the following IELTS Writing Task 2 essay.

Return ONLY this JSON structure:
{
  "overallScore": number,
  "criteria": {
    "taskAchievement": number,
    "coherenceAndCohesion": number,
    "lexicalResource": number,
    "grammaticalRangeAndAccuracy": number
  },
  "highlights": [
    {
      "type": "grammar" | "coherence" | "vocabulary",
      "excerpt": string,
      "suggestion": string
    }
  ],
  "summary": string,
  "statistics": {
    "wordCount": number,
    "uniqueWordCount": number,
    "overusedWords": [string],
    "topicRelevance": number
  }
}

Essay:
${text}`
    }

    let parsed
    let attempt = 0
    const maxAttempts = 2
    while (attempt < maxAttempts) {
      attempt++
      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.2,
          max_tokens: 900
        })

        const content = completion.choices?.[0]?.message?.content || ''
        if (!content) throw new Error('Empty response')
        parsed = OCRService.parseJsonSafely(content, 'Writing Evaluation')
        break
      } catch (e) {
        if (attempt >= maxAttempts) throw e
        await new Promise(r => setTimeout(r, 500))
      }
    }

    // Normalize keys for UI (accept both excerpt/text, topicRelevance/topicRelevancePercentage)
    try {
      if (parsed?.highlights) {
        parsed.highlights = parsed.highlights.map((h) => ({
          type: h.type,
          text: h.text || h.excerpt || '',
          suggestion: h.suggestion || ''
        }))
      }
      if (parsed?.statistics) {
        parsed.statistics.topicRelevancePercentage = parsed.statistics.topicRelevancePercentage ?? parsed.statistics.topicRelevance
      }
    } catch { }

    return res.json({ success: true, evaluation: parsed })
  } catch (error) {
    console.error('Writing evaluate error:', error)
    return res.status(500).json({ success: false, error: error.message || 'Server error' })
  }
})
